import "server-only";
import type { AskMode, AskReasoningPoint, AskResponse } from "@/lib/ask/types";
import type { SemanticToolPlan } from "@/lib/ask/semantic-planner";
import {
  createReasoningProvider,
  modelOutputSchema,
  synthesisOutputSchema,
  ReasoningProviderError,
  type ModelInterpretation,
  type ReasoningProvider,
} from "@/lib/ask/reasoning-provider";

export { ASK_MODEL_CONFIG, ReasoningProviderError } from "@/lib/ask/reasoning-provider";
export type { ModelInterpretation } from "@/lib/ask/reasoning-provider";

export type RecentAskExchange = {
  question: string;
  conclusion: string;
  findingId?: string | null;
};

export type SynthesisPlanContext = Pick<SemanticToolPlan,
  "understoodQuestion" | "informationNeeds" | "reasoningGoal" | "referencedPriorFindingIds" | "requiresJoinedAnalysis">;

type ModelCall = (args: {
  mode: AskMode;
  prompt: string;
  retryInstruction?: string;
  allowedEvidenceIds?: string[];
  jsonObjectRepair?: boolean;
}) => Promise<unknown>;

function synthesisPackage(response: AskResponse, history: RecentAskExchange[], semanticPlan?: SynthesisPlanContext | null) {
  // Record counts are not cost evidence. IDs refer only to facts actually sent.
  const evidence = response.evidence.filter((item) =>
    item.label !== "Financial records" && item.label !== "Financial records reviewed");
  const entries = [
    ...evidence,
    ...response.qualitativeEvidence,
  ].map((item, index) => ({ ...item, id: `E${index + 1}` }));
  const sources = response.sources.filter((source) => source.label !== "Bitget financial records");
  const validationResponse = { ...response, evidence, sources };
  const prompt = JSON.stringify({
    userQuestion: response.question,
    answerKind: response.answerKind,
    status: response.status,
    recentConversationContext: history.slice(-4).map((turn) => ({
      question: turn.question.slice(0, 400),
      conclusion: turn.conclusion.slice(0, 1_800),
      ...(turn.findingId ? { findingId: turn.findingId } : {}),
    })),
    semanticUnderstanding: semanticPlan ?? null,
    evidence: entries,
    deterministicFinding: response.finding,
    deterministicToolResults: response.toolRuns.map((tool) => ({
      key: tool.key, status: tool.status, summary: tool.summary,
      ...(tool.sampleSize !== undefined ? { sampleSize: tool.sampleSize } : {}),
    })),
    marketContext: response.marketContext,
    sourceLabels: sources.map((source) => source.label),
    dataWindow: response.dataWindow,
    limitations: response.limitations,
    confidence: response.confidence,
  });
  // Never cut serialized JSON or silently drop evidence used by the validator.
  if (prompt.length > 24_000) throw new ReasoningProviderError("INVALID_RESPONSE");
  return { prompt, validationResponse, labelsById: new Map(entries.map((item) => [item.id, item.label])) };
}

function normalizedWords(value: string) {
  return new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 2));
}

function claimClauses(value: string) {
  return value
    .split(/(?<=[.!?])\s+|[\r\n;]+|,\s*(?=(?:but|however|although|though|while|whereas|yet|not|no)\b)|\b(?:but|however|although|though|while|whereas|yet)\b/gi)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function canonicalNumericText(value: string) {
  return value
    .replace(/(?<=\d)[\u2010-\u2015](?=\d)/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u2212/g, "-");
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
  const text = `${candidate.finding.headline} ${candidate.finding.summary} ${candidate.interpretation} ${candidate.reasoningPoints.map((point) => point.statement).join(" ")}`.trim();
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

const numericTokenPattern = /(?<![A-Za-z0-9_.])[-+]?\d+(?:\.\d+)?%?/g;

function numericTokens(value: string): string[] {
  return [...(value.match(numericTokenPattern) ?? [])];
}

function adjacentNumericUnit(value: string, index: number, token: string) {
  if (token.endsWith("%")) return "%";
  const normalizeUnit = (raw: string | undefined) => {
    if (!raw) return "";
    if (/^[$€£]$/.test(raw)) return raw;
    if (/^[A-Z][A-Z0-9_-]{1,11}$/.test(raw) || /^(?:usd|usdt|usdc|btc|eth|eur|gbp|php|jpy)$/i.test(raw)) return raw.toLowerCase();
    return "";
  };
  const after = value.slice(index + token.length).match(/^\s*([A-Za-z][A-Za-z0-9_-]{1,11})\b/);
  if (after) return normalizeUnit(after[1]);
  const before = value.slice(0, index).match(/(?:^|\s)([$€£]|[A-Za-z]{2,10})\s*$/);
  return normalizeUnit(before?.[1]);
}

function allowedNumericTokens(response: AskResponse, modelVisibleOnly = false) {
  const allowedText = JSON.stringify({
    finding: modelVisibleOnly ? null : response.finding,
    evidence: modelVisibleOnly
      ? response.evidence.filter((item) => item.label !== "Financial records" && item.label !== "Financial records reviewed")
      : response.evidence,
    confidence: response.confidence,
    limitations: response.limitations,
    dataWindow: response.dataWindow,
    toolRuns: response.toolRuns,
    qualitativeEvidence: response.qualitativeEvidence,
  });
  return [...new Set(numericTokens(allowedText))];
}

function textHasUnsupportedNumericClaim(generated: string, response: AskResponse) {
  generated = canonicalNumericText(generated);
  const numberWord = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)";
  const spelledDecimalOrPercent = new RegExp(`\\b${numberWord}(?:\\s+point(?:\\s+${numberWord})+|\\s+percent)\\b`, "i");
  if (response.answerKind !== "fact" && spelledDecimalOrPercent.test(generated)) return true;
  const allowed = new Set(allowedNumericTokens(response));
  const assertions = [
    ...response.evidence.map((item) => `${item.label}: ${item.value} ${item.detail ?? ""}`),
    ...response.qualitativeEvidence.map((item) => `${item.label}: ${item.statement}`),
    ...response.toolRuns.map((tool) => `${tool.label}: ${tool.summary}`),
    ...response.confidence.reasons,
    response.finding.headline,
    response.finding.summary,
    response.interpretation,
    response.dataWindow.label ?? "",
    response.marketContext?.summary ?? "",
    response.marketContext?.regimeSummary ?? "",
  ].filter(Boolean);
  const metricPattern = /\b(execution\s+rows?|executions?|fills?|orders?|trades?|fees?|costs?|records?|candles?|positions?|assets?|instruments?|symbols?|days?|balance|pnl|profit|loss|returns?)\b/gi;
  const metricName = (value: string) => {
    const normalized = value.toLowerCase().replace(/\s+/g, "_").replace(/s$/, "");
    return normalized === "fee" || normalized === "cost" ? "fee_cost" : normalized;
  };
  const nearestMetric = (value: string, tokenIndex: number, token: string) => {
    const matches = [...value.matchAll(metricPattern)].map((match) => ({
      metric: metricName(match[0]),
      distance: Math.min(Math.abs((match.index ?? 0) - (tokenIndex + token.length)), Math.abs((match.index ?? 0) + match[0].length - tokenIndex)),
    })).filter((match) => match.distance <= 80).sort((a, b) => a.distance - b.distance);
    return matches[0]?.metric ?? "";
  };
  const contentWords = (value: string) => {
    const generic = new Set(["the", "and", "for", "are", "was", "were", "with", "from", "into", "that", "this", "only", "known", "available", "imported", "current", "latest", "data", "result"]);
    return new Set([...normalizedWords(value)].filter((word) => !generic.has(word) && !/^\d/.test(word)));
  };
  const sentences = claimClauses(generated);
  for (const sentence of sentences) {
    const unitized = sentence.match(/\b(?:per[-\s]+|each\s+|on each\s+)(fill|order|trade|execution)\b/i);
    const unitContext = sentence.replace(/\d+\.\d+/g, "decimal-value");
    const explicitlyNegatedUnit = /\b(?:not|no|without|rather than|unavailable|missing|lacks?|cannot|can't|does not|doesn't)\b[^.!?]{0,140}\b(?:per[-\s]+(?:fill|order|trade|execution)|(?:for|on)\s+each\s+(?:fill|order|trade|execution))\b/i.test(unitContext);
    for (const match of sentence.matchAll(numericTokenPattern)) {
      const token = match[0];
      const candidateUnit = adjacentNumericUnit(sentence, match.index, token);
      const candidateMetric = nearestMetric(sentence, match.index, token);
      if (!allowed.has(token)) return true;
      if (unitized && !explicitlyNegatedUnit) {
        const exactUnit = new RegExp(`\\b(?:per[-\\s]+|each\\s+|on each\\s+)${unitized[1]}\\b`, "i");
        if (!assertions.some((assertion) => assertion.includes(token) && exactUnit.test(assertion))) return true;
      }
      const nearby = contentWords(sentence);
      const supported = assertions.some((assertion) => {
        const normalizedAssertion = canonicalNumericText(assertion);
        const matchingTokens = [...normalizedAssertion.matchAll(numericTokenPattern)].filter((item) => item[0] === token);
        if (!matchingTokens.length) return false;
        const unitAndMetricMatch = matchingTokens.some((item) => adjacentNumericUnit(normalizedAssertion, item.index, token) === candidateUnit
          && (!candidateMetric || explicitlyNegatedUnit || nearestMetric(normalizedAssertion, item.index, token) === candidateMetric));
        return unitAndMetricMatch && [...contentWords(normalizedAssertion)].some((word) => nearby.has(word));
      });
      if (!supported) return true;
    }
  }
  const quantifiedFinancialClaim = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|dozen|couple|half|third|quarter|double|twice|triple|majority|minority|roughly|approximately)\b(?:\s+of)?(?:\s+the)?\s+(?:(?:valid|imported|completed|matched|observed|active|trading|financial|market|current|open|closed|reconstructed|native|quote|daily|account|separate)\s+){0,3}(fills?|executions?|execution\s+rows?|orders?|trades?|fees?|costs?|records?|candles?|positions?|assets?|instruments?|symbols?|days?|activity|history|balance|pnl|profit|loss|returns?)\b/gi;
  const exactNumberWords: Record<string, string> = {
    one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
    seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  };
  const allowedWords = normalizedWords(JSON.stringify({
    finding: response.finding,
    evidence: response.evidence,
    limitations: response.limitations,
    toolRuns: response.toolRuns,
  }));
  return [...generated.matchAll(quantifiedFinancialClaim)].some((match) => {
    const quantity = match[1].toLowerCase();
    if (quantity === "one" && /\bone\s+(?:can|cannot|can't|could|may|might|should|would|does|did|is|must)\b/i.test(match[0])) return false;
    const exactToken = exactNumberWords[quantity];
    const metricNoun = match[2]?.toLowerCase().replace(/s$/, "");
    if (exactToken && metricNoun && assertions.some((assertion) =>
      numericTokens(assertion).includes(exactToken) && new RegExp(`\\b${metricNoun}s?\\b`, "i").test(assertion))) return false;
    return !allowedWords.has(quantity);
  });
}

function hasUnsupportedNumericClaim(candidate: ModelInterpretation, response: AskResponse) {
  return unsupportedNumericClaimPaths(candidate, response).length > 0;
}

function candidateTextEntries(candidate: ModelInterpretation) {
  return [
    { path: "finding.headline", text: candidate.finding.headline },
    { path: "finding.summary", text: candidate.finding.summary },
    { path: "interpretation", text: candidate.interpretation },
    ...candidate.reasoningPoints.flatMap((point, index) => [
      { path: `reasoningPoints.${index}.statement`, text: point.statement },
      { path: `reasoningPoints.${index}.rationale`, text: point.rationale },
      { path: `reasoningPoints.${index}.test`, text: point.test ?? "" },
    ]),
    ...candidate.confidenceReasons.map((text, index) => ({ path: `confidenceReasons.${index}`, text })),
    ...candidate.limitations.map((text, index) => ({ path: `limitations.${index}`, text })),
    ...candidate.suggestedFollowups.map((text, index) => ({ path: `suggestedFollowups.${index}`, text })),
  ];
}

function candidateText(candidate: ModelInterpretation) {
  return candidateTextEntries(candidate).map((entry) => entry.text).join("\n");
}

const internalPlaceholder = /\[verified (?:value|quantity)\]/i;

function hasCoreInternalPlaceholder(candidate: ModelInterpretation) {
  return internalPlaceholder.test([
    candidate.finding.headline,
    candidate.finding.summary,
    candidate.interpretation,
    ...candidate.reasoningPoints.flatMap((point) => [point.statement, point.rationale, point.test ?? ""]),
  ].join("\n"));
}

function unsupportedNumericClaimPaths(candidate: ModelInterpretation, response: AskResponse) {
  return candidateTextEntries(candidate)
    .filter((entry) => textHasUnsupportedNumericClaim(entry.text, response))
    .map((entry) => {
      const normalized = canonicalNumericText(entry.text);
      const allowed = new Set(allowedNumericTokens(response));
      const hasUnlistedToken = numericTokens(normalized).some((token) => !allowed.has(token));
      const spelledQuantity = normalized.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|third|quarter|double|twice|triple|majority|minority|roughly|approximately)\b(?:\s+of)?(?:\s+the)?\s+(?:(?:valid|imported|completed|matched|observed|active|trading|financial|market|current|open|closed|reconstructed|native|quote|daily|account)\s+){0,3}(?:fills?|orders?|trades?|fees?|costs?|records?|candles?|positions?|assets?|instruments?|symbols?|days?|activity|history|balance|pnl|profit|loss|returns?)\b/i);
      const hasUnitization = /\b(?:per[-\s]+|each\s+|on each\s+)(?:fill|order|trade|execution)\b/i.test(normalized);
      const kind = hasUnlistedToken ? "unlisted_token" : spelledQuantity ? `spelled_${spelledQuantity[1].toLowerCase()}` : hasUnitization ? "reunitized" : "context_mismatch";
      return `${entry.path}:${kind}`;
    });
}

