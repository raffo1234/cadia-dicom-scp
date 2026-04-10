import { Client, requests, responses, constants, Dataset } from "dcmjs-dimse";
import { handleCStore } from "./cstore";
import { registerPendingMove, clearPendingMove } from "../lib/pendingMoves";
import { completeStudiesForAssociation } from "../lib/studyCompletion";

const { CGetRequest } = requests;
const { CStoreResponse } = responses;
const { Status } = constants;

type CGetResponseType = InstanceType<typeof responses.CGetResponse>;
type CStoreRequestType = InstanceType<typeof requests.CStoreRequest>;
type CStoreResponseType = InstanceType<typeof responses.CStoreResponse>;

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
  maxRetries?: number;
}

interface CGetResult {
  completed: number;
  failed: number;
}

interface RetryableError extends Error {
  retryable: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

const attempt = (opts: CGetOptions): Promise<CGetResult> => {
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

    let request: InstanceType<typeof CGetRequest>;

    if (queryLevel === "STUDY") {
      request = CGetRequest.createStudyGetRequest(studyInstanceUID);
    } else if (queryLevel === "SERIES" && seriesInstanceUID) {
      request = CGetRequest.createSeriesGetRequest(studyInstanceUID, seriesInstanceUID);
    } else if (queryLevel === "IMAGE" && sopInstanceUID && seriesInstanceUID) {
      request = CGetRequest.createImageGetRequest(
        studyInstanceUID,
        seriesInstanceUID,
        sopInstanceUID,
      );
    } else {
      request = new CGetRequest();
      request.setDataset(
        new Dataset({ QueryRetrieveLevel: queryLevel, StudyInstanceUID: studyInstanceUID }),
      );
    }

    registerPendingMove(calledAeTitle, hospitalId);

    request.on("response", async (response: CGetResponseType) => {
      const status = response.getStatus();

      if (status === Status.Pending) {
        console.log(
          `[C-GET SCU] Progress — completed: ${response.getCompleted()}, remaining: ${response.getRemaining()}, failed: ${response.getFailures()}`,
        );
      } else if (status === Status.Success) {
        result.completed = response.getCompleted();
        result.failed = response.getFailures();
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
      const error: RetryableError = Object.assign(
        new Error(`[C-GET SCU] Network error: ${err.message}`),
        { retryable: true },
      );
      reject(error);
    });

    client.on(
      "cStoreRequest",
      async (
        storeRequest: CStoreRequestType,
        storeCallback: (response: CStoreResponseType) => void,
      ) => {
        const storeDataset = storeRequest.getDataset();
        if (!storeDataset) {
          const failed = CStoreResponse.fromRequest(storeRequest);
          failed.setStatus(Status.ProcessingFailure);
          storeCallback(failed);
          return;
        }
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

export const getRemoteStudy = async (opts: CGetOptions): Promise<CGetResult> => {
  const maxRetries = opts.maxRetries ?? 5;
  let lastError: Error | undefined;

  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) {
      const delayMs = Math.pow(2, i) * 1000; // 2s, 4s, 8s, 16s, 32s
      console.log(`[C-GET SCU] Retry ${i}/${maxRetries} in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }

    try {
      return await attempt(opts);
    } catch (err: unknown) {
      if (!(err instanceof Error)) {
        throw err;
      }
      lastError = err;
      if (!(err as RetryableError).retryable) {
        throw err;
      }
      console.warn(`[C-GET SCU] Attempt ${i + 1} failed: ${err.message}`);
    }
  }

  throw lastError ?? new Error("[C-GET SCU] All retries exhausted");
};
