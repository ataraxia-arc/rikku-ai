import "server-only";

import { createClient } from "@supabase/supabase-js";

export function importWorkerConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createSupabaseServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("IMPORT_WORKER_NOT_CONFIGURED");

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
