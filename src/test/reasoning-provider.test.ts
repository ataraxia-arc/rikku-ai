// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createReasoningProvider,
  normalizeReasoningProviderError,
  parseCompatibleJson,
  ReasoningProviderError,
} from "@/lib/ask/reasoning-provider";

describe("reasoning provider abstraction", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("selects a complete OpenAI-compatible configuration before the OpenAI fallback", () => {
    const provider = createReasoningProvider({
      LLM_API_KEY: "custom-key",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_MODEL: "reasoning-model",
      OPENAI_API_KEY: "openai-key",
    });
    expect(provider.id).toBe("openai_compatible");
    expect(provider.modelIdentifier("analyst")).toBe("reasoning-model");
  });

  it("identifies Groq from its official OpenAI-compatible endpoint", () => {
    const provider = createReasoningProvider({
      LLM_API_KEY: "groq-key",
      LLM_BASE_URL: "https://api.groq.com/openai/v1",
      LLM_MODEL: "openai/gpt-oss-120b",
    });
    expect(provider.id).toBe("groq");
    expect(provider.modelIdentifier("analyst")).toBe("openai/gpt-oss-120b");
  });

  it("keeps the official OpenAI provider available when custom configuration is absent", () => {
    const provider = createReasoningProvider({ OPENAI_API_KEY: "openai-key" });
    expect(provider.id).toBe("openai");
    expect(provider.modelIdentifier("scout")).toBe("gpt-5.6-luna");
  });

  it("fails closed for partial or unsafe custom configuration", () => {
    expect(() => createReasoningProvider({ LLM_API_KEY: "custom-key" })).toThrowError(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(() => createReasoningProvider({
      LLM_API_KEY: "custom-key",
      LLM_BASE_URL: "http://remote.example.test/v1",
      LLM_MODEL: "reasoning-model",
    })).toThrowError(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("accepts only a complete JSON object before RIKKU schema validation", () => {
    expect(parseCompatibleJson('{"answerKind":"analysis"}')).toEqual({ answerKind: "analysis" });
    for (const invalid of ['```json\n{"answerKind":"fact"}\n```', 'Here is the answer: {"answerKind":"fact"}', '{} trailing prose', '{}{}', '[{}]', 'null', '{"finding":']) {
      expect(() => parseCompatibleJson(invalid)).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
    }
    expect(() => parseCompatibleJson("not json")).toThrowError(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("sends a minimal OpenAI-compatible chat request and parses JSON without relying on strict outputs", async () => {
    const output = {
      answerKind: "analysis",
      finding: { headline: "Observed activity.", summary: "Bounded evidence only." },
      interpretation: "The evidence supports a descriptive observation.",
      reasoningPoints: [],
      evidenceLabels: [],
      confidence: "low",
      confidenceReasons: [],
      limitations: [],
      suggestedFollowups: [],
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "reasoning-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createReasoningProvider({
      LLM_API_KEY: "custom-key",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_MODEL: "reasoning-model",
    });

    await expect(provider.generateStructuredResponse({ mode: "analyst", prompt: "Minimal reasoning request" })).resolves.toEqual(output);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/chat/completions");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ model: "reasoning-model" });
  });

  it("uses Groq strict JSON Schema mode before independent server-side validation", async () => {
    const output = {
      answerKind: "fact",
      finding: { headline: "Twelve fills.", summary: "The import contains 12 fills." },
      interpretation: "The verified import contains 12 fills.",
      reasoningPoints: [],
      evidenceLabels: ["Fills imported"],
      confidence: "high",
      confidenceReasons: ["The count comes from the deterministic import summary."],
      limitations: [],
      suggestedFollowups: [],
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      id: "chatcmpl-groq-test",
      object: "chat.completion",
      created: 0,
      model: "openai/gpt-oss-120b",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createReasoningProvider({
      LLM_API_KEY: "groq-key",
      LLM_BASE_URL: "https://api.groq.com/openai/v1",
      LLM_MODEL: "openai/gpt-oss-120b",
    });

    await expect(provider.generateStructuredResponse({
      mode: "analyst",
      prompt: "How many fills do I have?",
      allowedEvidenceLabels: ["Fills imported", "Known fill fees by coin"],
    })).resolves.toEqual(output);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema).toMatchObject({ name: "rikku_answer", strict: true });
    expect(body.response_format.json_schema.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningPoints: { maxItems: 4 },
        evidenceLabels: { maxItems: 12, items: { enum: ["Fills imported", "Known fill fees by coin"] } },
        suggestedFollowups: { maxItems: 3 },
      },
    });
    expect(body.max_completion_tokens).toBe(2_500);
    expect(body.reasoning_effort).toBe("low");
    expect(body.include_reasoning).toBe(false);
    expect(body.temperature).toBe(0.2);
    expect(body.messages[0].content).toContain("required strict JSON schema");
    expect(body.messages[0].content).toContain("never invent financial facts");

    await expect(provider.generateStructuredResponse({
      mode: "analyst",
      prompt: "Correct the rejected answer",
      retryInstruction: "Avoid the rejected claim.",
      allowedEvidenceLabels: ["Fills imported"],
    })).resolves.toEqual(output);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(retryBody.max_completion_tokens).toBe(2_500);
    expect(retryBody.reasoning_effort).toBe("low");
    expect(retryBody.response_format.json_schema.schema.properties.reasoningPoints.maxItems).toBe(2);
  });

  it("uses Groq strict JSON schema before independent server-side plan validation", async () => {
    const output = {
      understoodQuestion: "Count verified fills", informationNeeds: ["fill count"], toolRequests: ["get_import_summary"],
      needsConversationContext: false, referencedPriorFindingIds: [], analysisDepth: "factual",
      reasoningGoal: "Report the verified count", requiresJoinedAnalysis: false, answerKind: "fact", requestedImportMetric: "fills",
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      id: "chatcmpl-plan-test", object: "chat.completion", created: 0, model: "openai/gpt-oss-120b",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createReasoningProvider({
      LLM_API_KEY: "groq-key", LLM_BASE_URL: "https://api.groq.com/openai/v1", LLM_MODEL: "openai/gpt-oss-120b",
    });

    await expect(provider.generateStructuredPlan({ mode: "analyst", prompt: "Count the fills" })).resolves.toEqual(output);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "rikku_tool_plan", strict: true, schema: { additionalProperties: false } } });
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(1_500);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toContain("toolRequests: array of exact names");
    expect(body.messages[0].content).toContain("requestedImportMetric");
  });

  it.each(["length", "content_filter"])("rejects %s completions even if content looks like JSON", async (finishReason) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content: "{}" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const provider = createReasoningProvider({ LLM_API_KEY: "test-key", LLM_BASE_URL: "https://api.groq.com/openai/v1", LLM_MODEL: "openai/gpt-oss-120b" });
    await expect(provider.generateStructuredResponse({ mode: "analyst", prompt: "analyze the market" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(provider.generateStructuredPlan({ mode: "analyst", prompt: "analyze the market" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    [{ status: 401 }, "AUTH"],
    [{ status: 429, code: "credit_balance_exhausted" }, "QUOTA"],
    [{ status: 429, code: "rate_limit_exceeded", type: "tokens", message: "quota exceeded" }, "RATE_LIMIT"],
    [{ status: 400, code: "json_validate_failed", type: "invalid_request_error" }, "INVALID_RESPONSE"],
    [{ status: 400, code: "tool_use_failed", type: "invalid_request_error" }, "INVALID_RESPONSE"],
    [{ status: 404, code: "model_not_found" }, "MODEL_NOT_FOUND"],
    [new TypeError("connection failed"), "NETWORK"],
    [new DOMException("timed out", "TimeoutError"), "TIMEOUT"],
    [new Error("unexpected"), "UNKNOWN"],
  ])("normalizes provider failures without exposing raw errors", (error, code) => {
    expect(normalizeReasoningProviderError(error).code).toBe(code);
  });

  it("retains only safe rate-limit reset durations", () => {
    const safe = normalizeReasoningProviderError({
      status: 429,
      code: "rate_limit_exceeded",
      type: "tokens",
      message: "Token rate limit reached: Limit 8000, Used 3100, Requested 5400.",
      headers: new Headers({ "retry-after": "12", "x-ratelimit-reset-tokens": "2m59.5s" }),
    });
    expect(safe.safeProviderDetails).toMatchObject({
      retryAfter: "12",
      tokenReset: "2m59.5s",
      tokenLimit: 8_000,
      tokenUsed: 3_100,
      tokenRequested: 5_400,
    });
    const rejected = normalizeReasoningProviderError({
      status: 429,
      headers: { "retry-after": "Bearer secret-value", "x-ratelimit-reset-tokens": "not-a-duration" },
    });
    expect(rejected.safeProviderDetails).toMatchObject({ retryAfter: "", tokenReset: "" });
  });

  it("preserves an already normalized invalid-response error", () => {
    const error = new ReasoningProviderError("INVALID_RESPONSE");
    expect(normalizeReasoningProviderError(error)).toBe(error);
  });

  it("drops arbitrary or credential-shaped provider diagnostics before logging", () => {
    const arbitrary = normalizeReasoningProviderError({ status: 500, code: "unsafe value with spaces", type: `gsk_${"X".repeat(24)}` });
    expect(arbitrary.safeProviderDetails).toEqual({
      status: 500,
      code: "",
      type: "",
      retryAfter: "",
      tokenReset: "",
      tokenLimit: null,
      tokenUsed: null,
      tokenRequested: null,
    });
  });
});
