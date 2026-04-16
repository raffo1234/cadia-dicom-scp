import { Client, requests, responses, constants, Dataset } from "dcmjs-dimse";

const { CFindRequest } = requests;
const { CFindResponse } = responses;
const { Status } = constants;

type CFindResponseInstance = InstanceType<typeof CFindResponse>;

interface CFindOptions {
  host: string;
  port: number;
  callingAeTitle: string;
  calledAeTitle: string;
  queryLevel?: "STUDY" | "SERIES" | "IMAGE";
  query?: Record<string, any>;
}

export const fetchRemoteStudies = (opts: CFindOptions): Promise<Record<string, any>[]> => {
  return new Promise((resolve, reject) => {
    const { host, port, callingAeTitle, calledAeTitle, queryLevel = "STUDY", query = {} } = opts;

    const results: Record<string, any>[] = [];

    const request = new CFindRequest();
    request.setDataset(
      new Dataset({
        QueryRetrieveLevel: queryLevel,
        PatientName: "",
        PatientID: "",
        StudyInstanceUID: "",
        StudyDate: "",
        StudyDescription: "",
        Modality: "",
        NumberOfStudyRelatedInstances: "",
        ...query,
      }),
    );

    request.on("response", (response: CFindResponseInstance) => {
      const status = response.getStatus();

      if (status === Status.Pending) {
        const dataset = response.getDataset();
        if (dataset) {
          results.push(dataset.getElements());
        }
      } else if (status === Status.Success) {
        console.log(`[C-FIND SCU] Done — ${results.length} result(s)`);
        resolve(results);
      } else {
        reject(new Error(`C-FIND failed with status: 0x${status.toString(16).toUpperCase()}`));
      }
    });

    const client = new Client();

    client.on("networkError", (err: Error) => {
      reject(new Error(`[C-FIND SCU] Network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(host, port, callingAeTitle, calledAeTitle);
  });
}
