import { afterEach, describe, expect, it, vi } from "vitest";
import { ReasoningProviderError, type ReasoningProviderPlanRequest, type ReasoningProviderRequest } from "@/lib/ask/reasoning-provider";
import type { AskDataSource, AskFill } from "@/lib/ask/types";

const boundaries = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  createServiceClient: vi.fn(),
  createDataSource: vi.fn(),
  createReasoningProvider: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: boundaries.createServerClient,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceClient: boundaries.createServiceClient,
}));
vi.mock("@/lib/ask/supabase-data-source", () => ({
  createSupabaseAskDataSource: boundaries.createDataSource,
}));
vi.mock("@/lib/ask/reasoning-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ask/reasoning-provider")>();
  return { ...actual, createReasoningProvider: boundaries.createReasoningProvider };
});

import { POST } from "@/app/api/ask/route";

const coverageStart = "2026-07-08T06:26:10.790Z";
const coverageEnd = "2026-08-04T01:02:55.542Z";

function readClient(options: {
  latestAnalysisRows?: Array<Record<string, unknown>>;
  recentRuns?: Array<Record<string, unknown>>;
  recentResults?: Array<Record<string, unknown>>;
  userId?: string;
} = {}) {
  const latestAnalysisRows = options.latestAnalysisRows ?? [];
  const recentRuns = options.recentRuns ?? [];
  const recentResults = options.recentResults ?? [];
  const userId = options.userId ?? "route-pipeline-user";
  const analysisUserScope = vi.fn();
  const from = vi.fn((table: string) => {
    let inColumn = "";
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "contains", "order"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.in = vi.fn((column: string) => {
      inColumn = column;
      return chain;
    });
    chain.eq = vi.fn((column: string, value: unknown) => {
      if (table === "analysis_results" && column === "user_id") analysisUserScope(value);
      return chain;
    });
    chain.limit = vi.fn(async () => ({
      data: table === "agent_runs" ? recentRuns : table === "analysis_results" ? latestAnalysisRows : [],
      error: null,
    }));
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve({
      data: table === "analysis_results" && inColumn === "agent_run_id" ? recentResults : null,
      error: null,
    }).then(resolve, reject);
    return chain;
  });
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: userId } }, error: null })) },
    from,
    analysisUserScope,
  };
}

function writeClient() {
  const from = vi.fn((table: string) => {
    let action = "";
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "contains", "order", "limit", "in"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.insert = vi.fn(() => {
      action = "insert";
      return chain;
    });
    chain.upsert = vi.fn(() => {
      action = "upsert";
      return chain;
    });
    chain.maybeSingle = vi.fn(async () => ({
      data: action === "insert" && table === "agent_runs"
        ? { id: "synthetic-agent-run" }
        : action === "insert" && table === "memories"
          ? { id: "synthetic-memory" }
          : null,
      error: null,
    }));
    chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve, reject);
    return chain;
  });
  return { from };
}

function dataSource(): AskDataSource {
  const fills: AskFill[] = [
    {
      category: "SPOT",
      symbol: "BTCUSDT",
      side: "buy",
      executionPrice: "100",
      executionQuantity: "1",
      executionValue: "100",
      feeAmount: "0.1",
      feeCoin: "USDT",
      executedAt: coverageStart,
    },
    {
      category: "SPOT",
      symbol: "ETHUSDT",
      side: "sell",
      executionPrice: "200",
      executionQuantity: "1",
      executionValue: "200",
      feeAmount: "0.1",
      feeCoin: "USDT",
      executedAt: coverageEnd,
    },
  ];

  return {
    getConnectionStatus: vi.fn(async () => ({ connected: true, lastSyncedAt: "2026-09-18T00:00:00.000Z" })),
    getLatestCompletedImport: vi.fn(async () => ({
      id: "synthetic-import",
      completedAt: "2026-09-18T00:00:00.000Z",
      orders: 2,
      fills: 2,
      financialRecords: 1,
      assets: 0,
      positions: 0,
      instruments: 2,
      marketCandles: 0,
      completedTrades: 0,
      earliestRecordAt: coverageStart,
      latestRecordAt: coverageEnd,
    })),
    getFills: vi.fn(async () => fills),
    getFinancialRecords: vi.fn(async () => [{
      coin: "USDT",
      recordType: "fee",
      fee: null,
      amount: null,
      recordedAt: coverageStart,
    }]),
    getInstruments: vi.fn(async () => [
      { category: "SPOT", symbol: "BTCUSDT", quoteCoin: "USDT" },
      { category: "SPOT", symbol: "ETHUSDT", quoteCoin: "USDT" },
    ]),
    getMarketCandles: vi.fn(async () => []),
    getMemories: vi.fn(async () => []),
    getPatterns: vi.fn(async () => []),
  };
}

