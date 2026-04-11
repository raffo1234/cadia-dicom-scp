require("dotenv").config();
const { getRemoteStudy } = require("./dist/handlers/cget-scu");

getRemoteStudy({
  host: "170.0.83.100",
  port: 2104,
  callingAeTitle: "CADIA.PE",
  calledAeTitle: "DLQ_GRAU",
  studyInstanceUID: "1.2.840.113619.2.25.4.2411377.1767973000.235",
  queryLevel: "STUDY",
})
  .then((r) => console.log("✅ Completado:", r))
  .catch((e) => console.error("❌ Error:", e.message));
