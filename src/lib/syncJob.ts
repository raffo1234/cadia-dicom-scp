import { Client, requests, responses, constants } from "dcmjs-dimse";
import { supabase } from "./supabase";
import { getRemoteStudy } from "../handlers/cget-scu";

const { CFindRequest } = requests;
const { Status } = constants;

type CFindResponseType = InstanceType<typeof responses.CFindResponse>;

interface AeRoute {
  ae_title: string;
  host: string;
  port: number;
  hospital_id: string;
}

interface RemoteStudy {
  studyInstanceUID: string;
}

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // every hour
const SYNC_DAYS_BACK = 7;

const toDicomDate = (date: Date): string => date.toISOString().slice(0, 10).replace(/-/g, "");

const cfindStudies = (
  route: AeRoute,
  callingAeTitle: string,
  dateRange: string,
): Promise<RemoteStudy[]> => {
  return new Promise((resolve, reject) => {
    const results: RemoteStudy[] = [];

    const request = CFindRequest.createStudyFindRequest({
      QueryRetrieveLevel: "STUDY",
      StudyInstanceUID: "",
      StudyDate: dateRange,
    });

    request.on("response", (response: CFindResponseType) => {
      const status = response.getStatus();

      if (status === Status.Pending) {
        const ds = response.getDataset();
        if (!ds) return;
        const elements = ds.getElements() as Record<string, unknown>;
        const uid =
          typeof elements.StudyInstanceUID === "string" ? elements.StudyInstanceUID : undefined;
        if (uid) {
          results.push({ studyInstanceUID: uid });
        }
      } else if (status === Status.Success) {
        resolve(results);
      } else {
        reject(new Error(`C-FIND failed with status: 0x${status.toString(16).toUpperCase()}`));
      }
    });

    const client = new Client();
    client.on("networkError", (err: Error) => {
      reject(new Error(`C-FIND network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(route.host, route.port, callingAeTitle, route.ae_title);
  });
};

const getLocalStudyUIDs = async (hospitalId: string): Promise<Set<string>> => {
  const { data, error } = await supabase
    .from("dicom_study")
    .select("study_instance_uid")
    .eq("hospital_id", hospitalId)
    .eq("receive_status", "complete");

  if (error) {
    throw new Error(`Supabase query failed: ${error.message}`);
  }

  return new Set((data ?? []).map((r) => r.study_instance_uid));
};

const syncHospital = async (route: AeRoute, localAeTitle: string): Promise<void> => {
  const label = `[SyncJob][${route.ae_title}]`;

  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - SYNC_DAYS_BACK);
  const dateRange = `${toDicomDate(from)}-${toDicomDate(today)}`;

  console.log(`${label} C-FIND for studies from ${dateRange}...`);

  let remoteStudies: RemoteStudy[];
  try {
    remoteStudies = await cfindStudies(route, localAeTitle, dateRange);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label} C-FIND failed: ${msg}`);
    return;
  }

  console.log(`${label} Found ${remoteStudies.length} remote studies`);

  let localUIDs: Set<string>;
  try {
    localUIDs = await getLocalStudyUIDs(route.hospital_id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label} Failed to query local studies: ${msg}`);
    return;
  }

  const missing = remoteStudies.filter((s) => !localUIDs.has(s.studyInstanceUID));
  console.log(`${label} ${missing.length} missing locally — pulling...`);

  for (const study of missing) {
    try {
      const result = await getRemoteStudy({
        host: route.host,
        port: route.port,
        callingAeTitle: localAeTitle,
        calledAeTitle: route.ae_title,
        studyInstanceUID: study.studyInstanceUID,
        hospitalId: route.hospital_id,
      });
      console.log(
        `${label} Pulled ${study.studyInstanceUID} — completed: ${result.completed}, failed: ${result.failed}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${label} Failed to pull ${study.studyInstanceUID}: ${msg}`);
    }
  }

  console.log(`${label} Sync complete`);
};

const runSync = async (): Promise<void> => {
  console.log("[SyncJob] Starting sync run...");

  const localAeTitle = process.env.SCP_AE_TITLE ?? "CADIA.PE";

  const { data: routes, error: routeErr } = await supabase
    .from("ae_route")
    .select("ae_title, host, port, hospital_id")
    .eq("is_active", true);

  if (routeErr) {
    console.error("[SyncJob] Failed to load ae_routes:", routeErr.message);
    return;
  }

  for (const route of routes ?? []) {
    await syncHospital(route as AeRoute, localAeTitle);
  }

  console.log("[SyncJob] Run complete");
};

export const startSyncJob = (): void => {
  void runSync().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[SyncJob] Unhandled error:", msg);
  });

  setInterval(() => {
    void runSync().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[SyncJob] Unhandled error:", msg);
    });
  }, SYNC_INTERVAL_MS);

  console.log(`[SyncJob] Started — runs every ${SYNC_INTERVAL_MS / 60_000} min`);
};