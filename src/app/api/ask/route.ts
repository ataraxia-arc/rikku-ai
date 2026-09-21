import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reasonAboutEvidence, reasoningFallback } from "@/lib/ask/openai-reasoner";
import { ReasoningProviderError } from "@/lib/ask/reasoning-provider";
import { ASK_ANALYSIS_VERSION, askAnswerKinds, askModes, askReasoningPointKinds, askToolKeys, type AskImportSummary, type AskResponse } from "@/lib/ask/types";
import { askDataFingerprintInput, orchestrateAsk } from "@/lib/ask/orchestrator";
import { createSupabaseAskDataSource } from "@/lib/ask/supabase-data-source";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { containsSensitiveAskInput, scrubAskResponseForPersistence } from "@/lib/ask/input-safety";

export const runtime = "nodejs";

const contextPattern = /^(portfolio|memory|patterns|research|risk|playbook|latest-analysis|memory:[0-9a-f-]{36}|pattern:[0-9a-f-]{36}|research:[0-9a-f-]{36}|rule:[0-9a-f-]{36})$/i;
const bodySchema = z.object({
  question: z.string().trim().min(1).max(500),
  mode: z.enum(askModes).default("analyst"),
  threadId: z.string().uuid(),
  contextId: z.string().regex(contextPattern).max(80).nullable().default(null),
  history: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
}).strict();
const cachedEvidenceSchema = z.object({
  version: z.literal(ASK_ANALYSIS_VERSION),
  status: z.enum(["completed", "insufficient_data", "needs_connection", "needs_import"]),
  mode: z.enum(askModes),
  answerKind: z.enum(askAnswerKinds),
  question: z.string(),
  finding: z.object({ headline: z.string(), summary: z.string() }),
  interpretation: z.string(),
  reasoningPoints: z.array(z.object({
    kind: z.enum(askReasoningPointKinds),
    statement: z.string(),
    rationale: z.string(),
    evidenceLabels: z.array(z.string()),
    test: z.string().nullable(),
  })),
  evidence: z.array(z.object({ label: z.string(), value: z.string(), detail: z.string().optional() })),
  qualitativeEvidence: z.array(z.object({
    kind: z.enum(["memory", "pattern"]),
    label: z.string(),
    statement: z.string(),
    classification: z.string().nullable(),
    confidence: z.string().nullable(),
    status: z.string().nullable(),
  })),
  confidence: z.object({ level: z.enum(["low", "moderate", "high", "not_assessable"]), reasons: z.array(z.string()) }),
  limitations: z.array(z.string()),
  marketContext: z.object({ available: z.boolean(), summary: z.string(), matchedFills: z.number(), regimeSummary: z.string().optional() }).nullable(),
  dataWindow: z.object({ start: z.string().nullable(), end: z.string().nullable(), label: z.string().nullable() }),
  sources: z.array(z.object({ label: z.string(), detail: z.string().optional() })),
  toolRuns: z.array(z.object({ key: z.enum(askToolKeys), label: z.string(), status: z.enum(["completed", "insufficient_data", "skipped"]), summary: z.string(), sampleSize: z.number().optional(), sources: z.array(z.string()) })),
  suggestedFollowups: z.array(z.string()),
  reasoningStatus: z.literal("deterministic_fallback"),
  reasoningNotice: z.string().optional(),
}).passthrough();

type ServerSupabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type SafeExchange = { question: string; conclusion: string };

function response(status: number, body: Record<string, unknown>, requestId: string) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Request-ID": requestId },
  });
}

