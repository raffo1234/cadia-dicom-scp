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

// R2 downloads to run in parallel per batch
const DOWNLOAD_CONCURRENCY = 10;

/**
 * Resolves hospital_id from an AE title checking both tables:
 * 1. hospital_access (scanners/modalidades que envían estudios)
 * 2. ae_route (Orthanc u otros PACS destino que inician C-MOVE)
 */
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

  // 1. Validar caller
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

  // 2. Resolver ruta destino
  const { data: route, error: routeError } = await supabase
    .from("ae_route")
    .select("host, port, ae_title")
    .eq("hospital_id", caller.hospital_id)
    .eq("ae_title", moveDestination)
    .eq("is_active", true)
    .maybeSingle();

  if (routeError || !route) {
    console.warn(`[C-MOVE] Unknown move destination AE: ${moveDestination}`);
    clearPendingMove(callingAeTitle);
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

  // 3. Audit log (fire-and-forget)
  supabase.from("dicom_audit_log").insert({
    hospital_id: caller.hospital_id,
    action: "c-move",
    ae_title: callingAeTitle,
    ip_address: remoteAddress,
  });

  // 4. Find instances to move
  const instances = await resolveInstances(caller.hospital_id, query, queryLevel);
  if (instances.length === 0) {
    console.log(`[C-MOVE] No instances found for query`);
    clearPendingMove(callingAeTitle);
    return { success: true, completed: 0, failed: 0 };
  }

  console.log(`[C-MOVE] Found ${instances.length} instance(s) — downloading in parallel (concurrency: ${DOWNLOAD_CONCURRENCY})`);

  // 5. Download all instances from R2 in parallel chunks
  const tempFiles: string[] = [];
  let downloadFailed = 0;

  for (let i = 0; i < instances.length; i += DOWNLOAD_CONCURRENCY) {
    const chunk = instances.slice(i, i + DOWNLOAD_CONCURRENCY);

    const results = await Promise.allSettled(
      chunk.map(async (inst) => {
        const buffer = await downloadFromR2(caller.r2_bucket, storageUrlToKey(inst.storage_url));
        const tempPath = path.join(os.tmpdir(), `cadia-cmove-${inst.sop_instance_uid}.dcm`);
        fs.writeFileSync(tempPath, buffer);
        return tempPath;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        tempFiles.push(result.value);
      } else {
        console.error(`[C-MOVE] Failed to download instance:`, result.reason);
        downloadFailed++;
      }
    }
  }

  console.log(`[C-MOVE] Downloaded ${tempFiles.length} files (${downloadFailed} failed) — sending via single association`);

  // 6. Send all files over a single DICOM association.
  // Previously opened one connection per file (N TCP handshakes + N DICOM negotiations).
  // Now: one association for all files — dramatically faster for large studies.
  const MY_AE = process.env.SCP_AE_TITLE ?? "CADIA.PE";
  const { completed, failed: sendFailed } = await sendCStoreBatch(
    tempFiles,
    route.host,
    route.port,
    MY_AE,
    route.ae_title,
    (done, remaining, f) => onPending(done, remaining, f + downloadFailed),
  );

  const failed = downloadFailed + sendFailed;

  // 7. Cleanup temp files
  for (const f of tempFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }

  clearPendingMove(callingAeTitle);

  console.log(`[C-MOVE] Done — completed: ${completed}, failed: ${failed}`);
  return { success: true, completed, failed };
};

/**
 * Sends all files over a single DICOM association.
 * One TCP connection + one DICOM negotiation for the entire study,
 * vs the previous approach of one connection per file.
 */
const sendCStoreBatch = (
  filePaths: string[],
  host: string,
  port: number,
  callingAeTitle: string,
  calledAeTitle: string,
  onProgress: (completed: number, remaining: number, failed: number) => void,
): Promise<{ completed: number; failed: number }> => {
  return new Promise((resolve) => {
    const client = new Client();
    let completed = 0;
    let failed = 0;

    for (const filePath of filePaths) {
      const request = new CStoreRequest(filePath);

      request.on("response", (response: InstanceType<typeof CStoreResponse>) => {
        const status = response.getStatus();
        if (status === Status.Success) {
          completed++;
        } else {
          console.warn(`[C-MOVE] C-STORE response status: 0x${status.toString(16).toUpperCase()}`);
          failed++;
        }
        onProgress(completed, filePaths.length - completed - failed, failed);
      });

      client.addRequest(request);
    }

    client.on("networkError", (err: Error) => {
      console.error(`[C-MOVE] Network error sending to ${calledAeTitle}:`, err.message);
      resolve({ completed, failed: filePaths.length - completed });
    });

    // "associationReleased" fires on the Client after all requests are processed
    // and the association release handshake completes. This is the correct signal
    // that all C-STORE sub-operations are done (NOT "done", which fires on the
    // internal connection object — never on the Client directly).
    client.on("associationReleased", () => {
      resolve({ completed, failed });
    });

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
