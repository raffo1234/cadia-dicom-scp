import { Client, requests, responses, constants, Dataset } from "dcmjs-dimse";

const { CMoveRequest } = requests;
const { CMoveResponse } = responses;
const { Status } = constants;

type CMoveResponseInstance = InstanceType<typeof CMoveResponse>;

interface CMoveOptions {
  host: string;
  port: number;
  callingAeTitle: string;
  calledAeTitle: string;
  moveDestination: string;
  studyInstanceUID: string;
  queryLevel?: "STUDY" | "SERIES" | "IMAGE";
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
}

interface CMoveResult {
  completed: number;
  failed: number;
  warning: number;
}

export const moveRemoteStudy = (opts: CMoveOptions): Promise<CMoveResult> => {
  return new Promise((resolve, reject) => {
    const {
      host,
      port,
      callingAeTitle,
      calledAeTitle,
      moveDestination,
      studyInstanceUID,
      queryLevel = "STUDY",
      seriesInstanceUID,
      sopInstanceUID,
    } = opts;

    const result: CMoveResult = { completed: 0, failed: 0, warning: 0 };

    const dataset: Record<string, any> = {
      QueryRetrieveLevel: queryLevel,
      StudyInstanceUID: studyInstanceUID,
    };

    if (queryLevel === "SERIES" && seriesInstanceUID) {
      dataset.SeriesInstanceUID = seriesInstanceUID;
    }
    if (queryLevel === "IMAGE" && sopInstanceUID) {
      dataset.SOPInstanceUID = sopInstanceUID;
    }

    const request = new CMoveRequest();
    request.setDataset(new Dataset(dataset));

    // dcmjs-dimse lee el MoveDestination del command dataset
    // se setea via el campo interno del request
    (request as any).getCommandDataset().setElement("MoveDestination", moveDestination);

    request.on("response", (response: CMoveResponseInstance) => {
      const status = response.getStatus();

      if (status === Status.Pending) {
        const completed = (response as any).getCompleted?.() ?? 0;
        const remaining = (response as any).getRemaining?.() ?? 0;
        const failed = (response as any).getFailures?.() ?? 0;
        console.log(
          `[C-MOVE SCU] Progress — completed: ${completed}, remaining: ${remaining}, failed: ${failed}`,
        );
      } else if (status === Status.Success) {
        result.completed = (response as any).getCompleted?.() ?? 0;
        result.failed = (response as any).getFailures?.() ?? 0;
        result.warning = (response as any).getWarnings?.() ?? 0;
        if (result.failed > 0) {
          console.warn(
            `[C-MOVE SCU] Done with partial failures — completed: ${result.completed}, failed: ${result.failed}`,
          );
        } else {
          console.log(
            `[C-MOVE SCU] Done — completed: ${result.completed}, failed: ${result.failed}`,
          );
        }
        resolve(result);
      } else {
        reject(new Error(`C-MOVE failed with status: 0x${status.toString(16).toUpperCase()}`));
      }
    });

    const client = new Client();

    client.on("networkError", (err: Error) => {
      reject(new Error(`[C-MOVE SCU] Network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(host, port, callingAeTitle, calledAeTitle);
  });
};