function askRequest(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      question: "What does the verified activity show?",
      mode: "analyst",
      threadId: "44444444-4444-4444-8444-444444444444",
      contextId: null,
      history: [],
      ...overrides,
    }),
  });
}

function focusedActivityPlan() {
  return {
    understoodQuestion: "Describe the verified imported activity.",
    informationNeeds: ["Observed fill activity"],
    toolRequests: ["get_import_summary", "analyze_trading_activity"],
    needsConversationContext: false,
    referencedPriorFindingIds: [],
    analysisDepth: "focused" as const,
    reasoningGoal: "Explain only what the imported activity establishes.",
    requiresJoinedAnalysis: false,
    answerKind: "analysis" as const,
    requestedImportMetric: null,
  };
}

describe("POST /api/ask semantic reasoning pipeline", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("executes the model-selected read-only tools and sends their structured evidence to external synthesis", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const server = readClient();
    const service = writeClient();
    const source = dataSource();
    boundaries.createServerClient.mockResolvedValue(server);
    boundaries.createServiceClient.mockReturnValue(service);
    boundaries.createDataSource.mockReturnValue(source);

    const plan = {
      understoodQuestion: "Inspect verified fee evidence.",
      informationNeeds: ["Observed fill fees by native coin"],
      toolRequests: ["get_import_summary", "analyze_fees"],
      needsConversationContext: false,
      referencedPriorFindingIds: [],
      analysisDepth: "focused",
      reasoningGoal: "Explain only what the verified fee evidence supports.",
      requiresJoinedAnalysis: false,
      answerKind: "analysis",
      requestedImportMetric: null,
    };
    const synthesis = {
      answerKind: "analysis",
      finding: {
        headline: "Known fill fees are available by native coin.",
        summary: "The verified total is limited to observed fill-level fees.",
      },
      interpretation: "The known total covers observed fill fees in the imported window and does not establish complete account costs.",
      reasoningPoints: [
        {
          kind: "observation",
          statement: "Known fill fees are reported separately.",
          rationale: "This avoids combining unproven overlapping records.",
          evidenceLabels: ["Known fill fees by coin"],
          test: null,
        },
        {
          kind: "uncertainty",
          statement: "The total does not establish complete account costs.",
          rationale: "Financial records were reviewed separately.",
          evidenceLabels: ["Known fill fees by coin"],
          test: "Reconcile fee records against fills.",
        },
      ],
      evidenceLabels: ["Known fill fees by coin"],
      confidence: "low",
      confidenceReasons: ["The evidence is limited to the imported window."],
      limitations: ["Financial records were reviewed separately."],
      suggestedFollowups: ["Which instruments contributed to the observed fee total?"],
    };
    const generateStructuredPlan = vi.fn(async (request: ReasoningProviderPlanRequest) => {
      void request;
      return plan;
    });
    const generateStructuredResponse = vi.fn(async (request: ReasoningProviderRequest) => {
      void request;
      return synthesis;
    });
    boundaries.createReasoningProvider.mockReturnValue({
      id: "groq",
      modelIdentifier: () => "synthetic-reasoner",
      generateStructuredPlan,
      generateStructuredResponse,
    });

    const response = await POST(new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What can the imported fee evidence actually establish?",
        mode: "analyst",
        threadId: "11111111-1111-4111-8111-111111111111",
        contextId: null,
        history: [],
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(generateStructuredPlan).toHaveBeenCalledOnce();
    expect(generateStructuredResponse).toHaveBeenCalledOnce();
    expect(source.getFills).toHaveBeenCalledOnce();
    expect(source.getFinancialRecords).toHaveBeenCalledOnce();
    expect(source.getMarketCandles).not.toHaveBeenCalled();
    expect(source.getMemories).not.toHaveBeenCalled();
    expect(body.response.toolRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "analyze_fees", status: "completed" }),
      expect.objectContaining({ key: "run_skeptic_check", status: "completed" }),
    ]));

    const planningPrompt = generateStructuredPlan.mock.calls[0][0].prompt;
    const synthesisPrompt = generateStructuredResponse.mock.calls[0][0].prompt;
    expect(planningPrompt).toContain("analyze_fees");
    expect(synthesisPrompt).toContain("Known fill fees by coin");
    expect(synthesisPrompt).toContain("calculatedMetrics");
    expect(synthesisPrompt).toContain("analyze_fees");

    expect(body.response).toMatchObject({
      finding: { headline: synthesis.finding.headline },
      reasoningStatus: "external_llm",
      reasoningProvider: { id: "groq", model: "synthetic-reasoner" },
    });
    expect(body.response.reasoningNotice).toBeUndefined();
    expect(service.from).toHaveBeenCalledWith("analysis_results");
    expect(service.from).toHaveBeenCalledWith("agent_runs");
  });

  it("loads a bounded user-owned latest validated analysis instead of a generic context placeholder", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const server = readClient({
      latestAnalysisRows: [{
        skill_key: "ask-evidence-response",
        confidence: "low",
        created_at: "2026-09-18T00:00:00.000Z",
        result: {
          status: "completed",
          finding: {
            headline: "Activity was concentrated in two imported instruments.",
            summary: "The concentration is descriptive within the current import window.",
          },
          interpretation: "The records support concentration, not a persistent behavioral trait.",
          evidence: [{ label: "Instrument mix", value: "BTCUSDT and ETHUSDT" }],
          limitations: ["The import window is incomplete."],
          dataWindow: { label: "Jul 8 – Aug 4, 2026" },
        },
      }],
      recentRuns: [{ id: "prior-run-1", question: "What was concentrated?", created_at: "2026-09-17T00:00:00.000Z" }],
      recentResults: [{
        agent_run_id: "prior-run-1",
        result: { finding: { headline: "BTCUSDT dominated the imported slice.", summary: "This was descriptive, not causal." } },
      }],
      userId: "latest-context-user",
    });
    const service = writeClient();
    const source = dataSource();
    boundaries.createServerClient.mockResolvedValue(server);
    boundaries.createServiceClient.mockReturnValue(service);
    boundaries.createDataSource.mockReturnValue(source);

    const generateStructuredPlan = vi.fn(async (request: ReasoningProviderPlanRequest) => {
      void request;
      return {
        understoodQuestion: "Challenge the selected prior conclusion.",
        informationNeeds: ["Prior conclusion and its limitations"],
        toolRequests: ["get_import_summary", "analyze_symbol_concentration"],
        needsConversationContext: true,
        referencedPriorFindingIds: ["prior-run-1"],
        analysisDepth: "focused",
        reasoningGoal: "Test the bounded prior conclusion against imported evidence.",
        requiresJoinedAnalysis: false,
        answerKind: "analysis",
        requestedImportMetric: null,
      };
    });
    const generateStructuredResponse = vi.fn(async (request: ReasoningProviderRequest) => {
      void request;
      return {
        answerKind: "analysis",
        finding: { headline: "The prior conclusion remains bounded.", summary: "It describes only the imported window." },
        interpretation: "The selected analysis does not establish a persistent trait.",
        reasoningPoints: [{
          kind: "counter_evidence",
          statement: "The import window is incomplete.",
          rationale: "A partial window can overstate concentration.",
          evidenceLabels: ["Selected latest validated RIKKU analysis"],
          test: "Compare a longer import window.",
        }],
        evidenceLabels: ["Selected latest validated RIKKU analysis"],
        confidence: "low",
        confidenceReasons: ["The selected analysis is bounded."],
        limitations: ["The import window is incomplete."],
        suggestedFollowups: [],
      };
    });
    boundaries.createReasoningProvider.mockReturnValue({
      id: "groq",
      modelIdentifier: () => "synthetic-reasoner",
      generateStructuredPlan,
      generateStructuredResponse,
    });

    const response = await POST(new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "What evidence goes against the latest conclusion?",
        mode: "analyst",
        threadId: "22222222-2222-4222-8222-222222222222",
        contextId: "latest-analysis",
        history: [],
      }),
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.response.qualitativeEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Selected latest validated RIKKU analysis",
        classification: "prior_validated_analysis",
      }),
    ]));
    expect(server.analysisUserScope).toHaveBeenCalledWith("latest-context-user");
    const planningPrompt = generateStructuredPlan.mock.calls[0][0].prompt;
    const synthesisPrompt = generateStructuredResponse.mock.calls[0][0].prompt;
    expect(planningPrompt).toContain("Activity was concentrated in two imported instruments.");
    expect(planningPrompt).toContain("The import window is incomplete.");
    expect(planningPrompt).not.toContain("Most recent validated RIKKU analysis");
    expect(planningPrompt.length).toBeLessThan(20_000);
    expect(synthesisPrompt).toContain("Challenge the selected prior conclusion.");
    expect(synthesisPrompt).toContain("Test the bounded prior conclusion against imported evidence.");
    expect(synthesisPrompt).toContain("prior-run-1");
    expect(synthesisPrompt).toContain("BTCUSDT dominated the imported slice.");
  });

  it("fails safely when the requested latest validated analysis is unavailable", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const server = readClient({ userId: "missing-context-user" });
    boundaries.createServerClient.mockResolvedValue(server);

    const response = await POST(new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: "Challenge the latest conclusion.",
        mode: "analyst",
        threadId: "33333333-3333-4333-8333-333333333333",
        contextId: "latest-analysis",
        history: [],
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ ok: false, code: "ASK_CONTEXT_NOT_FOUND" });
    expect(server.analysisUserScope).toHaveBeenCalledWith("missing-context-user");
    expect(boundaries.createReasoningProvider).not.toHaveBeenCalled();
  });

  it("returns a safe deterministic fallback when semantic planning is unavailable", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const server = readClient({ userId: "planning-fallback-user" });
    const service = writeClient();
    const source = dataSource();
    boundaries.createServerClient.mockResolvedValue(server);
    boundaries.createServiceClient.mockReturnValue(service);
    boundaries.createDataSource.mockReturnValue(source);
    boundaries.createReasoningProvider.mockImplementation(() => {
      throw new ReasoningProviderError("NOT_CONFIGURED");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await POST(askRequest({
      question: "Look for something unusual in my activity.",
      threadId: "55555555-5555-4555-8555-555555555555",
    }));
    const body = await result.json();

    expect(result.status).toBe(200);
    expect(body.response).toMatchObject({
      status: "insufficient_data",
      reasoningStatus: "deterministic_fallback",
      finding: { headline: "RIKKU could not interpret this question safely." },
    });
    expect(body.response.reasoningNotice).toContain("not configured");
    expect(body.response.toolRuns).toEqual([
      expect.objectContaining({ key: "get_import_summary", status: "completed" }),
    ]);
    expect(source.getFills).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("rikku.ask.semantic_planning_failure"));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("Look for something unusual");
    warning.mockRestore();
  });

  it("returns the completed deterministic evidence when Stage B reasoning fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const server = readClient({ userId: "synthesis-fallback-user" });
    const service = writeClient();
    const source = dataSource();
    boundaries.createServerClient.mockResolvedValue(server);
    boundaries.createServiceClient.mockReturnValue(service);
    boundaries.createDataSource.mockReturnValue(source);
    const generateStructuredPlan = vi.fn(async () => focusedActivityPlan());
    const generateStructuredResponse = vi.fn(async () => {
      throw new ReasoningProviderError("RATE_LIMIT", {
        status: 429,
        code: "rate_limit_exceeded",
        type: "tokens",
        retryAfter: "12",
        tokenReset: "2s",
      });
    });
    boundaries.createReasoningProvider.mockReturnValue({
      id: "groq",
      modelIdentifier: () => "synthetic-reasoner",
      generateStructuredPlan,
      generateStructuredResponse,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await POST(askRequest({
      question: "Explain the recent activity without guessing.",
      threadId: "66666666-6666-4666-8666-666666666666",
    }));
    const body = await result.json();

    expect(result.status).toBe(200);
    expect(generateStructuredPlan).toHaveBeenCalledOnce();
    expect(generateStructuredResponse).toHaveBeenCalledOnce();
    expect(source.getFills).toHaveBeenCalledOnce();
    expect(body.response).toMatchObject({
      status: "completed",
      reasoningStatus: "deterministic_fallback",
    });
    expect(body.response.reasoningProvider).toBeUndefined();
    expect(body.response.reasoningNotice).toContain("temporarily unavailable");
    expect(body.response.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Fills analyzed", value: "2" }),
    ]));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("rikku.ask.reasoning_provider_failure"));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("Explain the recent activity");
    warning.mockRestore();
  });

  it("uses a bounded submitted conclusion to resolve a follow-up when persisted thread history is unavailable", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    const server = readClient({ userId: "client-context-fallback-user", recentRuns: [], recentResults: [] });
    const service = writeClient();
    const source = dataSource();
    boundaries.createServerClient.mockResolvedValue(server);
    boundaries.createServiceClient.mockReturnValue(service);
    boundaries.createDataSource.mockReturnValue(source);
    const generateStructuredPlan = vi.fn(async (request: ReasoningProviderPlanRequest) => {
      void request;
      return {
        ...focusedActivityPlan(),
        understoodQuestion: "Explain the prior bounded observation.",
        informationNeeds: ["Evidence behind the prior observation"],
        needsConversationContext: true,
        reasoningGoal: "Explain why the prior observation was made without inventing causation.",
      };
    });
    const generateStructuredResponse = vi.fn(async () => {
      throw new ReasoningProviderError("RATE_LIMIT");
    });
    boundaries.createReasoningProvider.mockReturnValue({
      id: "groq",
      modelIdentifier: () => "synthetic-reasoner",
      generateStructuredPlan,
      generateStructuredResponse,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await POST(askRequest({
      question: "Why do you think that?",
      threadId: "88888888-8888-4888-8888-888888888888",
      history: [{
        question: "What stood out in my activity?",
        conclusion: "The verified slice showed activity concentrated in two observed instruments, without proving a persistent habit.",
      }],
    }));
    const body = await result.json();

    expect(result.status).toBe(200);
    expect(body.response.reasoningStatus).toBe("deterministic_fallback");
    expect(generateStructuredPlan).toHaveBeenCalledOnce();
    const planningPrompt = generateStructuredPlan.mock.calls[0][0].prompt;
    expect(planningPrompt).toContain("What stood out in my activity?");
    expect(planningPrompt).toContain("activity concentrated in two observed instruments");
    expect(planningPrompt).toContain("Why do you think that?");
    expect(source.getFills).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("rejects oversized, malformed, invalid, and sensitive requests before authentication or reasoning", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");

    const oversized = await POST(askRequest({}, { "Content-Length": "8193" }));
    const malformed = await POST(new Request("http://localhost/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }));
    const invalid = await POST(askRequest({ threadId: "not-a-uuid" }));
    const sensitive = await POST(askRequest({ question: "My API secret is private." }));
    const sensitiveHistory = await POST(askRequest({
      history: [{ question: "What stood out?", conclusion: "API secret: private credential material" }],
    }));

    expect([oversized.status, malformed.status, invalid.status, sensitive.status, sensitiveHistory.status]).toEqual([413, 400, 400, 400, 400]);
    expect(await oversized.json()).toMatchObject({ ok: false, code: "ASK_REQUEST_TOO_LARGE" });
    expect(await malformed.json()).toMatchObject({ ok: false, code: "ASK_INVALID_REQUEST" });
    expect(await invalid.json()).toMatchObject({ ok: false, code: "ASK_INVALID_REQUEST" });
    expect(await sensitive.json()).toMatchObject({ ok: false, code: "ASK_SENSITIVE_INPUT" });
    expect(await sensitiveHistory.json()).toMatchObject({ ok: false, code: "ASK_SENSITIVE_INPUT" });
    expect(boundaries.createServerClient).not.toHaveBeenCalled();
    expect(boundaries.createReasoningProvider).not.toHaveBeenCalled();
  });

  it("classifies missing Supabase configuration and unavailable authentication safely", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const missingConfig = await POST(askRequest());
    expect(missingConfig.status).toBe(503);
    expect(await missingConfig.json()).toMatchObject({ ok: false, code: "SUPABASE_NOT_CONFIGURED" });

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    boundaries.createServerClient.mockRejectedValueOnce(new Error("synthetic auth outage"));
    const authUnavailable = await POST(askRequest({ threadId: "77777777-7777-4777-8777-777777777777" }));
    expect(authUnavailable.status).toBe(503);
    expect(await authUnavailable.json()).toMatchObject({ ok: false, code: "AUTH_UNAVAILABLE" });
    expect(boundaries.createReasoningProvider).not.toHaveBeenCalled();
  });
});
