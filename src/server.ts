import { setDefaultResultOrder } from "dns";
setDefaultResultOrder("ipv4first");

import "dotenv/config";
import type { Socket } from "net";
import { Server, Scp, requests, responses, constants, Dataset, association } from "dcmjs-dimse";
import { hospitalRegistry } from "./lib/hospitalRegistry";
import { handleCEcho } from "./handlers/cecho";
import { handleCStore } from "./handlers/cstore";
import { handleCFind } from "./handlers/cfind";
import { handleCMove } from "./handlers/cmove";
import { handleCGetScp } from "./handlers/cget-scp";
import { completeStudiesForAssociation, startCompletionWatchdog } from "./lib/studyCompletion";
import { startHttpServer, getActiveDownloadsCount } from "./http";

// ponytail: dcmjs logs one console.warn per unrecognized private tag during
// denaturalizeDataset (cstore.ts). Modalities like GE MRI carry dozens of private
// tags per image, and synchronous stdout writes (non-TTY, as in a container) block
// the event loop on every one — this was silently throttling C-STORE ingestion.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("dcmjs").log.setLevel("error");

const { CEchoResponse, CStoreResponse, CFindResponse, CMoveResponse, CGetResponse } = responses;
const { CEchoRequest, CStoreRequest, CFindRequest, CMoveRequest, CGetRequest } = requests;
const { Status, PresentationContextResult, TransferSyntax, SopClass, StorageClass, RejectResult, RejectSource, RejectReason } =
  constants;

type AssociationType = InstanceType<typeof association.Association>;

type CEchoRequestType = InstanceType<typeof CEchoRequest>;
type CStoreRequestType = InstanceType<typeof CStoreRequest>;
type CFindRequestType = InstanceType<typeof CFindRequest>;
type CMoveRequestType = InstanceType<typeof CMoveRequest>;
type CGetRequestType = InstanceType<typeof CGetRequest>;

type CEchoResponseType = InstanceType<typeof CEchoResponse>;
type CStoreResponseType = InstanceType<typeof CStoreResponse>;
type CFindResponseType = InstanceType<typeof CFindResponse>;
type CMoveResponseType = InstanceType<typeof CMoveResponse>;
type CGetResponseType = InstanceType<typeof CGetResponse>;

type QueryLevel = "STUDY" | "SERIES" | "IMAGE";

const SCP_PORT = parseInt(process.env.SCP_PORT ?? "104", 10);
const AE_TITLE = process.env.SCP_AE_TITLE ?? "CADIA.PE";

const toQueryLevel = (raw: unknown): QueryLevel => {
  const s = String(raw ?? "STUDY")
    .trim()
    .toUpperCase();
  if (s === "SERIES" || s === "IMAGE") return s;
  return "STUDY";
};

function stripP10Header(buffer: Buffer): Buffer {
  // Verifica magic DICM en offset 128
  if (buffer.slice(128, 132).toString('ascii') !== 'DICM') {
    return buffer; // No es P10, retorna tal cual
  }
  // FileMetaInformationGroupLength está en offset 140 (4 bytes LE)
  const metaLength = buffer.readUInt32LE(140);
  const datasetStart = 144 + metaLength;
  return buffer.slice(datasetStart);
}

// Tracks every open DICOM connection so a graceful shutdown can wait for them
// to finish instead of cutting an in-progress study transfer (see shutdown()).
// NOTE: dcmjs-dimse's own Server.close() forcibly destroys every connected
// client socket — the opposite of graceful — so shutdown must never call it.
// Instead it flips acceptingAssociations, and associationRequested() below
// rejects (A-ASSOCIATE-RJ, transient) any association that arrives after that.
const activeSockets = new Set<Socket>();
let acceptingAssociations = true;

class CadiaScp extends Scp {
  private remoteAddress: string = "";
  private currentAssociation: AssociationType | undefined = undefined;
  private receivedStudyUIDs: Set<string> = new Set();
  private hospitalId: string = "";
  private pendingUpserts: Set<Promise<unknown>> = new Set();
  private socket: Socket;

  constructor(socket: Socket, opts: Record<string, unknown>) {
    super(socket, opts);
    this.remoteAddress = socket.remoteAddress ?? "unknown";
    this.socket = socket;
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  }

