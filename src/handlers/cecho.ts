import { hospitalRegistry } from "../lib/hospitalRegistry";
import { supabase } from "../lib/supabase";

/**
 * C-ECHO — the DICOM "ping"
 * Called when a modality or PACS tests connectivity.
 * We validate the calling AE title and log the event.
 */
export const handleCEcho = async (
  callingAeTitle: string,
  calledAeTitle: string,
  remoteAddress: string,
): Promise<{ success: boolean; reason?: string }> => {
  // Validate the called AE title is one of ours
  const hospital = await hospitalRegistry.findByAeTitle(calledAeTitle);

  if (!hospital) {
    console.warn(
      `[C-ECHO] Rejected unknown AE title: ${calledAeTitle} from ${remoteAddress}`,
    );
    return { success: false, reason: "Unknown or inactive AE title" };
  }

  console.log(
    `[C-ECHO] ${callingAeTitle} → ${calledAeTitle} (${hospital.name}) from ${remoteAddress}`,
  );

  // Audit log
  await supabase.from("dicom_audit_log").insert({
    hospital_id: hospital.id,
    action: "c-echo",
    ae_title: callingAeTitle,
    ip_address: remoteAddress,
  });

  return { success: true };
};