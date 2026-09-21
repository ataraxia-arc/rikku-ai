import {
  ASK_ANALYSIS_VERSION,
  ASK_TOOL_BUDGETS,
  AskDataAccessError,
  type AskConfidence,
  type AskAnswerKind,
  type AskDataSource,
  type AskDataWindow,
  type AskFill,
  type AskImportSummary,
  type AskMarketCandle,
  type AskMetric,
  type AskMode,
  type AskResponse,
  type AskSource,
  type AskToolKey,
  type AskToolRun,
} from "@/lib/ask/types";

const SCALE = 10n ** 18n;
const DECIMAL = /^(-?)(\d+)(?:\.(\d{1,18}))?$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Intent = {
  activity: boolean;
  fees: boolean;
  symbols: boolean;
  timing: boolean;
  market: boolean;
  memory: boolean;
  patterns: boolean;
  portfolio: boolean;
  risk: boolean;
  limitations: boolean;
  deep: boolean;
  fact: "orders" | "fills" | "financial_records" | "instruments" | "candles" | "completed_trades" | null;
  followUp: "why" | "alternatives" | "counter_evidence" | "change_conclusion" | "next_investigation" | "bounded_inference" | null;
};

type ParsedFill = {
  category: string | null;
  symbol: string;
  side: "buy" | "sell" | null;
  executedAt: number;
  executionPrice: bigint | null;
  executionQuantity: bigint | null;
  executionValue: bigint | null;
  feeAmount: bigint | null;
  feeCoin: string | null;
};

type Activity = {
  fills: ParsedFill[];
  activeDays: number;
  averageIntervalMs: number | null;
  medianIntervalMs: number | null;
  buyCount: number;
  sellCount: number;
  unknownSideCount: number;
  bySymbol: Map<string, number>;
  byHour: Map<number, number>;
};

type MarketMatch = {
  fill: ParsedFill;
  candle: { category: string | null; symbol: string; observedAt: number; open: number; high: number; low: number; close: number };
};

type AnalysisContext = {
  source: AskDataSource;
  fills?: Promise<AskFill[]>;
  activity?: Promise<Activity>;
};

export type AskOrchestrationInput = {
  source: AskDataSource;
  question: string;
  mode: AskMode;
  /** Last user questions only; assistant prose is never treated as evidence. */
  history?: string[];
  initialImport?: AskImportSummary | null;
};

function decimalUnits(value: string | null): bigint | null {
  if (value === null) return null;
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const units = BigInt(match[2]) * SCALE + BigInt((match[3] ?? "").padEnd(18, "0"));
  return match[1] === "-" ? -units : units;
}

function decimalToNumber(value: bigint): number | null {
  const numeric = Number(value) / Number(SCALE);
  return Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER ? numeric : null;
}

function comma(value: string) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction] = unsigned.split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${withCommas}${fraction ? `.${fraction}` : ""}`;
}

function formatUnits(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = (magnitude / SCALE).toString();
  const fraction = (magnitude % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${comma(whole)}${fraction ? `.${fraction}` : ""}`;
}

function round(value: number, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "Not available";
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatWindow(start: string | null, end: string | null): AskDataWindow {
  if (!start || !end) return { start, end, label: null };
  const first = new Date(start);
  const last = new Date(end);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return { start: null, end: null, label: null };
  const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
  const left = `${MONTHS[first.getUTCMonth()]} ${first.getUTCDate()}${sameYear ? "" : `, ${first.getUTCFullYear()}`}`;
  const right = `${MONTHS[last.getUTCMonth()]} ${last.getUTCDate()}, ${last.getUTCFullYear()}`;
  return { start, end, label: `${left} – ${right}` };
}

function normalizeQuestion(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 500);
}

function followUpFocus(value: string): Intent["followUp"] {
  if (/\b(why|reason(?:ing)?)\b/.test(value)) return "why";
  if (/\b(another explanation|alternative explanation|something else|could it be)\b/.test(value)) return "alternatives";
  if (/\b(evidence .*against|counter[- ]?evidence|weakens?|contradict)\b/.test(value)) return "counter_evidence";
  if (/\b(change (?:your|the) conclusion|change your mind|strengthen|weaken)\b/.test(value)) return "change_conclusion";
  if (/\b(investigat(?:e|ion) next|look at next|check next)\b/.test(value)) return "next_investigation";
  if (/\b(most interesting|without overstating|infer)\b/.test(value)) return "bounded_inference";
  return null;
}

