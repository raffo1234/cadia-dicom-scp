import { setDefaultResultOrder } from "dns";
setDefaultResultOrder("ipv4first");

import dcmjs from 'dcmjs';
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
import { startHttpServer } from "./http";

const { CEchoResponse, CStoreResponse, CFindResponse, CMoveResponse, CGetResponse } = responses;
const { CEchoRequest, CStoreRequest, CFindRequest, CMoveRequest, CGetRequest } = requests;
const { Status, PresentationContextResult, TransferSyntax, SopClass, StorageClass } = constants;

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

class CadiaScp extends Scp {
  private remoteAddress: string = "";
  private currentAssociation: AssociationType | undefined = undefined;
  private receivedStudyUIDs: Set<string> = new Set();
  private hospitalId: string = "";

  constructor(socket: Socket, opts: Record<string, unknown>) {
    super(socket, opts);
    this.remoteAddress = socket.remoteAddress ?? "unknown";
  }

  associationRequested(assoc: AssociationType): void {
    this.currentAssociation = assoc;
    this.receivedStudyUIDs = new Set();
    this.hospitalId = "";

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

    if (this.receivedStudyUIDs.size > 0 && this.hospitalId) {
      void completeStudiesForAssociation(Array.from(this.receivedStudyUIDs), this.hospitalId).catch(
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[SCP] Failed to complete studies on release:", msg);
        },
      );
    }
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

    void handleCStore(callingAeTitle, calledAeTitle, this.remoteAddress, dataset)
      .then((result) => {
        if (result.success && result.studyInstanceUID && result.hospitalId) {
          this.receivedStudyUIDs.add(result.studyInstanceUID);
          this.hospitalId = result.hospitalId;
        }
        const response = CStoreResponse.fromRequest(request);
        response.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
        callback(response);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SCP] cStoreRequest error:", msg);
      });
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

        // ── DEBUG: descubrir API real de dcmjs-dimse ──────────────────────
        console.log('[DEBUG] association proto methods:',
          Object.getOwnPropertyNames(Object.getPrototypeOf(association as any)));

        const probeDataset = new Dataset({});
        const probeStore = new CStoreRequest(probeDataset);
        console.log('[DEBUG] CStoreRequest proto methods:',
          Object.getOwnPropertyNames(Object.getPrototypeOf(probeStore)));

        console.log('[DEBUG] this (Scp) proto methods:',
          Object.getOwnPropertyNames(Object.getPrototypeOf(this)));
        // ─────────────────────────────────────────────────────────────────

        for (const item of result.buffers) {
          try {
            const arrayBuffer = item.buffer.buffer.slice(
              item.buffer.byteOffset,
              item.buffer.byteOffset + item.buffer.byteLength
            ) as ArrayBuffer;

            const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
            const dataset = new Dataset(dicomData.dict);

            dataset.setElement("SOPClassUID", item.sopClassUid);
            dataset.setElement("SOPInstanceUID", item.sopInstanceUid);

            const dict = dicomData.dict as Record<string, { Value?: unknown[] }>;
            const transferSyntaxUid =
              (dict["00020010"]?.Value?.[0] as string) ||
              TransferSyntax.ExplicitVRLittleEndian;
            dataset.setElement("TransferSyntaxUID", transferSyntaxUid);

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

  await hospitalRegistry.init();
  startCompletionWatchdog();
  startHttpServer();

  const server = new Server(CadiaScp);
  server.on("networkError", (err: Error) => {
    console.error("[SCP] Network error:", err.message);
  });

  server.listen(SCP_PORT);
  console.log(`[SCP] Listening on port ${SCP_PORT} | AE Title: ${AE_TITLE}`);
};

start().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[SCP] Fatal startup error:", msg);
  process.exit(1);
});
