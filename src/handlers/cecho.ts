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
  const hospital = await hospitalRegistry.findByAeTitle(callingAeTitle);

  if (!hospital) {
    console.warn(
      `[C-ECHO] Rejected unknown AE title: ${callingAeTitle} from ${remoteAddress}`,
    );
    return { success: false, reason: "Unknown or inactive AE title" };
  }

  // IP allowlist check (consistente con cstore)
  if (hospital.allowed_ip && remoteAddress !== hospital.allowed_ip) {
    console.warn(`[C-ECHO] Rejected IP ${remoteAddress} for ${callingAeTitle}`);
    return { success: false, reason: "IP not allowed" };
  }

  console.log(
    `[C-ECHO] ${callingAeTitle} → ${calledAeTitle} (${hospital.hospital.name}) from ${remoteAddress}`,
  );

  // Audit log
  await supabase.from("dicom_audit_log").insert({
    hospital_id: hospital.hospital_id,
    action: "c-echo",
    ae_title: callingAeTitle,
    ip_address: remoteAddress,
  });

  return { success: true };
};