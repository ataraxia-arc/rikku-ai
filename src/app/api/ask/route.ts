import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ASK_ANALYSIS_VERSION, askModes, type AskImportSummary, type AskResponse } from "@/lib/ask/types";
import { askDataFingerprintInput, orchestrateAsk } from "@/lib/ask/orchestrator";
import { createSupabaseAskDataSource } from "@/lib/ask/supabase-data-source";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { containsSensitiveAskInput, PERSISTED_ASK_QUESTION, scrubAskResponseForPersistence } from "@/lib/ask/input-safety";

export const runtime = "nodejs";

const bodySchema = z.object({
  question: z.string().trim().min(1).max(500),
  mode: z.enum(askModes).default("analyst"),
  // Questions only: generated prose is never allowed to become a source of truth.
  history: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
}).strict();

function response(status: number, body: Record<string, unknown>, requestId: string) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Request-ID": requestId },
  });
}

function fingerprint(summary: AskImportSummary, question: string, mode: (typeof askModes)[number], history: string[]) {
  return createHash("sha256")
    .update(askDataFingerprintInput(summary, question, mode, history))
    .digest("hex");
}

function isAskResponse(value: unknown): value is AskResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const finding = record.finding;
  const confidence = record.confidence;
  const dataWindow = record.dataWindow;
  return record.version === ASK_ANALYSIS_VERSION
    && typeof record.question === "string"
    && askModes.includes(record.mode as (typeof askModes)[number])
    && finding !== null && typeof finding === "object"
    && typeof (finding as Record<string, unknown>).headline === "string"
    && typeof (finding as Record<string, unknown>).summary === "string"
    && confidence !== null && typeof confidence === "object"
    && typeof (confidence as Record<string, unknown>).level === "string"
    && Array.isArray((confidence as Record<string, unknown>).reasons)
    && dataWindow !== null && typeof dataWindow === "object"
    && Array.isArray(record.evidence) && record.evidence.every((metric) => metric && typeof metric === "object"
      && typeof (metric as Record<string, unknown>).label === "string" && typeof (metric as Record<string, unknown>).value === "string")
    && Array.isArray(record.toolRuns) && record.toolRuns.every((tool) => tool && typeof tool === "object"
      && typeof (tool as Record<string, unknown>).key === "string" && typeof (tool as Record<string, unknown>).label === "string"
      && typeof (tool as Record<string, unknown>).status === "string" && typeof (tool as Record<string, unknown>).summary === "string")
    && Array.isArray(record.sources) && record.sources.every((source) => source && typeof source === "object" && typeof (source as Record<string, unknown>).label === "string")
    && Array.isArray(record.limitations) && record.limitations.every((limitation) => typeof limitation === "string");
}

async function readCachedResponse(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  fingerprintValue: string,
): Promise<AskResponse | null> {
  try {
    const { data, error } = await supabase
      .from("analysis_results")
      .select("result")
      .eq("user_id", userId)
      .eq("skill_key", "ask-deterministic-response")
      .eq("input_fingerprint", fingerprintValue)
      .maybeSingle();
    if (error || !isAskResponse(data?.result)) return null;
    return data.result;
  } catch {
    return null;
  }
}

/**
 * A cache or audit-write failure must never turn a truthful answer into an
 * error. This function only receives authenticated user-owned aggregates and
 * tool metadata; it never receives credentials, raw Bitget responses, or IDs.
 */
async function persistSafeAskResult(args: {
  userId: string;
  mode: (typeof askModes)[number];
  response: AskResponse;
  fingerprintValue: string;
  importSummary: AskImportSummary;
}) {
  try {
    const service = createSupabaseServiceClient();
    const { data: run } = await service.from("agent_runs").insert({
      user_id: args.userId,
      question: PERSISTED_ASK_QUESTION,
      reasoning_mode: args.mode,
      status: "completed",
      tool_plan: args.response.toolRuns.map((tool) => ({ key: tool.key, status: tool.status })),
      evidence_map: {
        sources: args.response.sources.map((source) => source.label),
        dataWindow: args.response.dataWindow,
        analysisVersion: ASK_ANALYSIS_VERSION,
      },
      quant_version: ASK_ANALYSIS_VERSION,
      completed_at: new Date().toISOString(),
    }).select("id").maybeSingle();

    await service.from("analysis_results").upsert({
      user_id: args.userId,
      agent_run_id: run?.id ?? null,
      skill_key: "ask-deterministic-response",
      skill_version: ASK_ANALYSIS_VERSION,
      input_fingerprint: args.fingerprintValue,
      result: scrubAskResponseForPersistence(args.response),
      sample_size: args.importSummary.fills,
      warnings: args.response.limitations,
      confidence: args.response.confidence.level,
      confidence_reasons: args.response.confidence.reasons,
    }, { onConflict: "user_id,skill_key,input_fingerprint" });
  } catch {
    // Intentionally fail open. Never log an exception object or request body.
  }
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  if (!isSupabaseConfigured()) return response(503, { ok: false, code: "SUPABASE_NOT_CONFIGURED" }, requestId);

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 8_192) {
    return response(413, { ok: false, code: "ASK_REQUEST_TOO_LARGE" }, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return response(400, { ok: false, code: "ASK_INVALID_REQUEST" }, requestId);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return response(400, { ok: false, code: "ASK_INVALID_REQUEST" }, requestId);
  if (containsSensitiveAskInput(parsed.data.question) || parsed.data.history.some(containsSensitiveAskInput)) {
    return response(400, { ok: false, code: "ASK_SENSITIVE_INPUT" }, requestId);
  }

  let supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return response(401, { ok: false, code: "AUTH_REQUIRED" }, requestId);
    userId = data.user.id;
  } catch {
    return response(503, { ok: false, code: "AUTH_UNAVAILABLE" }, requestId);
  }

  const source = createSupabaseAskDataSource(supabase, userId);
  let initialImport: AskImportSummary | null | undefined;
  try {
    const connection = await source.getConnectionStatus();
    if (connection.connected) initialImport = await source.getLatestCompletedImport();
  } catch {
    // The orchestrator returns a safe, user-facing insufficient-data response.
  }

  if (initialImport) {
    const fingerprintValue = fingerprint(initialImport, parsed.data.question, parsed.data.mode, parsed.data.history);
    const cached = await readCachedResponse(supabase, userId, fingerprintValue);
    if (cached) {
      return response(200, { ok: true, cached: true, response: { ...cached, question: parsed.data.question, mode: parsed.data.mode } }, requestId);
    }

    const askResponse = await orchestrateAsk({
      source,
      question: parsed.data.question,
      mode: parsed.data.mode,
      history: parsed.data.history,
      initialImport,
    });
    await persistSafeAskResult({
      userId,
      mode: parsed.data.mode,
      response: askResponse,
      fingerprintValue,
      importSummary: initialImport,
    });
    return response(200, { ok: true, cached: false, response: askResponse }, requestId);
  }

  const askResponse = await orchestrateAsk({
    source,
    question: parsed.data.question,
    mode: parsed.data.mode,
    history: parsed.data.history,
  });
  return response(200, { ok: true, cached: false, response: askResponse }, requestId);
}