  associationRequested(assoc: AssociationType): void {
    if (!acceptingAssociations) {
      console.log(`[SCP] Rejecting association from ${this.remoteAddress} — shutting down`);
      this.sendAssociationReject(
        RejectResult.Transient,
        RejectSource.ServiceProviderAcse,
        RejectReason.TemporaryCongestion,
      );
      this.socket.end();
      return;
    }

    this.currentAssociation = assoc;
    this.receivedStudyUIDs = new Set();
    this.hospitalId = "";
    this.pendingUpserts = new Set();

    const callingAeTitle = assoc.getCallingAeTitle().trim();
    const calledAeTitle = assoc.getCalledAeTitle().trim();

    console.log(`[Association] ${callingAeTitle} → ${calledAeTitle} from ${this.remoteAddress}`);

    const contexts = assoc.getPresentationContexts();
    contexts.forEach(
      (c: { id: number; context: InstanceType<typeof association.PresentationContext> }) => {
        const context = assoc.getPresentationContext(c.id);
        const abstractSyntax = context.getAbstractSyntaxUid();
        const transferSyntaxes = context.getTransferSyntaxUids();

        const isVerification = abstractSyntax === SopClass.Verification;
        const isStorage = Object.values(StorageClass).includes(abstractSyntax);
        const isQueryRetrieve =
          abstractSyntax === SopClass.StudyRootQueryRetrieveInformationModelFind ||
          abstractSyntax === SopClass.StudyRootQueryRetrieveInformationModelMove ||
          abstractSyntax === SopClass.StudyRootQueryRetrieveInformationModelGet;

        if (isVerification || isStorage || isQueryRetrieve) {
          let accepted = false;
          transferSyntaxes.forEach((ts: string) => {
            if (
              ts === TransferSyntax.ImplicitVRLittleEndian ||
              ts === TransferSyntax.ExplicitVRLittleEndian
            ) {
              context.setResult(PresentationContextResult.Accept, ts);
              accepted = true;
            }
          });
          if (!accepted) {
            context.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
          }
        } else {
          context.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
        }
      },
    );

    this.sendAssociationAccept();
  }

  associationReleaseRequested(): void {
    this.sendAssociationReleaseResponse();

    // Capture pending upserts immediately — before any of them finish.
    // We must NOT check receivedStudyUIDs here because with respond-immediately
    // the C-STORE handlers are still running in the background when the release
    // arrives. receivedStudyUIDs is populated inside those handlers' .then(),
    // so it would be empty at this point for fast associations (small studies).
    // Instead, wait for all pending upserts to settle first, then check.
    const pending = Array.from(this.pendingUpserts);

    void Promise.allSettled(pending)
      .then(() => {
        if (this.receivedStudyUIDs.size > 0 && this.hospitalId) {
          const studyUIDs = Array.from(this.receivedStudyUIDs);
          const hospitalId = this.hospitalId;
          return completeStudiesForAssociation(studyUIDs, hospitalId);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SCP] Failed to complete studies on release:", msg);
      });
  }

