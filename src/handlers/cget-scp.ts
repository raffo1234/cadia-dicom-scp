import { supabase } from "../lib/supabase";
import { downloadFromR2 } from "../lib/r2";

interface DicomInstance {
  sop_instance_uid: string;
  sop_class_uid: string;
  storage_url: string;
  series_instance_uid: string;
}

interface ResolvedCaller {
  hospital_id: string;
  allowed_ip: string | null;
  r2_bucket: string;
}

const resolveCallerFromAeTitle = async (aeTitle: string): Promise<ResolvedCaller | null> => {
  const { data: access } = await supabase
    .from("hospital_access")
    .select("hospital_id, allowed_ip, hospital:hospital_id(r2_bucket)")
    .eq("ae_title", aeTitle)
    .eq("is_active", true)
    .maybeSingle();

  if (access) {
    const hospital = Array.isArray(access.hospital) ? access.hospital[0] : access.hospital;
    return {
      hospital_id: access.hospital_id,
      allowed_ip: access.allowed_ip,
      r2_bucket: hospital.r2_bucket,
    };
  }

  const { data: route } = await supabase
    .from("ae_route")
    .select("hospital_id, hospital:hospital_id(r2_bucket)")
    .eq("ae_title", aeTitle)
    .eq("is_active", true)
    .maybeSingle();

  if (route) {
    const hospital = Array.isArray(route.hospital) ? route.hospital[0] : route.hospital;
    return {
      hospital_id: route.hospital_id,
      allowed_ip: null,
      r2_bucket: hospital.r2_bucket,
    };
  }

  return null;
};

const resolveInstances = async (
  hospitalId: string,
  query: Record<string, any>,
  queryLevel: "STUDY" | "SERIES" | "IMAGE",
): Promise<DicomInstance[]> => {
  const studyInstanceUID = query.StudyInstanceUID
    ? String(query.StudyInstanceUID)
    : null;

  if (!studyInstanceUID) return [];

  const { data: studies, error } = await supabase
    .from("dicom_study")
    .select("instances")
    .eq("study_instance_uid", studyInstanceUID)
    .eq("hospital_id", hospitalId)
    .eq("receive_status", "complete");

  if (error || !studies) return [];

  let instances: DicomInstance[] = [];
  for (const study of studies) {
    const all: DicomInstance[] = study.instances ?? [];

    if (queryLevel === "SERIES" && query.SeriesInstanceUID) {
      instances.push(...all.filter((i) => i.series_instance_uid === query.SeriesInstanceUID));
    } else if (queryLevel === "IMAGE" && query.SOPInstanceUID) {
      instances.push(...all.filter((i) => i.sop_instance_uid === query.SOPInstanceUID));
    } else {
      instances.push(...all);
    }
  }

  return instances;
};

const storageUrlToFolderAndKey = (storageUrl: string): { folder: string; key: string } => {
  const idx = storageUrl.indexOf("/");
  if (idx === -1) return { folder: storageUrl, key: "" };
  return {
    folder: storageUrl.slice(0, idx),
    key: storageUrl.slice(idx + 1),
  };
};

export interface CGetScpResult {
  success: boolean;
  completed: number;
  failed: number;
  datasets: { buffer: Buffer; sopClassUid: string; sopInstanceUid: string }[];
  reason?: string;
}

export const handleCGetScp = async (
  callingAeTitle: string,
  calledAeTitle: string,
  remoteAddress: string,
  query: Record<string, any>,
  queryLevel: "STUDY" | "SERIES" | "IMAGE",
  onPending: (completed: number, remaining: number, failed: number) => void,
): Promise<CGetScpResult> => {
  // 1. Validar caller
  const caller = await resolveCallerFromAeTitle(callingAeTitle);
  if (!caller) {
    console.warn(`[C-GET SCP] Rejected unknown AE title: ${callingAeTitle}`);
    return { success: false, completed: 0, failed: 0, datasets: [], reason: "Unknown or inactive AE title" };
  }

  if (caller.allowed_ip && remoteAddress !== caller.allowed_ip) {
    console.warn(`[C-GET SCP] Rejected IP ${remoteAddress} for ${callingAeTitle}`);
    return { success: false, completed: 0, failed: 0, datasets: [], reason: "IP not allowed" };
  }

  console.log(
    `[C-GET SCP] ${callingAeTitle} → ${calledAeTitle} | Level: ${queryLevel} | Study: ${query.StudyInstanceUID}`,
  );

  // 2. Audit log
  await supabase.from("dicom_audit_log").insert({
    hospital_id: caller.hospital_id,
    action: "c-get",
    ae_title: callingAeTitle,
    ip_address: remoteAddress,
  });

  // 3. Resolver instancias
  const instances = await resolveInstances(caller.hospital_id, query, queryLevel);
  if (instances.length === 0) {
    console.log(`[C-GET SCP] No instances found`);
    return { success: true, completed: 0, failed: 0, datasets: [] };
  }

  console.log(`[C-GET SCP] Found ${instances.length} instance(s) to send`);

  // 4. Descargar de R2
  let completed = 0;
  let failed = 0;
  const datasets: { buffer: Buffer; sopClassUid: string; sopInstanceUid: string }[] = [];

  for (const inst of instances) {
    try {
      const { folder, key } = storageUrlToFolderAndKey(inst.storage_url);
      const buffer = await downloadFromR2(folder, key);
      datasets.push({
        buffer,
        sopClassUid: inst.sop_class_uid,
        sopInstanceUid: inst.sop_instance_uid,
      });
      completed++;
    } catch (err) {
      console.error(`[C-GET SCP] Failed to download ${inst.sop_instance_uid}:`, err);
      failed++;
    }

    onPending(completed, instances.length - completed - failed, failed);
  }

  console.log(`[C-GET SCP] Done — completed: ${completed}, failed: ${failed}`);
  return { success: true, completed, failed, datasets };
};