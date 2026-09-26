import { describe, expect, it, vi } from "vitest";
import { ASK_TOOL_BUDGETS, type AskDataSource, type AskFill, type AskMarketCandle, type AskToolKey } from "@/lib/ask/types";
import { askDataFingerprintInput, orchestrateAsk, planAskTools } from "@/lib/ask/orchestrator";
import type { SemanticToolPlan } from "@/lib/ask/semantic-planner";

const coverageStart = "2026-07-08T06:26:10.790Z";
const coverageEnd = "2026-08-04T01:02:55.542Z";
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];

function daysAfter(start: string, days: number) {
  return new Date(Date.parse(start) + days * 86_400_000).toISOString();
}

const fills: AskFill[] = Array.from({ length: 12 }, (_, index) => ({
  category: "SPOT",
  symbol: symbols[index % symbols.length],
  side: index % 2 ? "sell" : "buy",
  executionPrice: String(100 + index),
  executionQuantity: "1",
  executionValue: String(100 + index),
  feeAmount: "0.1",
  feeCoin: "USDT",
  executedAt: daysAfter(coverageStart, index < 6 ? index : index + 15),
}));

const candles: AskMarketCandle[] = symbols.flatMap((symbol) => Array.from({ length: 87 }, (_, index) => ({
  category: "SPOT",
  symbol,
  observedAt: daysAfter("2026-06-01T00:00:00.000Z", index),
  open: String(100 + index),
  high: String(103 + index),
  low: String(98 + index),
  close: String(101 + index),
})));

function source(overrides: Partial<AskDataSource> = {}): AskDataSource {
  return {
    getConnectionStatus: vi.fn(async () => ({ connected: true, lastSyncedAt: "2026-09-18T00:00:00.000Z" })),
    getLatestCompletedImport: vi.fn(async () => ({
      id: "synthetic-import", completedAt: "2026-09-18T00:00:00.000Z",
      orders: 12, fills: 12, financialRecords: 43, assets: 0, positions: 0,
      instruments: 5, marketCandles: 435, completedTrades: 0,
      earliestRecordAt: coverageStart, latestRecordAt: coverageEnd,
    })),
    getFills: vi.fn(async () => fills),
    getFinancialRecords: vi.fn(async () => Array.from({ length: 43 }, () => ({ coin: "USDT", recordType: "fee", fee: "99", amount: null, recordedAt: coverageStart }))),
    getInstruments: vi.fn(async () => symbols.map((symbol) => ({ category: "SPOT", symbol, quoteCoin: "USDT" }))),
    getMarketCandles: vi.fn(async () => candles),
    getMemories: vi.fn(async () => []),
    getPatterns: vi.fn(async () => []),
    ...overrides,
  };
}

function semanticPlan(toolRequests: AskToolKey[], overrides: Partial<SemanticToolPlan> = {}): SemanticToolPlan {
  return {
    understoodQuestion: "Inspect the selected verified evidence.",
    informationNeeds: ["Evidence-backed account observations"],
    toolRequests: ["get_import_summary", ...toolRequests],
    needsConversationContext: false,
    referencedPriorFindingIds: [],
    analysisDepth: "focused",
    reasoningGoal: "Explain only what the selected evidence supports.",
    requiresJoinedAnalysis: false,
    answerKind: "analysis",
    requestedImportMetric: null,
    ...overrides,
  };
}