  cEchoRequest(request: CEchoRequestType, callback: (response: CEchoResponseType) => void): void {
    const callingAeTitle = this.currentAssociation?.getCallingAeTitle().trim() ?? "";
    const calledAeTitle = this.currentAssociation?.getCalledAeTitle().trim() ?? "";

    void handleCEcho(callingAeTitle, calledAeTitle, this.remoteAddress)
      .then((result) => {
        const response = CEchoResponse.fromRequest(request);
        response.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
        callback(response);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SCP] cEchoRequest error:", msg);
      });
  }

  cStoreRequest(
    request: CStoreRequestType,
    callback: (response: CStoreResponseType) => void,
  ): void {
    const callingAeTitle = this.currentAssociation?.getCallingAeTitle().trim() ?? "";
    const calledAeTitle = this.currentAssociation?.getCalledAeTitle().trim() ?? "";
    const dataset: Dataset | undefined = request.getDataset();

    if (!dataset) {
      const response = CStoreResponse.fromRequest(request);
      response.setStatus(Status.ProcessingFailure);
      callback(response);
      return;
    }

    // Respond immediately so the modality can pipeline the next instance
    // without waiting for R2 upload + DB write (~800ms/instance → sequential bottleneck).
    // R2 upload and DB upsert run in the background; pendingUpserts ensures
    // completeStudiesForAssociation only fires after all of them settle.
    const response = CStoreResponse.fromRequest(request);
    response.setStatus(Status.Success);
    callback(response);

    const upsertPromise = handleCStore(callingAeTitle, calledAeTitle, this.remoteAddress, dataset)
      .then((result) => {
        if (result.success && result.studyInstanceUID && result.hospitalId) {
          this.receivedStudyUIDs.add(result.studyInstanceUID);
          this.hospitalId = result.hospitalId;
        }
        if (!result.success) {
          console.error(`[SCP] C-STORE background processing failed: ${result.reason}`);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SCP] cStoreRequest error:", msg);
      })
      .finally(() => {
        this.pendingUpserts.delete(upsertPromise);
      });

    this.pendingUpserts.add(upsertPromise);
  }

  cFindRequest(
    request: CFindRequestType,
    callback: (responses: CFindResponseType[]) => void,
  ): void {
    const callingAeTitle = this.currentAssociation?.getCallingAeTitle().trim() ?? "";
    const calledAeTitle = this.currentAssociation?.getCalledAeTitle().trim() ?? "";
    const elements: Record<string, unknown> = request.getDataset()?.getElements() ?? {};
    const queryLevel = toQueryLevel(elements.QueryRetrieveLevel);

    void handleCFind(callingAeTitle, calledAeTitle, this.remoteAddress, elements, queryLevel)
      .then((result) => {
        const pendingResponses: CFindResponseType[] = [];

        if (result.success && result.results?.length) {
          for (const match of result.results) {
            const response = CFindResponse.fromRequest(request);
            response.setStatus(Status.Pending);
            response.setDataset(new Dataset(match));
            pendingResponses.push(response);
          }
        }

        const final = CFindResponse.fromRequest(request);
        final.setStatus(Status.Success);
        pendingResponses.push(final);
        callback(pendingResponses);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SCP] cFindRequest error:", msg);
      });
  }

  cMoveRequest(
    request: CMoveRequestType,
    callback: (responses: CMoveResponseType[]) => void,
  ): void {
    const callingAeTitle = this.currentAssociation?.getCallingAeTitle().trim() ?? "";
    const calledAeTitle = this.currentAssociation?.getCalledAeTitle().trim() ?? "";
    const elements: Record<string, unknown> = request.getDataset()?.getElements() ?? {};
    const queryLevel = toQueryLevel(elements.QueryRetrieveLevel);

    const pendingResponses: CMoveResponseType[] = [];

    void handleCMove(
      callingAeTitle,
      calledAeTitle,
      this.remoteAddress,
      elements,
      queryLevel,
      (completed, remaining, failed) => {
        const pending = CMoveResponse.fromRequest(request);
        pending.setStatus(Status.Pending);
        pending.setCompleted(completed);
        pending.setRemaining(remaining);
        pending.setFailures(failed);
        pendingResponses.push(pending);
      },
    )
      .then((result) => {
        const final = CMoveResponse.fromRequest(request);
        final.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
        final.setCompleted(result.completed);
        final.setRemaining(0);
        final.setFailures(result.failed);
        pendingResponses.push(final);
        callback(pendingResponses);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SCP] cMoveRequest error:", msg);
      });
  }

  cGetRequest(
    request: CGetRequestType,
    callback: (responses: CGetResponseType[]) => void,
  ): void {
    const callingAeTitle = this.currentAssociation?.getCallingAeTitle().trim() ?? "";
    const calledAeTitle = this.currentAssociation?.getCalledAeTitle().trim() ?? "";
    const elements: Record<string, unknown> = request.getDataset()?.getElements() ?? {};
    const queryLevel = toQueryLevel(elements.QueryRetrieveLevel);

    const association = this.currentAssociation;
    if (!association) {
      const final = CGetResponse.fromRequest(request);
      final.setStatus(Status.ProcessingFailure);
      callback([final]);
      return;
    }

    let completedSubOps = 0;
    let failedSubOps = 0;

    void handleCGetScp(
      callingAeTitle,
      calledAeTitle,
      this.remoteAddress,
      elements,
      queryLevel,
      (completed, remaining, failed) => {
        console.log(`[C-GET] Progreso R2: ${completed} completados, ${remaining} restantes`);
      },
    )
    .then(async (result) => {
      const allResponses: CGetResponseType[] = [];

      if (result.success && result.buffers.length > 0) {
        console.log(`[SCP] Procesando ${result.buffers.length} instancias en memoria...`);

        for (const item of result.buffers) {
          try {
            const dataset = new Dataset({});
            dataset.setElement("SOPClassUID", item.sopClassUid);
            dataset.setElement("SOPInstanceUID", item.sopInstanceUid);
            dataset.setTransferSyntaxUid(TransferSyntax.ExplicitVRLittleEndian);

            const datasetBytes = stripP10Header(item.buffer);

            // Bypass dcmjs-dimse serialization — envía el buffer raw de R2
            (dataset as any).getDenaturalizedDataset = () => datasetBytes;

            const storeRequest = new CStoreRequest(dataset);

            await new Promise<void>((resolve) => {
              (storeRequest as any).on('response', (storeResponse: any) => {
                const status = storeResponse.getStatus();
                if (status === Status.Success || status === 0) {
                  completedSubOps++;
                } else {
                  failedSubOps++;
                }
                resolve();
              });
              (this as any).sendRequests([storeRequest]);
            });

            const pending = CGetResponse.fromRequest(request);
            pending.setStatus(Status.Pending);
            pending.setCompleted(completedSubOps);
            pending.setRemaining(result.buffers.length - completedSubOps - failedSubOps);
            pending.setFailures(failedSubOps + result.failed);
            allResponses.push(pending);

          } catch (err) {
            console.error(`[SCP] Error procesando instancia:`, err);
            failedSubOps++;
          }
        }
      }

      const final = CGetResponse.fromRequest(request);
      final.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
      final.setCompleted(completedSubOps);
      final.setRemaining(0);
      final.setFailures(failedSubOps + result.failed);
      allResponses.push(final);

      callback(allResponses);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[SCP] cGetRequest error fatal:", msg);
      const final = CGetResponse.fromRequest(request);
      final.setStatus(Status.ProcessingFailure);
      callback([final]);
    });
  }
}