function classify(question: string, history: string[]): Intent {
  const lower = question.toLowerCase();
  const followUp = followUpFocus(lower);
  const explicitSubject = /\b(orders?|fills?|financial records?|fees?|cost|commission|symbols?|instruments?|timing|market|regime|candles?|memory|memories|patterns?|portfolio|assets?|balances?|positions?|risks?|drawdown|pnl|return|win rate|completed trades?|missing|insufficient)\b/.test(lower);
  const contextualReference = /\b(it|that|those|them|same|more|again|conclusion|interpretation|explanation|idea)\b/.test(lower);
  const anchor = [...history].reverse().find((item) => !followUpFocus(item.toLowerCase())) ?? history.at(-1) ?? "";
  const contextual = !explicitSubject && (followUp !== null || contextualReference)
    ? `${lower} ${anchor.toLowerCase()}`
    : lower;
  const countQuestion = /\b(how many|count|number of)\b/.test(lower);
  const fact = countQuestion && /\borders?\b/.test(lower) ? "orders"
    : countQuestion && /\bfills?\b/.test(lower) ? "fills"
      : countQuestion && /\bfinancial records?\b/.test(lower) ? "financial_records"
        : countQuestion && /\b(instruments?|symbols?)\b/.test(lower) ? "instruments"
          : countQuestion && /\bcandles?\b/.test(lower) ? "candles"
            : countQuestion && /\bcompleted trades?\b/.test(lower) ? "completed_trades"
              : null;
  const activity = /\b(analy[sz]e|activity|traded|trade most|latest activity|what .*know|what .*notice|behavior|strongest evidence|patterns?)\b/.test(contextual);
  return {
    activity,
    fees: /\b(fee|fees|cost|commission)\b/.test(contextual),
    symbols: /\b(symbol|instrument|traded most|most active|concentration)\b/.test(contextual),
    timing: /\b(when|time of day|hour|timing|often)\b/.test(contextual),
    market: /\b(market|volatil|regime|candle|condition)\b/.test(contextual),
    memory: /\b(remember|memory|memories)\b/.test(contextual),
    patterns: /\b(patterns?|recurring)\b/.test(contextual),
    portfolio: /\b(portfolio|asset|balance|position|exposure)\b/.test(contextual),
    risk: /\b(risks?|tail|var|cvar|drawdown|overtrad|disposition|profit|pnl|return|win rate)\b/.test(contextual),
    limitations: /\b(cannot|can.t|not determine|missing|why can.t|why cant|insufficient)\b/.test(contextual),
    deep: /\b(investigat|deep|all|comprehensive)\b/.test(contextual),
    fact,
    followUp,
  };
}

function answerKindFor(mode: AskMode, intent: Intent): AskAnswerKind {
  if (intent.fact) return "fact";
  if (mode === "investigator" || intent.deep) return "investigation";
  return "analysis";
}

function toolPlan(mode: AskMode, intent: Intent): AskToolKey[] {
  const tools: AskToolKey[] = ["get_import_summary"];
  const add = (key: AskToolKey) => {
    if (!tools.includes(key)) tools.push(key);
  };
  const focused = intent.fees ? "analyze_fees"
    : intent.symbols ? "analyze_symbol_concentration"
      : intent.timing ? "analyze_trade_timing"
        : intent.market ? "analyze_market_context"
          : intent.memory ? "retrieve_memories"
            : "analyze_trading_activity";

  if (intent.fact) return tools;

  if (mode === "scout") {
    add(focused);
    return tools;
  }

  const broadActivity = (intent.activity && !intent.patterns) || intent.deep || (!intent.fees && !intent.symbols && !intent.timing && !intent.market && !intent.memory && !intent.patterns && !intent.portfolio && !intent.risk && !intent.limitations);
  if (broadActivity) {
    add("analyze_trading_activity");
    add("analyze_fees");
    add("analyze_symbol_concentration");
    add("analyze_trade_timing");
    add("analyze_market_context");
    add("analyze_market_regime");
    add("retrieve_memories");
    if (intent.patterns) {
      add("retrieve_memories");
      add("retrieve_patterns");
    }
  } else {
    add(focused);
    if (intent.market) add("analyze_market_regime");
    if (intent.memory) add("retrieve_memories");
    if (intent.patterns) {
      add("retrieve_memories");
      add("retrieve_patterns");
    }
    if (intent.portfolio) add("analyze_portfolio");
    if (intent.risk) {
      add("analyze_symbol_concentration");
      add("analyze_fees");
      add("analyze_tail_risk");
    }
  }

  if (mode === "investigator") {
    add("analyze_trading_activity");
    add("analyze_fees");
    add("analyze_symbol_concentration");
    add("analyze_trade_timing");
    add("analyze_market_context");
    add("analyze_market_regime");
    add("retrieve_memories");
    add("retrieve_patterns");
    if (intent.risk) {
      add("analyze_overtrading");
      add("analyze_disposition_effect");
      add("retrieve_similar_scenarios");
    }
  }
  const budget = ASK_TOOL_BUDGETS[mode];
  const bounded = tools.filter((key) => key !== "run_skeptic_check").slice(0, Math.max(1, budget - 1));
  return [...bounded, "run_skeptic_check"];
}

function parseFills(rows: AskFill[]): ParsedFill[] {
  const parsed: ParsedFill[] = [];
  for (const row of rows) {
    const symbol = row.symbol?.trim().toUpperCase();
    const executedAt = row.executedAt ? Date.parse(row.executedAt) : Number.NaN;
    if (!symbol || !Number.isFinite(executedAt)) continue;
    const side = row.side?.trim().toLowerCase();
    parsed.push({
      category: row.category?.trim().toUpperCase() || null,
      symbol,
      side: side === "buy" || side === "sell" ? side : null,
      executedAt,
      executionPrice: decimalUnits(row.executionPrice),
      executionQuantity: decimalUnits(row.executionQuantity),
      executionValue: decimalUnits(row.executionValue),
      feeAmount: decimalUnits(row.feeAmount),
      feeCoin: row.feeCoin?.trim().toUpperCase() || null,
    });
  }
  return parsed.sort((a, b) => a.executedAt - b.executedAt || a.symbol.localeCompare(b.symbol));
}

