import "server-only";
import type { AskMode, AskReasoningPoint, AskResponse } from "@/lib/ask/types";
import {
  createReasoningProvider,
  modelOutputSchema,
  ReasoningProviderError,
  type ModelInterpretation,
  type ReasoningProvider,
} from "@/lib/ask/reasoning-provider";

export { ASK_MODEL_CONFIG, ReasoningProviderError } from "@/lib/ask/reasoning-provider";
export type { ModelInterpretation } from "@/lib/ask/reasoning-provider";

export type RecentAskExchange = {
  question: string;
  conclusion: string;
};

type ModelCall = (args: {
  mode: AskMode;
  prompt: string;
  retryInstruction?: string;
}) => Promise<unknown>;

function safeJson(value: unknown) {
  return JSON.stringify(value).slice(0, 24_000);
}

function modelPrompt(response: AskResponse, history: RecentAskExchange[], context: string | null) {
  const importLabels = new Set([
    "Orders imported",
    "Fills imported",
    "Financial records",
    "Instruments observed",
    "Market candles",
    "Completed trades",
    "Assets imported",
    "Positions imported",
  ]);
  const skeptic = response.toolRuns.find((tool) => tool.key === "run_skeptic_check") ?? null;
  const evidencePackage = {
    userQuestion: response.question,
    mode: response.mode,
    answerKind: response.answerKind,
    status: response.status,
    recentConversationContext: history.slice(-5),
    verifiedFacts: response.evidence.filter((item) => importLabels.has(item.label)),
    calculatedMetrics: response.evidence.filter((item) => !importLabels.has(item.label)),
    relevantMemories: response.qualitativeEvidence.filter((item) => item.kind === "memory"),
    relevantPatterns: response.qualitativeEvidence.filter((item) => item.kind === "pattern"),
    marketContext: response.marketContext,
    counterEvidence: [
      ...response.limitations,
      ...response.toolRuns.filter((tool) => tool.status === "insufficient_data").map((tool) => tool.summary),
    ],
    sampleSize: response.toolRuns.flatMap((tool) => tool.sampleSize === undefined ? [] : [{ analysis: tool.key, observations: tool.sampleSize }]),
    dataWindow: response.dataWindow,
    limitations: response.limitations,
    skepticResult: skeptic ? { status: skeptic.status, summary: skeptic.summary, confidence: response.confidence } : { status: "not_run", confidence: response.confidence },
    deterministicFinding: response.finding,
    sourceLabels: response.sources.map((source) => source.label),
    confidence: response.confidence,
    relevantStructuredContext: context,
  };
  return [
    "Answer as RIKKU, a read-only trading decision-intelligence assistant.",
    "The deterministic evidence package is authoritative for every numerical fact. Interpret relationships in it; never calculate, infer, or invent a new financial metric.",
    "Never invent PnL, win rate, fees, counts, probabilities, positions, drawdown, VaR, CVaR, confidence scores, or reconstructed trades.",
    `The only digit or percentage tokens allowed anywhere in the answer are: ${safeJson(allowedNumericTokens(response))}. Do not derive or introduce any other number.`,
    "Do not spell out, approximate, or rename a quantity; copy its supplied evidence wording exactly.",
    "Use only evidence labels that exist verbatim in verifiedFacts, calculatedMetrics, relevantMemories, or relevantPatterns. Keep limitations explicit and do not imply external research unless it appears in sourceLabels.",
    "Answer only the current information need and build on recentConversationContext. Do not restart with a generic import summary or repeat metrics that do not matter to this question.",
    "For a fact answer, be direct and brief and leave reasoningPoints empty unless one concise uncertainty is essential.",
    "For analysis, connect relevant evidence in at most four reasoning points. Include at most one observation, then prioritize a clearly labeled hypothesis, alternative, counter-evidence, uncertainty, or next investigation over listing more metrics.",
    "For investigation, compare multiple plausible explanations, surface counter-evidence and unresolved questions, and propose the next test that would reduce uncertainty.",
    "Every hypothesis must state why it is plausible, cite supporting evidence labels, mention what could contradict it, and provide a concrete test. Never present a hypothesis as fact.",
    "Do not infer or mention intent, emotion, discipline, fear, greed, revenge trading, panic, or desire unless that exact concept is directly supported by supplied evidence.",
    "When evidence is insufficient, say why, state what remains observable, and identify the additional evidence or analysis that would help.",
    "Before finalizing an analytical answer, challenge causation, sample size, missing history, market-condition explanations, contradictions, and whether another analyst could disagree.",
    response.mode === "scout" ? "Scout mode: be fast, focused, and minimal." : response.mode === "investigator" ? "Investigator mode: do deeper multi-evidence reasoning rather than merely writing more." : "Analyst mode: connect relevant sources, consider alternatives, and stay concise.",
    `Authoritative evidence package: ${safeJson(evidencePackage)}`,
  ].join("\n\n");
}

