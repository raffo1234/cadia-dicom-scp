import * as http from "http";
import { Client, requests, responses, constants } from "dcmjs-dimse";
import { registerPendingMove } from "./lib/pendingMoves";
import { getRemoteStudy } from "./handlers/cget-scu";
import { Zip, ZipPassThrough } from "fflate";
import { downloadFromR2 } from "./lib/r2";
import { supabase } from "./lib/supabase";

const { CFindRequest } = requests;
const { CFindResponse, CMoveResponse } = responses;
const { Status } = constants;

const DOWNLOAD_CONCURRENCY = 50;

const storageUrlToFolderAndKey = (storageUrl: string): { folder: string; key: string } => {
  const idx = storageUrl.indexOf("/");
  if (idx === -1) return { folder: storageUrl, key: "" };
  return { folder: storageUrl.slice(0, idx), key: storageUrl.slice(idx + 1) };
};

type CFindResponseType = InstanceType<typeof CFindResponse>;
type CMoveResponseType = InstanceType<typeof CMoveResponse>;

const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "3001", 10);
const SCP_AE_TITLE = process.env.SCP_AE_TITLE ?? "CADIA.PE";

// ─── C-FIND SCU ───────────────────────────────────────────────────────────────

const executeCFind = (
  host: string,
  port: number,
  calledAeTitle: string,
  filters: Record<string, string>,
): Promise<Record<string, unknown>[]> => {
  return new Promise((resolve, reject) => {
    const results: Record<string, unknown>[] = [];
    const client = new Client();

    const request = CFindRequest.createStudyFindRequest({
      PatientName: filters.patientName ?? "",
      PatientID: filters.patientId ?? "",
      StudyDate: filters.studyDate ?? "",
      StudyTime: "",
      Modality: filters.modality ?? "",
      StudyDescription: filters.studyDescription ?? "",
      StudyInstanceUID: filters.studyInstanceUID ?? "",
      NumberOfStudyRelatedInstances: "",
    });

    request.on("response", (response: CFindResponseType) => {
      const status = response.getStatus();
      console.log(`[C-FIND] Response status: 0x${status.toString(16).toUpperCase()}`);
      console.log(`[C-FIND] Has dataset: ${response.hasDataset()}`);

      if (status === Status.Pending && response.hasDataset()) {
        const ds = response.getDataset();
        if (ds) {
          const elements = ds.getElements();
          console.log(`[C-FIND] Elements:`, JSON.stringify(elements).slice(0, 200));
          results.push({
            StudyInstanceUID: elements.StudyInstanceUID ?? "",
            PatientName: extractPatientName(elements.PatientName),
            PatientID: elements.PatientID ?? "",
            PatientAge: elements.PatientAge ?? "",
            PatientSex: elements.PatientSex ?? "",
            StudyDate: elements.StudyDate ?? "",
            StudyDescription: elements.StudyDescription ?? "",
            Modality: elements.Modality ?? "",
            NumberOfStudyRelatedInstances: String(elements.NumberOfStudyRelatedInstances ?? ""),
          });
        }
      }

      if (status === Status.Success) {
        console.log(`[C-FIND] Done — ${results.length} result(s)`);
        resolve(results);
      }
    });

    client.on("networkError", (err: Error) => {
      reject(new Error(`C-FIND network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(host, port, SCP_AE_TITLE, calledAeTitle);

    setTimeout(() => {
      console.log(`[C-FIND] Timeout — ${results.length} result(s)`);
      resolve(results);
    }, 60_000);
  });
};

// ─── C-MOVE SCU ───────────────────────────────────────────────────────────────

const executeCMove = (
  host: string,
  port: number,
  calledAeTitle: string,
  studyInstanceUID: string,
): Promise<{ completed: number; failed: number }> => {
  return new Promise((resolve, reject) => {
    const client = new Client();

    const request = requests.CMoveRequest.createStudyMoveRequest(SCP_AE_TITLE, studyInstanceUID);

    let completed = 0;
    let failed = 0;

    request.on("response", (response: CMoveResponseType) => {
      completed = response.getCompleted() ?? completed;
      failed = response.getFailures() ?? failed;

      const status = response.getStatus();
      if (status === Status.Success) {
        resolve({ completed, failed });
      } else if (status !== Status.Pending) {
        reject(new Error(`C-MOVE failed with status: ${status}`));
      }
    });

    client.on("networkError", (err: Error) => {
      reject(new Error(`C-MOVE network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(host, port, SCP_AE_TITLE, calledAeTitle);

    setTimeout(() => resolve({ completed, failed }), 120_000);
  });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const extractPatientName = (val: unknown): string => {
  if (!val) return "";
  if (typeof val === "string") return val.trim();
  if (typeof val === "object" && val !== null) {
    if ("Alphabetic" in val) return String((val as Record<string, unknown>).Alphabetic).trim();
    if (Array.isArray(val) && val[0]?.Alphabetic) return String(val[0].Alphabetic).trim();
  }
  return String(val).trim();
};

const parseBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          reject(new Error("Invalid JSON: expected an object"));
        } else {
          resolve(parsed as Record<string, unknown>);
        }
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
};

const send = (res: http.ServerResponse, status: number, data: unknown): void => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
};

const getString = (val: unknown): string | undefined => (typeof val === "string" ? val : undefined);

const getNumber = (val: unknown): number | undefined =>
  typeof val === "number" ? val : typeof val === "string" ? parseInt(val, 10) : undefined;

// ─── Request Handler ──────────────────────────────────────────────────────────

const handleRequest = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  const url = req.url ?? "";

  // ── GET /download ────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.startsWith("/download")) {
    const urlObj = new URL(url, "http://localhost");
    const studyInstanceUID = urlObj.searchParams.get("studyInstanceUID");
    const hospitalId = urlObj.searchParams.get("hospitalId");

    if (!studyInstanceUID || !hospitalId) {
      send(res, 400, { error: "studyInstanceUID and hospitalId are required" });
      return;
    }

    const { data: study } = await supabase
      .from("dicom_study")
      .select("patient_name, study_date, instances")
      .eq("study_instance_uid", studyInstanceUID)
      .eq("hospital_id", hospitalId)
      .maybeSingle();

    if (!study || !study.instances?.length) {
      send(res, 404, { error: "Study not found or has no instances" });
      return;
    }

    const instances = study.instances as { sop_instance_uid: string; storage_url: string }[];
    const safePatientName = (study.patient_name ?? "study").replace(/[^a-zA-Z0-9_ -]/g, "_");
    const safeDate = (study.study_date ?? "").replace(/\D/g, "");
    const fileName = `${safePatientName}_${safeDate}.zip`;

    console.log(`[HTTP] /download — ${instances.length} instances | study: ${studyInstanceUID}`);

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });

    let destroyed = false;
    const zipStream = new Zip((err, chunk, final) => {
      if (err) {
        console.error("[HTTP] ZIP stream error:", err.message);
        destroyed = true;
        res.destroy();
        return;
      }
      res.write(chunk);
      if (final) res.end();
    });

    let index = 0;
    let completed = 0;
    let failed = 0;

    const worker = async () => {
      while (index < instances.length && !destroyed) {
        const i = index++;
        const inst = instances[i];
        try {
          const { folder, key } = storageUrlToFolderAndKey(inst.storage_url);
          const buffer = await downloadFromR2(folder, key);
          const file = new ZipPassThrough(`${studyInstanceUID}/${inst.sop_instance_uid}.dcm`);
          zipStream.add(file);
          file.push(new Uint8Array(buffer), true);
          completed++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[HTTP] Download failed for ${inst.sop_instance_uid}: ${msg}`);
          failed++;
        }
      }
    };

    await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, worker));
    console.log(`[HTTP] /download done — completed: ${completed}, failed: ${failed}`);
    if (!destroyed) zipStream.end();
    return;
  }

  // ── GET /health ──────────────────────────────────────────────────────────────
  if (req.method === "GET" && url === "/health") {
    send(res, 200, { status: "ok", port: HTTP_PORT });
    return;
  }

  // ── GET /healthz — deep health check (verifica conectividad a Supabase) ──────
  if (req.method === "GET" && url === "/healthz") {
    try {
      const { error } = await supabase.from("hospital").select("id").limit(1);
      if (error) throw new Error(error.message);
      send(res, 200, { status: "ok" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[HTTP] /healthz failed:", msg);
      send(res, 503, { status: "unhealthy", error: msg });
    }
    return;
  }

  // ── POST /find ───────────────────────────────────────────────────────────────
  if (req.method === "POST" && url === "/find") {
    try {
      const body = await parseBody(req);
      const host = getString(body.host);
      const port = getNumber(body.port);
      const aeTitle = getString(body.aeTitle);
      const filters = (body.filters ?? {}) as Record<string, string>;

      if (!host || !port || !aeTitle) {
        send(res, 400, { error: "host, port and aeTitle are required" });
        return;
      }

      console.log(`[HTTP] C-FIND → ${aeTitle} @ ${host}:${port}`);
      const results = await executeCFind(host, port, aeTitle, filters);
      console.log(`[HTTP] C-FIND returned ${results.length} result(s)`);
      send(res, 200, { results });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[HTTP] /find error:", message);
      send(res, 500, { error: message });
    }
    return;
  }

  // ── POST /move ───────────────────────────────────────────────────────────────
  if (req.method === "POST" && url === "/move") {
    try {
      const body = await parseBody(req);
      const host = getString(body.host);
      const port = getNumber(body.port);
      const aeTitle = getString(body.aeTitle);
      const studyInstanceUID = getString(body.studyInstanceUID);
      const hospitalId = getString(body.hospitalId);

      if (!host || !port || !aeTitle || !studyInstanceUID) {
        send(res, 400, { error: "host, port, aeTitle and studyInstanceUID are required" });
        return;
      }

      if (hospitalId) {
        registerPendingMove(aeTitle, hospitalId);
      }

      console.log(
        `[HTTP] C-MOVE → ${aeTitle} @ ${host}:${port} | Study: ${studyInstanceUID} → ${SCP_AE_TITLE}`,
      );

      const result = await executeCMove(host, port, aeTitle, studyInstanceUID);
      console.log(`[HTTP] C-MOVE done — completed: ${result.completed}, failed: ${result.failed}`);
      send(res, 200, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[HTTP] /move error:", message);
      send(res, 500, { error: message });
    }
    return;
  }

  // ── POST /get ─────────────────────────────────────────────────────────────────
  if (req.method === "POST" && url === "/get") {
    try {
      const body = await parseBody(req);
      const host = getString(body.host);
      const port = getNumber(body.port);
      const aeTitle = getString(body.aeTitle);
      const studyInstanceUID = getString(body.studyInstanceUID);
      const hospitalId = getString(body.hospitalId);
      const queryLevel = getString(body.queryLevel) as "STUDY" | "SERIES" | "IMAGE" | undefined;
      const seriesInstanceUID = getString(body.seriesInstanceUID);
      const sopInstanceUID = getString(body.sopInstanceUID);

      if (!host || !port || !aeTitle || !studyInstanceUID || !hospitalId) {
        send(res, 400, {
          error: "host, port, aeTitle, studyInstanceUID and hospitalId are required",
        });
        return;
      }

      console.log(`[HTTP] C-GET → ${aeTitle} @ ${host}:${port} | Study: ${studyInstanceUID}`);

      const result = await getRemoteStudy({
        host,
        port,
        callingAeTitle: SCP_AE_TITLE,
        calledAeTitle: aeTitle,
        studyInstanceUID,
        hospitalId,
        queryLevel,
        seriesInstanceUID,
        sopInstanceUID,
      });

      console.log(`[HTTP] C-GET done — completed: ${result.completed}, failed: ${result.failed}`);
      send(res, 200, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[HTTP] /get error:", message);
      send(res, 500, { error: message });
    }
    return;
  }

  send(res, 404, { error: "Not found" });
};

// ─── HTTP Server ──────────────────────────────────────────────────────────────

export const startHttpServer = (): void => {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error("[HTTP] Unhandled error:", message);
    });
  });

  server.listen(HTTP_PORT, () => {
    console.log(`[HTTP] API listening on port ${HTTP_PORT}`);
  });
};
