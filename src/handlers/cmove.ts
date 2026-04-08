import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client, requests, responses, constants } from "dcmjs-dimse";
import { supabase } from "../lib/supabase";
import { downloadFromR2 } from "../lib/r2";
import { registerPendingMove, clearPendingMove } from "../lib/pendingMoves";

const { CStoreRequest } = requests;
const { CStoreResponse } = responses;
const { Status } = constants;

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

/**
 * Resolves hospital_id from an AE title checking both tables:
 * 1. hospital_access (scanners/modalidades que envían estudios)
 * 2. ae_route (Orthanc u otros PACS destino que inician C-MOVE)
 */
const resolveCallerFromAeTitle = async (aeTitle: string): Promise<ResolvedCaller | null> => {
  // Buscar en hospital_access primero
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

  // Si no está, buscar en ae_route (ej: ORTHANC)
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

/**
 * C-MOVE — retrieves studies/series/instances and sends them to a destination AE
 */
export const handleCMove = async (
  callingAeTitle: string,
  calledAeTitle: string,
  remoteAddress: string,
  query: Record<string, any>,
  queryLevel: "STUDY" | "SERIES" | "IMAGE",
  onPending: (completed: number, remaining: number, failed: number) => void,
): Promise<{ success: boolean; completed: number; failed: number; reason?: string }> => {
  const moveDestination = process.env.SCP_AE_TITLE ?? "CADIA.PE";
  

  if (!moveDestination) {
    return { success: false, completed: 0, failed: 0, reason: "SCP_AE_TITLE not configured" };
  }

  // 1. Validar caller — busca en hospital_access y ae_route
  const caller = await resolveCallerFromAeTitle(callingAeTitle);
  if (!caller) {
    console.warn(`[C-MOVE] Rejected unknown AE title: ${callingAeTitle}`);
    return { success: false, completed: 0, failed: 0, reason: "Unknown or inactive AE title" };
  }
  
  if (caller.allowed_ip && remoteAddress !== caller.allowed_ip) {
    console.warn(`[C-MOVE] Rejected IP ${remoteAddress} for ${callingAeTitle}`);
    return { success: false, completed: 0, failed: 0, reason: "IP not allowed" };
  }

  registerPendingMove(callingAeTitle, caller.hospital_id);

  // 2. Resolver ruta destino filtrando por hospital_id Y ae_title
  const { data: route, error: routeError } = await supabase
    .from("ae_route")
    .select("host, port, ae_title")
    .eq("hospital_id", caller.hospital_id)
    .eq("ae_title", moveDestination)
    .eq("is_active", true)
    .maybeSingle();

  if (routeError || !route) {
    console.warn(`[C-MOVE] Unknown move destination AE: ${moveDestination}`);
    return {
      success: false,
      completed: 0,
      failed: 0,
      reason: `Unknown move destination: ${moveDestination}`,
    };
  }

  console.log(
    `[C-MOVE] ${callingAeTitle} → ${calledAeTitle} | Dest: ${moveDestination} (${route.host}:${route.port}) | Level: ${queryLevel}`,
  );

  // 3. Audit log
  await supabase.from("dicom_audit_log").insert({
    hospital_id: caller.hospital_id,
    action: "c-move",
    ae_title: callingAeTitle,
    ip_address: remoteAddress,
  });

  // 4. Find instances to move
  const instances = await resolveInstances(caller.hospital_id, query, queryLevel);
  if (instances.length === 0) {
    console.log(`[C-MOVE] No instances found for query`);
    return { success: true, completed: 0, failed: 0 };
  }

  console.log(`[C-MOVE] Found ${instances.length} instance(s) to forward`);

  // 5. Send each instance to destination via C-STORE
  let completed = 0;
  let failed = 0;
  const tempFiles: string[] = [];

  for (const inst of instances) {
    let tempPath: string | null = null;
    try {
      const buffer = await downloadFromR2(
        caller.r2_bucket,
        storageUrlToKey(inst.storage_url),
      );

      tempPath = path.join(os.tmpdir(), `cadia-cmove-${inst.sop_instance_uid}.dcm`);
      fs.writeFileSync(tempPath, buffer);
      tempFiles.push(tempPath);

      const MY_AE = process.env.SCP_AE_TITLE ?? "CADIA.PE";
      const sent = await sendCStore(tempPath, route.host, route.port, MY_AE, route.ae_title);
      
      if (sent) { completed++; } else { failed++; }
    } catch (err) {
      console.error(`[C-MOVE] Failed to forward ${inst.sop_instance_uid}:`, err);
      failed++;
    }

    onPending(completed, instances.length - completed - failed, failed);
  }

  // 6. Cleanup temp files
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }

  clearPendingMove(callingAeTitle);

  console.log(`[C-MOVE] Done — completed: ${completed}, failed: ${failed}`);
  return { success: true, completed, failed };
};

// ... sendCStore y resolveInstances sin cambios

/**
 * Sends a single DICOM file to a destination via C-STORE
 */
const sendCStore = (
  filePath: string,
  host: string,
  port: number,
  callingAeTitle: string,
  calledAeTitle: string,
): Promise<boolean> => {
  return new Promise((resolve) => {
    const client = new Client();
    const request = new CStoreRequest(filePath);

    request.on("response", (response: InstanceType<typeof CStoreResponse>) => {
      const status = response.getStatus();
      console.log(`[C-STORE→] Status: 0x${status.toString(16).toUpperCase()} to ${calledAeTitle}@${host}:${port}`);
      if (status === Status.Success) {
        resolve(true);
      } else {
        console.warn(`[C-MOVE] C-STORE response status: ${status}`);
        resolve(false);
      }
    });

    client.on("networkError", (err: Error) => {
      console.error(`[C-MOVE] Network error sending to ${calledAeTitle}:`, err.message);
      resolve(false);
    });

    client.addRequest(request);
    client.send(host, port, callingAeTitle, calledAeTitle);
  });
};

/**
 * Resolves which instances to move based on query level and filters
 */
const resolveInstances = async (
  hospitalId: string,
  query: Record<string, any>,
  queryLevel: "STUDY" | "SERIES" | "IMAGE",
): Promise<DicomInstance[]> => {
  let studyUids: string[] = [];

  if (queryLevel === "STUDY" && query.StudyInstanceUID) {
    studyUids = [query.StudyInstanceUID];
  } else if (queryLevel === "SERIES" && query.StudyInstanceUID) {
    studyUids = [query.StudyInstanceUID];
  } else if (queryLevel === "IMAGE" && query.StudyInstanceUID) {
    studyUids = [query.StudyInstanceUID];
  }

  if (studyUids.length === 0) return [];
  
  const { data: studies, error } = await supabase
    .from("dicom_study")
    .select("instances")
    .in("study_instance_uid", studyUids)
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

/**
 * Extracts the R2 object key from a full storage URL
 * e.g. "https://storage.cadia.cc/dicom/..." → "dicom/..."
 */
const storageUrlToKey = (storageUrl: string): string => {
  const domain = process.env.STORAGE_DOMAIN?.replace(/\/$/, "") ?? "";
  return storageUrl.replace(`${domain}/`, "");
};