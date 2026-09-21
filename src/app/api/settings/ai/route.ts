import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const schema = z.object({
  defaultMode: z.enum(["scout", "analyst", "investigator"]),
  responseStyle: z.enum(["concise", "balanced", "detailed"]),
}).strict();

export async function PUT(request: Request) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return NextResponse.json({ ok: false, code: "AUTH_REQUIRED" }, { status: 401 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "SETTINGS_INVALID" }, { status: 400 });
  const service = createSupabaseServiceClient();
  const { error: writeError } = await service.from("audit_events").insert({
    user_id: data.user.id,
    action: "ai_preferences_updated",
    target_type: "user_settings",
    safe_metadata: parsed.data,
  });
  if (writeError) return NextResponse.json({ ok: false, code: "SETTINGS_WRITE_FAILED" }, { status: 503 });
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