function fingerprint(summary: AskImportSummary, question: string, mode: (typeof askModes)[number], history: string[]) {
  return createHash("sha256").update(askDataFingerprintInput(summary, question, mode, history)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function conclusionFromResult(value: unknown) {
  const result = record(value);
  const finding = record(result?.finding);
  const headline = typeof finding?.headline === "string" ? finding.headline : "";
  const summary = typeof finding?.summary === "string" ? finding.summary : "";
  const interpretation = typeof result?.interpretation === "string" ? result.interpretation : "";
  const reasoningPoints = Array.isArray(result?.reasoningPoints)
    ? result.reasoningPoints.flatMap((item) => {
      const point = record(item);
      return typeof point?.statement === "string" ? [point.statement] : [];
    }).join(" ")
    : "";
  return `${headline} ${summary} ${interpretation} ${reasoningPoints}`.trim().slice(0, 2_500);
}

async function readDeterministicCache(supabase: ServerSupabase, userId: string, fingerprintValue: string, question: string, mode: (typeof askModes)[number]) {
  try {
    const { data, error } = await supabase.from("analysis_results").select("result")
      .eq("user_id", userId).eq("skill_key", "ask-deterministic-evidence").eq("input_fingerprint", fingerprintValue).maybeSingle();
    const parsed = cachedEvidenceSchema.safeParse(data?.result);
    return error || !parsed.success ? null : { ...parsed.data, question, mode } as AskResponse;
  } catch {
    return null;
  }
}

async function persistDeterministicCache(userId: string, fingerprintValue: string, result: AskResponse, summary: AskImportSummary) {
  try {
    const service = createSupabaseServiceClient();
    await service.from("analysis_results").upsert({
      user_id: userId,
      agent_run_id: null,
      skill_key: "ask-deterministic-evidence",
      skill_version: ASK_ANALYSIS_VERSION,
      input_fingerprint: fingerprintValue,
      result: scrubAskResponseForPersistence(result),
      sample_size: summary.fills,
      warnings: result.limitations,
      confidence: result.confidence.level,
      confidence_reasons: result.confidence.reasons,
    }, { onConflict: "user_id,skill_key,input_fingerprint" });
  } catch {
    // Cache writes are optional and must not affect the answer path.
  }
}

async function readRecentThread(supabase: ServerSupabase, userId: string, threadId: string): Promise<SafeExchange[]> {
  try {
    const { data: runs, error } = await supabase
      .from("agent_runs")
      .select("id,question,created_at")
      .eq("user_id", userId)
      .contains("evidence_map", { threadId })
      .order("created_at", { ascending: false })
      .limit(5);
    if (error || !Array.isArray(runs) || !runs.length) return [];
    const ids = runs.flatMap((run) => typeof run.id === "string" ? [run.id] : []);
    const { data: results, error: resultError } = await supabase
      .from("analysis_results")
      .select("agent_run_id,result")
      .eq("user_id", userId)
      .in("agent_run_id", ids);
    if (resultError || !Array.isArray(results)) return [];
    const byRun = new Map(results.map((item) => [item.agent_run_id, item.result]));
    return [...runs].reverse().flatMap((run) => {
      const question = typeof run.question === "string" ? run.question.trim().slice(0, 500) : "";
      const conclusion = conclusionFromResult(byRun.get(run.id));
      return question && conclusion ? [{ question, conclusion }] : [];
    });
  } catch {
    return [];
  }
}

async function resolveContext(supabase: ServerSupabase, userId: string, contextId: string | null) {
  if (!contextId) return null;
  const staticContexts: Record<string, string> = {
    portfolio: "Current authenticated portfolio state and latest Bitget import",
    memory: "Evidence-linked RIKKU memory records",
    patterns: "Stored RIKKU patterns with supporting and counter-evidence",
    research: "Stored research sources and imported Bitget candle context",
    risk: "Current measurable and unavailable risk evidence",
    playbook: "User-owned personal trading rules",
    "latest-analysis": "Most recent validated RIKKU analysis",
  };
  if (staticContexts[contextId]) return `${contextId}: ${staticContexts[contextId]}`;
  const [kind, id] = contextId.split(":");
  const table = kind === "memory" ? "memories" : kind === "pattern" ? "patterns" : kind === "research" ? "research_sources" : kind === "rule" ? "personal_rules" : null;
  if (!table || !id) return null;
  const columns = table === "memories" ? "id,statement,classification,confidence,status"
    : table === "patterns" ? "id,claim,confidence,status"
      : table === "research_sources" ? "id,title,publisher,retrieved_at"
        : "id,category,if_conditions,then_action,confidence,status";
  const { data, error } = await supabase.from(table).select(columns).eq("user_id", userId).eq("id", id).maybeSingle();
  if (error || !data) return null;
  return `${kind}: ${JSON.stringify(data).slice(0, 2_000)}`;
}

async function persistSafeAskResult(args: {
  userId: string;
  threadId: string;
  mode: (typeof askModes)[number];
  question: string;
  response: AskResponse;
  fingerprintValue: string;
  importSummary: AskImportSummary;
  durationMs: number;
}) {
  try {
    const service = createSupabaseServiceClient();
    const { data: run } = await service.from("agent_runs").insert({
      user_id: args.userId,
      question: args.question,
      reasoning_mode: args.mode,
      status: "completed",
      tool_plan: args.response.toolRuns.map((tool) => ({ key: tool.key, status: tool.status })),
      evidence_map: {
        threadId: args.threadId,
        sources: args.response.sources.map((source) => source.label),
        dataWindow: args.response.dataWindow,
        analysisVersion: ASK_ANALYSIS_VERSION,
      },
      model_version: args.response.reasoningStatus === "external_llm" ? args.response.reasoningProvider?.model ?? "external-llm" : "deterministic-fallback",
      quant_version: ASK_ANALYSIS_VERSION,
      latency_ms: args.durationMs,
      completed_at: new Date().toISOString(),
    }).select("id").maybeSingle();

    await service.from("analysis_results").insert({
      user_id: args.userId,
      agent_run_id: run?.id ?? null,
      skill_key: "ask-evidence-response",
      skill_version: ASK_ANALYSIS_VERSION,
      input_fingerprint: createHash("sha256").update(`${args.fingerprintValue}:${args.threadId}:${run?.id ?? randomUUID()}`).digest("hex"),
      result: scrubAskResponseForPersistence(args.response),
      sample_size: args.importSummary.fills,
      warnings: args.response.limitations,
      confidence: args.response.confidence.level,
      confidence_reasons: args.response.confidence.reasons,
    });

    const meaningful = args.response.status === "completed"
      && args.response.toolRuns.some((tool) => tool.key === "run_skeptic_check" && tool.status === "completed")
      && args.response.toolRuns.some((tool) => !["get_import_summary", "run_skeptic_check"].includes(tool.key) && tool.status === "completed");
    if (meaningful && run?.id && args.response.dataWindow.label) {
      const { data: existing } = await service.from("memories").select("id")
        .eq("user_id", args.userId).eq("memory_type", "trade").contains("payload", { importId: args.importSummary.id }).limit(1).maybeSingle();
      if (!existing) {
        const { data: memory } = await service.from("memories").insert({
          user_id: args.userId,
          memory_type: "trade",
          statement: `${args.importSummary.fills} fills were imported for ${args.response.dataWindow.label}.`,
          classification: "fact",
          payload: { importId: args.importSummary.id, evidence: "Bitget import summary" },
          salience: 0.5,
          confidence: args.response.confidence.level,
          valid_from: args.importSummary.earliestRecordAt,
          valid_to: args.importSummary.latestRecordAt,
          status: "active",
          source_run_id: run.id,
        }).select("id").maybeSingle();
        if (memory?.id) await service.from("memory_evidence").insert({
          user_id: args.userId,
          memory_id: memory.id,
          evidence_type: "bitget_import",
          evidence_id: args.importSummary.id,
          direction: "supporting",
          source_label: "Bitget import summary",
          observed_at: args.importSummary.completedAt,
        });
      }
    }
  } catch {
    // Never log request content or downstream exceptions.
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const requestId = randomUUID();
  if (!isSupabaseConfigured()) return response(503, { ok: false, code: "SUPABASE_NOT_CONFIGURED" }, requestId);
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 8_192) return response(413, { ok: false, code: "ASK_REQUEST_TOO_LARGE" }, requestId);

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

  let supabase: ServerSupabase;
  let userId: string;
  try {
    supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return response(401, { ok: false, code: "AUTH_REQUIRED" }, requestId);
    userId = data.user.id;
  } catch {
    return response(503, { ok: false, code: "AUTH_UNAVAILABLE" }, requestId);
  }

  const [recent, context] = await Promise.all([
    readRecentThread(supabase, userId, parsed.data.threadId),
    resolveContext(supabase, userId, parsed.data.contextId),
  ]);
  const historyQuestions = recent.length ? recent.map((exchange) => exchange.question) : parsed.data.history;
  const source = createSupabaseAskDataSource(supabase, userId);
  let initialImport: AskImportSummary | null | undefined;
  try {
    const connection = await source.getConnectionStatus();
    if (connection.connected) initialImport = await source.getLatestCompletedImport();
  } catch {
    // The orchestrator returns a safe no-data response.
  }

  const fingerprintValue = initialImport ? fingerprint(initialImport, parsed.data.question, parsed.data.mode, historyQuestions) : null;
  let deterministic = fingerprintValue ? await readDeterministicCache(supabase, userId, fingerprintValue, parsed.data.question, parsed.data.mode) : null;
  if (!deterministic) {
    deterministic = await orchestrateAsk({
      source,
      question: parsed.data.question,
      mode: parsed.data.mode,
      history: historyQuestions,
      initialImport,
    });
    if (initialImport && fingerprintValue) await persistDeterministicCache(userId, fingerprintValue, deterministic, initialImport);
  }
  let answer = deterministic;
  if (deterministic.status === "completed" || deterministic.status === "insufficient_data") {
    try {
      answer = await reasonAboutEvidence({ response: deterministic, recent, context, correlationId: requestId });
    } catch (error) {
      const safeError = error instanceof ReasoningProviderError ? error : new ReasoningProviderError("UNKNOWN");
      console.warn(JSON.stringify({
        event: "rikku.ask.reasoning_provider_failure",
        correlationId: requestId,
        category: safeError.code,
        status: safeError.safeProviderDetails?.status ?? null,
        providerCode: safeError.safeProviderDetails?.code ?? "",
        providerType: safeError.safeProviderDetails?.type ?? "",
      }));
      if (safeError.code === "INVALID_RESPONSE") return response(502, { ok: false, code: "LLM_INVALID_RESPONSE" }, requestId);
      answer = reasoningFallback(deterministic, safeError);
    }
  }

  if (initialImport) {
    await persistSafeAskResult({
      userId,
      threadId: parsed.data.threadId,
      mode: parsed.data.mode,
      question: parsed.data.question,
      response: answer,
      fingerprintValue: fingerprintValue!,
      importSummary: initialImport,
      durationMs: Date.now() - startedAt,
    });
  }
  return response(200, { ok: true, response: answer, threadId: parsed.data.threadId }, requestId);
}
