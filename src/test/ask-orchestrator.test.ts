import { describe, expect, it, vi } from "vitest";
import { ASK_TOOL_BUDGETS, type AskDataSource, type AskFill, type AskMarketCandle } from "@/lib/ask/types";
import { askDataFingerprintInput, orchestrateAsk, planAskTools } from "@/lib/ask/orchestrator";

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

describe("Ask RIKKU deterministic orchestration", () => {
  it("answers the primary real imported-activity question from imported evidence only", async () => {
    const result = await orchestrateAsk({
      source: source(), mode: "analyst", question: "Analyze my imported Bitget activity.",
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

  it("enforces distinct real tool budgets for Scout, Analyst, and Investigator", async () => {
    const scoutPlan = planAskTools("How much have I paid in fees?", "scout");
    const analystPlan = planAskTools("Analyze my imported Bitget activity.", "analyst");
    const investigatorPlan = planAskTools("Investigate my imported Bitget activity in depth.", "investigator");
    expect(scoutPlan).toHaveLength(2);
    expect(scoutPlan).toEqual(["get_import_summary", "analyze_fees"]);
    expect(analystPlan.length).toBeLessThanOrEqual(ASK_TOOL_BUDGETS.analyst);
    expect(investigatorPlan.length).toBeLessThanOrEqual(ASK_TOOL_BUDGETS.investigator);
    expect(investigatorPlan.length).toBeGreaterThan(analystPlan.length);

    const scoutSource = source();
    const scout = await orchestrateAsk({ source: scoutSource, mode: "scout", question: "How much have I paid in fees?" });
    expect(scout.toolRuns).toHaveLength(2);
    expect(scout.toolRuns.map((tool) => tool.key)).toEqual(scoutPlan);
    expect(scoutSource.getMarketCandles).not.toHaveBeenCalled();
    expect(scoutSource.getMemories).not.toHaveBeenCalled();
  });

  it("uses bounded prior user questions for a follow-up without treating old generated prose as evidence", async () => {
    const plan = planAskTools("What about it?", "analyst", ["How much have I paid in fees?"]);
    expect(plan).toContain("analyze_fees");
    const result = await orchestrateAsk({
      source: source(), mode: "analyst", question: "What about it?", history: ["How much have I paid in fees?"],
    });
    expect(result.toolRuns.map((tool) => tool.key)).toContain("analyze_fees");
    expect(result.sources.map((entry) => entry.label)).toContain("Bitget financial records");
  });

  it("uses question-sensitive plans for patterns, risk, and simple factual prompts", () => {
    expect(planAskTools("Do you see any reliable behavioral patterns?", "analyst")).toEqual([
      "get_import_summary", "analyze_trading_activity", "retrieve_memories", "retrieve_patterns", "run_skeptic_check",
    ]);
    expect(planAskTools("Is that enough evidence to identify a behavioral pattern?", "analyst", ["What about fees?"])).toEqual([
      "get_import_summary", "analyze_trading_activity", "retrieve_memories", "retrieve_patterns", "run_skeptic_check",
    ]);
    expect(planAskTools("What risks can you currently measure?", "analyst")).toEqual([
      "get_import_summary", "analyze_trading_activity", "analyze_symbol_concentration", "analyze_fees", "analyze_tail_risk", "run_skeptic_check",
    ]);
    expect(planAskTools("How much did I pay in fees?", "scout")).toEqual(["get_import_summary", "analyze_fees"]);
    expect(planAskTools("How many fills do I have?", "analyst")).toEqual(["get_import_summary"]);
  });

  it("keeps the seven-turn reasoning acceptance conversation anchored to the original analysis", () => {
    const questions = [
      "What do you notice about my recent trading?",
      "Why do you think that?",
      "Could there be another explanation?",
      "What evidence goes against your current interpretation?",
      "What would change your conclusion?",
      "What would you investigate next?",
      "What is the most interesting thing you can infer without overstating it?",
    ];
    const history: string[] = [];
    for (const question of questions) {
      const plan = planAskTools(question, "analyst", history);
      expect(plan).toContain("analyze_trading_activity");
      expect(plan).toContain("run_skeptic_check");
      history.push(question);
    }
  });

  it("answers a simple imported count directly without unrelated metrics or analysis tools", async () => {
    const result = await orchestrateAsk({ source: source(), mode: "analyst", question: "How many fills do I have?" });
    expect(result.answerKind).toBe("fact");
    expect(result.finding.headline).toBe("You currently have 12 imported fills.");
    expect(result.finding.summary).toBe("Coverage: Jul 8 – Aug 4, 2026.");
    expect(result.evidence).toEqual([{ label: "Fills imported", value: "12" }]);
    expect(result.toolRuns.map((tool) => tool.key)).toEqual(["get_import_summary"]);
    expect(result.limitations).toEqual([]);
  });

  it("returns an honest insufficient-data result when imported fill rows are malformed", async () => {
    const malformed = source({ getFills: vi.fn(async () => [{ ...fills[0], symbol: null, executedAt: null }]) });
    const result = await orchestrateAsk({ source: malformed, mode: "scout", question: "What symbols did I trade?" });
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
    const result = await orchestrateAsk({ source: source(), mode: "investigator", question: "What are my current tail risks?" });
    const tailRisk = result.toolRuns.find((tool) => tool.key === "analyze_tail_risk");
    expect(tailRisk).toMatchObject({ status: "insufficient_data" });
    expect(result.evidence.map((metric) => metric.label)).not.toContain("Win rate");
    expect(result.evidence.map((metric) => metric.label)).not.toContain("Trade expectancy");
  });

  it("converts a data-access failure into a safe insufficient-data outcome", async () => {
    const result = await orchestrateAsk({
      source: source({ getFills: vi.fn(async () => { throw new Error("upstream detail must not escape"); }) }),
      mode: "scout", question: "What symbols did I trade?",
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
});
