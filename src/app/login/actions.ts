"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { safeNextPath } from "@/lib/auth/safe-next-path";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const credentialsSchema = z.object({
  email: z.email().trim(),
  password: z.string().min(8).max(128),
});

function requireConfiguration() {
  if (!isSupabaseConfigured()) redirect("/login?setup=required");
}

function loginErrorLocation(reason: string, next: string) {
  return `/login?${new URLSearchParams({ error: reason, next })}`;
}

export async function signInWithPassword(formData: FormData) {
  requireConfiguration();
  const next = safeNextPath(formData.get("next"));
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect(loginErrorLocation("invalid-fields", next));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) redirect(loginErrorLocation("credentials", next));
  redirect(next);
}

export async function signUpWithPassword(formData: FormData) {
  requireConfiguration();
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) redirect("/signup?error=invalid-fields");
  const supabase = await createSupabaseServerClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error } = await supabase.auth.signUp({ ...parsed.data, options: { emailRedirectTo: `${origin}/auth/callback` } });
  if (error) redirect("/signup?error=signup");
  redirect("/signup?check-email=true");
}

export async function signInWithGoogle(formData: FormData) {
  requireConfiguration();
  const next = safeNextPath(formData.get("next"));
  const supabase = await createSupabaseServerClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` } });
  if (error || !data.url) redirect(loginErrorLocation("google", next));
  redirect(data.url);
}
