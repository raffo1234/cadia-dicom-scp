import { supabase } from "./src/lib/supabase";
import { getRemoteStudy } from "./src/handlers/cget-scu";

const HOSPITAL_ID = "155c0ec0-1f17-4ace-aeb6-e279f9e8e9c1";
const CALLED_AE = "DLQ_GRAU";
const CALLING_AE = "CADIA.PE";
const HOST = "170.0.83.100";
const PORT = 2104;

const run = async () => {
  const { data, error } = await supabase
    .from("dicom_study")
    .select("study_instance_uid, patient_name, study_date, modality, receive_status")
    .eq("hospital_id", HOSPITAL_ID)
    .order("received_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    console.error("Failed to fetch latest study:", error?.message);
    process.exit(1);
  }

  console.log("Latest study found:");
  console.log(`  UID:      ${data.study_instance_uid}`);
  console.log(`  Patient:  ${data.patient_name}`);
  console.log(`  Date:     ${data.study_date}`);
  console.log(`  Modality: ${data.modality}`);
  console.log(`  Status:   ${data.receive_status}`);
  console.log("\nStarting C-GET...");

  const result = await getRemoteStudy({
    host: HOST,
    port: PORT,
    callingAeTitle: CALLING_AE,
    calledAeTitle: CALLED_AE,
    studyInstanceUID: data.study_instance_uid,
    hospitalId: HOSPITAL_ID,
  });

  console.log(`\nDone — completed: ${result.completed}, failed: ${result.failed}`);
};

run().catch((err) => {
  console.error("Unhandled error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
