const dcmjsDimse = require("dcmjs-dimse");
const { Client, requests, constants } = dcmjsDimse;
const { Status } = constants;
const path = require("path");
const fs = require("fs");

const HOST = "137.66.1.186";
const PORT = 11112;
const CALLING_AET = "MAGNETON";
const CALLED_AET = "CADIA.PE";

const dicomPath = process.argv[2];

if (!dicomPath) {
  console.error("Usage: node send_dicom.js <path-to-dicom-file-or-folder>");
  process.exit(1);
}

function getFiles(p) {
  if (fs.statSync(p).isDirectory()) {
    return fs
      .readdirSync(p)
      .map((f) => path.join(p, f))
      .filter((f) => fs.statSync(f).isFile());
  }
  return [p];
}

const files = getFiles(dicomPath);
console.log(`Sending ${files.length} file(s) to ${HOST}:${PORT} → ${CALLED_AET}`);

const client = new Client();

files.forEach((file) => {
  const request = new requests.CStoreRequest(file);
  request.on("response", (response) => {
    if (response.getStatus() === Status.Success) {
      console.log(`✓ ${path.basename(file)}`);
    } else {
      console.error(`✗ ${path.basename(file)} — status: 0x${response.getStatus().toString(16)}`);
    }
  });
  client.addRequest(request);
});

client.on("networkError", (e) => console.error("Network error:", e));
client.send(HOST, PORT, CALLING_AET, CALLED_AET);
