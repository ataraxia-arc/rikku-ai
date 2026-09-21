import { NextResponse } from "next/server";
import { z } from "zod";
import { containsSensitiveAskInput } from "@/lib/ask/input-safety";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const text = z.string().trim().min(3).max(500);
const createSchema = z.object({ category: z.string().trim().min(2).max(80), ifCondition: text, thenAction: text }).strict();
const updateSchema = z.object({
  id: z.string().uuid(),
  category: z.string().trim().min(2).max(80).optional(),
  ifCondition: text.optional(),
  thenAction: text.optional(),
  status: z.enum(["active", "paused", "retired"]).optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "id"));
const deleteSchema = z.object({ id: z.string().uuid() }).strict();

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function authenticatedUserId() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user?.id ?? null;
}

function containsSecret(value: Record<string, unknown>) {
  return Object.values(value).some((item) => typeof item === "string" && containsSensitiveAskInput(item));
}

export async function POST(request: Request) {
  const userId = await authenticatedUserId();
  if (!userId) return json(401, { ok: false, code: "AUTH_REQUIRED" });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || containsSecret(parsed.data)) return json(400, { ok: false, code: "RULE_INVALID" });
  const service = createSupabaseServiceClient();
  const { data, error } = await service.from("personal_rules").insert({
    user_id: userId,
    category: parsed.data.category,
    if_conditions: { text: parsed.data.ifCondition },
    then_action: parsed.data.thenAction,
    confidence: "user_asserted",
    status: "active",
  }).select("id").single();
  if (error || !data) return json(503, { ok: false, code: "RULE_WRITE_FAILED" });
  return json(201, { ok: true, id: data.id });
}

export async function PATCH(request: Request) {
  const userId = await authenticatedUserId();
  if (!userId) return json(401, { ok: false, code: "AUTH_REQUIRED" });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || containsSecret(parsed.data)) return json(400, { ok: false, code: "RULE_INVALID" });
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.category) updates.category = parsed.data.category;
  if (parsed.data.ifCondition) updates.if_conditions = { text: parsed.data.ifCondition };
  if (parsed.data.thenAction) updates.then_action = parsed.data.thenAction;
  if (parsed.data.status) updates.status = parsed.data.status;
  const service = createSupabaseServiceClient();
  const { data, error } = await service.from("personal_rules").update(updates)
    .eq("id", parsed.data.id).eq("user_id", userId).is("origin_memory_id", null).is("origin_pattern_id", null)
    .select("id").maybeSingle();
  if (error) return json(503, { ok: false, code: "RULE_WRITE_FAILED" });
  if (!data) return json(404, { ok: false, code: "RULE_NOT_EDITABLE" });
  return json(200, { ok: true });
}

export async function DELETE(request: Request) {
  const userId = await authenticatedUserId();
  if (!userId) return json(401, { ok: false, code: "AUTH_REQUIRED" });
  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { ok: false, code: "RULE_INVALID" });
  const service = createSupabaseServiceClient();
  const { error } = await service.from("personal_rules").delete()
    .eq("id", parsed.data.id).eq("user_id", userId).is("origin_memory_id", null).is("origin_pattern_id", null);
  if (error) return json(503, { ok: false, code: "RULE_WRITE_FAILED" });
  return json(200, { ok: true });
}
