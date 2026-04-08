import 'dotenv/config';
import {
  Server,
  Scp,
  responses,
  constants,
  Dataset,
} from "dcmjs-dimse";
import { hospitalRegistry } from "./lib/hospitalRegistry";
import { handleCEcho } from "./handlers/cecho";
import { handleCStore } from "./handlers/cstore";
import { handleCFind } from "./handlers/cfind";
import { handleCMove } from "./handlers/cmove";
import { completeStudiesForAssociation, startCompletionWatchdog } from "./lib/studyCompletion";
import { startHttpServer } from "./http";

const { CEchoResponse, CStoreResponse, CFindResponse, CMoveResponse } = responses;
const {
  Status,
  PresentationContextResult,
  TransferSyntax,
  SopClass,
  StorageClass,
} = constants;

type CFindResponseInstance = InstanceType<typeof CFindResponse>;
type CMoveResponseInstance = InstanceType<typeof CMoveResponse>;

const SCP_PORT = parseInt(process.env.SCP_PORT ?? "104", 10);
const AE_TITLE = process.env.SCP_AE_TITLE ?? "CADIA.PE";

class CadiaScp extends Scp {
  private remoteAddress: string = "";
  private association: any = undefined;
  // Track study UIDs and hospital received during this association
  private receivedStudyUIDs: Set<string> = new Set();
  private hospitalId: string = "";

  constructor(socket: any, opts: any) {
    super(socket, opts);
    this.remoteAddress = socket.remoteAddress ?? "unknown";
  }

  associationRequested(association: any): void {
    this.association = association;
    this.receivedStudyUIDs = new Set();
    this.hospitalId = "";

    const callingAeTitle = association.getCallingAeTitle().trim();
    const calledAeTitle = association.getCalledAeTitle().trim();

    console.log(
      `[Association] ${callingAeTitle} → ${calledAeTitle} from ${this.remoteAddress}`,
    );

    const contexts = association.getPresentationContexts();
    contexts.forEach((c: any) => {
      const context = association.getPresentationContext(c.id);
      const abstractSyntax = context.getAbstractSyntaxUid();
      const transferSyntaxes = context.getTransferSyntaxUids();

      const isVerification = abstractSyntax === SopClass.Verification;
      const isStorage = Object.values(StorageClass).includes(abstractSyntax);
      const isQueryRetrieve =
        abstractSyntax === SopClass.StudyRootQueryRetrieveInformationModelFind ||
        abstractSyntax === SopClass.StudyRootQueryRetrieveInformationModelMove;

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
    });

    this.sendAssociationAccept();
  }

  // Modality finished sending — mark all received studies as complete
  async associationReleaseRequested(): Promise<void> {
    this.sendAssociationReleaseResponse();

    if (this.receivedStudyUIDs.size > 0 && this.hospitalId) {
      await completeStudiesForAssociation(
        Array.from(this.receivedStudyUIDs),
        this.hospitalId,
      );
    }
  }

  async cEchoRequest(request: any, callback: (response: any) => void): Promise<void> {
    const callingAeTitle = this.association?.getCallingAeTitle?.()?.trim() ?? "";
    const calledAeTitle = this.association?.getCalledAeTitle?.()?.trim() ?? "";

    const result = await handleCEcho(callingAeTitle, calledAeTitle, this.remoteAddress);

    const response = CEchoResponse.fromRequest(request);
    response.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
    callback(response);
  }

  async cStoreRequest(request: any, callback: (response: any) => void): Promise<void> {
    const callingAeTitle = this.association?.getCallingAeTitle?.()?.trim() ?? "";
    const calledAeTitle = this.association?.getCalledAeTitle?.()?.trim() ?? "";
    const dataset = request.getDataset();

    const result = await handleCStore(
      callingAeTitle,
      calledAeTitle,
      this.remoteAddress,
      dataset,
    );

    // Track study UIDs received in this association for completion on release
    if (result.success && result.studyInstanceUID && result.hospitalId) {
      this.receivedStudyUIDs.add(result.studyInstanceUID);
      this.hospitalId = result.hospitalId;
    }

    const response = CStoreResponse.fromRequest(request);
    response.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
    callback(response);
  }

  async cFindRequest(
    request: any,
    callback: (responses: CFindResponseInstance[]) => void,
  ): Promise<void> {
    const callingAeTitle = this.association?.getCallingAeTitle?.()?.trim() ?? "";
    const calledAeTitle = this.association?.getCalledAeTitle?.()?.trim() ?? "";
    const dataset = request.getDataset();

    const queryLevel = (dataset?.QueryRetrieveLevel ?? "STUDY").trim().toUpperCase();

    const result = await handleCFind(
      callingAeTitle,
      calledAeTitle,
      this.remoteAddress,
      dataset,
      queryLevel as "STUDY" | "SERIES" | "IMAGE",
    );

    const pendingResponses: CFindResponseInstance[] = [];

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
  }

  async cMoveRequest(
    request: any,
    callback: (responses: CMoveResponseInstance[]) => void,
  ): Promise<void> {
    
    const callingAeTitle = this.association?.getCallingAeTitle?.()?.trim() ?? "";
    const calledAeTitle = this.association?.getCalledAeTitle?.()?.trim() ?? "";
    const dataset = request.getDataset()?.getElements() ?? {};
    const queryLevel = (dataset?.QueryRetrieveLevel ?? "STUDY").trim().toUpperCase() as
      | "STUDY"
      | "SERIES"
      | "IMAGE";

    

    const pendingResponses: CMoveResponseInstance[] = [];

    const result = await handleCMove(
      callingAeTitle,
      calledAeTitle,
      this.remoteAddress,
      dataset,
      queryLevel,
      (completed, remaining, failed) => {
        const pending = CMoveResponse.fromRequest(request);
        pending.setStatus(Status.Pending);
        pending.setCompleted(completed);
        pending.setRemaining(remaining);
        pending.setFailures(failed);
        pendingResponses.push(pending);
      },
    );

    const final = CMoveResponse.fromRequest(request);
    final.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
    final.setCompleted(result.completed);
    final.setRemaining(0);
    final.setFailures(result.failed);
    pendingResponses.push(final);

    callback(pendingResponses);
  }
}

const start = async (): Promise<void> => {
  console.log("[SCP] Starting Cadia DICOM SCP...");

  await hospitalRegistry.init();
  startCompletionWatchdog();
  startHttpServer();
  
  const server = new Server(CadiaScp);
  server.on("networkError", (e: any) => {
    console.error("[SCP] Network error:", e);
  });

  server.listen(SCP_PORT);
  console.log(`[SCP] Listening on port ${SCP_PORT} | AE Title: ${AE_TITLE}`);
};

start().catch((err) => {
  console.error("[SCP] Fatal startup error:", err);
  process.exit(1);
});