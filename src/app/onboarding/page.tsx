import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function OnboardingPage() {
  let hasCompletedImport = false;
  if (isSupabaseConfigured()) {
    try {
      const supabase = await createSupabaseServerClient();
      const { data: auth } = await supabase.auth.getUser();
      if (auth.user) {
        const { data: completedImport } = await supabase
          .from("import_jobs")
          .select("id")
          .eq("user_id", auth.user.id)
          .eq("job_type", "bitget_initial")
          .eq("status", "completed")
          .limit(1)
          .maybeSingle();
        hasCompletedImport = Boolean(completedImport);
      }
    } catch {
      // Route protection handles unavailable sessions. Do not turn a temporary
      // read failure into a false claim that onboarding has completed.
    }
  }
  if (hasCompletedImport) redirect("/home");
  redirect("/onboarding/bitget");
}
