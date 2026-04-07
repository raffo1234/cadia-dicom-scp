import { supabase } from "./supabase";
import { HospitalAccess } from "../types";

// In-memory cache — refreshed every 60 seconds
// The SCP checks this on every incoming connection
let cache: Map<string, HospitalAccess> = new Map();
let lastRefreshed: number = 0;
const CACHE_TTL_MS = 60_000;

const load = async (): Promise<void> => {
  const { data, error } = await supabase
    .from("hospital_access")
    .select("id, hospital_id, name, ae_title, allowed_ip, is_active, hospital(id, name, r2_bucket)")
    .eq("is_active", true);

  if (error) {
    console.error("[HospitalRegistry] Failed to load hospital access entries:", error.message);
    return;
  }

  const next = new Map<string, HospitalAccess>();
  for (const entry of data ?? []) {
    next.set(entry.ae_title, entry as unknown as HospitalAccess);
  }

  cache = next;
  lastRefreshed = Date.now();
  console.log(`[HospitalRegistry] Loaded ${cache.size} active AE title(s)`);
};

export const hospitalRegistry = {
  init: async (): Promise<void> => {
    await load();
    setInterval(async () => {
      await load();
    }, CACHE_TTL_MS);
  },

  findByAeTitle: async (aeTitle: string): Promise<HospitalAccess | null> => {
    if (Date.now() - lastRefreshed > CACHE_TTL_MS) {
      await load();
    }
    return cache.get(aeTitle) ?? null;
  },

  refresh: async (): Promise<void> => {
    await load();
  },
};