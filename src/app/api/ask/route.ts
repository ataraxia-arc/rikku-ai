import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { reasonAboutEvidence, reasoningFallback } from "@/lib/ask/openai-reasoner";
import { createReasoningProvider, ReasoningProviderError, type ReasoningProvider } from "@/lib/ask/reasoning-provider";
import { isDirectImportFactPlan, planAskSemantically, SemanticPlanError, type SemanticSelectedContext, type SemanticToolPlan } from "@/lib/ask/semantic-planner";
import { ASK_ANALYSIS_VERSION, askAnswerKinds, askModes, askReasoningPointKinds, askToolKeys, type AskImportSummary, type AskQualitativeEvidence, type AskResponse } from "@/lib/ask/types";
import { askDataFingerprintInput, orchestrateAsk } from "@/lib/ask/orchestrator";
import { createSupabaseAskDataSource } from "@/lib/ask/supabase-data-source";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { containsSensitiveAskInput, scrubAskResponseForPersistence } from "@/lib/ask/input-safety";
import { takeRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const contextPattern = /^(portfolio|memory|patterns|research|risk|playbook|latest-analysis|memory:[0-9a-f-]{36}|pattern:[0-9a-f-]{36}|research:[0-9a-f-]{36}|rule:[0-9a-f-]{36})$/i;
const clientConversationSchema = z.object({
  question: z.string().trim().min(1).max(300),
  conclusion: z.string().trim().min(1).max(600),
}).strict();
const bodySchema = z.object({
  question: z.string().trim().min(1).max(500),
  mode: z.enum(askModes).default("analyst"),
  threadId: z.string().uuid(),
  contextId: z.string().regex(contextPattern).max(80).nullable().default(null),
  // Keep accepting the original question-only history shape for older clients.
  // New clients also return a bounded copy of RIKKU's prior conclusion so a
  // follow-up remains understandable if optional thread persistence failed.
  history: z.array(z.union([z.string().trim().min(1).max(500), clientConversationSchema])).max(8).default([]),
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
    kind: z.enum(["memory", "pattern", "research", "rule", "context"]),
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
type SafeExchange = { question: string; conclusion: string; findingId: string };

function response(status: number, body: Record<string, unknown>, requestId: string) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Request-ID": requestId },
  });
}

function fingerprint(summary: AskImportSummary, question: string, mode: (typeof askModes)[number], history: string[], plan: SemanticToolPlan | null, selectedContext: ResolvedAskContext | null) {
  return createHash("sha256").update(askDataFingerprintInput(summary, question, mode, history)).update(JSON.stringify(plan && {
    tools: plan.toolRequests,
    kind: plan.answerKind,
    metric: plan.requestedImportMetric,
    depth: plan.analysisDepth,
    goal: plan.reasoningGoal,
    joined: plan.requiresJoinedAnalysis,
    priorFindings: plan.referencedPriorFindingIds,
  })).update(JSON.stringify(selectedContext?.planner ?? null)).digest("hex");
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
      return question && conclusion && !containsSensitiveAskInput(`${question} ${conclusion}`)
        ? [{ question, conclusion, findingId: run.id }]
        : [];
    });
  } catch {
    return [];
  }
}

type ResolvedAskContext = {
  planner: SemanticSelectedContext;
  evidence: AskQualitativeEvidence;
};

const validatedAnalysisSkillKeys = ["ask-evidence-response", "tail-risk-realized-pnl"] as const;

function safeContextValue(value: unknown, max = 800) {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return "";
  }
}

function resolvedContext(id: string, kind: SemanticSelectedContext["kind"], label: string, statement: string, metadata?: Partial<Pick<AskQualitativeEvidence, "classification" | "confidence" | "status">>): ResolvedAskContext | null {
  const boundedStatement = statement.trim().slice(0, 1_500);
  if (!boundedStatement || containsSensitiveAskInput(`${label} ${boundedStatement}`)) return null;
  return {
    planner: { id, kind, label, statement: boundedStatement },
    evidence: {
      kind,
      label,
      statement: boundedStatement,
      classification: metadata?.classification ?? null,
      confidence: metadata?.confidence ?? null,
      status: metadata?.status ?? null,
    },
  };
}