function activityFrom(rows: AskFill[]): Activity {
  const fills = parseFills(rows);
  const activeDays = new Set<string>();
  const bySymbol = new Map<string, number>();
  const byHour = new Map<number, number>();
  let buyCount = 0;
  let sellCount = 0;
  let unknownSideCount = 0;
  const intervals: number[] = [];
  for (let index = 0; index < fills.length; index++) {
    const fill = fills[index];
    const date = new Date(fill.executedAt);
    activeDays.add(date.toISOString().slice(0, 10));
    bySymbol.set(fill.symbol, (bySymbol.get(fill.symbol) ?? 0) + 1);
    const hour = date.getUTCHours();
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    if (fill.side === "buy") buyCount++;
    else if (fill.side === "sell") sellCount++;
    else unknownSideCount++;
    if (index > 0) intervals.push(fill.executedAt - fills[index - 1].executedAt);
  }
  const sortedIntervals = [...intervals].sort((a, b) => a - b);
  const medianIntervalMs = sortedIntervals.length === 0 ? null : sortedIntervals.length % 2
    ? sortedIntervals[(sortedIntervals.length - 1) / 2]
    : (sortedIntervals[sortedIntervals.length / 2 - 1] + sortedIntervals[sortedIntervals.length / 2]) / 2;
  return {
    fills,
    activeDays: activeDays.size,
    averageIntervalMs: intervals.length ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length : null,
    medianIntervalMs,
    buyCount,
    sellCount,
    unknownSideCount,
    bySymbol,
    byHour,
  };
}

function resultTool(key: AskToolKey, status: AskToolRun["status"], summary: string, sources: string[], sampleSize?: number): AskToolRun {
  const labels: Record<AskToolKey, string> = {
    get_import_summary: "Reading imported activity",
    analyze_trading_activity: "Analyzing trading activity",
    analyze_fees: "Calculating fee observations",
    analyze_symbol_concentration: "Checking symbol concentration",
    analyze_trade_timing: "Analyzing fill timing",
    analyze_market_context: "Checking market context",
    analyze_market_regime: "Checking market regime",
    retrieve_memories: "Searching RIKKU memory",
    retrieve_patterns: "Retrieving validated patterns",
    analyze_portfolio: "Reviewing portfolio data",
    analyze_tail_risk: "Assessing tail risk",
    analyze_overtrading: "Checking overtrading evidence",
    analyze_disposition_effect: "Checking disposition evidence",
    retrieve_similar_scenarios: "Retrieving similar scenarios",
    run_skeptic_check: "Validating evidence",
  };
  return { key, label: labels[key], status, summary, sources, ...(sampleSize === undefined ? {} : { sampleSize }) };
}

function addUnique<T>(items: T[], value: T, identity: (item: T) => string) {
  if (!items.some((item) => identity(item) === identity(value))) items.push(value);
}

function addSource(sources: AskSource[], label: string, detail?: string) {
  addUnique(sources, { label, detail }, (source) => source.label);
}

function addMetric(metrics: AskMetric[], label: string, value: string, detail?: string) {
  const existing = metrics.find((metric) => metric.label === label);
  if (existing) {
    existing.value = value;
    existing.detail = detail;
  } else {
    metrics.push({ label, value, ...(detail ? { detail } : {}) });
  }
}

function parsedActivity(context: AnalysisContext) {
  if (!context.activity) {
    context.activity = (async () => activityFrom(await getFills(context)))();
  }
  return context.activity;
}

function getFills(context: AnalysisContext) {
  if (!context.fills) context.fills = context.source.getFills();
  return context.fills;
}

function noDataRun(key: AskToolKey, reason: string) {
  return resultTool(key, "insufficient_data", reason, []);
}

function sourceFailureRun(key: AskToolKey) {
  return resultTool(key, "insufficient_data", "The required imported data could not be read safely.", []);
}

function findMarketMatches(activity: Activity, candles: AskMarketCandle[]): MarketMatch[] {
  const normalized = candles.flatMap((row) => {
    const symbol = row.symbol?.trim().toUpperCase();
    const observedAt = row.observedAt ? Date.parse(row.observedAt) : Number.NaN;
    const open = decimalUnits(row.open);
    const high = decimalUnits(row.high);
    const low = decimalUnits(row.low);
    const close = decimalUnits(row.close);
    if (!symbol || !Number.isFinite(observedAt) || open === null || high === null || low === null || close === null || open <= 0n) return [];
    const numeric = [open, high, low, close].map(decimalToNumber);
    if (numeric.some((value) => value === null)) return [];
    return [{
      category: row.category?.trim().toUpperCase() || null,
      symbol,
      observedAt,
      open: numeric[0]!, high: numeric[1]!, low: numeric[2]!, close: numeric[3]!,
    }];
  });
  const exact = new Map<string, MarketMatch["candle"]>();
  const symbolDay = new Map<string, MarketMatch["candle"]>();
  for (const candle of normalized) {
    const day = new Date(candle.observedAt).toISOString().slice(0, 10);
    exact.set(`${candle.category ?? ""}|${candle.symbol}|${day}`, candle);
    symbolDay.set(`${candle.symbol}|${day}`, candle);
  }
  return activity.fills.flatMap((fill) => {
    const day = new Date(fill.executedAt).toISOString().slice(0, 10);
    const candle = exact.get(`${fill.category ?? ""}|${fill.symbol}|${day}`) ?? symbolDay.get(`${fill.symbol}|${day}`);
    return candle ? [{ fill, candle }] : [];
  });
}

function confidenceFor(summary: AskImportSummary, activity: Activity | null, marketMatched: number): AskConfidence {
  if (!activity || activity.fills.length === 0) {
    return { level: "not_assessable", reasons: ["No valid imported fills were available for the requested analysis."] };
  }
  const reasons = [
    `${activity.fills.length} valid fill${activity.fills.length === 1 ? "" : "s"} are descriptive evidence, not a behavioral sample.`,
    `${summary.completedTrades} completed reconstructed trade${summary.completedTrades === 1 ? "" : "s"} are available.`,
  ];
  if (marketMatched) reasons.push(`Daily candles matched ${marketMatched} fill${marketMatched === 1 ? "" : "s"}.`);
  if (activity.fills.length < 30 || summary.completedTrades === 0) return { level: "low", reasons };
  return { level: "moderate", reasons };
}

