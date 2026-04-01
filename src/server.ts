import 'dotenv/config';
import {
  Server,
  Scp,
  responses,
  constants,
} from "dcmjs-dimse";
import { hospitalRegistry } from "./lib/hospitalRegistry";
import { handleCEcho } from "./handlers/cecho";
import { handleCStore } from "./handlers/cstore";

const { CEchoResponse, CStoreResponse } = responses;
const {
  Status,
  PresentationContextResult,
  TransferSyntax,
  SopClass,
  StorageClass,
} = constants;

const SCP_PORT = parseInt(process.env.SCP_PORT ?? "104", 10);
const AE_TITLE = process.env.SCP_AE_TITLE ?? "CADIA";

class CadiaScp extends Scp {
  private remoteAddress: string = "";
  private association: any = undefined;

  constructor(socket: any, opts: any) {
    super(socket, opts);
    this.remoteAddress = socket.remoteAddress ?? "unknown";
  }

  associationRequested(association: any): void {
    this.association = association;

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

      // Accept Verification (C-ECHO) and all storage classes
      const isVerification = abstractSyntax === SopClass.Verification;
      const isStorage = Object.values(StorageClass).includes(abstractSyntax);

      if (isVerification || isStorage) {
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

  associationReleaseRequested(): void {
    this.sendAssociationReleaseResponse();
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

    const response = CStoreResponse.fromRequest(request);
    response.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
    callback(response);
  }
}

const start = async (): Promise<void> => {
  console.log("[SCP] Starting Cadia DICOM SCP...");

  await hospitalRegistry.init();

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