function boundedResultStrings(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = typeof item === "string" ? item.trim() : "";
    return text ? [text.slice(0, maxLength)] : [];
  }).slice(0, maxItems);
}

function boundedResultString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function latestAnalysisStatement(value: unknown) {
  const row = record(value);
  const result = record(row?.result);
  const skillKey = boundedResultString(row?.skill_key, 80);
  if (!result || !validatedAnalysisSkillKeys.includes(skillKey as (typeof validatedAnalysisSkillKeys)[number])) return null;

  const status = boundedResultString(result.status, 40);
  if (status !== "completed" && status !== "insufficient_data") return null;
  const finding = record(result.finding);
  const headline = boundedResultString(finding?.headline, 240);
  const summary = boundedResultString(finding?.summary, 600) || boundedResultString(result.summary, 600);
  if (!summary) return null;

  const interpretation = boundedResultString(result.interpretation, 400);
  const confidence = boundedResultString(row?.confidence, 40);
  const dataWindow = record(result.dataWindow);
  const windowLabel = boundedResultString(dataWindow?.label, 120);
  const limitations = boundedResultStrings(result.limitations, 3, 240);
  const evidence = Array.isArray(result.evidence) ? result.evidence.flatMap((item) => {
    const metric = record(item);
    const label = boundedResultString(metric?.label, 120);
    const metricValue = boundedResultString(metric?.value, 160);
    return label && metricValue ? [`${label}: ${metricValue}`] : [];
  }).slice(0, 4) : [];

  return [
    headline ? `Finding: ${headline}` : "Validated result",
    `Summary: ${summary}`,
    interpretation ? `Interpretation: ${interpretation}` : "",
    evidence.length ? `Evidence: ${evidence.join("; ")}` : "",
    limitations.length ? `Limitations: ${limitations.join("; ")}` : "",
    confidence ? `Confidence: ${confidence}` : "",
    windowLabel ? `Data window: ${windowLabel}` : "",
  ].filter(Boolean).join(". ");
}

async function resolveLatestAnalysisContext(supabase: ServerSupabase, userId: string): Promise<ResolvedAskContext | null> {
  const { data, error } = await supabase
    .from("analysis_results")
    .select("skill_key,result,confidence,created_at")
    .eq("user_id", userId)
    .in("skill_key", [...validatedAnalysisSkillKeys])
    .order("created_at", { ascending: false })
    .limit(10);
  if (error || !Array.isArray(data)) return null;
  for (const row of data) {
    const statement = latestAnalysisStatement(row);
    if (!statement) continue;
    const result = record(record(row)?.result);
    const resolved = resolvedContext("latest-analysis", "context", "Selected latest validated RIKKU analysis", statement, {
      classification: "prior_validated_analysis",
      confidence: boundedResultString(record(row)?.confidence, 80) || null,
      status: boundedResultString(result?.status, 80) || null,
    });
    if (resolved) return resolved;
  }
  return null;
}

