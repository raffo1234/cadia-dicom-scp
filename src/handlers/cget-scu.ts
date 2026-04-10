import { Client, requests, responses, constants, Dataset } from "dcmjs-dimse";
import { handleCStore } from "./cstore";
import { registerPendingMove, clearPendingMove } from "../lib/pendingMoves";
import { completeStudiesForAssociation } from "../lib/studyCompletion";

const { CGetRequest } = requests;
const { CGetResponse, CStoreResponse } = responses;
const { Status } = constants;

type CGetResponseInstance = InstanceType<typeof CGetResponse>;

interface CGetOptions {
  host: string;
  port: number;
  callingAeTitle: string;
  calledAeTitle: string;
  studyInstanceUID: string;
  hospitalId: string;
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
      hospitalId,
      queryLevel = "STUDY",
      seriesInstanceUID,
      sopInstanceUID,
    } = opts;

    const result: CGetResult = { completed: 0, failed: 0 };

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

    // Register DLQ_GRAU as a known source so handleCStore can resolve the hospital
    registerPendingMove(calledAeTitle, hospitalId);

    request.on("response", async (response: CGetResponseInstance) => {
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

        await completeStudiesForAssociation([studyInstanceUID], hospitalId);

        clearPendingMove(calledAeTitle);
        resolve(result);
      } else {
        clearPendingMove(calledAeTitle);
        reject(new Error(`C-GET failed with status: 0x${status.toString(16).toUpperCase()}`));
      }
    });

    const client = new Client();

    client.on("networkError", (err: Error) => {
      clearPendingMove(calledAeTitle);
      reject(new Error(`[C-GET SCU] Network error: ${err.message}`));
    });

    // Handle incoming C-STORE sub-operations sent by DLQ_GRAU during C-GET
    (client as any).on(
      "cStoreRequest",
      async (storeRequest: any, storeCallback: (response: any) => void) => {
        const storeDataset = storeRequest.getDataset();
        const storeResult = await handleCStore(calledAeTitle, callingAeTitle, host, storeDataset);
        const storeResponse = CStoreResponse.fromRequest(storeRequest);
        storeResponse.setStatus(storeResult.success ? Status.Success : Status.ProcessingFailure);
        storeCallback(storeResponse);
      },
    );

    client.addRequest(request);
    client.send(host, port, callingAeTitle, calledAeTitle);
  });
};
