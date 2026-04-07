import { hospitalRegistry } from "../lib/hospitalRegistry";
import { supabase } from "../lib/supabase";

type StudyRow = {
  study_instance_uid: string;
  patient_name: string | null;
  patient_id: string | null;
  patient_age: string | null;
  patient_sex: string | null;
  study_description: string | null;
  study_date: string | null;
  modality: string | null;
  received_instances: number;
};

/**
 * C-FIND — DICOM query handler
 * Called when a modality or PACS queries for studies/series/instances.
 * Supports Study and Series level queries.
 */
export const handleCFind = async (
  callingAeTitle: string,
  calledAeTitle: string,
  remoteAddress: string,
  query: Record<string, any>,
  queryLevel: "STUDY" | "SERIES" | "IMAGE",
): Promise<{ success: boolean; results?: Record<string, any>[]; reason?: string }> => {
  // 1. Validate the called AE title is one of ours
  const hospital = await hospitalRegistry.findByAeTitle(calledAeTitle);

  if (!hospital) {
    console.warn(
      `[C-FIND] Rejected unknown AE title: ${calledAeTitle} from ${remoteAddress}`,
    );
    return { success: false, reason: "Unknown or inactive AE title" };
  }

  console.log(
    `[C-FIND] ${callingAeTitle} → ${calledAeTitle} (${hospital.hospital.name}) | Level: ${queryLevel}`,
  );

  // Audit log
  await supabase.from("dicom_audit_log").insert({
    hospital_id: hospital.hospital_id,
    action: "c-find",
    ae_title: callingAeTitle,
    ip_address: remoteAddress,
  });

  try {
    if (queryLevel === "STUDY") {
      return await handleStudyLevelFind(hospital.hospital_id, query);
    } else if (queryLevel === "SERIES") {
      return await handleSeriesLevelFind(hospital.hospital_id, query);
    } else {
      return { success: false, reason: `Unsupported query level: ${queryLevel}` };
    }
  } catch (err) {
    console.error(`[C-FIND] Query failed for ${callingAeTitle}:`, err);
    return { success: false, reason: "Query execution failed" };
  }
};

const handleStudyLevelFind = async (
  hospitalId: string,
  query: Record<string, any>,
): Promise<{ success: boolean; results?: Record<string, any>[]; reason?: string }> => {
  let q = supabase
    .from("dicom_study")
    .select(
      "study_instance_uid, patient_name, patient_id, patient_age, patient_sex, " +
      "study_description, study_date, modality, received_instances, receive_status",
    )
    .eq("hospital_id", hospitalId)
    .eq("receive_status", "complete");

  // Apply wildcard-aware filters for standard Study-level attributes
  if (query.StudyInstanceUID) {
    q = q.eq("study_instance_uid", query.StudyInstanceUID);
  }
  if (query.PatientID) {
    q = applyWildcard(q, "patient_id", query.PatientID);
  }
  if (query.PatientName) {
    q = applyWildcard(q, "patient_name", query.PatientName);
  }
  if (query.StudyDate) {
    q = applyDateRange(q, "study_date", query.StudyDate);
  }
  if (query.Modality) {
    q = q.eq("modality", query.Modality);
  }

  const { data, error } = await q.limit(200);

  if (error) {
  console.error("[C-FIND] Study query error:", error.message);
  return { success: false, reason: "Study query failed" };
}

  const results = ((data ?? []) as unknown as StudyRow[]).map((row) => ({
    StudyInstanceUID: row.study_instance_uid,
    PatientName: row.patient_name ?? "",
    PatientID: row.patient_id ?? "",
    PatientAge: row.patient_age ?? "",
    PatientSex: row.patient_sex ?? "",
    StudyDescription: row.study_description ?? "",
    StudyDate: row.study_date ?? "",
    Modality: row.modality ?? "",
    NumberOfStudyRelatedInstances: String(row.received_instances ?? 0),
  }));

  console.log(`[C-FIND] Study query returned ${results.length} result(s)`);
  return { success: true, results };
};

const handleSeriesLevelFind = async (
  hospitalId: string,
  query: Record<string, any>,
): Promise<{ success: boolean; results?: Record<string, any>[]; reason?: string }> => {
  if (!query.StudyInstanceUID) {
    return { success: false, reason: "StudyInstanceUID required for SERIES level query" };
  }

  const { data: study, error: studyError } = await supabase
    .from("dicom_study")
    .select("id, instances")
    .eq("study_instance_uid", query.StudyInstanceUID)
    .eq("hospital_id", hospitalId)
    .eq("receive_status", "complete")
    .maybeSingle();

  if (studyError) {
    console.error("[C-FIND] Series study lookup error:", studyError.message);
    return { success: false, reason: "Series query failed" };
  }

  if (!study) {
    return { success: true, results: [] };
  }

  // Aggregate series from the instances JSONB array
  const seriesMap = new Map<string, Record<string, any>>();
  const instances: Record<string, any>[] = study.instances ?? [];

  for (const inst of instances) {
    const uid = inst.series_instance_uid;
    if (!uid) continue;
    if (!seriesMap.has(uid)) {
      seriesMap.set(uid, {
        SeriesInstanceUID: uid,
        SeriesNumber: String(inst.series_number ?? ""),
        SeriesDescription: inst.series_description ?? "",
        Modality: inst.modality ?? "",
        NumberOfSeriesRelatedInstances: 1,
      });
    } else {
      seriesMap.get(uid)!.NumberOfSeriesRelatedInstances += 1;
    }
  }

  let results = Array.from(seriesMap.values());

  if (query.SeriesInstanceUID) {
    results = results.filter((s) => s.SeriesInstanceUID === query.SeriesInstanceUID);
  }

  console.log(`[C-FIND] Series query returned ${results.length} series`);
  return { success: true, results };
};

// --- Query helpers ---

const applyWildcard = (q: any, column: string, value: string): any => {
  if (value.includes("*") || value.includes("?")) {
    // DICOM wildcards: * → %, ? → _
    const pattern = value.replace(/\*/g, "%").replace(/\?/g, "_");
    return q.ilike(column, pattern);
  }
  return q.eq(column, value);
};

const applyDateRange = (q: any, column: string, value: string): any => {
  // DICOM date range: "20230101-20231231", or exact "20230101"
  if (value.includes("-")) {
    const [start, end] = value.split("-");
    if (start) q = q.gte(column, start);
    if (end) q = q.lte(column, end);
    return q;
  }
  return q.eq(column, value);
};