function importMetrics(summary: AskImportSummary, metrics: AskMetric[], intent: Intent) {
  const add = (key: NonNullable<Intent["fact"]>) => {
    if (key === "orders") addMetric(metrics, "Orders imported", String(summary.orders));
    if (key === "fills") addMetric(metrics, "Fills imported", String(summary.fills));
    if (key === "financial_records") addMetric(metrics, "Financial records", String(summary.financialRecords), "Reported separately from fill fees to avoid double-counting.");
    if (key === "instruments") addMetric(metrics, "Instruments observed", String(summary.instruments));
    if (key === "candles") addMetric(metrics, "Market candles", String(summary.marketCandles));
    if (key === "completed_trades") addMetric(metrics, "Completed trades", summary.completedTrades ? String(summary.completedTrades) : "Not yet reconstructable");
  };
  if (intent.fact) {
    add(intent.fact);
    return;
  }
  if (intent.fees) {
    add("fills");
    add("financial_records");
    return;
  }
  if (intent.symbols) {
    add("fills");
    add("instruments");
    return;
  }
  if (intent.timing) {
    add("fills");
    return;
  }
  if (intent.market) {
    add("fills");
    add("candles");
    return;
  }
  if (intent.portfolio) {
    addMetric(metrics, "Assets imported", String(summary.assets));
    addMetric(metrics, "Positions imported", String(summary.positions));
    return;
  }
  if (intent.risk || intent.patterns || intent.memory || intent.limitations) {
    add("fills");
    add("completed_trades");
    return;
  }
  add("orders");
  add("fills");
  add("financial_records");
  add("instruments");
  add("candles");
  add("completed_trades");
}

function baseResponse(question: string, mode: AskMode, answerKind: AskAnswerKind, status: AskResponse["status"], finding: AskResponse["finding"]): AskResponse {
  return {
    version: ASK_ANALYSIS_VERSION,
    status,
    mode,
    answerKind,
    question,
    finding,
    interpretation: finding.summary,
    reasoningPoints: [],
    evidence: [],
    qualitativeEvidence: [],
    confidence: { level: "not_assessable", reasons: [] },
    limitations: [],
    marketContext: null,
    dataWindow: { start: null, end: null, label: null },
    sources: [],
    toolRuns: [],
    suggestedFollowups: [],
    reasoningStatus: "deterministic_fallback",
  };
}

function dataUnavailable(response: AskResponse, key: AskToolKey) {
  response.toolRuns.push(sourceFailureRun(key));
  addUnique(response.limitations, "A required imported dataset was unavailable, so RIKKU did not substitute a value.", (value) => value);
}

function metricValue(response: AskResponse, label: string) {
  return response.evidence.find((metric) => metric.label === label)?.value ?? null;
}

function applyQuestionFocusedFinding(response: AskResponse, intent: Intent) {
  const fees = metricValue(response, "Known fill fees by coin");
  const symbols = metricValue(response, "Activity by symbol");
  const timing = metricValue(response, "Most active time window");
  const memories = metricValue(response, "Relevant RIKKU memories");
  const patterns = metricValue(response, "Stored pattern candidates");

  const factValues: Record<NonNullable<Intent["fact"]>, { label: string; noun: string }> = {
    orders: { label: "Orders imported", noun: "imported orders" },
    fills: { label: "Fills imported", noun: "imported fills" },
    financial_records: { label: "Financial records", noun: "imported financial records" },
    instruments: { label: "Instruments observed", noun: "observed instruments" },
    candles: { label: "Market candles", noun: "imported market candles" },
    completed_trades: { label: "Completed trades", noun: "completed reconstructed trades" },
  };

  if (intent.fact) {
    const fact = factValues[intent.fact];
    const value = metricValue(response, fact.label) ?? "Not available";
    response.finding = {
      headline: `You currently have ${value} ${fact.noun}.`,
      summary: response.dataWindow.label ? `Coverage: ${response.dataWindow.label}.` : "The completed import did not report a usable coverage window.",
    };
  } else if (intent.limitations) {
    response.finding = {
      headline: "The current import supports descriptive activity, but not completed-trade performance claims.",
      summary: response.limitations[0] ?? "The available evidence does not support the requested conclusion yet.",
    };
  } else if (intent.fees && fees) {
    response.finding = {
      headline: `Known fill-level fees: ${fees}.`,
      summary: "RIKKU kept fill fees separate from financial-record fees because overlap has not been proven.",
    };
  } else if (intent.symbols && symbols) {
    response.finding = {
      headline: `Imported fill activity by symbol: ${symbols}.`,
      summary: "This is fill-frequency evidence, not proof of preference or profitability.",
    };
  } else if (intent.timing && timing) {
    response.finding = {
      headline: `Your most active observed UTC window was ${timing}.`,
      summary: "This describes the imported window only and is not yet a stable behavioral pattern.",
    };
  } else if (intent.market && response.marketContext) {
    response.finding = {
      headline: response.marketContext.available ? "Market context was matched to imported fill activity." : "Market context could not be matched reliably.",
      summary: response.marketContext.summary,
    };
  } else if (intent.memory) {
    response.finding = memories ? {
      headline: `${memories} evidence-linked memor${memories === "1" ? "y is" : "ies are"} currently available.`,
      summary: "Stored memory remains separate from raw Bitget records and keeps its evidence classification visible.",
    } : {
      headline: "No evidence-linked RIKKU memories are available yet.",
      summary: "RIKKU did not turn a short imported history into an unsupported behavioral memory.",
    };
  } else if (intent.patterns) {
    response.finding = patterns ? {
      headline: `${patterns} stored pattern candidates are available for review.`,
      summary: "Stored candidates are not treated as validated behavior without sufficient supporting evidence.",
    } : {
      headline: "No reliable behavioral pattern is established yet.",
      summary: "The current fill sample and unreconstructed trades are insufficient for a defensible behavioral conclusion.",
    };
  } else if (intent.portfolio) {
    response.finding = {
      headline: "Bitget returned no current assets or positions during the latest sync.",
      summary: "RIKKU will not estimate portfolio value, allocation, or exposure from order and fill history.",
    };
  } else if (intent.risk) {
    response.finding = {
      headline: "Only limited descriptive risk evidence is available from the current import.",
      summary: "Closed-trade drawdown, expectancy, VaR, and CVaR remain unavailable without reconstructed return history.",
    };
  }
  response.interpretation = response.finding.summary;
  response.suggestedFollowups = response.status === "completed" && response.answerKind !== "fact" ? [
    "What information is missing?",
    "Show me evidence against this conclusion.",
  ] : [];
}

