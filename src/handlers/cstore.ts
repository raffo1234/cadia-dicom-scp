// eslint-disable-next-line @typescript-eslint/no-var-requires
const dcmjsData = require('dcmjs').data;
import { Dataset } from "dcmjs-dimse";
import { hospitalRegistry } from "../lib/hospitalRegistry";
import { uploadToR2 } from "../lib/r2";
import { supabase } from "../lib/supabase";
import { DicomInstanceInsert } from "../types";

/**
 * Naturalized dcmjs datasets return plain values (strings, numbers, arrays)
 * not wrapped in { Value: [...] } objects. These helpers handle both formats.
 */
const tag = (dataset: Record<string, any>, key: string): string | undefined => {
  const val = dataset[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") return val.trim() || undefined;
  if (typeof val === "number") return String(val);
  // DICOM Person Name — { Alphabetic: "DOE^JOHN" }
  if (typeof val === "object" && !Array.isArray(val) && val.Alphabetic !== undefined) {
    return String(val.Alphabetic).trim() || undefined;
  }
  if (Array.isArray(val)) {
    const first = val[0];
    if (first?.Alphabetic !== undefined) return String(first.Alphabetic).trim() || undefined;
    return first !== undefined ? String(first).trim() : undefined;
  }
  if (typeof val === "object" && val.Value) {
    const v = Array.isArray(val.Value) ? val.Value[0] : val.Value;
    if (v?.Alphabetic !== undefined) return String(v.Alphabetic).trim() || undefined;
    return v !== undefined && v !== null ? String(v).trim() : undefined;
  }
  return String(val).trim() || undefined;
};

const tagFloat = (dataset: Record<string, any>, key: string): number | undefined => {
  const val = dataset[key];
  if (val === undefined || val === null) return undefined;
  const v = Array.isArray(val)
    ? val[0]
    : val?.Value
    ? Array.isArray(val.Value) ? val.Value[0] : val.Value
    : val;
  const n = parseFloat(String(v));
  return isNaN(n) ? undefined : n;
};

const tagInt = (dataset: Record<string, any>, key: string): number | undefined => {
  const val = dataset[key];
  if (val === undefined || val === null) return undefined;
  const v = Array.isArray(val)
    ? val[0]
    : val?.Value
    ? Array.isArray(val.Value) ? val.Value[0] : val.Value
    : val;
  const n = parseInt(String(v), 10);
  return isNaN(n) ? undefined : n;
};

const tagFloatArray = (dataset: Record<string, any>, key: string): number[] | undefined => {
  const val = dataset[key];
  if (!val) return undefined;
  const arr = Array.isArray(val) ? val : val?.Value ? val.Value : undefined;
  if (!arr) return undefined;
  const nums = arr.map((v: unknown) => parseFloat(String(v)));
  return nums.every((n: number) => !isNaN(n)) ? nums : undefined;
};

/**
 * C-STORE — receives a single DICOM instance from a modality
 * Called once per file during a study send
 */
export const handleCStore = async (
  callingAeTitle: string,
  calledAeTitle: string,
  remoteAddress: string,
  rawDataset: Dataset,
): Promise<{ success: boolean; reason?: string; studyInstanceUID?: string; hospitalId?: string }> => {
  // 1. Validate AE title
  const hospital = await hospitalRegistry.findByAeTitle(callingAeTitle);
  if (!hospital) {
    console.warn(`[C-STORE] Rejected unknown AE title: ${callingAeTitle}`);
    return { success: false, reason: "Unknown or inactive AE title" };
  }

  // IP allowlist check
  if (hospital.allowed_ip && remoteAddress !== hospital.allowed_ip) {
    console.warn(`[C-STORE] Rejected IP ${remoteAddress} for AE title ${calledAeTitle}`);
    return { success: false, reason: "IP not allowed" };
  }

  let dataset: Record<string, any>;
  let fileBuffer: Buffer;

  // 2. Extract buffer and parse DICOM metadata
  try {
    const elements = rawDataset.getElements();
    const transferSyntaxUid = rawDataset.getTransferSyntaxUid();

    // Replicate toFile() internals to get buffer without writing to disk
    const denaturalizedMeta = dcmjsData.DicomMetaDictionary.denaturalizeDataset({
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: elements.SOPClassUID ?? "1.2.840.10008.5.1.4.1.1.7",
      MediaStorageSOPInstanceUID: elements.SOPInstanceUID ?? "",
      TransferSyntaxUID: transferSyntaxUid,
    });

    const dicomDict = new dcmjsData.DicomDict(denaturalizedMeta);
    dicomDict.dict = dcmjsData.DicomMetaDictionary.denaturalizeDataset(elements);
    fileBuffer = Buffer.from(dicomDict.write());

    const dicomData = dcmjsData.DicomMessage.readFile(fileBuffer.buffer as ArrayBuffer);
    dataset = dcmjsData.DicomMetaDictionary.naturalizeDataset(dicomData.dict);
  } catch (err) {
    console.error(`[C-STORE] Failed to parse DICOM from ${callingAeTitle}:`, err);
    return { success: false, reason: "Failed to parse DICOM file" };
  }

  // 3. Extract required UIDs
  const studyInstanceUID = tag(dataset, "StudyInstanceUID");
  const seriesInstanceUID = tag(dataset, "SeriesInstanceUID");
  const sopInstanceUID = tag(dataset, "SOPInstanceUID");
  const sopClassUID = tag(dataset, "SOPClassUID");

  if (!studyInstanceUID || !seriesInstanceUID || !sopInstanceUID || !sopClassUID) {
    console.error(`[C-STORE] Missing required UIDs from ${callingAeTitle}`);
    return { success: false, reason: "Missing required DICOM UIDs" };
  }

  // 4. Upload to R2
  const storagePath = `dicom/${studyInstanceUID}/${seriesInstanceUID}/${sopInstanceUID}.dcm`;
  let storageUrl: string;

  try {
    storageUrl = await uploadToR2(hospital.hospital.r2_bucket, storagePath, fileBuffer);
  } catch (err) {
    console.error(`[C-STORE] R2 upload failed for ${sopInstanceUID}:`, err);
    return { success: false, reason: "Failed to upload to storage" };
  }

  // 5. Build instance metadata
  const instance: DicomInstanceInsert = {
    sop_instance_uid: sopInstanceUID,
    series_instance_uid: seriesInstanceUID,
    instance_number: tagInt(dataset, "InstanceNumber") ?? 0,
    storage_url: storageUrl,
    sop_class_uid: sopClassUID,
    series_number: tagInt(dataset, "SeriesNumber") ?? 1,
    series_description: tag(dataset, "SeriesDescription") ?? "",
    rows: tagInt(dataset, "Rows") ?? 512,
    columns: tagInt(dataset, "Columns") ?? 512,
    bits_allocated: tagInt(dataset, "BitsAllocated") ?? 16,
    bits_stored: tagInt(dataset, "BitsStored") ?? 16,
    high_bit: tagInt(dataset, "HighBit") ?? 15,
    pixel_representation: tagInt(dataset, "PixelRepresentation") ?? 0,
    samples_per_pixel: tagInt(dataset, "SamplesPerPixel") ?? 1,
    photometric_interpretation: tag(dataset, "PhotometricInterpretation") ?? "MONOCHROME2",
    slice_thickness: tagFloat(dataset, "SliceThickness"),
    pixel_spacing: tagFloatArray(dataset, "PixelSpacing") as [number, number] | undefined,
    image_orientation: tagFloatArray(dataset, "ImageOrientationPatient") as [number, number, number, number, number, number] | undefined,
    image_position: tagFloatArray(dataset, "ImagePositionPatient") as [number, number, number] | undefined,
    window_center: tagFloat(dataset, "WindowCenter"),
    window_width: tagFloat(dataset, "WindowWidth"),
    rescale_intercept: tagFloat(dataset, "RescaleIntercept"),
    rescale_slope: tagFloat(dataset, "RescaleSlope"),
    rescale_type: tag(dataset, "RescaleType"),
    number_of_frames: tagInt(dataset, "NumberOfFrames"),
  };

  // 6. Upsert study in dicom_study
  const { data: existingStudy } = await supabase
    .from("dicom_study")
    .select("id, received_instances, total_instances")
    .eq("study_instance_uid", studyInstanceUID)
    .eq("hospital_id", hospital.hospital_id)
    .maybeSingle();

  if (!existingStudy) {
    // First instance of this study — create the study record
    const { data: newStudy, error: insertError } = await supabase
      .from("dicom_study")
      .insert({
        study_instance_uid: studyInstanceUID,
        hospital_id: hospital.hospital_id,
        ae_title_source: callingAeTitle,
        ae_title_destination: calledAeTitle,
        patient_name: tag(dataset, "PatientName"),
        patient_id: tag(dataset, "PatientID"),
        patient_age: tag(dataset, "PatientAge"),
        patient_sex: tag(dataset, "PatientSex"),
        study_description: tag(dataset, "StudyDescription"),
        study_date: tag(dataset, "StudyDate"),
        modality: tag(dataset, "Modality") ?? "OT",
        instances: [instance],
        receive_status: "receiving",
        received_instances: 1,
        total_instances: tagInt(dataset, "ImagesInAcquisition") ?? 0,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error(`[C-STORE] Failed to insert study ${studyInstanceUID}:`, insertError.message);
      return { success: false, reason: "Failed to save study metadata" };
    }

    // Audit log
    await supabase.from("dicom_audit_log").insert({
      study_id: newStudy.id,
      hospital_id: hospital.hospital_id,
      action: "c-store",
      ae_title: callingAeTitle,
      ip_address: remoteAddress,
    });
  } else {
    // Subsequent instance — append to instances array and increment counter
    const newReceivedInstances = existingStudy.received_instances + 1;
    const isComplete =
      existingStudy.total_instances > 0 &&
      newReceivedInstances >= existingStudy.total_instances;

    // Append instance to jsonb array atomically via rpc
    const { error: appendError } = await supabase.rpc("append_dicom_instance", {
      study_id: existingStudy.id,
      instance: instance,
    });

    if (appendError) {
      console.error(`[C-STORE] Failed to append instance:`, appendError.message);
      return { success: false, reason: "Failed to append instance" };
    }

    const { error: updateError } = await supabase
      .from("dicom_study")
      .update({
        received_instances: newReceivedInstances,
        receive_status: isComplete ? "complete" : "receiving",
        ...(isComplete && { completed_at: new Date().toISOString() }),
      })
      .eq("id", existingStudy.id);

    if (updateError) {
      console.error(`[C-STORE] Failed to update study ${studyInstanceUID}:`, updateError.message);
      return { success: false, reason: "Failed to update study metadata" };
    }
  }

  console.log(
    `[C-STORE] ✓ ${sopInstanceUID} → ${hospital.hospital.name} (${hospital.hospital.r2_bucket})`,
  );

  return { success: true, studyInstanceUID, hospitalId: hospital.hospital_id };
};