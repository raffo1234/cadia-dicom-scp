import * as http from "http";
import { Client, requests, responses, constants, Dataset } from "dcmjs-dimse";

const { CFindRequest, CStoreRequest } = requests;
const { CFindResponse, CStoreResponse } = responses;
const { Status, TransferSyntax } = constants;

const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? "3001", 10);
const SCP_AE_TITLE = process.env.SCP_AE_TITLE ?? "CADIA-GRAU";

// ─── C-FIND SCU ───────────────────────────────────────────────────────────────

const executeCFind = (
  host: string,
  port: number,
  calledAeTitle: string,
  filters: Record<string, string>,
): Promise<Record<string, any>[]> => {
  return new Promise((resolve, reject) => {
    const results: Record<string, any>[] = [];

    const client = new Client();

    const request = CFindRequest.createStudyFindRequest({
      PatientName: filters.patientName ?? "",
      PatientID: filters.patientId ?? "",
      StudyDate: filters.studyDate ?? "",
      Modality: filters.modality ?? "",
      StudyDescription: filters.studyDescription ?? "",
      StudyInstanceUID: filters.studyInstanceUID ?? "",
    });

    request.on("response", (response: InstanceType<typeof CFindResponse>) => {
      if (
        response.getStatus() === Status.Pending &&
        response.hasDataset()
      ) {
        const ds = response.getDataset();
        if (ds) {
          const elements = ds.getElements();
          results.push({
            StudyInstanceUID: elements.StudyInstanceUID ?? "",
            PatientName: extractPatientName(elements.PatientName),
            PatientID: elements.PatientID ?? "",
            PatientAge: elements.PatientAge ?? "",
            PatientSex: elements.PatientSex ?? "",
            StudyDate: elements.StudyDate ?? "",
            StudyDescription: elements.StudyDescription ?? "",
            Modality: elements.Modality ?? "",
            NumberOfStudyRelatedInstances: String(
              elements.NumberOfStudyRelatedInstances ?? "",
            ),
          });
        }
      }
    });

    client.on("networkError", (err: Error) => {
      reject(new Error(`C-FIND network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(host, port, SCP_AE_TITLE, calledAeTitle);

    // Resolve after 30s max
    const timeout = setTimeout(() => {
      resolve(results);
    }, 30_000);

    request.on("response", (response: InstanceType<typeof CFindResponse>) => {
      if (response.getStatus() === Status.Success) {
        clearTimeout(timeout);
        resolve(results);
      }
    });
  });
};

// ─── C-MOVE SCU (pull) ────────────────────────────────────────────────────────

const executeCMove = (
  host: string,
  port: number,
  calledAeTitle: string,
  moveDestination: string,
  studyInstanceUID: string,
): Promise<{ completed: number; failed: number }> => {
  return new Promise((resolve, reject) => {
    const client = new Client();

    const request = requests.CMoveRequest.createStudyMoveRequest(
      moveDestination,
      studyInstanceUID,
    );

    let completed = 0;
    let failed = 0;

    request.on("response", (response: any) => {
      completed = response.getCompleted() ?? completed;
      failed = response.getFailures() ?? failed;

      if (response.getStatus() === Status.Success) {
        resolve({ completed, failed });
      } else if (
        response.getStatus() !== Status.Pending
      ) {
        reject(new Error(`C-MOVE failed with status: ${response.getStatus()}`));
      }
    });

    client.on("networkError", (err: Error) => {
      reject(new Error(`C-MOVE network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(host, port, SCP_AE_TITLE, calledAeTitle);

    setTimeout(() => {
      resolve({ completed, failed });
    }, 120_000);
  });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const extractPatientName = (val: any): string => {
  if (!val) return "";
  if (typeof val === "string") return val.trim();
  if (val.Alphabetic) return String(val.Alphabetic).trim();
  if (Array.isArray(val) && val[0]?.Alphabetic) return String(val[0].Alphabetic).trim();
  return String(val).trim();
};

const parseBody = (req: http.IncomingMessage): Promise<any> => {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
};

const send = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
};

// ─── HTTP Server ──────────────────────────────────────────────────────────────

export const startHttpServer = (): void => {
  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" });
      res.end();
      return;
    }

    const url = req.url ?? "";

    // ── GET /health ───────────────────────────────────────────────────────────
    if (req.method === "GET" && url === "/health") {
      send(res, 200, { status: "ok", port: HTTP_PORT });
      return;
    }

    // ── POST /find ────────────────────────────────────────────────────────────
    // Body: { host, port, aeTitle, filters: { patientName, patientId, studyDate, modality } }
    if (req.method === "POST" && url === "/find") {
      try {
        const body = await parseBody(req);
        const { host, port, aeTitle, filters = {} } = body;

        if (!host || !port || !aeTitle) {
          send(res, 400, { error: "host, port and aeTitle are required" });
          return;
        }

        console.log(`[HTTP] C-FIND → ${aeTitle} @ ${host}:${port}`);
        const results = await executeCFind(host, port, aeTitle, filters);
        console.log(`[HTTP] C-FIND returned ${results.length} result(s)`);
        send(res, 200, { results });
      } catch (err: any) {
        console.error("[HTTP] /find error:", err.message);
        send(res, 500, { error: err.message });
      }
      return;
    }

    // ── POST /move ────────────────────────────────────────────────────────────
    // Body: { host, port, aeTitle, moveDestination, studyInstanceUID }
    // moveDestination = our SCP AE title so the PACS sends files back to us
    if (req.method === "POST" && url === "/move") {
      try {
        const body = await parseBody(req);
        const { host, port, aeTitle, studyInstanceUID } = body;

        if (!host || !port || !aeTitle || !studyInstanceUID) {
          send(res, 400, { error: "host, port, aeTitle and studyInstanceUID are required" });
          return;
        }

        // moveDestination = our own AE title so the PACS sends the files back to us
        const moveDestination = SCP_AE_TITLE;

        console.log(
          `[HTTP] C-MOVE → ${aeTitle} @ ${host}:${port} | Study: ${studyInstanceUID} → ${moveDestination}`,
        );

        const result = await executeCMove(host, port, aeTitle, moveDestination, studyInstanceUID);
        console.log(`[HTTP] C-MOVE done — completed: ${result.completed}, failed: ${result.failed}`);
        send(res, 200, result);
      } catch (err: any) {
        console.error("[HTTP] /move error:", err.message);
        send(res, 500, { error: err.message });
      }
      return;
    }

    send(res, 404, { error: "Not found" });
  });

  server.listen(HTTP_PORT, () => {
    console.log(`[HTTP] API listening on port ${HTTP_PORT}`);
  });
};