export async function orchestrateAsk(input: AskOrchestrationInput): Promise<AskResponse> {
  const question = normalizeQuestion(input.question);
  const history = (input.history ?? []).map(normalizeQuestion).filter(Boolean).slice(-8);
  const intent = classify(question, history);
  const answerKind = answerKindFor(input.mode, intent);
  const context: AnalysisContext = { source: input.source };

  let connection;
  try {
    connection = await input.source.getConnectionStatus();
  } catch {
    const response = baseResponse(question, input.mode, answerKind, "insufficient_data", {
      headline: "RIKKU could not safely read your connection status.",
      summary: "No analysis was generated because the authenticated data check was unavailable.",
    });
    response.limitations.push("Connection status could not be verified for this request.");
    response.toolRuns.push(sourceFailureRun("get_import_summary"));
    return response;
  }

  if (!connection.connected) {
    const response = baseResponse(question, input.mode, answerKind, "needs_connection", {
      headline: "Connect Bitget before asking for account-specific analysis.",
      summary: "RIKKU does not infer personal trading activity without an authenticated, read-only Bitget connection.",
    });
    response.limitations.push("No verified Bitget connection is available for this session.");
    response.toolRuns.push(resultTool("get_import_summary", "skipped", "A verified Bitget connection is required before imported activity can be read.", []));
    return response;
  }

  let summary: AskImportSummary | null;
  try {
    summary = input.initialImport === undefined ? await input.source.getLatestCompletedImport() : input.initialImport;
  } catch {
    const response = baseResponse(question, input.mode, answerKind, "insufficient_data", {
      headline: "RIKKU could not safely read the completed import.",
      summary: "No analysis was generated because import metadata was unavailable.",
    });
    response.toolRuns.push(sourceFailureRun("get_import_summary"));
    response.limitations.push("Import metadata could not be read for this request.");
    return response;
  }

  if (!summary) {
    const response = baseResponse(question, input.mode, answerKind, "needs_import", {
      headline: "Import Bitget activity before asking this question.",
      summary: "Your connection is verified, but RIKKU has no completed Bitget import to analyze yet.",
    });
    response.toolRuns.push(resultTool("get_import_summary", "insufficient_data", "No completed Bitget import is available.", ["Bitget connection status"]));
    response.sources.push({ label: "Bitget connection status" });
    response.limitations.push("No completed import is available for evidence-backed analysis.");
    return response;
  }

  const response = baseResponse(question, input.mode, answerKind, "completed", {
    headline: "Imported Bitget activity is available for descriptive analysis.",
    summary: "RIKKU calculated only metrics supported by the current import and did not infer profitability or behavior from unreconstructed trades.",
  });
  const metrics = response.evidence;
  response.dataWindow = formatWindow(summary.earliestRecordAt, summary.latestRecordAt);
  importMetrics(summary, metrics, intent);
  addSource(response.sources, "Bitget import summary", response.dataWindow.label ? `Coverage: ${response.dataWindow.label}` : undefined);
  const summaryMetric = intent.fact ? metrics[0] : null;
  response.toolRuns.push(resultTool(
    "get_import_summary",
    "completed",
    summaryMetric ? `${summaryMetric.label}: ${summaryMetric.value}.` : "The latest completed import summary is available.",
    ["Bitget import summary"],
    summary.fills,
  ));

  const needsTradeReconstruction = intent.activity || intent.patterns || intent.risk || intent.limitations || intent.deep || intent.followUp !== null;
  if (summary.completedTrades === 0 && needsTradeReconstruction) {
    response.limitations.push("Completed trades cannot yet be reconstructed because opening inventory inside the imported Bitget history window is unknown.");
    response.limitations.push("Win rate, realized trade return, tail risk by trade, disposition effect, R multiple, and trade expectancy are not available.");
  }
  if (!response.dataWindow.label) response.limitations.push("The completed import did not report a usable coverage window.");

  const plan = toolPlan(input.mode, intent).filter((key) => key !== "get_import_summary");
  let activity: Activity | null = null;
  let marketMatched = 0;

  for (const key of plan) {
    try {
      if (key === "analyze_trading_activity") {
        activity = await parsedActivity(context);
        if (!activity.fills.length) {
          response.toolRuns.push(noDataRun(key, "No valid imported fills were available for activity analysis."));
          response.limitations.push("Imported fill rows lacked the fields required for activity analysis.");
          continue;
        }
        addSource(response.sources, "Bitget fills");
        addMetric(metrics, "Fills analyzed", String(activity.fills.length));
        addMetric(metrics, "Active trading days", String(activity.activeDays));
        addMetric(metrics, "Fills per active day", String(round(activity.fills.length / activity.activeDays)));
        addMetric(metrics, "Average interval between fills", formatDuration(activity.averageIntervalMs));
        addMetric(metrics, "Median interval between fills", formatDuration(activity.medianIntervalMs));
        addMetric(metrics, "Buy / sell fills", `${activity.buyCount} buy · ${activity.sellCount} sell${activity.unknownSideCount ? ` · ${activity.unknownSideCount} unclassified` : ""}`);
        response.finding = {
          headline: `${activity.fills.length} imported fills across ${activity.bySymbol.size} instrument${activity.bySymbol.size === 1 ? "" : "s"} on ${activity.activeDays} active trading day${activity.activeDays === 1 ? "" : "s"}.`,
          summary: "This is a descriptive view of imported fills. It does not represent reconstructed trades, PnL, or a behavioral conclusion.",
        };
        response.toolRuns.push(resultTool(key, "completed", `${activity.fills.length} valid fills across ${activity.activeDays} active UTC day${activity.activeDays === 1 ? "" : "s"}.`, ["Bitget fills"], activity.fills.length));
        continue;
      }

      if (key === "analyze_fees") {
        activity ??= await parsedActivity(context);
        const records = await input.source.getFinancialRecords();
        addSource(response.sources, "Bitget financial records", `${records.length} records examined separately from fill fees.`);
        const fees = new Map<string, { units: bigint; observations: number }>();
        for (const fill of activity.fills) {
          if (fill.feeAmount === null || fill.feeAmount < 0n || !fill.feeCoin) continue;
          const entry = fees.get(fill.feeCoin) ?? { units: 0n, observations: 0 };
          entry.units += fill.feeAmount;
          entry.observations++;
          fees.set(fill.feeCoin, entry);
        }
        if (!fees.size) {
          response.toolRuns.push(noDataRun(key, "No valid fill-level fee observations were available. Financial-record fees were not substituted because overlap has not been proven."));
          response.limitations.push("No valid fill-level fee totals are available. Financial-record fee values are kept separate to avoid double-counting.");
          continue;
        }
        addSource(response.sources, "Bitget fills", "Fee observations are taken from fills only.");
        const detail = [...fees.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([coin, fee]) => `${formatUnits(fee.units)} ${coin} (${fee.observations} fill${fee.observations === 1 ? "" : "s"})`).join(" · ");
        addMetric(metrics, "Known fill fees by coin", detail, "Fill fees only; not added to financial-record fees.");
        addMetric(metrics, "Financial records reviewed", String(records.length), "Kept separate from fill-level fee observations.");
        response.toolRuns.push(resultTool(key, "completed", `Known fill-level fees are reported by native coin. ${records.length} financial records were kept separate to prevent double-counting.`, ["Bitget fills", "Bitget financial records"], activity.fills.length));
        continue;
      }

      if (key === "analyze_symbol_concentration") {
        activity ??= await parsedActivity(context);
        if (!activity.fills.length) {
          response.toolRuns.push(noDataRun(key, "No valid imported fills were available for symbol analysis."));
          continue;
        }
        const ranked = [...activity.bySymbol.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const [topSymbol, topCount] = ranked[0];
        const symbolDetail = ranked.map(([symbol, count]) => `${symbol}: ${count}`).join(" · ");
        const topShare = round(topCount / activity.fills.length * 100);
        addMetric(metrics, "Activity by symbol", symbolDetail);
        addMetric(metrics, "Top-symbol activity share", `${topSymbol}: ${topShare}% (${topCount} of ${activity.fills.length} fills)`);
        addSource(response.sources, "Bitget fills");

        const instruments = await input.source.getInstruments();
        const quotes = new Map(instruments.flatMap((instrument) => {
          const key = instrument.symbol?.trim().toUpperCase();
          const quote = instrument.quoteCoin?.trim().toUpperCase();
          return key && quote ? [[`${instrument.category?.trim().toUpperCase() ?? ""}|${key}`, quote] as const] : [];
        }));
        const notional = new Map<string, { units: bigint; fills: number }>();
        for (const fill of activity.fills) {
          const quote = quotes.get(`${fill.category ?? ""}|${fill.symbol}`);
          if (!quote) continue;
          const value = fill.executionValue && fill.executionValue > 0n
            ? fill.executionValue
            : fill.executionPrice && fill.executionQuantity && fill.executionPrice > 0n && fill.executionQuantity > 0n
              ? fill.executionPrice * fill.executionQuantity / SCALE
              : null;
          if (value === null || value <= 0n) continue;
          const entry = notional.get(quote) ?? { units: 0n, fills: 0 };
          entry.units += value;
          entry.fills++;
          notional.set(quote, entry);
        }
        if (notional.size) {
          const nativeNotional = [...notional.entries()].sort(([a], [b]) => a.localeCompare(b))
            .map(([coin, entry]) => `${formatUnits(entry.units)} ${coin} (${entry.fills} valid fill${entry.fills === 1 ? "" : "s"})`).join(" · ");
          addMetric(metrics, "Valid native-quote notional", nativeNotional, "Only valid execution values or price × quantity; currencies are not combined.");
          addSource(response.sources, "Bitget instruments");
        } else {
          response.limitations.push("No valid native-quote notional could be established without a matching instrument quote currency and valid execution values.");
        }
        response.toolRuns.push(resultTool(key, "completed", `${topSymbol} accounts for ${topShare}% of valid imported fill activity.`, ["Bitget fills", "Bitget instruments"], activity.fills.length));
        continue;
      }

      if (key === "analyze_trade_timing") {
        activity ??= await parsedActivity(context);
        if (!activity.fills.length || !activity.byHour.size) {
          response.toolRuns.push(noDataRun(key, "No valid fill timestamps were available for timing analysis."));
          continue;
        }
        const [hour, count] = [...activity.byHour.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        const label = `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59 UTC`;
        addMetric(metrics, "Most active time window", `${label} (${count} fill${count === 1 ? "" : "s"})`);
        addSource(response.sources, "Bitget fills");
        response.toolRuns.push(resultTool(key, "completed", `The most active observed UTC hour is ${label}.`, ["Bitget fills"], activity.fills.length));
        continue;
      }

      if (key === "analyze_market_context" || key === "analyze_market_regime") {
        activity ??= await parsedActivity(context);
        if (!activity.fills.length) {
          response.toolRuns.push(noDataRun(key, "No valid fills were available for market matching."));
          continue;
        }
        const candles = await input.source.getMarketCandles();
        const matches = findMarketMatches(activity, candles);
        if (key === "analyze_market_context") {
          if (!matches.length) {
            response.marketContext = { available: false, summary: "Insufficient data: no imported daily candle could be matched to a fill date and symbol.", matchedFills: 0 };
            response.toolRuns.push(noDataRun(key, "No imported daily candles matched a fill date and symbol."));
            continue;
          }
          marketMatched = matches.length;
          const ranges = matches.map(({ candle }) => (candle.high - candle.low) / candle.open * 100).filter(Number.isFinite).sort((a, b) => a - b);
          const medianRange = ranges.length % 2 ? ranges[(ranges.length - 1) / 2] : (ranges[ranges.length / 2 - 1] + ranges[ranges.length / 2]) / 2;
          const up = matches.filter(({ candle }) => candle.close > candle.open).length;
          const down = matches.filter(({ candle }) => candle.close < candle.open).length;
          const flat = matches.length - up - down;
          const summaryText = `Daily candle context matched ${matches.length} of ${activity.fills.length} fill${activity.fills.length === 1 ? "" : "s"}; median same-day high–low range was ${round(medianRange)}%. ${up} matched up day${up === 1 ? "" : "s"}, ${down} down, ${flat} flat.`;
          response.marketContext = { available: true, summary: summaryText, matchedFills: matches.length };
          addMetric(metrics, "Matched market context", `${matches.length} of ${activity.fills.length} fills`, "Same-symbol, same-UTC-day daily candles.");
          addMetric(metrics, "Median matched daily range", `${round(medianRange)}%`, "High–low range relative to daily open; not a formal volatility estimate.");
          addSource(response.sources, "Bitget daily candles");
          response.toolRuns.push(resultTool(key, "completed", summaryText, ["Bitget fills", "Bitget daily candles"], matches.length));
        } else {
          const normalized = candles.flatMap((row) => {
            const symbol = row.symbol?.trim().toUpperCase();
            const observedAt = row.observedAt ? Date.parse(row.observedAt) : Number.NaN;
            const close = decimalUnits(row.close);
            if (!symbol || !Number.isFinite(observedAt) || close === null || close <= 0n) return [];
            const numeric = decimalToNumber(close);
            return numeric === null ? [] : [{ symbol, observedAt, close: numeric }];
          });
          const bySymbol = new Map<string, typeof normalized>();
          for (const candle of normalized) bySymbol.set(candle.symbol, [...(bySymbol.get(candle.symbol) ?? []), candle]);
          const counts = new Map<"uptrend" | "downtrend" | "neutral", number>();
          for (const match of matches) {
            const series = [...(bySymbol.get(match.fill.symbol) ?? [])].sort((a, b) => a.observedAt - b.observedAt);
            const index = series.findIndex((candle) => candle.observedAt === match.candle.observedAt);
            if (index < 5) continue;
            const prior = series[index - 5].close;
            const current = series[index].close;
            const returnPct = (current / prior - 1) * 100;
            const regime: "uptrend" | "downtrend" | "neutral" = returnPct > 2 ? "uptrend" : returnPct < -2 ? "downtrend" : "neutral";
            counts.set(regime, (counts.get(regime) ?? 0) + 1);
          }
          const classified = [...counts.values()].reduce((sum, count) => sum + count, 0);
          if (!classified) {
            response.toolRuns.push(noDataRun(key, "At least five prior daily candles were not available around any matched fill."));
            continue;
          }
          const text = `${counts.get("uptrend") ?? 0} uptrend · ${counts.get("downtrend") ?? 0} downtrend · ${counts.get("neutral") ?? 0} neutral across ${classified} fill context${classified === 1 ? "" : "s"}`;
          if (response.marketContext) response.marketContext.regimeSummary = `Simple five-candle regime: ${text}.`;
          addMetric(metrics, "Five-candle market regime", text, "Up/down when five-candle return exceeds ±2%; otherwise neutral.");
          addSource(response.sources, "Bitget daily candles");
          response.toolRuns.push(resultTool(key, "completed", `Simple five-candle regime was available for ${classified} matched fill contexts.`, ["Bitget fills", "Bitget daily candles"], classified));
        }
        continue;
      }

      if (key === "retrieve_memories") {
        const memories = await input.source.getMemories(input.mode === "scout" ? 2 : 5);
        if (!memories.length) {
          response.toolRuns.push(noDataRun(key, "No evidence-linked RIKKU memories are available yet."));
          continue;
        }
        addSource(response.sources, "RIKKU memory");
        const factual = memories.filter((memory) => memory.classification === "fact").length;
        for (const [index, memory] of memories.entries()) {
          const statement = memory.statement?.trim().slice(0, 500);
          if (!statement) continue;
          response.qualitativeEvidence.push({
            kind: "memory",
            label: `RIKKU memory ${index + 1}`,
            statement,
            classification: memory.classification,
            confidence: memory.confidence,
            status: memory.status,
          });
        }
        addMetric(metrics, "Relevant RIKKU memories", String(memories.length), `${factual} factual; memories are shown separately from imported source records.`);
        response.toolRuns.push(resultTool(key, "completed", `${memories.length} relevant RIKKU memor${memories.length === 1 ? "y" : "ies"} were retrieved.`, ["RIKKU memory"], memories.length));
        continue;
      }

      if (key === "retrieve_patterns") {
        const patterns = await input.source.getPatterns(5);
        if (!patterns.length) {
          response.toolRuns.push(noDataRun(key, "No validated or candidate patterns are stored yet."));
          continue;
        }
        addSource(response.sources, "RIKKU patterns");
        for (const [index, pattern] of patterns.entries()) {
          const statement = pattern.claim?.trim().slice(0, 500);
          if (!statement) continue;
          response.qualitativeEvidence.push({
            kind: "pattern",
            label: `RIKKU pattern ${index + 1}`,
            statement,
            classification: null,
            confidence: pattern.confidence,
            status: pattern.status,
          });
        }
        addMetric(metrics, "Stored pattern candidates", String(patterns.length), "Stored patterns are not substituted for a fresh statistical finding.");
        response.toolRuns.push(resultTool(key, "completed", `${patterns.length} stored pattern candidate${patterns.length === 1 ? "" : "s"} were retrieved.`, ["RIKKU patterns"], patterns.length));
        continue;
      }

      if (key === "analyze_portfolio") {
        if (summary.assets === 0 && summary.positions === 0) {
          response.toolRuns.push(noDataRun(key, "No current assets or positions were returned by the connected Bitget account."));
          response.limitations.push("No current assets or positions were returned by the connected Bitget account.");
        } else {
          response.toolRuns.push(noDataRun(key, "Portfolio rows require a dedicated current-account read before allocation can be calculated."));
          response.limitations.push("Current portfolio allocation was not calculated from import counts alone.");
        }
        continue;
      }

      if (["analyze_tail_risk", "analyze_overtrading", "analyze_disposition_effect", "retrieve_similar_scenarios"].includes(key)) {
        const label = key === "analyze_tail_risk" ? "tail-risk analysis"
          : key === "analyze_overtrading" ? "overtrading analysis"
            : key === "analyze_disposition_effect" ? "disposition-effect analysis"
              : "similar-scenario retrieval";
        if (summary.completedTrades === 0) {
          response.toolRuns.push(noDataRun(key, `${label} is not available because completed trades cannot yet be reconstructed.`));
        } else {
          response.toolRuns.push(noDataRun(key, `${label} requires a dedicated validated dataset and was not substituted from fill counts.`));
        }
        continue;
      }

      if (key === "run_skeptic_check") {
        activity ??= await parsedActivity(context);
        const confidence = confidenceFor(summary, activity, marketMatched);
        response.confidence = confidence;
        const reasons = [...confidence.reasons];
        if (response.dataWindow.label) reasons.push(`Data window: ${response.dataWindow.label}.`);
        response.confidence = { ...confidence, reasons };
        response.toolRuns.push(resultTool(key, "completed", `Confidence is capped at ${confidence.level.toUpperCase()} after sample-size, coverage, and reconstruction checks.`, ["Bitget import summary"], activity.fills.length));
      }
    } catch (error) {
      if (error instanceof AskDataAccessError) dataUnavailable(response, key);
      else dataUnavailable(response, key);
    }
  }

  if (!response.toolRuns.some((tool) => tool.key === "run_skeptic_check")) {
    response.confidence = answerKind === "fact"
      ? { level: "high", reasons: ["This value comes directly from the latest completed import summary."] }
      : confidenceFor(summary, activity, marketMatched);
  }
  applyQuestionFocusedFinding(response, intent);
  const evidenceToolCompleted = response.toolRuns.some((tool) => tool.status === "completed"
    && tool.key !== "get_import_summary" && tool.key !== "run_skeptic_check");
  if (answerKind !== "fact" && ((!activity && summary.fills === 0) || !evidenceToolCompleted)) {
    response.status = "insufficient_data";
    response.finding = {
      headline: summary.fills === 0
        ? "The completed import contains no fills to analyze yet."
        : "The requested evidence could not be established from the imported data.",
      summary: "RIKKU can report import coverage but will not invent activity, fee, timing, or market metrics.",
    };
    response.interpretation = response.finding.summary;
  }
  return response;
}

/** The deterministic plan is exported so mode budgets remain testable. */
export function planAskTools(question: string, mode: AskMode, history: string[] = []) {
  return toolPlan(mode, classify(normalizeQuestion(question), history.map(normalizeQuestion)));
}

export function askDataFingerprintInput(summary: AskImportSummary, question: string, mode: AskMode, history: string[]) {
  return JSON.stringify({
    version: ASK_ANALYSIS_VERSION,
    mode,
    question: normalizeQuestion(question).toLowerCase(),
    history: history.slice(-2).map(normalizeQuestion).map((value) => value.toLowerCase()),
    import: {
      id: summary.id,
      completedAt: summary.completedAt,
      orders: summary.orders,
      fills: summary.fills,
      financialRecords: summary.financialRecords,
      assets: summary.assets,
      positions: summary.positions,
      instruments: summary.instruments,
      marketCandles: summary.marketCandles,
      completedTrades: summary.completedTrades,
      earliestRecordAt: summary.earliestRecordAt,
      latestRecordAt: summary.latestRecordAt,
    },
  });
}
