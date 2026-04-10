import { supabase } from "./supabase";

/**
 * Mark all receiving studies from a specific association as complete.
 * Called when associationReleaseRequested fires — the modality finished sending.
 */
export const completeStudiesForAssociation = async (
  studyInstanceUIDs: string[],
  hospitalId: string,
): Promise<void> => {
  if (studyInstanceUIDs.length === 0) return;

  const { error } = await supabase
    .from("dicom_study")
    .update({
      receive_status: "complete",
      completed_at: new Date().toISOString(),
    })
    .in("study_instance_uid", studyInstanceUIDs)
    .eq("hospital_id", hospitalId)
    .eq("receive_status", "receiving");

  if (error) {
    console.error("[StudyCompletion] Failed to complete studies on release:", error.message);
  } else {
    console.log(
      `[StudyCompletion] Marked ${studyInstanceUIDs.length} study/studies as complete (association release)`,
    );
  }
};

/**
 * Background job — runs every 5 minutes.
 * Finds studies stuck in "receiving" for more than 10 minutes and marks them complete.
 * Catches edge cases where modality disconnects without releasing (crash, network drop).
 */
export const startCompletionWatchdog = (): void => {
  const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  const STALE_AFTER_MS = 10 * 60 * 1000; // studies older than 10 minutes

  const run = async () => {
    const staleThreshold = new Date(Date.now() - STALE_AFTER_MS).toISOString();

    const { data, error } = await supabase
      .from("dicom_study")
      .update({
        receive_status: "complete",
        completed_at: new Date().toISOString(),
      })
      .eq("receive_status", "receiving")
      .lt("received_at", staleThreshold)
      .select("id, study_instance_uid, received_instances");

    if (error) {
      console.error("[Watchdog] Failed to complete stale studies:", error.message);
      return;
    }

    if (data && data.length > 0) {
      console.log(
        `[Watchdog] Marked ${data.length} stale study/studies as complete:`,
        data.map((s) => `${s.study_instance_uid} (${s.received_instances} instances)`).join(", "),
      );
    }
  };

  // Run immediately on startup to catch any studies left from a previous crash
  run();

  setInterval(run, INTERVAL_MS);
  console.log("[Watchdog] Study completion watchdog started (every 5 min, stale after 10 min)");
};
