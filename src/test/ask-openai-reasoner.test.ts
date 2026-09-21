import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ASK_MODEL_CONFIG, ReasoningProviderError, isExcessivelyRepetitive, reasonAboutEvidence, reasoningFallback, validateModelReasoning, type ModelInterpretation } from "@/lib/ask/openai-reasoner";
import type { AskResponse } from "@/lib/ask/types";

const deterministic: AskResponse = {
  version: "ask-evidence-v3",
  status: "completed",
  mode: "analyst",
  answerKind: "analysis",
  question: "How much did I pay in known fees?",
  finding: { headline: "Known fill-level fees: 1.2 USDT.", summary: "Fill-level fees only." },
  interpretation: "Fill-level fees only.",
  reasoningPoints: [],
  evidence: [{ label: "Known fill fees by coin", value: "1.2 USDT" }],
  qualitativeEvidence: [],
  confidence: { level: "low", reasons: ["12 fills are available."] },
  limitations: ["Financial records were kept separate."],
  marketContext: null,
  dataWindow: { start: "2026-07-08T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z", label: "Jul 8 – Aug 4, 2026" },
  sources: [{ label: "Bitget fills" }],
  toolRuns: [{ key: "analyze_fees", label: "Calculating fees", status: "completed", summary: "1.2 USDT", sources: ["Bitget fills"], sampleSize: 12 }],
  suggestedFollowups: [],
  reasoningStatus: "deterministic_fallback",
};

function modelOutput(overrides: Partial<ModelInterpretation> = {}): ModelInterpretation {
  return {
    answerKind: "analysis",
    finding: { headline: "Known fees are 1.2 USDT.", summary: "This answers the fee question directly." },
    interpretation: "The known total covers fill-level fees in the imported window only.",
    reasoningPoints: [
      { kind: "observation", statement: "Known fill fees are reported separately.", rationale: "This avoids combining unproven overlapping records.", evidenceLabels: ["Known fill fees by coin"], test: null },
      { kind: "uncertainty", statement: "The total does not establish complete account costs.", rationale: "Financial records were kept separate.", evidenceLabels: ["Known fill fees by coin"], test: "Reconcile fee records against fills." },
    ],
    evidenceLabels: ["Known fill fees by coin"],
    confidence: "moderate",
    confidenceReasons: ["12 fills are available."],
    limitations: ["Financial records were kept separate."],
    suggestedFollowups: ["Which symbols generated these fees?"],
    ...overrides,
  };
}

