import { Client, requests, responses, constants, Dataset } from "dcmjs-dimse";

const { CGetRequest } = requests;
const { CGetResponse } = responses;
const { Status } = constants;

type CGetResponseInstance = InstanceType<typeof CGetResponse>;

interface CGetOptions {
  host: string;
  port: number;
  callingAeTitle: string;
  calledAeTitle: string;
  studyInstanceUID: string;
  queryLevel?: "STUDY" | "SERIES" | "IMAGE";
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
}

interface CGetResult {
  completed: number;
  failed: number;
}

export const getRemoteStudy = (opts: CGetOptions): Promise<CGetResult> => {
  return new Promise((resolve, reject) => {
    const {
      host,
      port,
      callingAeTitle,
      calledAeTitle,
      studyInstanceUID,
      queryLevel = "STUDY",
      seriesInstanceUID,
      sopInstanceUID,
    } = opts;

    const result: CGetResult = { completed: 0, failed: 0 };

    // Build identifier dataset
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

    // Use static factory method from the source
    let request: InstanceType<typeof CGetRequest>;

    if (queryLevel === "STUDY") {
      request = (CGetRequest as any).createStudyGetRequest(studyInstanceUID);
    } else if (queryLevel === "SERIES" && seriesInstanceUID) {
      request = (CGetRequest as any).createSeriesGetRequest(studyInstanceUID, seriesInstanceUID);
    } else if (queryLevel === "IMAGE" && sopInstanceUID && seriesInstanceUID) {
      request = (CGetRequest as any).createImageGetRequest(
        studyInstanceUID,
        seriesInstanceUID,
        sopInstanceUID,
      );
    } else {
      request = new CGetRequest();
      request.setDataset(new Dataset(dataset));
    }

    request.on("response", (response: CGetResponseInstance) => {
      const status = response.getStatus();

      if (status === Status.Pending) {
        const completed = (response as any).getCompleted?.() ?? 0;
        const remaining = (response as any).getRemaining?.() ?? 0;
        const failed = (response as any).getFailures?.() ?? 0;
        console.log(
          `[C-GET SCU] Progress — completed: ${completed}, remaining: ${remaining}, failed: ${failed}`,
        );
      } else if (status === Status.Success) {
        result.completed = (response as any).getCompleted?.() ?? 0;
        result.failed = (response as any).getFailures?.() ?? 0;
        console.log(`[C-GET SCU] Done — completed: ${result.completed}, failed: ${result.failed}`);
        resolve(result);
      } else {
        reject(new Error(`C-GET failed with status: 0x${status.toString(16).toUpperCase()}`));
      }
    });

    const client = new Client();

    client.on("networkError", (err: Error) => {
      reject(new Error(`[C-GET SCU] Network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(host, port, callingAeTitle, calledAeTitle);
  });
};
