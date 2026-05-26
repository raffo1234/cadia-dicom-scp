// eslint-disable-next-line @typescript-eslint/no-var-requires
const dcmjsData = require("dcmjs").data;
import { Dataset } from "dcmjs-dimse";
import { hospitalRegistry } from "../lib/hospitalRegistry";
import { uploadToR2 } from "../lib/r2";
import { supabase } from "../lib/supabase";
import { DicomInstanceInsert, HospitalAccess } from "../types";

/**
 * Naturalized dcmjs datasets return plain values (strings, numbers, arrays)
 * not wrapped in { Value: [...] } objects. These helpers handle both formats.
 */
const tag = (dataset: Record<string, any>, key: string): string | undefined => {
  const val = dataset[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val === "string") return val.trim() || undefined;
  if (typeof val === "number") return String(val);
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
      ? Array.isArray(val.Value)
        ? val.Value[0]
        : val.Value
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
      ? Array.isArray(val.Value)
        ? val.Value[0]
        : val.Value
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
 * Resolves a hospital record by ID, returning it in the same shape
 * as hospitalRegistry.findByAeTitle() so the rest of handleCStore works unchanged.
 */
const resolveHospitalById = async (hospitalId: string): Promise<HospitalAccess | null> => {
  const { data } = await supabase
    .from("hospital")
    .select("id, name, r2_bucket")
    .eq("id", hospitalId)
    .maybeSingle();

  if (!data) return null;

  return {
    id: data.id,
    hospital_id: hospitalId,
    name: data.name,
    ae_title: "",
    allowed_ip: null,
    is_active: true,
    hospital: {
      id: data.id,
      name: data.name,
      r2_bucket: data.r2_bucket,
    },
  } as unknown as HospitalAccess;
};

/**
 * Retries an async operation up to maxAttempts times with linear backoff.
 * Used to make R2 uploads and DB upserts resilient to transient failures.
 */
const withRetry = async <T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number = 3,
  delayMs: number = 500,
): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        console.warn(`[C-STORE] ${label} — attempt ${attempt}/${maxAttempts} failed: ${msg}. Retrying in ${delayMs * attempt}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      } else {
        console.error(`[C-STORE] ${label} — all ${maxAttempts} attempts failed: ${msg}`);
      }
    }
  }
  throw lastError;
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
): Promise<{
  success: boolean;
  reason?: string;
  studyInstanceUID?: string;
  hospitalId?: string;
}> => {
  // 1. Validate AE title — first check hospitalRegistry, then ae_route in DB
  let hospital = await hospitalRegistry.findByAeTitle(callingAeTitle);

  if (!hospital) {
    // Fallback: resolve by ae_title in ae_route (handles C-MOVE callbacks
    // from external PACS across multiple Fly.io instances)
    const { data: route } = await supabase
      .from("ae_route")
      .select("hospital_id")
      .eq("ae_title", callingAeTitle)
      .eq("is_active", true)
      .maybeSingle();

    if (!route) {
      console.warn(`[C-STORE] Rejected unknown AE title: ${callingAeTitle}`);
      return { success: false, reason: "Unknown or inactive AE title" };
    }

    console.log(
      `[C-STORE] C-MOVE callback from ${callingAeTitle} → resolving hospital via ae_route`,
    );
    hospital = await resolveHospitalById(route.hospital_id);

    if (!hospital) {
      console.warn(`[C-STORE] Could not resolve hospital for ${callingAeTitle}`);
      return { success: false, reason: "Could not resolve hospital" };
    }
  }

  // IP allowlist check (skipped for C-MOVE callbacks since allowed_ip is null)
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

    const denaturalizedMeta = dcmjsData.DicomMetaDictionary.denaturalizeDataset({
      FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
      MediaStorageSOPClassUID: elements.SOPClassUID ?? "1.2.840.10008.5.1.4.1.1.7",
      MediaStorageSOPInstanceUID: elements.SOPInstanceUID ?? "",
      TransferSyntaxUID: transferSyntaxUid,
    });

    const dicomDict = new dcmjsData.DicomDict(denaturalizedMeta);
    dicomDict.dict = dcmjsData.DicomMetaDictionary.denaturalizeDataset(elements);
    fileBuffer = Buffer.from(dicomDict.write());

    // Use elements directly from dcmjs-dimse — already naturalized, no round-trip needed.
    // naturalizeDataset crashes on null values inside private/sequence tags that some
    // modalities produce. getElements() never crashes because dcmjs-dimse handles them safely.
    dataset = elements as Record<string, any>;
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

  // 4. Upload to R2 — with retry for transient failures
  const storagePath = `dicom/${studyInstanceUID}/${seriesInstanceUID}/${sopInstanceUID}.dcm`;
  let storageUrl: string;

  try {
    storageUrl = await withRetry(
      () => uploadToR2(hospital.hospital.r2_bucket, storagePath, fileBuffer),
      `R2 upload ${sopInstanceUID}`,
    );
  } catch (err) {
    console.error(`[C-STORE] R2 upload permanently failed for ${sopInstanceUID}:`, err);
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
    image_orientation: tagFloatArray(dataset, "ImageOrientationPatient") as
      | [number, number, number, number, number, number]
      | undefined,
    image_position: tagFloatArray(dataset, "ImagePositionPatient") as
      | [number, number, number]
      | undefined,
    window_center: tagFloat(dataset, "WindowCenter"),
    window_width: tagFloat(dataset, "WindowWidth"),
    rescale_intercept: tagFloat(dataset, "RescaleIntercept"),
    rescale_slope: tagFloat(dataset, "RescaleSlope"),
    rescale_type: tag(dataset, "RescaleType"),
    number_of_frames: tagInt(dataset, "NumberOfFrames"),
  };

  // 6. Upsert estudio + instancia en una sola operación atómica — con retry
  const rpcParams = {
    p_study_instance_uid:   studyInstanceUID,
    p_hospital_id:          hospital.hospital_id,
    p_ae_title_source:      callingAeTitle,
    p_ae_title_destination: calledAeTitle,
    p_patient_name:         tag(dataset, "PatientName") ?? null,
    p_patient_id:           tag(dataset, "PatientID") ?? null,
    p_patient_age:          tag(dataset, "PatientAge") ?? null,
    p_patient_sex:          tag(dataset, "PatientSex") ?? null,
    p_study_description:    tag(dataset, "StudyDescription") ?? null,
    p_study_date:           tag(dataset, "StudyDate") ?? null,
    p_modality:             tag(dataset, "Modality") ?? "OT",
    p_total_instances:      tagInt(dataset, "ImagesInAcquisition") ?? 0,
    p_instance:             instance as unknown as Record<string, unknown>,
    p_remote_address:       remoteAddress,
  };

  let upsertResult: { study_id: string; is_duplicate: boolean };

  try {
    upsertResult = await withRetry(async () => {
      const { data, error } = await supabase.rpc("upsert_dicom_instance", rpcParams);
      if (error) throw new Error(error.message);
      return data as { study_id: string; is_duplicate: boolean };
    }, `DB upsert ${sopInstanceUID}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[C-STORE] upsert_dicom_instance permanently failed for ${sopInstanceUID}:`, msg);
    return { success: false, reason: "Failed to save instance metadata" };
  }

  if (upsertResult.is_duplicate) {
    console.log(`[C-STORE] Duplicate skipped: ${sopInstanceUID}`);
  } else {
    console.log(`[C-STORE] ✓ ${sopInstanceUID} → ${hospital.hospital.name}`);
  }

  return { success: true, studyInstanceUID, hospitalId: hospital.hospital_id };
};
