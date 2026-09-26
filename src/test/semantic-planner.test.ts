// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  isDirectImportFactPlan,
  planAskSemantically,
  semanticPlannerPrompt,
  validateSemanticToolPlan,
  type SemanticToolPlan,
} from "@/lib/ask/semantic-planner";
import type { ReasoningProvider } from "@/lib/ask/reasoning-provider";
import { createReasoningProvider, ReasoningProviderError } from "@/lib/ask/reasoning-provider";

const basePlan: SemanticToolPlan = {
  understoodQuestion: "Assess my recent activity using verified evidence.",
  informationNeeds: ["Describe observed fills."],
  toolRequests: ["get_import_summary", "analyze_trading_activity"],
  needsConversationContext: false,
  referencedPriorFindingIds: [],
  analysisDepth: "focused",
  reasoningGoal: "Explain what the observed activity can and cannot support.",
  requiresJoinedAnalysis: false,
  answerKind: "analysis",
  requestedImportMetric: null,
};

function provider(output: unknown): ReasoningProvider {
  return {
    id: "groq",
    modelIdentifier: () => "openai/gpt-oss-120b",
    generateStructuredResponse: vi.fn(),
    generateStructuredPlan: vi.fn(async () => output),
  };
}

describe("semantic evidence planner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes raw casual language to the planner without a preset prompt lookup", async () => {
    const questions = [
      "yo, what patterns jump out of the stuff I did recently?",
      "could ya spot anything unusual in the way I've been active?",
    ];
    for (const question of questions) {
      const model = provider(basePlan);
      const result = await planAskSemantically({ question, mode: "analyst", provider: model });
      expect(result.toolRequests).toEqual(["get_import_summary", "analyze_trading_activity"]);
      expect(model.generateStructuredPlan).toHaveBeenCalledOnce();
      const request = vi.mocked(model.generateStructuredPlan).mock.calls[0][0];
      expect(request.prompt).toContain(JSON.stringify(question));
      expect(request.prompt).toContain("analyze_trading_activity");
    }
  });

  it("accepts a multi-need plan and keeps model-selected semantic priority", () => {
    const plan = validateSemanticToolPlan({
      ...basePlan,
      informationNeeds: ["Compare timing to market conditions.", "Inspect observed fill fees."],
      toolRequests: ["analyze_trade_timing", "analyze_market_context", "analyze_fees", "run_skeptic_check"],
      requiresJoinedAnalysis: true,
    }, "analyst");
    expect(plan.toolRequests).toEqual([
      "get_import_summary", "analyze_trade_timing", "analyze_market_context", "analyze_fees", "run_skeptic_check",
    ]);
    expect(plan.informationNeeds).toHaveLength(2);
    expect(plan.requiresJoinedAnalysis).toBe(true);
  });

  it("supports follow-up references only to bounded, supplied prior findings", () => {
    const context = [{ question: "What stood out?", conclusion: "Observed activity was concentrated.", findingId: "finding-a" }];
    const plan = validateSemanticToolPlan({
      ...basePlan,
      needsConversationContext: true,
      referencedPriorFindingIds: ["finding-a"],
      reasoningGoal: "Challenge the previous concentration interpretation.",
    }, "analyst", context);
    expect(plan.referencedPriorFindingIds).toEqual(["finding-a"]);
    expect(() => validateSemanticToolPlan({ ...plan, referencedPriorFindingIds: ["invented-id"] }, "analyst", context)).toThrow("INVALID_SEMANTIC_PLAN");
  });

  it("requires every semantic follow-up to reselect at least one read-only evidence tool", () => {
    const context = [{ question: "What stood out?", conclusion: "Observed activity was concentrated.", findingId: "finding-a" }];
    expect(() => validateSemanticToolPlan({
      ...basePlan,
      informationNeeds: ["Re-examine the previous conclusion."],
      toolRequests: [],
      needsConversationContext: true,
      referencedPriorFindingIds: ["finding-a"],
    }, "analyst", context)).toThrow("INVALID_SEMANTIC_PLAN");

    const prompt = semanticPlannerPrompt("what does that leave out?", "analyst", context);
    expect(prompt).toContain("toolRequests must never be empty");
    expect(prompt).toContain("reselect the read-only tools");
    expect(prompt).toContain("not a standalone fact or import summary");
    expect(prompt).toContain("every distinct information need");
    expect(prompt).toContain("fills are actual executions/execution rows");
    expect(prompt).toContain("time-of-day or clock-based observations");
    expect(prompt).toContain("informally calls a timing shape");
    expect(prompt).toContain('"requiredInputs":"Imported fills."');
    expect(prompt).toContain('"unavailableWhen":"No valid fill timestamps or sides."');
  });

  it("keeps factual import counts concise and explicit", () => {
    const plan = validateSemanticToolPlan({
      ...basePlan,
      answerKind: "fact",
      analysisDepth: "factual",
      requestedImportMetric: "fills",
      toolRequests: ["get_import_summary"],
    }, "scout");
    expect(plan.toolRequests).toEqual(["get_import_summary"]);
    expect(plan.requestedImportMetric).toBe("fills");
    expect(isDirectImportFactPlan(plan)).toBe(true);
    expect(isDirectImportFactPlan({ ...plan, requestedImportMetric: null })).toBe(false);
    expect(() => validateSemanticToolPlan({ ...plan, toolRequests: ["analyze_trading_activity"] }, "scout")).toThrow("INVALID_SEMANTIC_PLAN");
    expect(() => validateSemanticToolPlan({ ...plan, toolRequests: ["get_import_summary", "analyze_fees"] }, "scout")).toThrow("INVALID_SEMANTIC_PLAN");
  });

  it("fails closed on write operations, arbitrary strings, unknown fields and contradictory facts", () => {
    expect(() => validateSemanticToolPlan({ ...basePlan, toolRequests: ["place_order"] }, "analyst")).toThrow("INVALID_SEMANTIC_PLAN");
    expect(() => validateSemanticToolPlan({ ...basePlan, analysisDepth: "whatever" }, "analyst")).toThrow("INVALID_SEMANTIC_PLAN");
    expect(() => validateSemanticToolPlan({ ...basePlan, externalUrl: "https://example.test" }, "analyst")).toThrow("INVALID_SEMANTIC_PLAN");
    expect(() => validateSemanticToolPlan({ ...basePlan, requestedImportMetric: "fills" }, "analyst")).toThrow("INVALID_SEMANTIC_PLAN");
    expect(() => validateSemanticToolPlan({ ...basePlan, answerKind: "fact", analysisDepth: "factual", requiresJoinedAnalysis: true }, "analyst")).toThrow("INVALID_SEMANTIC_PLAN");
    expect(() => validateSemanticToolPlan({ ...basePlan, toolRequests: ["get_import_summary"] }, "analyst")).toThrow("INVALID_SEMANTIC_PLAN");
    expect(() => validateSemanticToolPlan({ ...basePlan, toolRequests: ["get_import_summary", "run_skeptic_check"] }, "analyst")).toThrow("INVALID_SEMANTIC_PLAN");
  });

  it("deduplicates and caps tools without turning wording into an intent", () => {
    const plan = validateSemanticToolPlan({
      ...basePlan,
      toolRequests: ["analyze_fees", "analyze_fees", "analyze_market_context", "retrieve_memories"],
    }, "scout");
    expect(plan.toolRequests).toEqual(["get_import_summary", "analyze_fees"]);
  });

  it("excludes credential-shaped persisted context before the provider sees it", () => {
    const prompt = semanticPlannerPrompt("Check the previous observation", "analyst", [
      { question: "Earlier question", conclusion: "safe conclusion" },
      { question: "Later question", conclusion: "API secret: redacted credential value" },
    ]);
    expect(prompt).toContain("safe conclusion");
    expect(prompt).not.toContain("redacted credential value");
  });

  it("passes bounded selected app context into semantic planning as untrusted data", async () => {
    const model = provider(basePlan);
    await planAskSemantically({
      question: "What does this leave out?",
      mode: "analyst",
      provider: model,
      selectedContext: {
        id: "memory:00000000-0000-0000-0000-000000000000",
        kind: "memory",
        label: "Selected RIKKU memory",
        statement: "Observed activity was concentrated in one UTC interval.",
      },
    });
    const request = vi.mocked(model.generateStructuredPlan).mock.calls[0][0];
    expect(request.prompt).toContain("Selected application context");
    expect(request.prompt).toContain("Selected RIKKU memory");
    expect(request.prompt).toContain("concentrated in one UTC interval");
    expect(request.prompt).toContain("not proof beyond its explicitly supplied fields");
  });

  it("never calls the provider when the question itself contains credential-shaped text", async () => {
    const model = provider(basePlan);
    await expect(planAskSemantically({ question: "My API secret is confidential", mode: "analyst", provider: model })).rejects.toThrow("INVALID_SEMANTIC_PLAN");
    expect(model.generateStructuredPlan).not.toHaveBeenCalled();
  });

  it("propagates provider failure so the caller can use the honest deterministic fallback", async () => {
    const model = provider(basePlan);
    const callModel = vi.fn(async () => { throw new Error("RATE_LIMIT"); });
    await expect(planAskSemantically({ question: "What stands out?", mode: "analyst", provider: model, callModel })).rejects.toThrow("RATE_LIMIT");
    expect(callModel).toHaveBeenCalledOnce();
  });

  it("retries one invalid provider plan and still applies strict server validation", async () => {
    const model = provider(basePlan);
    const callModel = vi.fn()
      .mockRejectedValueOnce(new ReasoningProviderError("INVALID_RESPONSE"))
      .mockResolvedValueOnce(basePlan);

    await expect(planAskSemantically({
      question: "Recheck what the imported activity can support",
      mode: "analyst",
      provider: model,
      callModel,
    })).resolves.toEqual(basePlan);

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[1][0].prompt).toContain("prior provider response was invalid");

    const alwaysInvalid = vi.fn()
      .mockRejectedValueOnce(new ReasoningProviderError("INVALID_RESPONSE"))
      .mockResolvedValueOnce({ ...basePlan, toolRequests: ["place_order"] });
    await expect(planAskSemantically({
      question: "Try the same request again",
      mode: "analyst",
      provider: model,
      callModel: alwaysInvalid,
    })).rejects.toThrow("INVALID_SEMANTIC_PLAN");
    expect(alwaysInvalid).toHaveBeenCalledTimes(2);
  });

  it("uses the configured Groq provider for a separate JSON planning call", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({
      id: "chatcmpl-plan-test",
      object: "chat.completion",
      created: 0,
      model: "openai/gpt-oss-120b",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(basePlan) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const groq = createReasoningProvider({
      LLM_API_KEY: "test-only-key",
      LLM_BASE_URL: "https://api.groq.com/openai/v1",
      LLM_MODEL: "openai/gpt-oss-120b",
    });
    await expect(planAskSemantically({ question: "Tell me what looks different lately", mode: "analyst", provider: groq })).resolves.toMatchObject(basePlan);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("openai/gpt-oss-120b");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("semantic read-only evidence planner");
    expect(body.messages[0].content).not.toContain("rikku_answer");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toContain("Tell me what looks different lately");
    expect(body.include_reasoning).toBe(false);
  });
});