function textHasUnsupportedBehaviorClaim(generatedText: string, response: AskResponse) {
  const claimTerms = [
    "fear", "greed", "revenge", "discipline", "panic", "emotional", "intention", "intends", "wanted", "motive",
    "overtrading", "overtrade", "impulsive", "reckless", "fomo", "chasing", "impatience", "impatient", "anxiety", "anxious",
  ];
  const generated = generatedText.toLowerCase();
  const supportedStatements = response.toolRuns.filter((tool) => tool.status === "completed").map((tool) => tool.summary);
  const sentences = generated.split(/(?<=[.!?])\s+|[\r\n]+/).filter(Boolean);
  return claimTerms.some((term) => {
    const positivelySupported = supportedStatements.some((statement) => {
      const normalized = statement.toLowerCase();
      if (!normalized.includes(term)) return false;
      return !/\b(?:no|not|never|without|unknown|unverified|unsupported|cannot|can't|insufficient)\b[^.!?]{0,80}/i.test(normalized);
    });
    if (positivelySupported) return false;
    return sentences.some((sentence) => {
      if (!sentence.includes(term)) return false;
      if (/\b(?:cannot|can't)(?: be)? ruled? out\b/.test(sentence)) return true;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const explicitNonInferenceBefore = new RegExp(`\\b(?:cannot|can't|unable to|do not|does not|not|not enough evidence to|insufficient evidence to|no evidence to|without evidence to|avoid)\\b[^.!?]{0,80}\\b${escaped}\\b`);
      const explicitNonInferenceAfter = new RegExp(`\\b${escaped}\\b[^.!?]{0,80}\\b(?:cannot be|can't be|is not|isn't|remains unknown|is unsupported)\\b`);
      return !explicitNonInferenceBefore.test(sentence) && !explicitNonInferenceAfter.test(sentence);
    });
  });
}

function hasUnsupportedBehaviorClaim(candidate: ModelInterpretation, response: AskResponse) {
  return textHasUnsupportedBehaviorClaim(candidateText(candidate), response);
}

function hasUnsupportedOutcomeClaim(candidate: ModelInterpretation, response: AskResponse) {
  const explicitOutcomeEvidence = response.evidence.filter((item) =>
    /\b(?:completed trade|realized pnl|profit|loss|account return|trade return|win rate|drawdown|liquidation|cost basis|acquisition basis)\b/i.test(`${item.label} ${item.detail ?? ""}`)
      && !/\b(?:market|candle|regime)\b/i.test(item.label)
      && !/insufficient|unavailable|unknown|not calculated|not reconstructed|cannot|no verified/i.test(item.value));
  const explicitOutcomeTools = response.toolRuns.filter((tool) =>
    tool.status === "completed"
      && tool.key !== "analyze_market_context"
      && tool.key !== "analyze_market_regime"
      && /\b(?:pnl|profit|loss|return|win rate|drawdown|liquidation|winning|losing|made money|lost money|cost basis|acquisition basis)\b/i.test(tool.summary)
      && !/insufficient|unavailable|unknown|not calculated|not reconstructed|cannot|no verified/i.test(tool.summary));
  const verified = JSON.stringify({ evidence: explicitOutcomeEvidence, completedTools: explicitOutcomeTools }).toLowerCase();
  const outcomeTerms = [
    { pattern: /\b(?:cost|acquisition)[ -]basis\b/i, support: /\b(?:cost|acquisition)[ -]basis\b/i },
    { pattern: /\b(?:pnl|profit(?:able|ability|s)?|loss(?:es)?|return(?:s)?)\b/i, support: /\b(?:pnl|profit(?:able|ability|s)?|loss(?:es)?|return(?:s)?)\b/i },
    { pattern: /\bwin[ -]?rate\b/i, support: /\bwin[ -]?rate\b/i },
    { pattern: /\b(?:drawdown|liquidation)\b/i, support: /\b(?:drawdown|liquidation)\b/i },
    { pattern: /\b(?:made|lost|making|losing)\s+money\b|\b(?:winning|losing)\s+(?:trade|position)s?\b/i, support: /\b(?:made|lost|making|losing)\s+money\b|\b(?:winning|losing)\s+(?:trade|position)s?\b/i },
    { pattern: /\b(?:came|come|coming)\s+out\s+ahead\b/i, support: /\b(?:profit(?:able|ability|s)?|positive\s+(?:pnl|returns?)|made\s+money|winning)\b/i },
    { pattern: /\b(?:ended?|finish(?:ed)?)\s+(?:up\s+)?in\s+the\s+green\b/i, support: /\b(?:profit(?:able|ability|s)?|positive\s+(?:pnl|returns?)|made\s+money|winning)\b/i },
  ];
  // Tests and suggested follow-ups ask what to check next; they are not claims about the account.
  const assertions = candidateAssertionEntries(candidate)
    .filter((entry) => entry.kind !== "next_investigation")
    .map((entry) => entry.text);
  return assertions.flatMap(claimClauses).some((clause) => outcomeTerms.some(({ pattern, support }) => {
    if (!pattern.test(clause) || support.test(verified)) return false;
    const unresolved = /\b(?:cannot|can't|could not|not enough|insufficient|unknown|unavailable|unverified|unproven|uncertain|undetermined|missing|absent|no evidence|no verified|excluded?|omits?|omitted|leaves? out|left out|outside (?:the )?(?:available )?evidence|not (?:included|covered|calculated|established|proven|known)|(?:is|are|was|were|remain|remains) (?:not (?:available|known|verified|established|calculated|reconstructed)|speculative)|would be speculative|does not (?:include|cover|establish|show|support|demonstrate|prove|imply)|doesn't (?:include|cover|establish|show|support|demonstrate|prove|imply)|do not (?:show|support|demonstrate|prove|imply)|cannot (?:infer|conclude|determine)|can't (?:infer|conclude|determine)|do not have|would need|would require|need(?:s)? to|requires? more|whether|to (?:check|test|measure|calculate|determine|assess|investigate)|could (?:check|test|measure|calculate|determine|assess|investigate))\b/i;
    if (unresolved.test(clause)) return false;
    // A nearby explicit negation is a limitation, not an assertion of trading outcomes.
    const match = clause.match(pattern);
    if (!match || match.index === undefined) return true;
    const before = clause.slice(Math.max(0, match.index - 80), match.index);
    const after = clause.slice(match.index + match[0].length, match.index + match[0].length + 80);
    const negatedBefore = /\b(?:not|no|without|rather than)\b(?:\W+\w+){0,8}\W*$/i.test(before);
    const negatedAfter = /^(?:\W+\w+){0,8}\W*\b(?:not|unknown|unavailable|unverified|unproven|uncertain|unsupported)\b/i.test(after);
    return !negatedBefore && !negatedAfter;
  }));
}

function unsupportedItemizationClaimPaths(candidate: ModelInterpretation, response: AskResponse) {
  const verified = JSON.stringify({ evidence: response.evidence, toolRuns: response.toolRuns });
  if (/\bitemized\b/i.test(verified)) return [];
  const verifiedCoinBreakdown = response.evidence.some((item) => /known fill fees by (?:native )?coin/i.test(item.label));
  const assertions = candidateTextEntries(candidate).filter((entry) =>
    !entry.path.endsWith(".test") && !entry.path.startsWith("suggestedFollowups."));
  return assertions.flatMap((entry) => claimClauses(entry.text).flatMap((clause) => {
    const normalized = canonicalNumericText(clause);
    const unitContext = normalized.replace(/\d+\.\d+/g, "decimal-value");
    const describesVerifiedCoinBreakdown = verifiedCoinBreakdown
      && /\bitemized\b[^.!?]{0,60}\b(?:by|for each)\s+(?:native\s+)?(?:coin|currency|asset)\b/i.test(normalized);
    const claimsItemized = /\bitemized\b/i.test(normalized) && !describesVerifiedCoinBreakdown
      && !/\b(?:no|not|without|rather than|missing|lacks?|unavailable|unknown|cannot|can't)\b[^.!?]{0,70}\bitemized\b/i.test(normalized);
    const claimsPerExecution = /\b(?:fees?|costs?)\b[^.!?]{0,120}\b(?:for|on)\s+each\s+(?:fill|execution|order|trade)\b/i.test(normalized)
      || /\b(?:fees?|costs?)\b[^.!?]{0,120}\bper[-\s]+(?:fill|execution|order|trade)\b/i.test(normalized)
      || /\b(?:enumerates?|lists?|provides?|shows?)\b[^.!?]{0,80}\b(?:fees?|costs?)\b[^.!?]{0,80}\b(?:for|on)\s+each\s+(?:fill|execution|order|trade)\b/i.test(normalized);
    const explicitlyRejectsPerExecution = /\b(?:not|no|without|rather than|unavailable|missing|lacks?|cannot|can't|does not|doesn't)\b[^.!?]{0,140}\b(?:per[-\s]+(?:fill|execution|order|trade)|(?:for|on)\s+each\s+(?:fill|execution|order|trade))\b/i.test(unitContext);
    const rejectsAfterPerExecution = /\b(?:per[-\s]+(?:fill|execution|order|trade)|(?:for|on)\s+each\s+(?:fill|execution|order|trade))\b[^.!?]{0,100}\b(?:is|are|was|were|remain|remains)?\s*(?:not (?:available|included|provided|known|verified)|unavailable|missing|unknown|unverified|unsupported|not established)\b/i.test(unitContext);
    if (claimsPerExecution && !explicitlyRejectsPerExecution && !rejectsAfterPerExecution) return [`${entry.path}:per_execution`];
    if (claimsItemized) return [`${entry.path}:generic_itemized`];
    return [];
  }));
}

function hasUnsupportedItemizationClaim(candidate: ModelInterpretation, response: AskResponse) {
  return unsupportedItemizationClaimPaths(candidate, response).length > 0;
}

function hasUnsupportedFinancialRecordFeeClaim(candidate: ModelInterpretation, response: AskResponse) {
  const verifiedFeeAmount = response.evidence.some((item) => /financial[- ]record fees?/i.test(item.label)
    && !/\brecords?\b/i.test(item.value));
  if (verifiedFeeAmount) return false;
  const assertions = candidateAssertionEntries(candidate).map((entry) => entry.text);
  return assertions.flatMap(claimClauses).some((clause) => {
    const normalized = canonicalNumericText(clause);
    return /\bfinancial[- ]record fees?\b|\bfees?\s+(?:in|from|of)\s+(?:the\s+)?financial records?\b/i.test(normalized)
      || /\b(?:measured|known|verified|observed)\s+costs?\b[^.!?]{0,160}\bfinancial[- ]records?\b/i.test(normalized);
  });
}

function hasUnsupportedAggregationClaim(candidate: ModelInterpretation, response: AskResponse) {
  const authoritative = [
    ...response.evidence.map((item) => `${item.label}: ${item.value} ${item.detail ?? ""}`),
    ...response.toolRuns.filter((tool) => tool.status === "completed").map((tool) => tool.summary),
    response.finding.headline,
    response.finding.summary,
  ].map((value) => value.toLowerCase());
  const aggregations = [
    { claim: /\b(?:average|mean)\b/i, support: /\b(?:average|mean)\b/i, key: "average" },
    { claim: /\bmedian\b/i, support: /\bmedian\b/i, key: "median" },
    { claim: /\b(?:maximum|max|highest)\b/i, support: /\b(?:maximum|max|highest|top[- ]symbol)\b/i, key: "maximum" },
    { claim: /\b(?:minimum|min|lowest)\b/i, support: /\b(?:minimum|min|lowest)\b/i, key: "minimum" },
    { claim: /\b(?:total|sum|summed|grouped)\b/i, support: /\b(?:total|sum|summed|grouped|by (?:native )?coin|native[- ]quote notional)\b/i, key: "total" },
  ] as const;
  const domains = [
    { pattern: /\b(?:fees?|costs?|charges?)\b/i, key: "fees" },
    { pattern: /\b(?:intervals?|cadence)\b/i, key: "interval" },
    { pattern: /\b(?:ranges?|volatility)\b/i, key: "range" },
    { pattern: /\b(?:fills?|executions?|activity)\b/i, key: "activity" },
    { pattern: /\b(?:shares?|concentration)\b/i, key: "share" },
    { pattern: /\b(?:notional|value)\b/i, key: "notional" },
    { pattern: /\bprices?\b/i, key: "price" },
    { pattern: /\bquantit(?:y|ies)\b/i, key: "quantity" },
  ] as const;
  const domainPattern: Record<(typeof domains)[number]["key"], RegExp> = {
    fees: /\b(?:fees?|costs?|charges?)\b/i,
    interval: /\b(?:intervals?|cadence)\b/i,
    range: /\b(?:ranges?|volatility)\b/i,
    activity: /\b(?:fills?|executions?|activity)\b/i,
    share: /\b(?:shares?|concentration)\b/i,
    notional: /\b(?:notional|value)\b/i,
    price: /\bprices?\b/i,
    quantity: /\bquantit(?:y|ies)\b/i,
  };

  return candidateAssertionEntries(candidate)
    .filter((entry) => entry.kind !== "next_investigation" && entry.kind !== "hypothesis" && entry.kind !== "alternative")
    .some((entry) => claimClauses(entry.text).some((clause) => {
      const aggregation = aggregations.find((item) => item.claim.test(clause));
      if (!aggregation) return false;
      const claimedDomains = domains.filter((domain) => domain.pattern.test(clause)).map((domain) => domain.key);
      return !authoritative.some((assertion) => aggregation.support.test(assertion)
        && (!claimedDomains.length || claimedDomains.some((domain) => domainPattern[domain].test(assertion))));
    }));
}

type AssertionEntry = {
  path: string;
  text: string;
  kind: "finding" | "interpretation" | "confidence" | "limitation" | AskReasoningPoint["kind"];
  test: string | null;
  evidenceLabels: string[];
};

function candidateAssertionEntries(candidate: ModelInterpretation): AssertionEntry[] {
  return [
    { path: "finding.headline", text: candidate.finding.headline, kind: "finding", test: null, evidenceLabels: candidate.evidenceLabels },
    { path: "finding.summary", text: candidate.finding.summary, kind: "finding", test: null, evidenceLabels: candidate.evidenceLabels },
    { path: "interpretation", text: candidate.interpretation, kind: "interpretation", test: null, evidenceLabels: candidate.evidenceLabels },
    ...candidate.reasoningPoints.flatMap((point, index) => [
      { path: `reasoningPoints.${index}.statement`, text: point.statement, kind: point.kind, test: point.test, evidenceLabels: point.evidenceLabels },
      { path: `reasoningPoints.${index}.rationale`, text: point.rationale, kind: point.kind, test: point.test, evidenceLabels: point.evidenceLabels },
    ]),
    ...candidate.confidenceReasons.map((text, index) => ({ path: `confidenceReasons.${index}`, text, kind: "confidence" as const, test: null, evidenceLabels: [] })),
    ...candidate.limitations.map((text, index) => ({ path: `limitations.${index}`, text, kind: "limitation" as const, test: null, evidenceLabels: [] })),
  ];
}

function candidateContainingOnly(entry: AssertionEntry, candidate: ModelInterpretation): ModelInterpretation {
  const base: ModelInterpretation = {
    answerKind: candidate.answerKind,
    finding: { headline: "Grounded response", summary: "Grounded response" },
    interpretation: "Grounded response.",
    reasoningPoints: [],
    evidenceLabels: candidate.evidenceLabels,
    confidence: candidate.confidence,
    confidenceReasons: [],
    limitations: [],
    suggestedFollowups: [],
  };
  if (entry.path === "finding.headline") return { ...base, finding: { ...base.finding, headline: entry.text } };
  if (entry.path === "finding.summary") return { ...base, finding: { ...base.finding, summary: entry.text } };
  if (entry.path === "interpretation") return { ...base, interpretation: entry.text };
  if (entry.kind === "confidence") return { ...base, confidenceReasons: [entry.text] };
  if (entry.kind === "limitation") return { ...base, limitations: [entry.text] };
  if (entry.kind === "finding" || entry.kind === "interpretation") return base;
  return {
    ...base,
    reasoningPoints: [{
      kind: entry.kind,
      statement: entry.text,
      rationale: "Grounded response.",
      evidenceLabels: entry.evidenceLabels,
      test: entry.test,
    }],
  };
}

function unsupportedClaimPaths(
  candidate: ModelInterpretation,
  response: AskResponse,
  predicate: (isolated: ModelInterpretation, response: AskResponse) => boolean,
) {
  return candidateAssertionEntries(candidate)
    .filter((entry) => predicate(candidateContainingOnly(entry, candidate), response))
    .map((entry) => entry.path);
}

function isExplicitlyUnresolved(clause: string, relationIndex: number) {
  const boundary = /\b(?:and|but|even\s+though|although|though|however|while|whereas|yet|despite|nevertheless)\b/i;
  const before = clause.slice(Math.max(0, relationIndex - 120), relationIndex).split(boundary).at(-1) ?? "";
  const after = clause.slice(relationIndex, relationIndex + 140).split(boundary)[0] ?? "";
  return /\b(?:cannot|can't|could not|unknown|unavailable|unverified|unproven|uncertain|undetermined|not established|not proven|no evidence|no joined|no basis|does not (?:establish|show|support|demonstrate|prove|imply)|do not (?:establish|show|support|demonstrate|prove|imply|calculate)|cannot (?:infer|conclude|determine)|can't (?:infer|conclude|determine)|would need|would require|whether|to (?:check|test|measure|calculate|determine|assess|investigate))\b/i.test(`${before} ${after}`)
    || /^\s*(?:compare|check|test|measure|calculate|determine|assess|investigate)\b/i.test(clause)
    || /\bdescriptive rather than causal\b|\bnot (?:a )?causal\b|\bcausality (?:is )?not established\b/i.test(clause)
    || /\b(?:cause|driver|explanation|relationship|association|correlation)\s+(?:is |remains? )?(?:unknown|unresolved|unverified|unproven)\b/i.test(clause)
    || /\b(?:cannot|can't)\s+be\s+(?:inferred|concluded|determined|established|verified|proven|calculated)\b/i.test(`${before} ${after}`)
    || /\bno\s+(?:verified|supported|calculated|established|proven)\s+(?:causal\s+)?(?:relationship|association|correlation|link)\b/i.test(clause)
    || /\b(?:relationship|association|correlation|link)\s+(?:between|among)\b[^,;.!?]{0,120}\b(?:cannot|can't)\s+be\s+(?:established|verified|proven|calculated|determined)\b/i.test(clause)
    || /\b(?:relationship|association|correlation|link)\s+(?:(?:cannot|can't)\s+be|(?:is|was|remains?)\s+not)\s+(?:established|verified|proven|calculated|determined)\b/i.test(clause)
    || /\bnot\s+(?:its|the|a|an)?\s*(?:cause|driver|explanation|relationship|association|correlation)\b/i.test(clause)
    || /\b(?:does not|doesn't|cannot|can't)\s+(?:explain|identify|determine|establish|prove)\b/i.test(`${before} ${after}`)
    || /\b(?:has|have|had)\s+not\s+been\s+(?:checked|verified|established|tested)\b/i.test(`${before} ${after}`);
}

function hasUnsupportedAssociationClaim(candidate: ModelInterpretation, response: AskResponse) {
  const deterministicStatements = [
    ...response.evidence.flatMap((item) => [item.value, item.detail ?? ""]),
    ...response.toolRuns.filter((tool) => tool.status === "completed").map((tool) => tool.summary),
    response.marketContext?.summary ?? "",
    response.marketContext?.regimeSummary ?? "",
  ];
  const joinedAssociationVerified = deterministicStatements.some((statement) =>
    /\b(?:joined|paired|matched)\b[^.!?]{0,80}\b(?:association|correlation|relationship|effect)\b/i.test(statement)
      && !/\b(?:no|not|cannot|can't|unavailable|insufficient|does not|do not)\b/i.test(statement));
  if (joinedAssociationVerified) return false;

  const causal = /\b(?:cause[ds]?|caused|causing|causal|drive|drives|drove|driven|driving|driver|drivers|explain|explains|explained|explaining|due to|because of|led to|leads? to|resulted? in|predicts?|predicted|influenc(?:e|es|ed|ing))\b/i;
  const association = /\b(?:align|aligns|aligned|coincide|coincides|coincided|correlate|correlates|correlated|correlation|associated|association|relationship|links?|linked|tracks?|tracked)\b/i;
  const financialDomain = /\b(?:activity|timing|range|volatility|fees?|costs?|symbol|concentration|market|fills?|orders?|trades?|outcomes?|returns?|prices?|regime|notional|risk)\b/i;
  return candidateAssertionEntries(candidate).some((entry) => {
    if (entry.kind === "next_investigation") return false;
    return entry.text.split(/(?<=[.!?])\s+|[\r\n;]+|(?:,\s*|\s+)(?:but|even\s+though|although|though|however|while|whereas|yet|despite|nevertheless)\b/i).some((clause) => {
      const causalMatch = clause.match(causal);
      const associationMatch = clause.match(association);
      const match = causalMatch ?? (associationMatch && financialDomain.test(clause) ? associationMatch : null);
      if (!match || match.index === undefined || isExplicitlyUnresolved(clause, match.index)) return false;
      const isStructuredAlternative = entry.kind === "hypothesis" || entry.kind === "alternative";
      const isTentative = /\b(?:could|may|might|possibly|plausibly|hypothesis|alternative|possibility)\b/i.test(clause);
      if (isStructuredAlternative && isTentative && entry.test && entry.evidenceLabels.length) return false;
      if ((entry.kind === "interpretation" || entry.kind === "finding")
        && /\b(?:hypothesis|(?:a |an )?(?:plausible )?alternative(?: explanation)?|one possibility)\b/i.test(clause) && isTentative) return false;
      return true;
    });
  });
}

function hasUnsupportedRelativeJudgment(candidate: ModelInterpretation, response: AskResponse) {
  const deterministicStatements = [
    ...response.evidence.flatMap((item) => [`${item.label}: ${item.value}`, item.detail ?? ""]),
    ...response.toolRuns.filter((tool) => tool.status === "completed").map((tool) => tool.summary),
    response.marketContext?.summary ?? "",
    response.marketContext?.regimeSummary ?? "",
  ].filter(Boolean);
  const metricPattern = /\b(range|volatility|fees?|costs?|activity|concentration|notional|risk|frequency|interval)\b/i;
  const relativePattern = /\b(high|higher|low|lower|large|larger|small|smaller|modest|extreme|unusual|volatile|wider|narrower)\b/i;
  const family = (word: string) => ({ high: "high", higher: "high", low: "low", lower: "low", large: "large", larger: "large", small: "small", smaller: "small", wide: "wide", wider: "wide", narrow: "narrow", narrower: "narrow", volatile: "volatile" }[word] ?? word);
  return candidateAssertionEntries(candidate).some((entry) => {
    if (entry.kind === "next_investigation") return false;
    return entry.text.split(/(?<=[.!?])\s+|[\r\n;]+|(?:,\s*|\s+)(?:but|however|although|though|whereas|yet|despite|nevertheless)\b/i).some((clause) => {
      const normalizedClause = clause.replace(/\bhigh[\-\u2010-\u2015\u2212 ]low(?=\s+range\b)/gi, "intraday");
      const metric = normalizedClause.match(metricPattern)?.[1]?.toLowerCase();
      const relative = normalizedClause.match(relativePattern)?.[1]?.toLowerCase();
      if (!metric || !relative) return false;
      if (/\bconfidence\b[^.!?]{0,24}\b(?:low|high)\b|\b(?:low|high)\s+confidence\b/i.test(normalizedClause)) return false;
      if (/\b(?:small|limited)\s+(?:sample|dataset|data set|window|history)\b/i.test(normalizedClause)) return false;
      if (/\b(?:cannot|can't|unknown|unavailable|unverified|uncertain|no benchmark|no baseline|no basis|without (?:a )?(?:benchmark|baseline)|not enough evidence|insufficient evidence|not supported|does not (?:support|justify|establish|show|calculate|determine|compare)|do not (?:support|justify|establish|show|calculate|determine|compare)|would need|whether|to (?:check|test|compare|determine|assess)|cannot be (?:judged|characterized|classified))\b/i.test(normalizedClause)) return false;
      const supported = deterministicStatements.some((statement) => {
        if (/\b(?:no|not|without|unavailable|insufficient|cannot|can't|missing)\b[^.!?]{0,80}\b(?:benchmark|baseline|comparison|average)\b/i.test(statement)) return false;
        const normalizedStatement = statement
          .replace(/[\u2010-\u2015\u2212]/g, "-")
          .replace(/\bhigh-low(?=\s+range\b)/gi, "intraday");
        const supportedMetric = normalizedStatement.match(metricPattern)?.[1]?.toLowerCase();
        const supportedRelative = normalizedStatement.match(relativePattern)?.[1]?.toLowerCase();
        return supportedMetric === metric && Boolean(supportedRelative) && family(supportedRelative!) === family(relative);
      });
      return !supported;
    });
  });
}

function hasUnsupportedExternalContextClaim(candidate: ModelInterpretation, response: AskResponse) {
  const evidence = JSON.stringify({ evidence: response.evidence, qualitativeEvidence: response.qualitativeEvidence, marketContext: response.marketContext, toolRuns: response.toolRuns, sources: response.sources }).toLowerCase();
  const external = /\b(?:news|economic events?|event calendar|release schedules?|market[- ]makers?|liquidity windows?|liquidity spikes?|coinbase|binance|on[- ]chain|fed(?:eral reserve)?|fomc|social sentiment)\b/i;
  const hasStructuredExternalAlternative = candidate.reasoningPoints.some((point) =>
    (point.kind === "hypothesis" || point.kind === "alternative")
      && external.test(`${point.statement} ${point.rationale}`)
      && /\b(?:could|may|might|possibly|plausibly|hypothesis|alternative|possibility)\b/i.test(point.statement)
      && Boolean(point.test) && point.evidenceLabels.length > 0);
  const genericSource = /\b(?:according to|reported by|data from|research from|analysis from)\s+(?:the\s+)?([a-z][a-z0-9&.-]*(?:\s+[a-z][a-z0-9&.-]*){0,2})|\b(?:a|an|the)?\s*([a-z][a-z0-9&.-]*)\s+(?:data|research|reports?|analysis|stud(?:y|ies)|metrics?|datasets?|figures?)\s+(?:confirms?|shows?|indicates?|suggests?|finds?|reports?)\b|\b(?!(?:is|are|was|were|be|been|being|do|does|did|not|cannot|will|would|could|should|may|might)\b)([a-z][a-z0-9&.-]*)\s+(?:says?|said|reports?|reported|confirms?|confirmed|shows?|showed|finds?|found|indicates?|indicated|suggests?|suggested)\b/gi;
  const genericEvidenceWords = new Set(["rikku", "bitget", "deterministic", "verified", "import", "imported", "current", "available", "account", "market", "evidence", "data", "analysis", "tool", "record", "records", "result", "results", "fee", "fees", "fill", "fills", "order", "orders", "this", "that", "it", "there"]);
  return candidateAssertionEntries(candidate).some((entry) => entry.text.split(/(?<=[.!?])\s+|[\r\n;]+/).some((clause) => {
    const explicitlyUnsupported = /\b(?:unknown|unverified|not provided|not available|no evidence|metadata only|contents? (?:was|were|is|are) not (?:provided|verified)|would need|to (?:check|test|investigate))\b/i.test(clause);
    for (const sourceMatch of clause.matchAll(genericSource)) {
      // In this bounded account-data subject, "recent" modifies data; it is
      // not a publisher. Other matches and all claim validators still apply.
      const accountDataSubject = sourceMatch[2]?.toLowerCase() === "recent"
        && /\byour\s*$/i.test(clause.slice(0, sourceMatch.index))
        && /^\s*recent\s+data\s+(?:confirms?|shows?|indicates?|suggests?|finds?|reports?)$/i.test(sourceMatch[0]);
      if (accountDataSubject) continue;
      const source = (sourceMatch[1] ?? sourceMatch[2] ?? sourceMatch[3] ?? "").trim().toLowerCase().replace(/^the\s+/, "");
      const sourceHead = source.split(/\s+/)[0];
      const metadataOnly = response.qualitativeEvidence.some((item) => item.kind === "research" && item.statement.toLowerCase().includes(sourceHead));
      if (source && metadataOnly && !explicitlyUnsupported) return true;
      if (source && !genericEvidenceWords.has(sourceHead) && !evidence.includes(source)) return true;
    }
    const match = clause.match(external);
    if (!match || evidence.includes(match[0].toLowerCase())) return false;
    if (explicitlyUnsupported) return false;
    const isTentative = /\b(?:could|may|might|possibly|plausibly|hypothesis|alternative|possibility)\b/i.test(clause);
    const claimsExternalKnowledge = /\b(?:typical|known|usually|commonly|historically|scheduled|confirmed|occurred)\b/i.test(clause);
    const structuredAlternative = (entry.kind === "hypothesis" || entry.kind === "alternative") && entry.test && entry.evidenceLabels.length;
    if (structuredAlternative && isTentative && !claimsExternalKnowledge) return false;
    if (/^\s*(?:compare|check|test|investigate|obtain|collect)\b/i.test(clause)) return false;
    if ((entry.kind === "finding" || entry.kind === "interpretation") && hasStructuredExternalAlternative
      && /\b(?:hypothesis|(?:a |an )?(?:plausible )?alternative(?: explanation)?|one possibility)\b/i.test(clause) && isTentative && !claimsExternalKnowledge) return false;
    return true;
  }));
}

function hasUnsupportedSelectedContextClaim(candidate: ModelInterpretation, response: AskResponse) {
  const selected = response.qualitativeEvidence.filter((item) =>
    item.label.startsWith("Selected RIKKU") || item.classification === "prior_validated_analysis");
  if (!selected.length) return false;
  const assertions = candidateAssertionEntries(candidate).filter((entry) => entry.kind !== "next_investigation");
  return assertions.some((entry) => {
    const text = entry.text;
    const explicitlyLimited = /\b(?:not|cannot|can't|unknown|unverified|not established|does not prove|metadata only|contents? (?:was|were|is|are) not (?:provided|verified))\b/i.test(text);
    return selected.some((item) => {
      if (item.classification === "prior_validated_analysis") {
        const epistemicUpgrade = /\b(?:independent(?:ly)?|pro(?:of|ven|ves?)|confirm(?:s|ed|ation)?|establish(?:es|ed)?|definitive(?:ly)?|persistent|persistence|persist(?:s|ed)?|generaliz(?:e|es|ed|ation)|enduring|stable (?:pattern|trait)|across (?:other|future|all) (?:windows?|periods?))\b/i;
        const bounded = /\b(?:not|cannot|can't|does not|doesn't|within (?:the|its|this) (?:import(?:ed)? )?window only|only within (?:the|its|this) (?:import(?:ed)? )?window|bounded (?:to|within)|not independent|not evidence of|does not generalize|persistence (?:is )?(?:not|unproven|unknown))\b/i;
        if (claimClauses(text).some((clause) => epistemicUpgrade.test(clause) && !bounded.test(clause))) return true;
        return false;
      }
      if (explicitlyLimited) return false;
      if (item.kind === "memory" && item.classification !== "fact"
        && /\b(?:fact|proven|proves?|established|verified|confirmed|definitive)\b/i.test(text)) return true;
      if (item.kind === "pattern" && item.status !== "validated"
        && /\b(?:proven|proves?|established|verified|confirmed|definitive)\b/i.test(text)) return true;
      if (item.kind === "research"
        && /\b(?:the (?:article|source|research)|its (?:analysis|data|findings?))\b[^.!?]{0,80}\b(?:says?|reports?|shows?|confirms?|finds?|indicates?|proves?)\b/i.test(text)) return true;
      if (item.kind === "rule"
        && /\b(?:you|the account|the trader)\b[^.!?]{0,80}\b(?:followed|violated|broke|obeyed|ignored|adhered|complied)\b/i.test(text)) return true;
      return false;
    });
  });
}

function hasUnsupportedCategoricalClaim(candidate: ModelInterpretation, response: AskResponse) {
  const deterministicText = JSON.stringify({
    finding: response.finding,
    evidence: response.evidence,
    qualitativeEvidence: response.qualitativeEvidence,
    marketContext: response.marketContext,
    toolRuns: response.toolRuns,
    limitations: response.limitations,
  });
  const deterministicLower = deterministicText.toLowerCase();
  const groundedCodes = new Set(deterministicText.match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? []);
  const structuralAcronyms = new Set(["RIKKU", "UTC", "API", "LLM", "AI", "PNL", "VAR", "CVAR"]);
  const assertions = candidateAssertionEntries(candidate).filter((entry) => entry.kind !== "next_investigation");

  for (const entry of assertions) {
    for (const code of entry.text.match(/\b[A-Z][A-Z0-9]{1,9}\b/g) ?? []) {
      if (!structuralAcronyms.has(code) && !groundedCodes.has(code)) return true;
    }
  }

  const hasZeroOrMissing = (noun: "asset" | "position" | "completed trade") => {
    const nounPattern = noun === "completed trade" ? /completed trades?/i : new RegExp(`${noun}s?`, "i");
    return response.evidence.some((item) => nounPattern.test(item.label)
      && /^(?:0|none|not (?:yet )?(?:available|reconstructable|reconstructed))$/i.test(item.value.trim()))
      || new RegExp(String.raw`\b(?:no|zero)\s+(?:current\s+)?${noun.replace(" ", String.raw`\s+`)}s?\b`, "i").test(deterministicText)
      || (noun === "completed trade" && /completed trades? cannot (?:yet )?be reconstructed|completed trades?: not yet reconstructable/i.test(deterministicText));
  };
  const positiveAvailability = /\b(?:available|present|open|active|held|holding|holdings|exist|exists|reconstructed)\b/i;
  const explicitNegation = /\b(?:no|not|none|without|unavailable|missing|cannot|can't|zero|unknown|unverified|insufficient)\b/i;
  for (const entry of assertions) {
    for (const clause of claimClauses(entry.text)) {
      if (explicitNegation.test(clause)) continue;
      // A locally absent trade noun is not positive availability. Inspect the
      // remaining clause so this cannot hide another asserted account state.
      const availabilityClause = clause.replace(/\b(?:lack|absence)\s+of\s+(?:verified\s+)?(?:completed|reconstructed)\s+trades?\b/gi, "");
      if (/\bassets?\b/i.test(availabilityClause) && positiveAvailability.test(availabilityClause) && hasZeroOrMissing("asset")) return true;
      if (/\bpositions?\b/i.test(availabilityClause) && positiveAvailability.test(availabilityClause) && hasZeroOrMissing("position")) return true;
      if (/\b(?:completed|reconstructed) trades?\b/i.test(availabilityClause) && positiveAvailability.test(availabilityClause) && hasZeroOrMissing("completed trade")) return true;
    }
  }

  const metricValue = (label: RegExp) => response.evidence.find((item) => label.test(item.label))?.value ?? "";
  const symbolEvidence = response.evidence
    .filter((item) => /(?:activity by symbol|top-symbol activity share)/i.test(item.label))
    .map((item) => item.value)
    .join(" ");
  const groundedSymbols = new Set((symbolEvidence.match(/\b[A-Z0-9]{4,14}(?=\s*:)/g) ?? []).map((value) => value.toLowerCase()));
  const activityBySymbol = metricValue(/activity by symbol/i);
  const symbolCounts = new Map([...activityBySymbol.matchAll(/\b([A-Z0-9]{4,14})\s*:\s*(\d+)\b/g)]
    .map((match) => [match[1].toLowerCase(), Number(match[2])] as const));
  const topSymbolEvidence = metricValue(/top-symbol activity share/i).match(/^\s*([A-Z0-9]{4,14})\s*:/i)?.[1]?.toLowerCase();
  const maximumSymbolCount = symbolCounts.size ? Math.max(...symbolCounts.values()) : null;
  const busiestSymbols = new Set(maximumSymbolCount === null
    ? topSymbolEvidence ? [topSymbolEvidence] : []
    : [...symbolCounts].filter(([, count]) => count === maximumSymbolCount).map(([symbol]) => symbol));
  const feeEvidence = metricValue(/known fill fees by coin/i);
  const groundedFeeCoins = new Set([...feeEvidence.matchAll(/\b\d+(?:\.\d+)?\s+([A-Z][A-Z0-9]{1,9})\b/g)].map((match) => match[1].toLowerCase()));
  const timeEvidence = metricValue(/most active time window/i).toLowerCase();
  const regimeEvidence = metricValue(/five-candle market regime/i).toLowerCase();
  const unsupportedTimeWords = /\b(?:morning|afternoon|evening|overnight|midday|noon|midnight|dawn|dusk)\b/gi;
  const unsupportedRegimeWords = /\b(?:bullish|bearish|sideways|uptrend|downtrend|neutral|calm|turbulent)\b/gi;
  const uncertainty = /\b(?:no|not|cannot|can't|unknown|unavailable|insufficient|unclear|does not|doesn't|would need|not establish)\b/i;
  const feeCodeStopWords = new Set(["a", "an", "the", "this", "that", "known", "fill", "fills", "level", "trading", "execution", "transaction", "commission", "network", "grouped", "native", "total", "account", "exchange", "observed", "recorded", "itemized", "available", "imported", "separate", "separately", "window"]);

  for (const entry of assertions) {
    for (const clause of claimClauses(entry.text)) {
      if (uncertainty.test(clause)) continue;
      for (const symbol of clause.match(/\b[a-z0-9]{2,10}(?:usdt|usdc|usd|btc|eth)\b/gi) ?? []) {
        if (!groundedSymbols.has(symbol.toLowerCase())) return true;
      }
      const marketCandidates = [
        ...[...clause.matchAll(/\b([a-z][a-z0-9]{1,13})\s+(?:was|is|appears?|became)\s+(?:the\s+)?(?:busiest|dominant|top|most active)\s+(?:market|symbol|instrument)\b/gi)].map((match) => match[1]),
        ...[...clause.matchAll(/\b(?:busiest|dominant|top|most active)\s+(?:market|symbol|instrument)\s+(?:was|is|appears? to be)\s+([a-z][a-z0-9]{1,13})\b/gi)].map((match) => match[1]),
      ].map((value) => value.toLowerCase());
      if (marketCandidates.some((symbol) => !groundedSymbols.has(symbol))) return true;
      if (busiestSymbols.size && marketCandidates.some((symbol) => !busiestSymbols.has(symbol))) return true;
      if (/\b(?:fees?|costs?|charges?)\b/i.test(clause)) {
        const feeCandidates = [
          ...[...clause.matchAll(/\b(?:fees?|costs?|charges?)\s+(?:(?:were|are|was|is)\s+)?(?:paid|denominated|recorded)?\s*in\s+([a-z][a-z0-9]{1,11})\b/gi)].map((match) => match[1]),
          ...[...clause.matchAll(/\b([a-z][a-z0-9]{1,11})\s+(?:fees?|costs?|charges?)\b/gi)].map((match) => match[1]),
          ...[...clause.matchAll(/\b(?:denominated|paid|charged)\s+in\s+([a-z][a-z0-9]{1,11})\b/gi)].map((match) => match[1]),
        ].map((value) => value.toLowerCase()).filter((value) => (value.length <= 6 || groundedSymbols.has(value)) && !feeCodeStopWords.has(value));
        if (feeCandidates.some((coin) => !groundedFeeCoins.has(coin))) return true;
      }
      for (const word of clause.match(unsupportedTimeWords) ?? []) {
        if (!timeEvidence.includes(word.toLowerCase())) return true;
      }
      for (const word of clause.match(unsupportedRegimeWords) ?? []) {
        const normalized = word.toLowerCase();
        if (/^(?:neutral|calm|turbulent)$/.test(normalized) && !/\b(?:market|regime|trend|candle|price)\b/i.test(clause)) continue;
        if (!regimeEvidence.includes(normalized)) return true;
        const count = regimeEvidence.match(new RegExp(`(?:^|\u00b7)\\s*(\\d+)\\s+${normalized}\\b`));
        if (count && Number(count[1]) === 0) return true;
      }
      const regimeCounts = new Map([...regimeEvidence.matchAll(/(?:^|\u00b7)\s*(\d+)\s+(uptrend|downtrend|neutral)\b/g)]
        .map((match) => [match[2], Number(match[1])] as const));
      const exclusiveRegime = clause.match(/\b(?:all|only|every|exclusively)\b[^.!?]{0,80}\b(uptrend|downtrend|neutral)\b|\b(uptrend|downtrend|neutral)\b[^.!?]{0,80}\b(?:all|only|every|exclusively)\b/i);
      const claimedRegime = (exclusiveRegime?.[1] ?? exclusiveRegime?.[2])?.toLowerCase();
      if (claimedRegime && [...regimeCounts].some(([regime, count]) => regime !== claimedRegime && count > 0)) return true;
      const dominantRegime = clause.match(/\b(uptrend|downtrend|neutral)\b[^.!?]{0,80}\b(?:dominant|dominated|most common|most frequent|prevalent)\b|\b(?:dominant|most common|most frequent|prevalent)\b[^.!?]{0,80}\b(uptrend|downtrend|neutral)\b/i);
      const claimedDominantRegime = (dominantRegime?.[1] ?? dominantRegime?.[2])?.toLowerCase();
      if (claimedDominantRegime && regimeCounts.size) {
        const maximumRegimeCount = Math.max(...regimeCounts.values());
        if ((regimeCounts.get(claimedDominantRegime) ?? -1) < maximumRegimeCount) return true;
      }
    }
  }

  const fullMatch = deterministicText.match(/matched\s+(\d+)\s+of\s+(\d+)\s+fills?/i);
  if (fullMatch && Number(fullMatch[1]) === Number(fullMatch[2])) {
    if (assertions.some((entry) => /\b(?:only\s+)?(?:a\s+)?subset\s+of\s+(?:the\s+)?fills?\b|\b(?:some|part)\s+of\s+(?:the\s+)?fills?\b/i.test(entry.text)
      && !/\b(?:not|isn't|is not)\s+(?:only\s+)?(?:a\s+)?subset\b/i.test(entry.text))) return true;
  }

  const sideMetric = response.evidence.find((item) => /buy\s*\/\s*sell fills?/i.test(item.label));
  const sideCounts = sideMetric?.value.match(/(\d+)\s+buy\b[^\d]*(\d+)\s+sell\b/i);
  if (sideCounts) {
    const buyCount = Number(sideCounts[1]);
    const sellCount = Number(sideCounts[2]);
    for (const entry of assertions) {
      for (const text of claimClauses(entry.text)) {
        const positiveSidePresence = /\b(?:present|observed|available|recorded|occurred|appear|appeared|exist|exists|included|contains?)\b/i;
        if ((buyCount === 0 || sellCount === 0)
          && /\bboth\s+buys?\s+and\s+sells?\b|\bbuys?\s+and\s+sells?\b[^.!?]{0,60}\b(?:present|observed|available|recorded|occurred|appear|appeared|exist|exists|included)\b/i.test(text)
          && !explicitNegation.test(text)) return true;
        if (buyCount === 0 && /\bbuys?\b/i.test(text) && positiveSidePresence.test(text) && !explicitNegation.test(text)) return true;
        if (sellCount === 0 && /\bsells?\b/i.test(text) && positiveSidePresence.test(text) && !explicitNegation.test(text)) return true;
        if (/\b(?:all|only|every|exclusively)\b[^.!?]{0,60}\bbuys?\b|\bbuys?\b[^.!?]{0,60}\b(?:all|only|every|exclusively)\b/i.test(text)) {
          if (sellCount > 0) return true;
        }
        if (/\b(?:all|only|every|exclusively)\b[^.!?]{0,60}\bsells?\b|\bsells?\b[^.!?]{0,60}\b(?:all|only|every|exclusively)\b/i.test(text)) {
          if (buyCount > 0) return true;
        }
        if (/\b(?:mostly|majority|predominantly|more)\b[^.!?]{0,60}\bbuys?\b/i.test(text) && buyCount <= sellCount) return true;
        if (/\b(?:mostly|majority|predominantly|more)\b[^.!?]{0,60}\bsells?\b/i.test(text) && sellCount <= buyCount) return true;
        const buyDominance = /\bbuys?\b[^.!?]{0,60}\b(?:dominant|dominat(?:e|ed|es|ing)|outnumber(?:ed|s|ing)?|most common|more common|most frequent|more frequent|prevalent)\b|\b(?:dominant|most common|most frequent|prevalent)\b[^.!?]{0,60}\bbuys?\b/i;
        const sellDominance = /\bsells?\b[^.!?]{0,60}\b(?:dominant|dominat(?:e|ed|es|ing)|outnumber(?:ed|s|ing)?|most common|more common|most frequent|more frequent|prevalent)\b|\b(?:dominant|most common|most frequent|prevalent)\b[^.!?]{0,60}\bsells?\b/i;
        if (!explicitNegation.test(text) && buyDominance.test(text) && buyCount <= sellCount) return true;
        if (!explicitNegation.test(text) && sellDominance.test(text) && sellCount <= buyCount) return true;
      }
    }
  } else if (/\b(?:all|only|every|mostly|majority|predominantly)\b[^.!?]{0,60}\b(?:buys?|sells?)\b/i.test(candidateText(candidate))
    && !/\b(?:all|only|every|mostly|majority|predominantly)\b[^.!?]{0,60}\b(?:buys?|sells?)\b/i.test(deterministicLower)) {
    return true;
  }
  return false;
}

function hasUngroundedDomainClaim(candidate: ModelInterpretation, response: AskResponse) {
  const deterministic = JSON.stringify({
    evidence: response.evidence,
    qualitativeEvidence: response.qualitativeEvidence,
    marketContext: response.marketContext,
    toolRuns: response.toolRuns,
  }).toLowerCase();
  const domains = [
    { claim: /\b(?:clock|time[- ]of[- ]day|timing|hourly|utc\s+hour|fill\s+times?|cadence)\b/i, support: /\b(?:most active time window|time[- ]of[- ]day|timing|utc\s+hour|fill timestamps?|interval between fills?|fill intervals?|cadence)\b/i },
    { claim: /\b(?:fees?|costs?|charges?)\b/i, support: /\b(?:fees?|costs?|charges?)\b/i },
    { claim: /\b(?:candles?|market context|market regime|daily range)\b/i, support: /\b(?:candles?|market context|market regime|daily range|high[\-\u2010-\u2015\u2212 ]low range|intraday range)\b/i },
    { claim: /\b(?:symbols?|instruments?|markets?)\b/i, support: /\b(?:symbols?|instruments?|markets?)\b/i },
    { claim: /\b(?:assets?|positions?|portfolio)\b/i, support: /\b(?:assets?|positions?|portfolio)\b/i },
  ];
  const unresolved = /\b(?:no|not|cannot|can't|unknown|unavailable|missing|unverified|not analyzed|not calculated|would need|requires? more|insufficient)\b/i;
  const explicitlyTentative = /\b(?:could|may|might|possibly|plausibly|plausible explanation|hypothesis|alternative explanation|one possibility)\b/i;
  return candidateAssertionEntries(candidate).some((entry) => {
    if (entry.kind === "next_investigation" || entry.kind === "hypothesis" || entry.kind === "alternative") return false;
    return claimClauses(entry.text).some((clause) => {
      if (/^\s*(?:compare|check|test|measure|analyze|inspect|investigate|obtain|collect)\b/i.test(clause)) return false;
      return !unresolved.test(clause) && !explicitlyTentative.test(clause)
        && domains.some((domain) => domain.claim.test(clause) && !domain.support.test(deterministic));
    });
  });
}

function hasUnsupportedConfidenceClaim(candidate: ModelInterpretation, response: AskResponse) {
  if (confidenceRank(response.confidence.level) >= confidenceRank("high")) return false;
  const overclaim = /\b(?:high confidence|strong evidence|compelling evidence|conclusive evidence|definitive evidence|certainly|definitively|this proves|proven conclusion)\b/i;
  return candidateAssertionEntries(candidate).some((entry) => entry.text.split(/(?<=[.!?])\s+|[\r\n;]+/).some((clause) => {
    const match = clause.match(overclaim);
    if (!match || match.index === undefined) return false;
    const before = clause.slice(Math.max(0, match.index - 70), match.index);
    return !/\b(?:not|no|cannot|can't|without|insufficient|isn't|is not)\b/i.test(before);
  }));
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
  if (hasCoreInternalPlaceholder(candidate)) failures.push("INTERNAL_PLACEHOLDER");
  if (referencedLabels.some((label) => !allowedLabels.has(label))) failures.push("UNKNOWN_EVIDENCE_LABEL");
  if (hasUnsupportedNumericClaim(candidate, response)) failures.push("UNSUPPORTED_NUMERIC_CLAIM");
  if (hasUnsupportedBehaviorClaim(candidate, response)) failures.push("UNSUPPORTED_BEHAVIOR_CLAIM");
  if (hasUnsupportedOutcomeClaim(candidate, response)) failures.push("UNSUPPORTED_OUTCOME_CLAIM");
  if (hasUnsupportedItemizationClaim(candidate, response)) failures.push("UNSUPPORTED_ITEMIZATION_CLAIM");
  if (hasUnsupportedFinancialRecordFeeClaim(candidate, response)) failures.push("UNSUPPORTED_FINANCIAL_RECORD_FEE_CLAIM");
  if (hasUnsupportedAggregationClaim(candidate, response)) failures.push("UNSUPPORTED_AGGREGATION_CLAIM");
  if (hasUnsupportedAssociationClaim(candidate, response)) failures.push("UNSUPPORTED_ASSOCIATION_CLAIM");
  if (hasUnsupportedRelativeJudgment(candidate, response)) failures.push("UNSUPPORTED_RELATIVE_JUDGMENT");
  if (hasUnsupportedExternalContextClaim(candidate, response)) failures.push("UNSUPPORTED_EXTERNAL_CONTEXT_CLAIM");
  if (hasUnsupportedCategoricalClaim(candidate, response)) failures.push("UNSUPPORTED_CATEGORICAL_CLAIM");
  if (hasUngroundedDomainClaim(candidate, response)) failures.push("UNGROUNDED_DOMAIN_CLAIM");
  if (hasUnsupportedSelectedContextClaim(candidate, response)) failures.push("UNSUPPORTED_SELECTED_CONTEXT_CLAIM");
  if (hasUnsupportedConfidenceClaim(candidate, response)) failures.push("UNSUPPORTED_CONFIDENCE_CLAIM");
  if (confidenceRank(candidate.confidence) > confidenceRank(response.confidence.level)) failures.push("UNSUPPORTED_CONFIDENCE");
  if (candidate.answerKind === "fact" && candidate.reasoningPoints.length > 1) failures.push("FACT_TOO_MANY_REASONING_POINTS");
  if (candidate.answerKind !== "fact" && response.evidence.length > 0 && !referencedLabels.length) failures.push("ANALYSIS_UNGROUNDED");
  if (response.status === "insufficient_data" && !candidate.limitations.length) failures.push("MISSING_DATA_LIMITATION");
  if (candidate.reasoningPoints.some((point) => point.kind === "hypothesis"
    && !(point.evidenceLabels.length > 0 && point.rationale.trim() && point.test?.trim()))) {
    failures.push("HYPOTHESIS_INCOMPLETE");
  }
  return failures;
}

export function validateModelReasoning(candidate: ModelInterpretation, response: AskResponse) {
  return modelReasoningValidationFailures(candidate, response).length === 0;
}

function safeValidationDiagnostic(
  parsed: ReturnType<typeof modelOutputSchema.safeParse> | null,
  response: AskResponse,
) {
  if (!parsed) return ["PROVIDER_INVALID_JSON"];
  if (!parsed.success) return parsed.error.issues.map((issue) => `SCHEMA:${issue.path.join(".") || "root"}:${issue.code}`);
  const failures = modelReasoningValidationFailures(parsed.data, response);
  if (failures.includes("UNSUPPORTED_NUMERIC_CLAIM")) {
    failures.push(...unsupportedNumericClaimPaths(parsed.data, response).slice(0, 6).map((path) => `UNSUPPORTED_NUMERIC_CLAIM_PATH:${path}`));
  }
  if (failures.includes("UNSUPPORTED_ITEMIZATION_CLAIM")) {
    failures.push(...unsupportedItemizationClaimPaths(parsed.data, response).slice(0, 6).map((path) => `UNSUPPORTED_ITEMIZATION_CLAIM_PATH:${path}`));
  }
  const diagnosticPredicates = [
    ["UNSUPPORTED_OUTCOME_CLAIM", hasUnsupportedOutcomeClaim],
    ["UNSUPPORTED_ASSOCIATION_CLAIM", hasUnsupportedAssociationClaim],
    ["UNSUPPORTED_RELATIVE_JUDGMENT", hasUnsupportedRelativeJudgment],
    ["UNSUPPORTED_EXTERNAL_CONTEXT_CLAIM", hasUnsupportedExternalContextClaim],
    ["UNSUPPORTED_CATEGORICAL_CLAIM", hasUnsupportedCategoricalClaim],
    ["UNGROUNDED_DOMAIN_CLAIM", hasUngroundedDomainClaim],
  ] as const;
  for (const [failure, predicate] of diagnosticPredicates) {
    if (!failures.includes(failure)) continue;
    failures.push(...unsupportedClaimPaths(parsed.data, response, predicate).slice(0, 6).map((path) => `${failure}_PATH:${path}`));
  }
  return failures;
}

function mergeInterpretation(
  response: AskResponse,
  candidate: ModelInterpretation,
  provider: ReasoningProvider | null,
): AskResponse {
  const candidateConfidence = confidenceRank(candidate.confidence) <= confidenceRank(response.confidence.level)
    ? candidate.confidence
    : response.confidence.level;
  return {
    ...response,
    answerKind: candidate.answerKind,
    finding: candidate.finding,
    interpretation: candidate.interpretation,
    reasoningPoints: candidate.reasoningPoints as AskReasoningPoint[],
    evidence: response.evidence,
    confidence: {
      level: candidateConfidence,
      reasons: [...new Set([...response.confidence.reasons, ...candidate.confidenceReasons.filter((text) => !internalPlaceholder.test(text))])],
    },
    limitations: [...new Set([...response.limitations, ...candidate.limitations.filter((text) => !internalPlaceholder.test(text))])],
    suggestedFollowups: response.suggestedFollowups,
    reasoningStatus: "external_llm",
    reasoningProvider: provider ? { id: provider.id, model: provider.modelIdentifier(response.mode) } : undefined,
    reasoningNotice: undefined,
  };
}

export async function reasonAboutEvidence(args: {
  response: AskResponse;
  recent?: RecentAskExchange[];
  semanticPlan?: SynthesisPlanContext | null;
  callModel?: ModelCall;
  provider?: ReasoningProvider;
  correlationId?: string;
}) {
  const recent = (args.recent ?? []).slice(-5);
  const { prompt, validationResponse, labelsById } = synthesisPackage(args.response, recent, args.semanticPlan);
  const provider = args.callModel ? null : args.provider ?? createReasoningProvider();
  const callModel = args.callModel ?? ((request) => provider!.generateStructuredResponse(request));
  const deterministicPrefix = `${args.response.finding.headline} ${args.response.finding.summary} `;
  const answerContext = recent.map((turn) => ({
    ...turn,
    conclusion: turn.conclusion.startsWith(deterministicPrefix)
      ? turn.conclusion.slice(deterministicPrefix.length) : turn.conclusion,
  }));
  const attempt = async (retryInstruction?: string): Promise<{ candidate?: ModelInterpretation; failures: string[]; rejected?: unknown }> => {
    let payload: unknown;
    try {
      payload = await callModel({
        mode: args.response.mode, prompt, retryInstruction,
        allowedEvidenceIds: [...labelsById.keys()],
        ...(retryInstruction ? { jsonObjectRepair: true } : {}),
      });
    } catch (error) {
      if (!(error instanceof ReasoningProviderError) || error.code !== "INVALID_RESPONSE") throw error;
      // One application-validated JSON-object repair is allowed if native output fails.
      return { failures: ["PROVIDER_INVALID_JSON"] };
    }
    const parsed = synthesisOutputSchema.safeParse(payload);
    if (!parsed.success) return { failures: parsed.error.issues.map((issue) => `SCHEMA:${issue.path.join(".") || "root"}:${issue.code}`) };
    const result = parsed.data;
    if (result.evidenceIds.some((id) => !labelsById.has(id))) return { failures: ["UNKNOWN_EVIDENCE_ID:evidenceIds"], rejected: result };
    // Preserve every model-authored claim, including uncertainty, for validation.
    const interpretation = [result.answer, result.uncertainty].filter(Boolean).join("\n\n");
    if (interpretation.length > 1_200) return { failures: ["SCHEMA:answer:too_big"], rejected: result };
    const candidate: ModelInterpretation = {
      answerKind: args.response.answerKind,
      finding: args.response.finding,
      interpretation,
      reasoningPoints: [],
      evidenceLabels: result.evidenceIds.map((id) => labelsById.get(id)!),
      confidence: args.response.confidence.level,
      confidenceReasons: [],
      limitations: result.uncertainty ? [result.uncertainty] : [],
      suggestedFollowups: [],
    };
    const failures = safeValidationDiagnostic({ success: true, data: candidate }, validationResponse);
    // Repeated deterministic headings are not repeated model answers.
    if (!failures.length && isExcessivelyRepetitive({ ...candidate, finding: { headline: "", summary: "" } }, answerContext)) {
      failures.push("EXCESSIVE_REPETITION");
    }
    return { candidate, failures, rejected: result };
  };
  let result = await attempt();
  for (let index = 1; result.failures.length; index += 1) {
    if (args.correlationId) console.warn(JSON.stringify({
      event: "rikku.ask.reasoning_validation", correlationId: args.correlationId,
      provider: provider?.id ?? "test", model: provider?.modelIdentifier(args.response.mode) ?? "injected",
      attempt: index, failures: result.failures,
    }));
    if (index === 2) throw new ReasoningProviderError("INVALID_RESPONSE");
    const corrections = [
      result.failures.includes("UNSUPPORTED_NUMERIC_CLAIM")
        ? args.response.answerKind === "fact"
          ? "Numeric failure: copy the exact requested metric label and value in a standalone sentence; do not combine metrics, approximate, rename units or spell out counts."
          : "Numeric failure: remove numerical restatements from this analytical answer and uncertainty, including spelled-out counts and fractions. The interface already displays the quantities. Interpret the cited observations qualitatively instead."
        : "",
      result.failures.includes("UNSUPPORTED_ASSOCIATION_CLAIM") ? "Association failure: remove unsupported association as well as causation (align, correlate, link, explain, drive, due to). Matching a candle to a fill is context, not a verified relationship between activity and price. State observations separately and missing evidence directly." : "",
      result.failures.includes("UNSUPPORTED_RELATIVE_JUDGMENT") ? "Relative-size failure: no supplied comparison baseline supports modest, high, low, large, small, unusual, wider or narrower for this metric. Remove the size judgment; retain only the supported observation." : "",
      result.failures.includes("UNSUPPORTED_CATEGORICAL_CLAIM") ? "Categorical failure: remove unsupported currencies, symbols, time labels or account states; use supplied categories only and state missing availability explicitly." : "",
      result.failures.includes("UNSUPPORTED_EXTERNAL_CONTEXT_CLAIM") ? "Source failure: do not attribute findings to external sources or unsupplied events. Refer only to the supplied evidence." : "",
    ].filter(Boolean).join(" ");
    // Same question, context and evidence; exactly one repair, never relaxed checks.
    result = await attempt(`Exact validation failures: ${JSON.stringify(result.failures)}. Rejected draft: ${JSON.stringify(result.rejected ?? null)}. Rewrite the answer to fix ONLY these failures. Use only supplied evidence. Return valid output matching the schema. ${corrections} Answer the new information need without repeating the previous answer.`);
  }
  if (!result.candidate) throw new ReasoningProviderError("INVALID_RESPONSE");
  return mergeInterpretation(args.response, result.candidate, provider);
}

export function reasoningFallback(response: AskResponse, error: ReasoningProviderError): AskResponse {
  const notice = error.code === "NOT_CONFIGURED"
    ? "External reasoning is not configured yet. The answer below comes directly from RIKKU's deterministic evidence engine."
    : "RIKKU's reasoning service is temporarily unavailable. Your imported data remains safe; the answer below comes directly from deterministic evidence.";
  return { ...response, reasoningStatus: "deterministic_fallback", reasoningProvider: undefined, reasoningNotice: notice };
}
