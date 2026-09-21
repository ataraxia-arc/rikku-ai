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

  it("parses plain or fenced compatibility JSON before RIKKU schema validation", () => {
    expect(parseCompatibleJson('{"answerKind":"analysis"}')).toEqual({ answerKind: "analysis" });
    expect(parseCompatibleJson('```json\n{"answerKind":"fact"}\n```')).toEqual({ answerKind: "fact" });
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

  it("uses Groq JSON Object mode before strict server-side validation", async () => {
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

    await expect(provider.generateStructuredResponse({ mode: "analyst", prompt: "How many fills do I have?" })).resolves.toEqual(output);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_completion_tokens).toBe(2_000);
    expect(body.messages[0].content).toContain('"answerKind": "fact | analysis | investigation"');
  });

  it.each([
    [{ status: 401 }, "AUTH"],
    [{ status: 429, code: "credit_balance_exhausted" }, "QUOTA"],
    [{ status: 429, code: "rate_limit_exceeded", type: "tokens", message: "quota exceeded" }, "RATE_LIMIT"],
    [{ status: 400, code: "json_validate_failed", type: "invalid_request_error" }, "INVALID_RESPONSE"],
    [{ status: 404, code: "model_not_found" }, "MODEL_NOT_FOUND"],
    [new TypeError("connection failed"), "NETWORK"],
    [new DOMException("timed out", "TimeoutError"), "TIMEOUT"],
    [new Error("unexpected"), "UNKNOWN"],
  ])("normalizes provider failures without exposing raw errors", (error, code) => {
    expect(normalizeReasoningProviderError(error).code).toBe(code);
  });

  it("preserves an already normalized invalid-response error", () => {
    const error = new ReasoningProviderError("INVALID_RESPONSE");
    expect(normalizeReasoningProviderError(error)).toBe(error);
  });
});