function normalizedWords(value: string) {
  return new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 2));
}

function jaccard(left: string, right: string) {
  const a = normalizedWords(left);
  const b = normalizedWords(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const word of a) if (b.has(word)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

export function isExcessivelyRepetitive(candidate: ModelInterpretation, recent: RecentAskExchange[]) {
  const text = `${candidate.finding.headline} ${candidate.finding.summary} ${candidate.interpretation} ${candidate.reasoningPoints.map((point) => point.statement).join(" ")}`;
  const opening = text.split(/(?<=[.!?])\s+/)[0]?.toLowerCase().trim() ?? "";
  return recent.slice(-5).some((exchange) => {
    const previous = exchange.conclusion.toLowerCase().trim();
    const previousOpening = previous.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
    return (opening.length > 20 && opening === previousOpening) || jaccard(text, previous) >= 0.76;
  });
}

function confidenceRank(value: AskResponse["confidence"]["level"]) {
  return value === "high" ? 3 : value === "moderate" ? 2 : value === "low" ? 1 : 0;
}

function allowedNumericTokens(response: AskResponse) {
  const allowedText = JSON.stringify({
    finding: response.finding,
    evidence: response.evidence,
    confidence: response.confidence,
    limitations: response.limitations,
    dataWindow: response.dataWindow,
    toolRuns: response.toolRuns,
  });
  return [...new Set(allowedText.match(/\b\d+(?:\.\d+)?%?\b/g) ?? [])];
}

function textHasUnsupportedNumericClaim(generated: string, response: AskResponse) {
  const allowed = new Set(allowedNumericTokens(response));
  if ((generated.match(/\b\d+(?:\.\d+)?%?\b/g) ?? []).some((value) => !allowed.has(value))) return true;
  const quantitativeWords = [
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "half", "third", "quarter", "double", "twice", "triple", "majority", "minority", "roughly", "approximately",
  ];
  const generatedWords = normalizedWords(generated);
  const allowedWords = normalizedWords(JSON.stringify({
    finding: response.finding,
    evidence: response.evidence,
    limitations: response.limitations,
    toolRuns: response.toolRuns,
  }));
  return quantitativeWords.some((word) => generatedWords.has(word) && !allowedWords.has(word));
}

function hasUnsupportedNumericClaim(candidate: ModelInterpretation, response: AskResponse) {
  return textHasUnsupportedNumericClaim(candidateText(candidate), response);
}

function candidateText(candidate: ModelInterpretation) {
  return [
    candidate.finding.headline,
    candidate.finding.summary,
    candidate.interpretation,
    ...candidate.reasoningPoints.flatMap((point) => [point.statement, point.rationale, point.test ?? ""]),
    ...candidate.confidenceReasons,
    ...candidate.limitations,
    ...candidate.suggestedFollowups,
  ].join(" ");
}

function textHasUnsupportedBehaviorClaim(generatedText: string, response: AskResponse) {
  const claimTerms = ["fear", "greed", "revenge", "discipline", "panic", "emotional", "intention", "intends", "wanted"];
  const generated = generatedText.toLowerCase();
  const supported = JSON.stringify({
    metrics: response.evidence,
    qualitativeEvidence: response.qualitativeEvidence,
    marketContext: response.marketContext,
    limitations: response.limitations,
  }).toLowerCase();
  const sentences = generated.split(/(?<=[.!?])\s+|[\r\n]+/).filter(Boolean);
  return claimTerms.some((term) => {
    if (supported.includes(term)) return false;
    return sentences.some((sentence) => {
      if (!sentence.includes(term)) return false;
      if (/\b(?:cannot|can't)(?: be)? ruled? out\b/.test(sentence)) return true;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const explicitNonInferenceBefore = new RegExp(`\\b(?:cannot|can't|unable to|do not|does not|not enough evidence to|insufficient evidence to|no evidence to|without evidence to|avoid)\\b[^.!?]{0,80}\\b${escaped}\\b`);
      const explicitNonInferenceAfter = new RegExp(`\\b${escaped}\\b[^.!?]{0,80}\\b(?:cannot be|can't be|is not|isn't|remains unknown|is unsupported)\\b`);
      return !explicitNonInferenceBefore.test(sentence) && !explicitNonInferenceAfter.test(sentence);
    });
  });
}

function hasUnsupportedBehaviorClaim(candidate: ModelInterpretation, response: AskResponse) {
  return textHasUnsupportedBehaviorClaim(candidateText(candidate), response);
}

function requiredFollowUpKind(question: string): AskReasoningPoint["kind"] | null {
  const lower = question.toLowerCase();
  if (/\bwhat do you notice\b.*\b(?:trading|activity)\b/.test(lower)) return "hypothesis";
  if (/\b(another explanation|alternative explanation|something else|could it be)\b/.test(lower)) return "alternative";
  if (/\b(evidence .*against|counter[- ]?evidence|weakens?|contradict)\b/.test(lower)) return "counter_evidence";
  if (/\b(change (?:your|the) conclusion|change your mind|investigat(?:e|ion) next|look at next|check next)\b/.test(lower)) return "next_investigation";
  if (/\b(most interesting|without overstating|infer)\b/.test(lower)) return "hypothesis";
  return null;
}

export function modelReasoningValidationFailures(candidate: ModelInterpretation, response: AskResponse) {
  const failures: string[] = [];
  const allowedLabels = new Set([
    ...response.evidence.map((item) => item.label),
    ...response.qualitativeEvidence.map((item) => item.label),
  ]);
  const referencedLabels = [
    ...candidate.evidenceLabels,
    ...candidate.reasoningPoints.flatMap((point) => point.evidenceLabels),
  ];
  if (candidate.answerKind !== response.answerKind) failures.push("ANSWER_KIND_MISMATCH");
  if (referencedLabels.some((label) => !allowedLabels.has(label))) failures.push("UNKNOWN_EVIDENCE_LABEL");
  if (hasUnsupportedNumericClaim(candidate, response)) failures.push("UNSUPPORTED_NUMERIC_CLAIM");
  if (hasUnsupportedBehaviorClaim(candidate, response)) failures.push("UNSUPPORTED_BEHAVIOR_CLAIM");
  if (candidate.answerKind === "fact" && candidate.reasoningPoints.length > 1) failures.push("FACT_TOO_MANY_REASONING_POINTS");
  if (candidate.answerKind !== "fact") {
    if (!candidate.reasoningPoints.some((point) => point.kind === "observation" || point.kind === "uncertainty")) failures.push("ANALYSIS_MISSING_OBSERVATION_OR_UNCERTAINTY");
    if (!candidate.reasoningPoints.some((point) => ["alternative", "counter_evidence", "uncertainty", "next_investigation"].includes(point.kind))) failures.push("ANALYSIS_MISSING_SKEPTIC_POINT");
    const required = requiredFollowUpKind(response.question);
    if (required && !candidate.reasoningPoints.some((point) => point.kind === required)) failures.push("REQUIRED_FOLLOWUP_KIND_MISSING");
  }
  if (candidate.reasoningPoints.some((point) => point.kind === "hypothesis"
    && !(point.evidenceLabels.length > 0 && point.rationale.trim() && point.test?.trim()))) {
    failures.push("HYPOTHESIS_INCOMPLETE");
  }
  return failures;
}

export function validateModelReasoning(candidate: ModelInterpretation, response: AskResponse) {
  return modelReasoningValidationFailures(candidate, response).length === 0;
}

function sanitizeEvidenceLabels(candidate: ModelInterpretation, response: AskResponse): ModelInterpretation {
  const allowed = new Set([
    ...response.evidence.map((item) => item.label),
    ...response.qualitativeEvidence.map((item) => item.label),
  ]);
  return {
    ...candidate,
    evidenceLabels: candidate.evidenceLabels.filter((label) => allowed.has(label)),
    reasoningPoints: candidate.reasoningPoints.map((point) => ({
      ...point,
      evidenceLabels: point.evidenceLabels.filter((label) => allowed.has(label)),
    })),
  };
}

function sanitizeUnsupportedClaims(candidate: ModelInterpretation, response: AskResponse): ModelInterpretation {
  const isSafe = (text: string) => !textHasUnsupportedNumericClaim(text, response)
    && !textHasUnsupportedBehaviorClaim(text, response);
  const safeSentences = (text: string, fallback: string) => {
    const safe = text.split(/(?<=[.!?])\s+|[\r\n]+/).map((sentence) => sentence.trim()).filter((sentence) => sentence && isSafe(sentence));
    return safe.join(" ") || fallback;
  };
  const safeFinding = {
    headline: safeSentences(candidate.finding.headline, response.finding.headline),
    summary: safeSentences(candidate.finding.summary, response.finding.summary),
  };
  const safeInterpretation = safeSentences(candidate.interpretation, response.interpretation);
  let reasoningPoints = candidate.reasoningPoints.filter((point) => {
    if (!isSafe(`${point.statement} ${point.rationale} ${point.test ?? ""}`)) return false;
    if (point.kind === "hypothesis" && !(point.evidenceLabels.length > 0 && point.rationale.trim() && point.test?.trim())) return false;
    return true;
  });
  if (candidate.answerKind !== "fact"
    && !reasoningPoints.some((point) => ["alternative", "counter_evidence", "uncertainty", "next_investigation"].includes(point.kind))) {
    const limitation = response.limitations.find(isSafe);
    if (limitation) {
      reasoningPoints = [...reasoningPoints, {
        kind: "uncertainty" as const,
        statement: limitation,
        rationale: "This limits how far the imported evidence can support the interpretation.",
        evidenceLabels: [],
        test: null,
      }].slice(0, 10);
    }
  }
  const required = candidate.answerKind === "fact" ? null : requiredFollowUpKind(response.question);
  if (required && !reasoningPoints.some((point) => point.kind === required)) {
    const supporting = response.evidence.find((item) => /share|time window|per active|interval|fees/i.test(item.label))
      ?? response.evidence[0];
    const templates: Record<Exclude<AskReasoningPoint["kind"], "observation" | "uncertainty">, { statement: string; rationale: string; test: string }> = {
      hypothesis: {
        statement: "The strongest observed pattern may be specific to the imported window rather than persistent.",
        rationale: "The evidence describes a bounded import window, so persistence remains a hypothesis rather than a fact.",
        test: "Compare the same evidence across later import windows.",
      },
      alternative: {
        statement: "A temporary market or execution context could produce the same observed pattern without making it persistent.",
        rationale: "The imported evidence is descriptive and does not isolate the cause of the activity pattern.",
        test: "Compare the pattern with available market context and later imports.",
      },
      counter_evidence: {
        statement: response.limitations[0] ?? "The current import does not contain enough outcome evidence to establish a persistent pattern.",
        rationale: "This limits the strength of the current interpretation.",
        test: "Re-evaluate after the missing evidence becomes available.",
      },
      next_investigation: {
        statement: "Compare the same observed pattern across later imports and available market context.",
        rationale: "That would test whether the current observation persists under different conditions.",
        test: "Run the same deterministic analysis after the next import window.",
      },
    };
    if (required !== "observation" && required !== "uncertainty") {
      const template = templates[required];
      reasoningPoints = [...reasoningPoints.slice(0, 3), {
        kind: required,
        ...template,
        evidenceLabels: supporting ? [supporting.label] : [],
      }];
    }
  }
  const confidenceReasons = candidate.confidenceReasons.filter(isSafe);
  const limitations = candidate.limitations.filter(isSafe);
  return {
    ...candidate,
    finding: safeFinding,
    interpretation: safeInterpretation,
    reasoningPoints,
    confidenceReasons: confidenceReasons.length ? confidenceReasons : response.confidence.reasons,
    limitations: limitations.length ? limitations : response.limitations,
    suggestedFollowups: candidate.suggestedFollowups.filter(isSafe),
  };
}

function normalizeModelPayload(payload: unknown, response: AskResponse) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const finding = record.finding && typeof record.finding === "object" && !Array.isArray(record.finding)
    ? record.finding as Record<string, unknown>
    : {};
  const allowedLabels = new Set([
    ...response.evidence.map((item) => item.label),
    ...response.qualitativeEvidence.map((item) => item.label),
  ]);
  const labels = (value: unknown, max: number) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && allowedLabels.has(item)).slice(0, max)
    : value;
  const boundedStrings = (value: unknown, max: number) => Array.isArray(value) ? value.slice(0, max) : value;
  const points = Array.isArray(record.reasoningPoints)
    ? record.reasoningPoints.map((point) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) return point;
      const item = point as Record<string, unknown>;
      return {
        kind: item.kind,
        statement: item.statement,
        rationale: item.rationale,
        evidenceLabels: labels(item.evidenceLabels, 8),
        test: item.test,
      };
    }).filter((point, index, all) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) return true;
      const kind = (point as Record<string, unknown>).kind;
      if (kind !== "observation") return true;
      return index === all.findIndex((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
        && (candidate as Record<string, unknown>).kind === "observation");
    }).slice(0, 4)
    : record.reasoningPoints;
  return {
    answerKind: record.answerKind,
    finding: { headline: finding.headline, summary: finding.summary },
    interpretation: record.interpretation,
    reasoningPoints: points,
    evidenceLabels: labels(record.evidenceLabels, 12),
    confidence: record.confidence,
    confidenceReasons: boundedStrings(record.confidenceReasons, 6),
    limitations: boundedStrings(record.limitations, 8),
    suggestedFollowups: boundedStrings(record.suggestedFollowups, 4),
  };
}

function safeValidationDiagnostic(
  parsed: ReturnType<typeof modelOutputSchema.safeParse> | null,
  response: AskResponse,
) {
  if (!parsed) return ["PROVIDER_INVALID_JSON"];
  if (!parsed.success) return parsed.error.issues.map((issue) => `SCHEMA:${issue.path.join(".") || "root"}:${issue.code}`);
  return modelReasoningValidationFailures(parsed.data, response);
}

function validationRetryCorrection(failures: string[], response: AskResponse) {
  const corrections: string[] = [];
  if (failures.includes("UNSUPPORTED_NUMERIC_CLAIM")) {
    corrections.push("Use no digits, percentages, spelled-out numbers, fractions, approximations, or quantitative adjectives except an exact value copied from the evidence package. Prefer citing an exact evidence label without restating its value.");
  }
  if (failures.includes("UNSUPPORTED_BEHAVIOR_CLAIM")) {
    corrections.push("Do not use the words fear, greed, revenge, discipline, panic, emotional, intention, intends, or wanted anywhere, including in caveats or negations.");
  }
  if (failures.includes("ANALYSIS_MISSING_OBSERVATION_OR_UNCERTAINTY")) {
    corrections.push("Include a reasoningPoints item whose kind is uncertainty and whose rationale is grounded in a supplied limitation.");
  }
  if (failures.includes("ANALYSIS_MISSING_SKEPTIC_POINT")) {
    corrections.push("Include a reasoningPoints item whose kind is uncertainty or counter_evidence and do not add a new factual claim to satisfy it.");
  }
  if (failures.includes("REQUIRED_FOLLOWUP_KIND_MISSING")) {
    const required = requiredFollowUpKind(response.question);
    if (required) corrections.push(`Include a reasoningPoints item whose kind is exactly ${required} and answer that follow-up directly.`);
  }
  return corrections.join(" ");
}

function mergeInterpretation(
  response: AskResponse,
  candidate: ModelInterpretation,
  provider: ReasoningProvider | null,
): AskResponse {
  const labels = new Set(candidate.evidenceLabels);
  const evidence = labels.size ? response.evidence.filter((metric) => labels.has(metric.label)) : response.evidence;
  const candidateConfidence = confidenceRank(candidate.confidence) <= confidenceRank(response.confidence.level)
    ? candidate.confidence
    : response.confidence.level;
  return {
    ...response,
    answerKind: candidate.answerKind,
    finding: candidate.finding,
    interpretation: candidate.interpretation,
    reasoningPoints: candidate.reasoningPoints as AskReasoningPoint[],
    evidence,
    confidence: {
      level: candidateConfidence,
      reasons: candidate.confidenceReasons.length ? candidate.confidenceReasons : response.confidence.reasons,
    },
    limitations: candidate.limitations.length ? candidate.limitations : response.limitations,
    suggestedFollowups: candidate.suggestedFollowups,
    reasoningStatus: "external_llm",
    reasoningProvider: provider ? { id: provider.id, model: provider.modelIdentifier(response.mode) } : undefined,
    reasoningNotice: undefined,
  };
}

export async function reasonAboutEvidence(args: {
  response: AskResponse;
  recent?: RecentAskExchange[];
  context?: string | null;
  callModel?: ModelCall;
  provider?: ReasoningProvider;
  correlationId?: string;
}) {
  const recent = (args.recent ?? []).slice(-5);
  const prompt = modelPrompt(args.response, recent, args.context ?? null);
  const provider = args.callModel ? null : args.provider ?? createReasoningProvider();
  const callModel = args.callModel ?? ((request) => provider!.generateStructuredResponse(request));
  const retryGuardrails = [
    "Your previous output failed RIKKU's evidence validation.",
    "Return exactly the required structure and cite only supplied evidence labels.",
    `The only digit or percentage tokens allowed anywhere in the answer are: ${safeJson(allowedNumericTokens(args.response))}. Do not derive or introduce any other number.`,
    "Do not spell out, approximate, or rename a quantity; copy its supplied evidence wording exactly.",
    "Do not mention fear, greed, revenge, discipline, panic, emotion, intent, or desire unless that exact concept appears in the supplied evidence.",
    "Keep hypotheses explicitly labeled and avoid unsupported behavioral claims.",
  ].join(" ");
  const parseAttempt = async (retryInstruction?: string) => {
    try {
      const payload = await callModel({ mode: args.response.mode, prompt, retryInstruction });
      const parsed = modelOutputSchema.safeParse(normalizeModelPayload(payload, args.response));
      return parsed.success
        ? { ...parsed, data: sanitizeUnsupportedClaims(sanitizeEvidenceLabels(parsed.data, args.response), args.response) }
        : parsed;
    } catch (error) {
      if (error instanceof ReasoningProviderError && error.code === "INVALID_RESPONSE") return null;
      throw error;
    }
  };
  let parsed = await parseAttempt();
  if (!parsed?.success || !validateModelReasoning(parsed.data, args.response)) {
    const firstFailures = safeValidationDiagnostic(parsed, args.response);
    if (args.correlationId) {
      console.warn(JSON.stringify({
        event: "rikku.ask.reasoning_validation",
        correlationId: args.correlationId,
        provider: provider?.id ?? "test",
        model: provider?.modelIdentifier(args.response.mode) ?? "injected",
        attempt: 1,
        failures: firstFailures,
      }));
    }
    parsed = await parseAttempt(`${retryGuardrails} ${validationRetryCorrection(firstFailures, args.response)}`.trim());
  }
  if (!parsed?.success || !validateModelReasoning(parsed.data, args.response)) {
    if (args.correlationId) {
      console.warn(JSON.stringify({
        event: "rikku.ask.reasoning_validation",
        correlationId: args.correlationId,
        provider: provider?.id ?? "test",
        model: provider?.modelIdentifier(args.response.mode) ?? "injected",
        attempt: 2,
        failures: safeValidationDiagnostic(parsed, args.response),
      }));
    }
    throw new ReasoningProviderError("INVALID_RESPONSE");
  }

  if (isExcessivelyRepetitive(parsed.data, recent)) {
    const retried = await parseAttempt("Answer only the new information need. Build on prior context instead of restating the previous response. Introduce new reasoning or evidence.");
    if (retried?.success && validateModelReasoning(retried.data, args.response)) parsed = retried;
  }
  return mergeInterpretation(args.response, parsed.data, provider);
}

export function reasoningFallback(response: AskResponse, error: ReasoningProviderError): AskResponse {
  const notice = error.code === "NOT_CONFIGURED"
    ? "External reasoning is not configured yet. The answer below comes directly from RIKKU's deterministic evidence engine."
    : "RIKKU's reasoning service is temporarily unavailable. Your imported data remains safe; the answer below comes directly from deterministic evidence.";
  return { ...response, reasoningStatus: "deterministic_fallback", reasoningProvider: undefined, reasoningNotice: notice };
}