async function resolveContext(supabase: ServerSupabase, userId: string, contextId: string | null): Promise<ResolvedAskContext | null> {
  if (!contextId) return null;
  if (contextId === "latest-analysis") return resolveLatestAnalysisContext(supabase, userId);
  const staticContexts: Record<string, string> = {
    portfolio: "Current authenticated portfolio state and latest Bitget import",
    memory: "Evidence-linked RIKKU memory records",
    patterns: "Stored RIKKU patterns with supporting and counter-evidence",
    research: "Stored research sources and imported Bitget candle context",
    risk: "Current measurable and unavailable risk evidence",
    playbook: "User-owned personal trading rules",
  };
  if (staticContexts[contextId]) return resolvedContext(contextId, "context", `Selected ${contextId} context`, staticContexts[contextId]);
  const [kind, id] = contextId.split(":");
  const table = kind === "memory" ? "memories" : kind === "pattern" ? "patterns" : kind === "research" ? "research_sources" : kind === "rule" ? "personal_rules" : null;
  if (!table || !id) return null;
  const columns = table === "memories" ? "id,statement,classification,confidence,status"
    : table === "patterns" ? "id,claim,confidence,status"
      : table === "research_sources" ? "id,title,publisher,retrieved_at"
        : "id,category,if_conditions,then_action,confidence,status";
  const { data, error } = await supabase.from(table).select(columns).eq("user_id", userId).eq("id", id).maybeSingle();
  if (error || !data) return null;
  const row = record(data);
  if (!row) return null;
  if (kind === "memory") return resolvedContext(contextId, "memory", "Selected RIKKU memory", safeContextValue(row.statement), {
    classification: safeContextValue(row.classification, 80) || null,
    confidence: safeContextValue(row.confidence, 80) || null,
    status: safeContextValue(row.status, 80) || null,
  });
  if (kind === "pattern") return resolvedContext(contextId, "pattern", "Selected RIKKU pattern", safeContextValue(row.claim), {
    confidence: safeContextValue(row.confidence, 80) || null,
    status: safeContextValue(row.status, 80) || null,
  });
  if (kind === "research") {
    const statement = [safeContextValue(row.title), safeContextValue(row.publisher) && `Publisher: ${safeContextValue(row.publisher)}`, safeContextValue(row.retrieved_at) && `Retrieved: ${safeContextValue(row.retrieved_at)}`].filter(Boolean).join(" · ");
    return resolvedContext(contextId, "research", "Selected RIKKU research source", statement);
  }
  const statement = [safeContextValue(row.category), safeContextValue(row.if_conditions) && `Conditions: ${safeContextValue(row.if_conditions)}`, safeContextValue(row.then_action) && `Action: ${safeContextValue(row.then_action)}`].filter(Boolean).join(" · ");
  return resolvedContext(contextId, "rule", "Selected RIKKU playbook rule", statement, {
    confidence: safeContextValue(row.confidence, 80) || null,
    status: safeContextValue(row.status, 80) || null,
  });
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
  const submittedHistoryText = parsed.data.history.flatMap((entry) => typeof entry === "string"
    ? [entry]
    : [entry.question, entry.conclusion]);
  if (containsSensitiveAskInput(parsed.data.question) || submittedHistoryText.some(containsSensitiveAskInput)) {
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
  const rateLimit = takeRateLimit(`ask:${userId}`, 6, 60_000);
  if (!rateLimit.allowed) {
    return response(429, { ok: false, code: "ASK_RATE_LIMITED", retryAfterSeconds: rateLimit.retryAfterSeconds }, requestId);
  }

  const [recent, selectedContext] = await Promise.all([
    readRecentThread(supabase, userId, parsed.data.threadId),
    resolveContext(supabase, userId, parsed.data.contextId),
  ]);
  if ((parsed.data.contextId?.includes(":") || parsed.data.contextId === "latest-analysis") && !selectedContext) {
    return response(404, { ok: false, code: "ASK_CONTEXT_NOT_FOUND" }, requestId);
  }
  const clientConversation: SafeExchange[] = parsed.data.history.flatMap((entry) => typeof entry === "string"
    ? []
    : [{ question: entry.question, conclusion: entry.conclusion, findingId: "" }]);
  const conversationContext = recent.length ? recent : clientConversation;
  const historyQuestions = recent.length
    ? recent.map((exchange) => exchange.question)
    : parsed.data.history.map((entry) => typeof entry === "string" ? entry : entry.question);
  let provider: ReasoningProvider | null = null;
  let plan: SemanticToolPlan | null = null;
  let planningError: ReasoningProviderError | null = null;
  try {
    provider = createReasoningProvider();
    plan = await planAskSemantically({
      question: parsed.data.question,
      mode: parsed.data.mode,
      conversationContext,
      selectedContext: selectedContext?.planner ?? null,
      provider,
    });
  } catch (error) {
    planningError = error instanceof ReasoningProviderError ? error : new ReasoningProviderError("INVALID_RESPONSE");
    console.warn(JSON.stringify({
      event: "rikku.ask.semantic_planning_failure",
      correlationId: requestId,
      category: planningError.code,
      status: planningError.safeProviderDetails?.status ?? null,
      providerCode: planningError.safeProviderDetails?.code ?? "",
      providerType: planningError.safeProviderDetails?.type ?? "",
      retryAfter: planningError.safeProviderDetails?.retryAfter ?? "",
      tokenReset: planningError.safeProviderDetails?.tokenReset ?? "",
      tokenLimit: planningError.safeProviderDetails?.tokenLimit ?? null,
      tokenUsed: planningError.safeProviderDetails?.tokenUsed ?? null,
      tokenRequested: planningError.safeProviderDetails?.tokenRequested ?? null,
      ...(error instanceof SemanticPlanError ? { schemaPaths: error.failurePaths } : {}),
    }));
  }
  const source = createSupabaseAskDataSource(supabase, userId);
  let initialImport: AskImportSummary | null | undefined;
  try {
    const connection = await source.getConnectionStatus();
    if (connection.connected) initialImport = await source.getLatestCompletedImport();
  } catch {
    // The orchestrator returns a safe no-data response.
  }

  const fingerprintValue = initialImport ? fingerprint(initialImport, parsed.data.question, parsed.data.mode, historyQuestions, plan, selectedContext) : null;
  let deterministic = fingerprintValue ? await readDeterministicCache(supabase, userId, fingerprintValue, parsed.data.question, parsed.data.mode) : null;
  if (!deterministic) {
    deterministic = await orchestrateAsk({
      source,
      question: parsed.data.question,
      mode: parsed.data.mode,
      history: historyQuestions,
      selectedContextAvailable: selectedContext !== null,
      initialImport,
      plan,
    });
    if (initialImport && fingerprintValue) await persistDeterministicCache(userId, fingerprintValue, deterministic, initialImport);
  }
  if (selectedContext && !deterministic.qualitativeEvidence.some((item) => item.label === selectedContext.evidence.label && item.statement === selectedContext.evidence.statement)) {
    const epistemicLimitation = selectedContext.evidence.kind === "memory"
      ? selectedContext.evidence.classification === "fact"
        ? "The selected memory is an evidence-linked stored fact; later imports may supersede it."
        : "The selected memory is not classified as a verified fact and must not be treated as one."
      : selectedContext.evidence.kind === "pattern"
        ? "A selected stored pattern is not proof that the pattern is established or causal."
        : selectedContext.evidence.kind === "research"
          ? "The selected research evidence contains stored source metadata only; source contents and external events were not independently verified."
          : selectedContext.evidence.kind === "rule"
            ? "A selected playbook rule is normative; it does not prove the rule was followed, violated, or affected an outcome."
            : selectedContext.planner.id === "latest-analysis"
              ? "The selected latest analysis is a bounded prior validated result, not independent new account evidence."
              : "The selected application section is navigation context, not independent account evidence.";
    deterministic = {
      ...deterministic,
      qualitativeEvidence: [...deterministic.qualitativeEvidence, selectedContext.evidence],
      sources: [...deterministic.sources, { label: selectedContext.evidence.label }],
      limitations: [...new Set([...deterministic.limitations, epistemicLimitation])],
    };
  }
  let answer = deterministic;
  if (planningError) {
    answer = reasoningFallback(deterministic, planningError);
  } else if (isDirectImportFactPlan(plan) && deterministic.status === "completed") {
    // The model selected the import fact; the verified count itself needs no second model call.
    answer = deterministic;
  } else if (deterministic.status === "completed" || deterministic.status === "insufficient_data") {
    try {
      answer = await reasonAboutEvidence({ response: deterministic, recent: conversationContext, semanticPlan: plan, provider: provider ?? undefined, correlationId: requestId });
    } catch (error) {
      const safeError = error instanceof ReasoningProviderError ? error : new ReasoningProviderError("UNKNOWN");
      console.warn(JSON.stringify({
        event: "rikku.ask.reasoning_provider_failure",
        correlationId: requestId,
        category: safeError.code,
        status: safeError.safeProviderDetails?.status ?? null,
        providerCode: safeError.safeProviderDetails?.code ?? "",
        providerType: safeError.safeProviderDetails?.type ?? "",
        retryAfter: safeError.safeProviderDetails?.retryAfter ?? "",
        tokenReset: safeError.safeProviderDetails?.tokenReset ?? "",
        tokenLimit: safeError.safeProviderDetails?.tokenLimit ?? null,
        tokenUsed: safeError.safeProviderDetails?.tokenUsed ?? null,
        tokenRequested: safeError.safeProviderDetails?.tokenRequested ?? null,
      }));
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