describe("Ask RIKKU deterministic orchestration", () => {
  it("answers the primary real imported-activity question from imported evidence only", async () => {
    const result = await orchestrateAsk({
      source: source(), mode: "analyst", question: "Analyze my imported Bitget activity.",
      plan: semanticPlan(["analyze_trading_activity", "analyze_fees", "analyze_symbol_concentration", "analyze_trade_timing"]),
    });

    expect(result.status).toBe("completed");
    expect(result.finding.headline).toContain("12 imported fills");
    expect(result.dataWindow.label).toBe("Jul 8 – Aug 4, 2026");
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Orders imported", value: "12" }),
      expect.objectContaining({ label: "Fills imported", value: "12" }),
      expect.objectContaining({ label: "Financial records", value: "43" }),
      expect.objectContaining({ label: "Instruments observed", value: "5" }),
      expect.objectContaining({ label: "Market candles", value: "435" }),
      expect.objectContaining({ label: "Active trading days" }),
      expect.objectContaining({ label: "Average interval between fills" }),
      expect.objectContaining({ label: "Known fill fees by coin", value: expect.stringContaining("USDT") }),
      expect.objectContaining({ label: "Activity by symbol" }),
      expect.objectContaining({ label: "Valid native-quote notional", value: expect.stringContaining("USDT") }),
      expect.objectContaining({ label: "Most active time window" }),
    ]));
    expect(result.evidence.map((metric) => metric.value).join(" ")).not.toContain("99");
    expect(result.limitations).toContain("Completed trades cannot yet be reconstructed because opening inventory inside the imported Bitget history window is unknown.");
    expect(result.limitations.join(" ").toLowerCase()).toContain("win rate");
    expect(result.confidence.level).toBe("low");
    expect(result.sources.map((entry) => entry.label)).toEqual(expect.arrayContaining([
      "Bitget import summary", "Bitget fills", "Bitget financial records",
    ]));
    expect(result.toolRuns.map((tool) => tool.key)).toEqual(expect.arrayContaining([
      "get_import_summary", "analyze_trading_activity", "analyze_fees", "analyze_symbol_concentration",
      "analyze_trade_timing", "run_skeptic_check",
    ]));
    expect(result.toolRuns).toHaveLength(ASK_TOOL_BUDGETS.analyst);
  });

  it("enforces mode budgets and a mandatory Skeptic pass without keyword routing", async () => {
    const requested = semanticPlan([
      "analyze_fees", "analyze_trade_timing", "analyze_market_context", "analyze_market_regime",
      "analyze_symbol_concentration", "retrieve_memories", "retrieve_patterns", "analyze_trading_activity",
      "analyze_tail_risk", "analyze_overtrading", "analyze_disposition_effect", "retrieve_similar_scenarios",
    ]);
    const scoutPlan = planAskTools("scout", requested);
    const analystPlan = planAskTools("analyst", requested);
    const investigatorPlan = planAskTools("investigator", requested);
    expect(scoutPlan).toEqual(["get_import_summary", "analyze_fees", "run_skeptic_check"]);
    expect(analystPlan.length).toBeLessThanOrEqual(ASK_TOOL_BUDGETS.analyst);
    expect(investigatorPlan.length).toBeLessThanOrEqual(ASK_TOOL_BUDGETS.investigator);
    expect(investigatorPlan.length).toBeGreaterThan(analystPlan.length);

    const scoutSource = source();
    const scout = await orchestrateAsk({ source: scoutSource, mode: "scout", question: "Arbitrary user wording.", plan: requested });
    expect(scout.toolRuns.map((tool) => tool.key)).toEqual(scoutPlan);
    expect(scoutSource.getMarketCandles).not.toHaveBeenCalled();
    expect(scoutSource.getMemories).not.toHaveBeenCalled();
  });

  it("does not inject an unrelated analyzer into an underspecified semantic plan", () => {
    const selected = planAskTools("analyst", semanticPlan(["get_import_summary", "run_skeptic_check"]));
    expect(selected).toEqual(["get_import_summary", "run_skeptic_check"]);
    expect(selected).not.toContain("analyze_trading_activity");
  });

  it("uses a semantic follow-up plan even when the raw phrase contains no topic words", async () => {
    const plan = semanticPlan(["analyze_fees"], {
      needsConversationContext: true,
      referencedPriorFindingIds: ["prior-fee-finding"],
    });
    const result = await orchestrateAsk({
      source: source(), mode: "analyst", question: "What about it?", history: ["Earlier explanation"], plan,
    });
    expect(result.toolRuns.map((tool) => tool.key)).toContain("analyze_fees");
    expect(result.sources.map((entry) => entry.label)).toContain("Bitget financial records");
  });

  it("fails closed when a follow-up plan requires context but none is available", async () => {
    const askSource = source();
    const plan = semanticPlan(["analyze_fees"], { needsConversationContext: true });
    const result = await orchestrateAsk({
      source: askSource,
      mode: "analyst",
      question: "What about that?",
      history: ["   "],
      selectedContextAvailable: false,
      plan,
    });

    expect(result.status).toBe("insufficient_data");
    expect(result.finding.headline).toBe("RIKKU needs the referenced context to answer this safely.");
    expect(result.finding.summary).toContain("without recent conversation or selected application context");
    expect(result.toolRuns.map((tool) => tool.key)).toEqual(["get_import_summary"]);
    expect(askSource.getFills).not.toHaveBeenCalled();
    expect(askSource.getFinancialRecords).not.toHaveBeenCalled();
  });

  it("allows a context-dependent plan when selected application context is available", async () => {
    const plan = semanticPlan(["analyze_fees"], { needsConversationContext: true });
    const result = await orchestrateAsk({
      source: source(),
      mode: "analyst",
      question: "What about that?",
      history: [],
      selectedContextAvailable: true,
      plan,
    });

    expect(result.toolRuns.map((tool) => tool.key)).toContain("analyze_fees");
    expect(result.sources.map((entry) => entry.label)).toContain("Bitget financial records");
  });

  it("selects multi-intent tools from the semantic plan, not the question text", async () => {
    const plan = semanticPlan(["analyze_trade_timing", "analyze_market_context", "analyze_fees"], { requiresJoinedAnalysis: true });
    const first = await orchestrateAsk({ source: source(), mode: "analyst", question: "Weird timing and cost thing?", plan });
    const second = await orchestrateAsk({ source: source(), mode: "analyst", question: "Completely different phrasing.", plan });
    const keys = ["get_import_summary", "analyze_trade_timing", "analyze_market_context", "analyze_fees", "run_skeptic_check"];
    expect(first.toolRuns.map((tool) => tool.key)).toEqual(keys);
    expect(second.toolRuns.map((tool) => tool.key)).toEqual(keys);
    expect(first.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Most active time window" }),
      expect.objectContaining({ label: "Known fill fees by coin" }),
      expect.objectContaining({ label: "Matched market context" }),
    ]));
    expect(first.limitations.join(" ")).toContain("do not calculate a joined association");
  });

  it("does not discard analytical requests when a fact label and count metric accompany them", async () => {
    const plan = semanticPlan(["analyze_symbol_concentration"], { answerKind: "fact", requestedImportMetric: "fills" });
    const result = await orchestrateAsk({ source: source(), mode: "analyst", question: "An arbitrary combined question.", plan });
    expect(result.answerKind).toBe("analysis");
    expect(result.toolRuns.map((tool) => tool.key)).toEqual(["get_import_summary", "analyze_symbol_concentration", "run_skeptic_check"]);
  });

  it("answers a simple imported count directly without unrelated metrics or analysis tools", async () => {
    const result = await orchestrateAsk({
      source: source(), mode: "analyst", question: "Got a fill count?",
      plan: semanticPlan([], { answerKind: "fact", analysisDepth: "factual", requestedImportMetric: "fills" }),
    });
    expect(result.answerKind).toBe("fact");
    expect(result.finding.headline).toBe("You currently have 12 imported fills.");
    expect(result.finding.summary).toBe("Coverage: Jul 8 – Aug 4, 2026.");
    expect(result.evidence).toEqual([{ label: "Fills imported", value: "12" }]);
    expect(result.toolRuns.map((tool) => tool.key)).toEqual(["get_import_summary"]);
    expect(result.limitations).toEqual([]);
  });

  it("states the verified reconstructed-trade absence without count-like grammar", async () => {
    const result = await orchestrateAsk({
      source: source(), mode: "analyst", question: "Is there a reconstructed-trade count?",
      plan: semanticPlan([], { answerKind: "fact", analysisDepth: "factual", requestedImportMetric: "completed_trades" }),
    });
    expect(result.answerKind).toBe("fact");
    expect(result.finding.headline).toBe("Completed trades are not yet reconstructable.");
    expect(result.evidence).toEqual([{ label: "Completed trades", value: "Not yet reconstructable" }]);
  });

  it("returns an honest insufficient-data result when imported fill rows are malformed", async () => {
    const malformed = source({ getFills: vi.fn(async () => [{ ...fills[0], symbol: null, executedAt: null }]) });
    const result = await orchestrateAsk({ source: malformed, mode: "scout", question: "What symbols did I trade?", plan: semanticPlan(["analyze_symbol_concentration"]) });
    expect(result.status).toBe("insufficient_data");
    expect(result.finding.headline).toContain("could not be established");
    expect(result.evidence.some((metric) => metric.label === "Activity by symbol")).toBe(false);
  });

  it("fails closed for an account with no verified Bitget connection", async () => {
    const result = await orchestrateAsk({
      source: source({ getConnectionStatus: vi.fn(async () => ({ connected: false, lastSyncedAt: null })) }),
      mode: "analyst", question: "Analyze my imported Bitget activity.",
    });
    expect(result.status).toBe("needs_connection");
    expect(result.sources).toEqual([]);
    expect(result.toolRuns[0]).toMatchObject({ key: "get_import_summary", status: "skipped" });
  });

  it("does not fabricate completed-trade or risk metrics when reconstruction is zero", async () => {
    const result = await orchestrateAsk({ source: source(), mode: "investigator", question: "What are my current tail risks?", plan: semanticPlan(["analyze_tail_risk"], { answerKind: "investigation" }) });
    const tailRisk = result.toolRuns.find((tool) => tool.key === "analyze_tail_risk");
    expect(tailRisk).toMatchObject({ status: "insufficient_data" });
    expect(result.evidence.map((metric) => metric.label)).not.toContain("Win rate");
    expect(result.evidence.map((metric) => metric.label)).not.toContain("Trade expectancy");
  });

  it("converts a data-access failure into a safe insufficient-data outcome", async () => {
    const result = await orchestrateAsk({
      source: source({ getFills: vi.fn(async () => { throw new Error("upstream detail must not escape"); }) }),
      mode: "scout", question: "What symbols did I trade?", plan: semanticPlan(["analyze_symbol_concentration"]),
    });
    expect(result.status).toBe("insufficient_data");
    expect(result.limitations.join(" ")).not.toContain("upstream detail");
  });

  it("invalidates deterministic evidence fingerprints when imported data changes", async () => {
    const summary = await source().getLatestCompletedImport();
    expect(summary).not.toBeNull();
    const first = askDataFingerprintInput(summary!, "How much did I pay in fees?", "analyst", []);
    const changed = askDataFingerprintInput({ ...summary!, completedAt: "2026-09-19T00:00:00.000Z", fills: summary!.fills + 1 }, "How much did I pay in fees?", "analyst", []);
    expect(changed).not.toBe(first);
  });

  it("does not execute an unallowlisted model-supplied tool", async () => {
    const selected = planAskTools("analyst", semanticPlan(["analyze_fees", "transfer_funds" as AskToolKey]));
    expect(selected).toEqual(["get_import_summary", "analyze_fees", "run_skeptic_check"]);
  });

  it("returns only verified import-summary evidence when no semantic plan is available", async () => {
    const askSource = source();
    const result = await orchestrateAsk({ source: askSource, mode: "analyst", question: "Any arbitrary sentence." });
    expect(result.status).toBe("insufficient_data");
    expect(result.finding.headline).toBe("RIKKU could not interpret this question safely.");
    expect(result.finding.summary).toContain("no topic-specific analyzer ran");
    expect(result.toolRuns.map((tool) => tool.key)).toEqual(["get_import_summary"]);
    expect(result.limitations).toContain("Semantic planning did not complete, so RIKKU returned only verified import-summary evidence.");
    expect(askSource.getFills).not.toHaveBeenCalled();
    expect(planAskTools("analyst", null)).toEqual(["get_import_summary"]);
    expect(result.reasoningStatus).toBe("deterministic_fallback");
  });
});
