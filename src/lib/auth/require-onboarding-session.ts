import "server-only";

import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function requireOnboardingSession(path: string) {
  if (!isSupabaseConfigured()) redirect("/login?setup=required");

  let authenticated = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    authenticated = Boolean(data.user);
  } catch {
    authenticated = false;
  }

  if (!authenticated) redirect(`/login?next=${encodeURIComponent(path)}`);
}
