export const ASK_ANALYSIS_VERSION = "ask-evidence-v3";

export const askModes = ["scout", "analyst", "investigator"] as const;
export type AskMode = (typeof askModes)[number];

/** These are execution budgets, not merely presentation labels. */
export const ASK_TOOL_BUDGETS: Record<AskMode, number> = {
  scout: 2,
  analyst: 6,
  investigator: 12,
};

export const askToolKeys = [
  "get_import_summary",
  "analyze_trading_activity",
  "analyze_fees",
  "analyze_symbol_concentration",
  "analyze_trade_timing",
  "analyze_market_context",
  "analyze_market_regime",
  "retrieve_memories",
  "retrieve_patterns",
  "analyze_portfolio",
  "analyze_tail_risk",
  "analyze_overtrading",
  "analyze_disposition_effect",
  "retrieve_similar_scenarios",
  "run_skeptic_check",
] as const;
export type AskToolKey = (typeof askToolKeys)[number];

export type AskToolStatus = "completed" | "insufficient_data" | "skipped";

export type AskToolRun = {
  key: AskToolKey;
  label: string;
  status: AskToolStatus;
  summary: string;
  sampleSize?: number;
  sources: string[];
};

export type AskMetric = {
  label: string;
  value: string;
  detail?: string;
};

export type AskSource = {
  label: string;
  detail?: string;
};

export type AskDataWindow = {
  start: string | null;
  end: string | null;
  label: string | null;
};

export type AskConfidence = {
  level: "low" | "moderate" | "high" | "not_assessable";
  reasons: string[];
};

export type AskReasoningStatus = "external_llm" | "deterministic_fallback";

export type AskReasoningProvider = {
  id: "openai" | "openai_compatible" | "groq";
  model: string;
};

export const askAnswerKinds = ["fact", "analysis", "investigation"] as const;
export type AskAnswerKind = (typeof askAnswerKinds)[number];

export const askReasoningPointKinds = [
  "observation",
  "hypothesis",
  "alternative",
  "counter_evidence",
  "uncertainty",
  "next_investigation",
] as const;
export type AskReasoningPointKind = (typeof askReasoningPointKinds)[number];

export type AskReasoningPoint = {
  kind: AskReasoningPointKind;
  statement: string;
  rationale: string;
  evidenceLabels: string[];
  test: string | null;
};

export type AskQualitativeEvidence = {
  kind: "memory" | "pattern";
  label: string;
  statement: string;
  classification: string | null;
  confidence: string | null;
  status: string | null;
};

export type AskMarketContext = {
  available: boolean;
  summary: string;
  matchedFills: number;
  regimeSummary?: string;
};

export type AskResponseStatus =
  | "completed"
  | "insufficient_data"
  | "needs_connection"
  | "needs_import";

export type AskResponse = {
  version: typeof ASK_ANALYSIS_VERSION;
  status: AskResponseStatus;
  mode: AskMode;
  answerKind: AskAnswerKind;
  question: string;
  finding: {
    headline: string;
    summary: string;
  };
  interpretation: string;
  reasoningPoints: AskReasoningPoint[];
  evidence: AskMetric[];
  qualitativeEvidence: AskQualitativeEvidence[];
  confidence: AskConfidence;
  limitations: string[];
  marketContext: AskMarketContext | null;
  dataWindow: AskDataWindow;
  sources: AskSource[];
  toolRuns: AskToolRun[];
  suggestedFollowups: string[];
  reasoningStatus: AskReasoningStatus;
  reasoningProvider?: AskReasoningProvider;
  reasoningNotice?: string;
};

export type AskConnectionStatus = {
  connected: boolean;
  lastSyncedAt: string | null;
};

export type AskImportSummary = {
  id: string;
  completedAt: string | null;
  orders: number;
  fills: number;
  financialRecords: number;
  assets: number;
  positions: number;
  instruments: number;
  marketCandles: number;
  completedTrades: number;
  earliestRecordAt: string | null;
  latestRecordAt: string | null;
};

export type AskFill = {
  category: string | null;
  symbol: string | null;
  side: string | null;
  executionPrice: string | null;
  executionQuantity: string | null;
  executionValue: string | null;
  feeAmount: string | null;
  feeCoin: string | null;
  executedAt: string | null;
};

export type AskInstrument = {
  category: string | null;
  symbol: string | null;
  quoteCoin: string | null;
};

export type AskFinancialRecord = {
  coin: string | null;
  recordType: string | null;
  fee: string | null;
  amount: string | null;
  recordedAt: string | null;
};

export type AskMarketCandle = {
  category: string | null;
  symbol: string | null;
  observedAt: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
};

export type AskMemory = {
  memoryType: string | null;
  statement: string | null;
  classification: string | null;
  confidence: string | null;
  status: string | null;
  createdAt: string | null;
};

export type AskPattern = {
  claim: string | null;
  status: string | null;
  confidence: string | null;
  updatedAt: string | null;
};

/**
 * This interface keeps all quantitative calculations pure and testable. The
 * Supabase adapter only returns authenticated, user-owned rows.
 */
export type AskDataSource = {
  getConnectionStatus(): Promise<AskConnectionStatus>;
  getLatestCompletedImport(): Promise<AskImportSummary | null>;
  getFills(): Promise<AskFill[]>;
  getFinancialRecords(): Promise<AskFinancialRecord[]>;
  getInstruments(): Promise<AskInstrument[]>;
  getMarketCandles(): Promise<AskMarketCandle[]>;
  getMemories(limit: number): Promise<AskMemory[]>;
  getPatterns(limit: number): Promise<AskPattern[]>;
};

export class AskDataAccessError extends Error {
  constructor(public readonly code: "DATA_UNAVAILABLE" | "DATASET_TOO_LARGE") {
    super(code);
    this.name = "AskDataAccessError";
  }
}