const start = async (): Promise<void> => {
  console.log("[SCP] Starting Cadia DICOM SCP...");

  // Start HTTP server first so Fly.io health checks pass immediately
  // while the rest of the initialization (DB, registry) completes.
  startHttpServer();
  await hospitalRegistry.init();
  startCompletionWatchdog();

  const server = new Server(CadiaScp);
  server.on("networkError", (err: Error) => {
    console.error("[SCP] Network error:", err.message);
  });

  server.listen(SCP_PORT);
  console.log(`[SCP] Listening on port ${SCP_PORT} | AE Title: ${AE_TITLE}`);

  const SHUTDOWN_MAX_WAIT_MS = 5 * 60 * 1000; // matches fly.toml kill_timeout (Fly's hard cap)
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(
      `[SCP] ${signal} received — refusing new associations, waiting for ${activeSockets.size} active connection(s) and ${getActiveDownloadsCount()} active download(s) to finish...`,
    );
    // Do NOT call server.close() here — dcmjs-dimse's Server.close() destroys every
    // connected client socket immediately (verified against the installed version).
    // acceptingAssociations is enough: the TCP listener stays up, but every new
    // association gets an immediate A-ASSOCIATE-RJ (see associationRequested above).
    acceptingAssociations = false;

    const deadline = Date.now() + SHUTDOWN_MAX_WAIT_MS;
    while (
      (activeSockets.size > 0 || getActiveDownloadsCount() > 0) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (activeSockets.size > 0 || getActiveDownloadsCount() > 0) {
      console.warn(
        `[SCP] Shutdown timed out with ${activeSockets.size} connection(s) and ${getActiveDownloadsCount()} download(s) still open — exiting anyway`,
      );
    } else {
      console.log("[SCP] All connections finished — shutting down cleanly");
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

start().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[SCP] Fatal startup error:", msg);
  process.exit(1);
});
