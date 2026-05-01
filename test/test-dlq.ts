import { Client, requests } from "dcmjs-dimse";

const { CFindRequest } = requests;

const CALLING_AE = "RADIANT";
const CALLED_AE = "DLQ_GRAU";
const HOST = "170.0.83.100";
const PORT = 2104;

async function findStudies() {
  return new Promise<void>((resolve, reject) => {
    const client = new Client();

    const request = CFindRequest.createStudyFindRequest({
      PatientName: "",
      PatientID: "",
      StudyDate: "",
      StudyTime: "",
      StudyDescription: "",
      StudyInstanceUID: "",
      AccessionNumber: "",
      NumberOfStudyRelatedInstances: "",
      ModalitiesInStudy: "",
      QueryRetrieveLevel: "STUDY",
    });

    const responses: unknown[] = [];

    request.on("response", (response: any) => {
      const status = response.getStatus();
      console.log(`[response] status=0x${status.toString(16).toUpperCase()}`);
      const rDataset = response.getDataset();
      if (rDataset) {
        console.log("  →", JSON.stringify(rDataset)); // dump crudo
      }
    });

    client.on("associationAccepted", () => {
      console.log("✅ Asociación aceptada por DLQ_GRAU");
    });

    client.on("associationRejected", (rejection: any) => {
      console.error("❌ Asociación RECHAZADA:", JSON.stringify(rejection));
      reject(new Error("Association rejected"));
    });

    client.on("closed", () => {
      console.log(`\nTotal estudios encontrados: ${responses.length}`);
      resolve();
    });

    client.on("error", (err: Error) => {
      console.error("❌ Error:", err.message);
      reject(err);
    });

    console.log(`Conectando → ${HOST}:${PORT} | ${CALLING_AE} → ${CALLED_AE}`);
    client.addRequest(request);
    client.send(HOST, PORT, CALLING_AE, CALLED_AE);
  });
}

findStudies()
  .then(() => {
    console.log("Done");
  })
  .catch((err) => {
    console.error(err);
  });