describe("OpenAI evidence interpretation", () => {
  it("maps Scout, Analyst, and Investigator to the required model and reasoning effort", () => {
    expect(ASK_MODEL_CONFIG.scout).toMatchObject({ model: "gpt-5.6-luna", effort: "low" });
    expect(ASK_MODEL_CONFIG.analyst).toMatchObject({ model: "gpt-5.6-terra", effort: "medium" });
    expect(ASK_MODEL_CONFIG.investigator).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
  });

  it("uses only allowlisted deterministic evidence and never raises deterministic confidence", async () => {
    const result = await reasonAboutEvidence({ response: deterministic, callModel: vi.fn(async () => modelOutput()) });
    expect(result.reasoningStatus).toBe("external_llm");
    expect(result.evidence).toEqual(deterministic.evidence);
    expect(result.confidence.level).toBe("low");
    expect(result.reasoningPoints).toHaveLength(2);
    expect(result.suggestedFollowups).toEqual(["Which symbols generated these fees?"]);
  });

  it("drops non-allowlisted model citation labels before post-model validation", async () => {
    const output = modelOutput({
      evidenceLabels: ["Invented evidence", "Known fill fees by coin"],
      reasoningPoints: [
        { kind: "observation", statement: "Known fill fees are reported separately.", rationale: "The verified metric is descriptive.", evidenceLabels: ["Invented evidence", "Known fill fees by coin"], test: null },
        { kind: "uncertainty", statement: "The total does not establish complete account costs.", rationale: "Financial records were kept separate.", evidenceLabels: ["Invented evidence"], test: "Reconcile fee records against fills." },
      ],
    });

    const result = await reasonAboutEvidence({ response: deterministic, callModel: vi.fn(async () => output) });

    expect(result.reasoningPoints[0].evidenceLabels).toEqual(["Known fill fees by coin"]);
    expect(result.reasoningPoints[1].evidenceLabels).toEqual([]);
    expect(result.evidence).toEqual(deterministic.evidence);
  });

  it("bounds provider citation arrays and strips extra structural keys before strict validation", async () => {
    const output = modelOutput();
    const overflow = {
      ...output,
      ignoredTopLevelKey: "not part of the contract",
      finding: { ...output.finding, ignoredFindingKey: "not part of the contract" },
      evidenceLabels: Array.from({ length: 20 }, () => "Known fill fees by coin"),
      reasoningPoints: output.reasoningPoints.map((point) => ({
        ...point,
        ignoredPointKey: "not part of the contract",
        evidenceLabels: Array.from({ length: 20 }, () => "Known fill fees by coin"),
      })),
    };

    const result = await reasonAboutEvidence({ response: deterministic, callModel: vi.fn(async () => overflow) });

    expect(result.reasoningStatus).toBe("external_llm");
    expect(result.reasoningPoints.every((point) => point.evidenceLabels.length <= 8)).toBe(true);
  });

  it("builds a focused structured evidence package with conversation context", async () => {
    const callModel = vi.fn(async (args: { mode: "scout" | "analyst" | "investigator"; prompt: string; retryInstruction?: string }) => {
      void args;
      return modelOutput();
    });
    await reasonAboutEvidence({
      response: deterministic,
      recent: [{ question: "What did you notice?", conclusion: "Fee evidence was incomplete." }],
      callModel,
    });
    const prompt = callModel.mock.calls[0][0].prompt;
    expect(prompt).toContain('"userQuestion":"How much did I pay in known fees?"');
    expect(prompt).toContain('"recentConversationContext"');
    expect(prompt).toContain('"calculatedMetrics":[{"label":"Known fill fees by coin"');
    expect(prompt).toContain('only digit or percentage tokens allowed anywhere in the answer');
    for (const token of ['"1.2"', '"12"', '"2026"', '"07"', '"08"', '"00"', '"8"', '"4"']) {
      expect(prompt).toContain(token);
    }
    expect(prompt).not.toContain('"orders"');
  });

  it("removes an unsupported live-style numeric clause without weakening the allowlist", async () => {
    const invalid = modelOutput({ interpretation: "The imported activity covers a derived 27-day window." });
    const callModel = vi.fn().mockResolvedValueOnce(invalid);

    const result = await reasonAboutEvidence({ response: deterministic, callModel });

    expect(result.reasoningStatus).toBe("external_llm");
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.interpretation).toBe(deterministic.interpretation);
    expect(result.interpretation).not.toContain("27");
  });

  it("drops unsupported numeric and behavioral reasoning while preserving deterministic uncertainty", async () => {
    const invalid = modelOutput({
      interpretation: "One explanation could be fear.",
      reasoningPoints: [
        { kind: "hypothesis", statement: "Fear may explain it.", rationale: "This is a guess.", evidenceLabels: ["Known fill fees by coin"], test: "Compare later activity." },
      ],
    });
    const callModel = vi.fn()
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(modelOutput());

    const result = await reasonAboutEvidence({ response: deterministic, callModel });

    expect(result.reasoningStatus).toBe("external_llm");
    expect(result.interpretation).toBe(deterministic.interpretation);
    expect(result.reasoningPoints).toEqual([
      expect.objectContaining({ kind: "uncertainty", statement: "Financial records were kept separate." }),
    ]);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("carries the exact five-turn acceptance conversation forward without restarting it", async () => {
    const turns: Array<{ question: string; points: ModelInterpretation["reasoningPoints"] }> = [
      { question: "What do you notice about my recent trading?", points: [
        { kind: "observation", statement: "The strongest observable signal is concentrated recent activity.", rationale: "The verified activity evidence points in the same direction.", evidenceLabels: ["Known fill fees by coin"], test: null },
        { kind: "hypothesis", statement: "The observed concentration may be specific to this import window.", rationale: "The bounded evidence describes this window but cannot establish persistence.", evidenceLabels: ["Known fill fees by coin"], test: "Compare the same metric across later imports." },
        { kind: "uncertainty", statement: "This does not establish a persistent behavioral pattern.", rationale: "The evidence window remains limited.", evidenceLabels: [], test: "Compare future imports." },
      ] },
      { question: "Why?", points: [
        { kind: "observation", statement: "That interpretation follows from the evidence relationship, not an assumed motive.", rationale: "The verified metric is descriptive only.", evidenceLabels: ["Known fill fees by coin"], test: null },
        { kind: "uncertainty", statement: "The cause remains unresolved.", rationale: "Context outside the import is missing.", evidenceLabels: [], test: "Add broader history." },
      ] },
      { question: "Could there be another explanation?", points: [
        { kind: "observation", statement: "The observed concentration remains real within the imported window.", rationale: "It is present in verified evidence.", evidenceLabels: ["Known fill fees by coin"], test: null },
        { kind: "alternative", statement: "A short-lived market condition could produce the same observation.", rationale: "Market context can affect activity without implying stable behavior.", evidenceLabels: [], test: "Compare across regimes." },
      ] },
      { question: "What evidence goes against that?", points: [
        { kind: "observation", statement: "The earlier observation is descriptive rather than causal.", rationale: "It identifies association only.", evidenceLabels: ["Known fill fees by coin"], test: null },
        { kind: "counter_evidence", statement: "Missing completed-trade history weakens any persistent-pattern claim.", rationale: "The current record cannot separate temporary conditions from repeat behavior.", evidenceLabels: [], test: "Reconstruct later trades." },
      ] },
      { question: "What would you investigate next?", points: [
        { kind: "observation", statement: "The unresolved issue is whether the signal survives changing conditions.", rationale: "The current evidence cannot answer that.", evidenceLabels: ["Known fill fees by coin"], test: null },
        { kind: "next_investigation", statement: "Compare the same activity relationship across market regimes and later imports.", rationale: "That test directly targets stability and confounding.", evidenceLabels: [], test: "Run a regime-stratified comparison when more data arrives." },
      ] },
    ];
    const headlines = ["Initial observation", "Reasoning basis", "Alternative explanation", "Counter-evidence", "Next investigation"];
    const recent: Array<{ question: string; conclusion: string }> = [];
    for (const [index, turn] of turns.entries()) {
      const turnResponse: AskResponse = { ...deterministic, question: turn.question };
      const output = modelOutput({
        finding: { headline: `${headlines[index]} addresses only the current question.`, summary: turn.points[0].statement },
        interpretation: turn.points.map((point) => point.statement).join(" "),
        reasoningPoints: turn.points,
      });
      const callModel = vi.fn(async (args: { mode: "scout" | "analyst" | "investigator"; prompt: string; retryInstruction?: string }) => {
        if (recent.length) expect(args.prompt).toContain(recent.at(-1)!.question);
        return output;
      });
      const result = await reasonAboutEvidence({ response: turnResponse, recent, callModel });
      expect(callModel).toHaveBeenCalledTimes(1);
      expect(result.reasoningStatus).toBe("external_llm");
      recent.push({ question: turn.question, conclusion: `${result.finding.headline} ${result.interpretation}` });
      if (recent.length > 5) recent.shift();
    }
  });

  it("keeps open-ended analysis concise and supplies a bounded testable hypothesis", async () => {
    const response: AskResponse = { ...deterministic, question: "What do you notice about my recent trading?" };
    const manyObservations = Array.from({ length: 6 }, (_, index) => ({
      kind: "observation" as const,
      statement: `Known fill fees are reported separately.`,
      rationale: `The verified metric is descriptive.`,
      evidenceLabels: ["Known fill fees by coin"],
      test: index === 0 ? null : "Review the same evidence.",
    }));
    const result = await reasonAboutEvidence({
      response,
      callModel: vi.fn(async () => modelOutput({ reasoningPoints: manyObservations })),
    });

    expect(result.reasoningPoints.filter((point) => point.kind === "observation")).toHaveLength(1);
    expect(result.reasoningPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "hypothesis", evidenceLabels: ["Known fill fees by coin"] }),
      expect.objectContaining({ kind: "uncertainty" }),
    ]));
    expect(result.reasoningPoints.length).toBeLessThanOrEqual(4);
  });

  it("replaces an incomplete provider hypothesis with a cited testable hypothesis", async () => {
    const response: AskResponse = { ...deterministic, question: "What do you notice about my recent trading?" };
    const result = await reasonAboutEvidence({
      response,
      callModel: vi.fn(async () => modelOutput({
        reasoningPoints: [
          { kind: "hypothesis", statement: "The pattern may persist.", rationale: "", evidenceLabels: [], test: null },
          { kind: "uncertainty", statement: "The cause remains unresolved.", rationale: "Context outside the import is missing.", evidenceLabels: [], test: null },
        ],
      })),
    });

    const hypothesis = result.reasoningPoints.find((point) => point.kind === "hypothesis");
    expect(hypothesis).toMatchObject({ evidenceLabels: ["Known fill fees by coin"] });
    expect(hypothesis?.rationale).toBeTruthy();
    expect(hypothesis?.test).toBeTruthy();
  });

  it("fails post-reasoning validation for unknown evidence, incomplete hypotheses, or unsupported behavioral claims", () => {
    expect(validateModelReasoning(modelOutput({ evidenceLabels: ["Invented evidence"] }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({
      reasoningPoints: [
        { kind: "hypothesis", statement: "This may be a cost pattern.", rationale: "", evidenceLabels: [], test: null },
        { kind: "uncertainty", statement: "More evidence is needed.", rationale: "The sample is limited.", evidenceLabels: [], test: null },
      ],
    }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "This proves revenge trading and weak discipline." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The available data cannot establish fear or discipline." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Revenge trading cannot be ruled out." }), deterministic)).toBe(false);
  });

  it("retries malformed structured output once and then fails safely", async () => {
    const callModel = vi.fn(async () => ({ wrong: true }));
    await expect(reasonAboutEvidence({ response: deterministic, callModel })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported numeric claims even when the schema is valid", async () => {
    const callModel = vi.fn(async () => modelOutput({
      finding: { headline: "The fees prove a 99% cost burden.", summary: "Half of the activity carried the known fees." },
      interpretation: "The fees prove a 99% cost burden.",
      reasoningPoints: [
        { kind: "observation", statement: "The fees prove a 99% burden.", rationale: "Half the activity carried fees.", evidenceLabels: ["Known fill fees by coin"], test: null },
        { kind: "uncertainty", statement: "Half may be incomplete.", rationale: "Financial records were kept separate.", evidenceLabels: [], test: null },
      ],
    }));
    const result = await reasonAboutEvidence({ response: deterministic, callModel });
    expect(result.finding).toEqual(deterministic.finding);
    expect(result.interpretation).toBe(deterministic.interpretation);
    expect(result.reasoningPoints).toEqual([
      expect.objectContaining({ kind: "uncertainty", statement: "Financial records were kept separate." }),
    ]);
    expect(`${result.finding.headline} ${result.finding.summary} ${result.interpretation} ${result.reasoningPoints.map((point) => `${point.statement} ${point.rationale}`).join(" ")}`).not.toContain("99");
    expect(validateModelReasoning(modelOutput({ interpretation: "Half of the activity carried the known fees." }), deterministic)).toBe(false);
  });

  it("performs at most one anti-repetition regeneration", async () => {
    const repeated = modelOutput();
    expect(isExcessivelyRepetitive(repeated, [{ question: "Earlier", conclusion: "Known fees are 1.2 USDT. This answers the fee question directly. The known total covers fill-level fees in the imported window only." }])).toBe(true);
    const callModel = vi.fn(async (args: { mode: "scout" | "analyst" | "investigator"; prompt: string; retryInstruction?: string }) => {
      void args;
      return repeated;
    });
    await reasonAboutEvidence({ response: deterministic, recent: [{ question: "Earlier", conclusion: "Known fees are 1.2 USDT. This answers the fee question directly. The known total covers fill-level fees in the imported window only." }], callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[1][0].retryInstruction).toBe("Answer only the new information need. Build on prior context instead of restating the previous response. Introduce new reasoning or evidence.");
  });

  it("keeps a simple fact answer brief and free of analysis scaffolding", async () => {
    const factResponse: AskResponse = {
      ...deterministic,
      answerKind: "fact",
      question: "How many fills do I have?",
      finding: { headline: "You currently have 12 imported fills.", summary: "Coverage: Jul 8 – Aug 4, 2026." },
      interpretation: "Coverage: Jul 8 – Aug 4, 2026.",
      evidence: [{ label: "Fills imported", value: "12" }],
      confidence: { level: "high", reasons: ["This value comes directly from the latest completed import summary."] },
    };
    const callModel = vi.fn(async () => modelOutput({
      answerKind: "fact",
      finding: factResponse.finding,
      interpretation: factResponse.finding.summary,
      reasoningPoints: [],
      evidenceLabels: ["Fills imported"],
      confidence: "high",
      confidenceReasons: factResponse.confidence.reasons,
      limitations: [],
      suggestedFollowups: [],
    }));
    const result = await reasonAboutEvidence({ response: factResponse, callModel });
    expect(result.answerKind).toBe("fact");
    expect(result.reasoningPoints).toEqual([]);
    expect(result.finding.headline).toBe("You currently have 12 imported fills.");
  });

  it("shows a safe deterministic fallback for model outages", () => {
    const fallback = reasoningFallback(deterministic, new ReasoningProviderError("NETWORK"));
    expect(fallback.reasoningNotice).toContain("temporarily unavailable");
    expect(fallback.reasoningNotice).not.toContain("payload");
  });
});
