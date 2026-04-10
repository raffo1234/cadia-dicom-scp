import { Client, requests, responses, constants } from "dcmjs-dimse";
import { getRemoteStudy } from "./src/handlers/cget-scu";

const { CFindRequest } = requests;
const { Status } = constants;

type CFindResponseType = InstanceType<typeof responses.CFindResponse>;

const HOSPITAL_ID = "155c0ec0-1f17-4ace-aeb6-e279f9e8e9c1";
const CALLED_AE = "DLQ_GRAU";
const CALLING_AE = "CADIA.PE";
const HOST = "170.0.83.100";
const PORT = 2104;

const cfindLatest = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    const results: Array<{ uid: string; date: string; time: string }> = [];

    // Filtra solo estudios de hoy
    const today = new Date();
    const studyDate = today.toISOString().slice(0, 10).replace(/-/g, ""); // "20260410"

    const request = CFindRequest.createStudyFindRequest({
      QueryRetrieveLevel: "STUDY",
      StudyInstanceUID: "",
      StudyDate: studyDate, // 👈 filtra por fecha de hoy
      StudyTime: "",
      PatientName: "",
      PatientID: "",
      StudyDescription: "",
      Modality: "",
      NumberOfStudyRelatedInstances: "", // útil para debug
    });

    request.on("response", (response: CFindResponseType) => {
      const status = response.getStatus();

      if (status === Status.Pending) {
        const ds = response.getDataset();
        if (!ds) return;
        const elements = ds.getElements() as Record<string, unknown>;
        const uid =
          typeof elements.StudyInstanceUID === "string" ? elements.StudyInstanceUID : undefined;
        const date = typeof elements.StudyDate === "string" ? elements.StudyDate : "";
        const time = typeof elements.StudyTime === "string" ? elements.StudyTime : "";

        if (uid) results.push({ uid, date, time });
      } else if (status === Status.Success) {
        if (results.length === 0) {
          reject(new Error("No studies found on PACS for today"));
          return;
        }

        // Ordena descendente y toma el primero
        results.sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`));

        const latest = results[0];
        console.log(`\nLatest study on PACS:`);
        console.log(`  UID:  ${latest.uid}`);
        console.log(`  Date: ${latest.date}`);
        console.log(`  Time: ${latest.time}`);
        console.log(`  Total studies today: ${results.length}`);

        resolve(latest.uid);
      } else {
        reject(new Error(`C-FIND failed: 0x${status.toString(16).toUpperCase()}`));
      }
    });

    const client = new Client();
    client.on("networkError", (err: Error) => {
      reject(new Error(`C-FIND network error: ${err.message}`));
    });

    client.addRequest(request);
    client.send(HOST, PORT, CALLING_AE, CALLED_AE);
  });
};

const run = async () => {
  console.log("Running C-FIND to get latest study from DLQ_GRAU...");
  const studyInstanceUID = await cfindLatest();

  console.log("\nStarting C-GET...");
  const result = await getRemoteStudy({
    host: HOST,
    port: PORT,
    callingAeTitle: CALLING_AE,
    calledAeTitle: CALLED_AE,
    studyInstanceUID,
    hospitalId: HOSPITAL_ID,
  });

  console.log(`\nDone — completed: ${result.completed}, failed: ${result.failed}`);
};

run().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
