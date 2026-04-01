import {
  Server,
  Scp,
  responses,
  constants,
  Dataset,
} from "dcmjs-dimse";
import 'dotenv/config';

const { CEchoResponse, CStoreResponse } = responses;
const { Status } = constants;
import { hospitalRegistry } from "./lib/hospitalRegistry";
import { handleCEcho } from "./handlers/cecho";
import { handleCStore } from "./handlers/cstore";

const SCP_PORT = parseInt(process.env.SCP_PORT ?? "104", 10);
const AE_TITLE = process.env.SCP_AE_TITLE ?? "CADIA";

class CadiaScp extends Scp {
  private remoteAddress: string = "";

  constructor(socket: any, opts: any) {
    super(socket, opts);
    this.remoteAddress = socket.remoteAddress ?? "unknown";
  }

  // Called when association is requested — validate AE titles here
  associationRequested(association: any): void {
    const callingAeTitle = association.getCallingAeTitle().trim();
    const calledAeTitle = association.getCalledAeTitle().trim();

    console.log(
      `[Association] ${callingAeTitle} → ${calledAeTitle} from ${this.remoteAddress}`,
    );

    // Accept association — handlers will reject per-operation if AE title is invalid
    this.sendAssociationAccept();
  }

  associationReleaseRequested(): void {
    this.sendAssociationReleaseResponse();
  }

  // C-ECHO — connectivity test
  async cEchoRequest(request: any, callback: (response: any) => void): Promise<void> {
    const callingAeTitle = request.getCallingAeTitle?.()?.trim() ?? "";
    const calledAeTitle = request.getCalledAeTitle?.()?.trim() ?? "";

    const result = await handleCEcho(callingAeTitle, calledAeTitle, this.remoteAddress);

    const response = CEchoResponse.fromRequest(request);
    response.setStatus(result.success ? Status.Success : Status.ProcessingFailure);
    callback(response);
  }

  // C-STORE — receive DICOM file
  async cStoreRequest(request: any, callback: (response: any) => void): Promise<void> {
    const callingAeTitle = request.getCallingAeTitle?.()?.trim() ?? "";
    const calledAeTitle = request.getCalledAeTitle?.()?.trim() ?? "";

    const dataset: Dataset = request.getDataset();

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

  // Load hospitals from Supabase before accepting connections
  await hospitalRegistry.init();

  const server = new Server(CadiaScp);

  server.listen(SCP_PORT);
  console.log(`[SCP] Listening on port ${SCP_PORT} | AE Title: ${AE_TITLE}`);
};

start().catch((err) => {
  console.error("[SCP] Fatal startup error:", err);
  process.exit(1);
});