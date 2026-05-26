import { supabase } from "./supabase";

/**
 * Finaliza estudios al soltar la asociación DICOM.
 * Sincroniza received_instances desde el array real y marca como complete.
 * Llamada desde associationReleaseRequested (fire-and-forget).
 */
export const completeStudiesForAssociation = async (
  studyInstanceUIDs: string[],
  hospitalId: string,
): Promise<void> => {
  if (studyInstanceUIDs.length === 0) return;

  const { error } = await supabase.rpc("finalize_studies", {
    p_study_uids:  studyInstanceUIDs,
    p_hospital_id: hospitalId,
  });

  if (error) {
    console.error("[StudyCompletion] finalize_studies failed:", error.message);
  } else {
    console.log(
      `[StudyCompletion] Finalized ${studyInstanceUIDs.length} study/studies on association release`,
    );
  }
};

/**
 * Finaliza un estudio individual por UID.
 * Usado por C-GET SCU donde hospitalId puede no estar disponible.
 */
export const completeStudyByUID = async (studyInstanceUID: string): Promise<void> => {
  const { error } = await supabase.rpc("finalize_study_by_uid", {
    p_study_uid: studyInstanceUID,
  });

  if (error) {
    console.error("[StudyCompletion] finalize_study_by_uid failed:", error.message);
  } else {
    console.log(`[StudyCompletion] Finalized ${studyInstanceUID}`);
  }
};

/**
 * Watchdog — corre cada 5 minutos.
 * Estudios en "receiving" por más de 10 minutos → finalizados con contador real.
 * Cubre casos donde la modalidad desconecta sin soltar la asociación.
 */
export const startCompletionWatchdog = (): void => {
  const INTERVAL_MS    = 5 * 60 * 1000;
  const STALE_AFTER_MS = 10 * 60 * 1000;

  const run = async (): Promise<void> => {
    const staleThreshold = new Date(Date.now() - STALE_AFTER_MS).toISOString();

    const { data, error } = await supabase.rpc("finalize_stale_studies", {
      p_stale_threshold: staleThreshold,
    });

    if (error) {
      console.error("[Watchdog] finalize_stale_studies failed:", error.message);
      return;
    }

    const results = (data as Array<{ uid: string; count: number }> | null) ?? [];

    if (results.length > 0) {
      console.log(
        `[Watchdog] Finalized ${results.length} stale study/studies:`,
        results.map((s) => `${s.uid} (${s.count} instances)`).join(", "),
      );
    }
  };

  void run();
  setInterval(() => void run(), INTERVAL_MS);
  console.log("[Watchdog] Started (every 5 min, stale after 10 min)");
};
