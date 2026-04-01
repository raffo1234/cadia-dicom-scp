import { supabase } from "./supabase";
import { Hospital } from "../types";

// In-memory cache — refreshed every 60 seconds
// The SCP checks this on every incoming connection
let cache: Map<string, Hospital> = new Map();
let lastRefreshed: number = 0;
const CACHE_TTL_MS = 60_000;

const load = async (): Promise<void> => {
  const { data, error } = await supabase
    .from("hospital")
    .select("id, name, ae_title, is_active, r2_bucket")
    .eq("is_active", true);

  if (error) {
    console.error("[HospitalRegistry] Failed to load hospitals:", error.message);
    return;
  }

  const next = new Map<string, Hospital>();
  for (const hospital of data ?? []) {
    next.set(hospital.ae_title, hospital as Hospital);
  }

  cache = next;
  lastRefreshed = Date.now();
  console.log(`[HospitalRegistry] Loaded ${cache.size} active AE title(s)`);
};

export const hospitalRegistry = {
  // Call once at startup
  init: async (): Promise<void> => {
    await load();
    // Refresh every 60s so deactivations take effect without restart
    setInterval(async () => {
      await load();
    }, CACHE_TTL_MS);
  },

  // Called on every incoming DICOM connection
  findByAeTitle: async (aeTitle: string): Promise<Hospital | null> => {
    // Refresh if cache is stale
    if (Date.now() - lastRefreshed > CACHE_TTL_MS) {
      await load();
    }
    return cache.get(aeTitle) ?? null;
  },

  // Force immediate refresh — called after admin creates/deactivates a hospital
  refresh: async (): Promise<void> => {
    await load();
  },
};