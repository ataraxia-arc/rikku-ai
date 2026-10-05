import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ASK_MODEL_CONFIG, ReasoningProviderError, isExcessivelyRepetitive, modelReasoningValidationFailures, reasonAboutEvidence, reasoningFallback, validateModelReasoning, type ModelInterpretation } from "@/lib/ask/openai-reasoner";
import type { AskResponse } from "@/lib/ask/types";

const deterministic: AskResponse = {
  version: "ask-evidence-v18",
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
    confidence: "low",
    confidenceReasons: ["12 fills are available."],
    limitations: ["Financial records were kept separate."],
    suggestedFollowups: ["Which symbols generated these fees?"],
    ...overrides,
  };
}

describe("OpenAI evidence interpretation", () => {
  it("repairs invalid JSON once without dropping follow-up context or the semantic goal", async () => {
    const callModel = vi.fn().mockRejectedValueOnce(new ReasoningProviderError("INVALID_RESPONSE")).mockResolvedValueOnce(modelOutput());
    const response = await reasonAboutEvidence({
      response: deterministic,
      recent: [{ question: "Earlier fee question", conclusion: "The coverage remains bounded." }],
      semanticPlan: { understoodQuestion: "Review the fee evidence", informationNeeds: ["Known fees"], reasoningGoal: "Consider another interpretation", referencedPriorFindingIds: [], requiresJoinedAnalysis: false },
      callModel,
    });
    expect(response.reasoningStatus).toBe("external_llm");
    expect(callModel).toHaveBeenCalledTimes(2);
    const retry = callModel.mock.calls[1][0];
    expect(retry.retryInstruction).toContain("PROVIDER_INVALID_JSON");
    expect(retry.retryInstruction).toContain("Return only valid JSON matching the schema");
    expect(retry.prompt).toContain("The coverage remains bounded.");
    expect(retry.prompt).toContain("Consider another interpretation");
    expect(retry.prompt).toContain("1.2 USDT");
  });

  it("sends exact unsupported-claim failures and paths to the single repair attempt", async () => {
    const callModel = vi.fn().mockResolvedValueOnce(modelOutput({ interpretation: "The fee total is 9876 USDT." })).mockResolvedValueOnce(modelOutput());
    await reasonAboutEvidence({ response: deterministic, callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[1][0].retryInstruction).toContain("UNSUPPORTED_NUMERIC_CLAIM_PATH:interpretation");
    expect(callModel.mock.calls[1][0].retryInstruction).toContain("Remove or rewrite the unsupported claims");
  });

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

  it("preserves deterministic Skeptic reasons and limitations when adding model commentary", async () => {
    const output = modelOutput({
      confidenceReasons: ["The model adds a bounded caveat.", "[verified quantity] observations were reviewed."],
      limitations: ["A later import may change the interpretation.", "The [verified value] is hidden."],
      suggestedFollowups: ["Review [verified quantity] next."],
    });
    const result = await reasonAboutEvidence({ response: deterministic, callModel: vi.fn(async () => output) });

    expect(result.confidence.reasons).toEqual(expect.arrayContaining(["12 fills are available.", "The model adds a bounded caveat."]));
    expect(result.limitations).toEqual(expect.arrayContaining(["Financial records were kept separate.", "A later import may change the interpretation."]));
    expect(JSON.stringify(result)).not.toMatch(/\[verified (?:value|quantity)\]/i);
  });

  it("rejects invented citations and accepts one grounded regeneration", async () => {
    const output = modelOutput({
      evidenceLabels: ["Invented evidence", "Known fill fees by coin"],
      reasoningPoints: [
        { kind: "observation", statement: "Known fill fees are reported separately.", rationale: "The verified metric is descriptive.", evidenceLabels: ["Invented evidence", "Known fill fees by coin"], test: null },
        { kind: "uncertainty", statement: "The total does not establish complete account costs.", rationale: "Financial records were kept separate.", evidenceLabels: ["Invented evidence"], test: "Reconcile fee records against fills." },
      ],
    });

    const callModel = vi.fn().mockResolvedValueOnce(output).mockResolvedValueOnce(modelOutput());
    const result = await reasonAboutEvidence({ response: deterministic, callModel });

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[1][0].retryInstruction).toContain("Cite only exact labels");
    expect(result.reasoningPoints[0].evidenceLabels).toEqual(["Known fill fees by coin"]);
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
    expect(prompt).toContain('"deterministicToolResults":[{"key":"analyze_fees"');
    expect(prompt).toContain("COMPLETE natural-language answer");
    expect(prompt).toContain("exact supplied facts may be copied only when needed");
    expect(prompt).toContain("Do not combine, divide, convert, rank, or restate supplied numbers");
    expect(prompt).toContain("majority, minority, half, roughly, or approximately");
    expect(prompt).toContain('"value":"1.2 USDT"');
    expect(prompt).toContain('"sampleSize":12');
    expect(prompt).toContain('"start":"2026-07-08T00:00:00.000Z"');
    expect(prompt).toContain('"summary":"1.2 USDT"');
    expect(prompt).not.toContain('"orders"');
  });

  it("hands the validated semantic meaning and referenced prior finding to synthesis", async () => {
    const callModel = vi.fn(async (args: { mode: "scout" | "analyst" | "investigator"; prompt: string; retryInstruction?: string }) => {
      void args;
      return modelOutput();
    });
    await reasonAboutEvidence({
      response: deterministic,
      recent: [{ question: "wut bout that?", conclusion: "The prior verified fee conclusion.", findingId: "finding-7" }],
      semanticPlan: {
        understoodQuestion: "Challenge the prior fee conclusion.",
        informationNeeds: ["Counter-evidence to the prior fee conclusion"],
        reasoningGoal: "Explain what weakens the prior conclusion.",
        referencedPriorFindingIds: ["finding-7"],
        requiresJoinedAnalysis: false,
      },
      callModel,
    });
    const prompt = callModel.mock.calls[0][0].prompt;
    expect(prompt).toContain('"understoodQuestion":"Challenge the prior fee conclusion."');
    expect(prompt).toContain('"findingId":"finding-7"');
    expect(prompt).toContain('"conclusion":"The prior verified fee conclusion."');
  });

  it("keeps record counts out of monetary synthesis while preserving deterministic UI evidence", async () => {
    const response: AskResponse = {
      ...deterministic,
      finding: { headline: "Known fees with 43 financial records separate.", summary: "Only fill fees were calculated." },
      evidence: [...deterministic.evidence, { label: "Financial records reviewed", value: "43" }],
      sources: [...deterministic.sources, { label: "Bitget financial records" }],
      toolRuns: deterministic.toolRuns.map((tool) => ({ ...tool, sources: [...tool.sources, "Bitget financial records"] })),
    };
    const callModel = vi.fn(async (args: { mode: "scout" | "analyst" | "investigator"; prompt: string; retryInstruction?: string }) => {
      void args;
      return modelOutput();
    });
    const answer = await reasonAboutEvidence({ response, callModel });
    const prompt = callModel.mock.calls[0][0].prompt;
    expect(prompt).not.toContain('"Financial records reviewed"');
    expect(prompt).not.toContain('"Bitget financial records"');
    expect(prompt).not.toContain('"43"');
    expect(answer.evidence).toContainEqual({ label: "Financial records reviewed", value: "43" });
  });

  it("regenerates unsupported numeric claims instead of silently editing them", async () => {
    const invalid = modelOutput({ interpretation: "The imported activity covers a derived 27-day window." });
    const callModel = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(modelOutput());

    const result = await reasonAboutEvidence({ response: deterministic, callModel });

    expect(result.reasoningStatus).toBe("external_llm");
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.interpretation).toBe(modelOutput().interpretation);
    expect(result.interpretation).not.toContain("27");
  });

  it("regenerates unsupported behavioral reasoning instead of silently inserting uncertainty", async () => {
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
    expect(result.interpretation).toBe(modelOutput().interpretation);
    expect(result.reasoningPoints).toHaveLength(2);
    expect(callModel).toHaveBeenCalledTimes(2);
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
      expect(modelReasoningValidationFailures(output, turnResponse), turn.question).toEqual([]);
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

  it("does not force a canned hypothesis or point kind for unseen wording", async () => {
    const response: AskResponse = { ...deterministic, question: "Could this bill just be the market being noisy?" };
    const output = modelOutput({
      interpretation: "The known fees establish cost, not its cause. Market context might matter, but the current fee evidence cannot separate that explanation from execution choices.",
      reasoningPoints: [],
    });
    expect(modelReasoningValidationFailures(output, response)).toEqual([]);
    const result = await reasonAboutEvidence({ response, callModel: vi.fn(async () => output) });

    expect(result.interpretation).toBe(output.interpretation);
    expect(result.reasoningPoints).toEqual([]);
  });

  it("rejects incomplete hypotheses and accepts only a corrected provider answer", async () => {
    const invalid = modelOutput({ reasoningPoints: [
      { kind: "hypothesis", statement: "The pattern may persist.", rationale: "", evidenceLabels: [], test: null },
    ] });
    const corrected = modelOutput({ reasoningPoints: [
      { kind: "hypothesis", statement: "The observed cost pattern may persist.", rationale: "The current fee metric describes this window, not a future one.", evidenceLabels: ["Known fill fees by coin"], test: "Compare the same fee metric across later imports." },
    ] });
    const callModel = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(corrected);
    const result = await reasonAboutEvidence({ response: deterministic, callModel });

    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.reasoningPoints).toEqual(corrected.reasoningPoints);
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
    expect(validateModelReasoning(modelOutput({ interpretation: "The [verified quantity] fills support this claim." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The trader's motive was volatility." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "This proves overtrading and impulsive chasing." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Impatience explains the observed fees." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "You seemed anxious about the observed costs." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The available data cannot establish fear or discipline." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The available data cannot establish impatience or anxiety." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Revenge trading cannot be ruled out." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The account is profitable." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The fills were profitable, although account returns are not established." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Your realized PnL is positive." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "You came out ahead overall." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "You ended in the green." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Whether you came out ahead is unknown from these records." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The account's profitability cannot be established from these fills." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "This is not a profitability conclusion." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "There is no evidence of profit in these counts." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The account is not proven profitable." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "One cannot infer account activity beyond the imported evidence." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "One plausible explanation is that activity timing is coincidental." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Three possible counterarguments concern trading activity." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The main point is that the evidence remains descriptive." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Double-check the third-party source next quarter." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Twelve fills are available." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Twelve positions are available." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Eleven executions are available." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Three execution rows are available." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "A dozen fills are available." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "12 fees were recorded across the fills." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The range was three point zero five percent." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "A majority of fills were costly." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "This evidence omits profitability and returns." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "That leaves out PnL and loss outcomes." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Profitability is outside the available evidence." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The imported records do not cover returns." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ limitations: ["Win rate and realized trade return are not available."] }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ limitations: ["Any profitability conclusion would be speculative."] }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Fees reduced account returns." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "You have 12 positions." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The exchange charged 1.2 USDT per fill." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The average fee is 1.2 USDT." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The maximum fee was 1.2 USDT." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The exchange charged 1.2 USDT per‑fill." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The exchange charged 1.2 USDT on each execution." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Known fill fees are 1.2 BTC." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The grouped fill fees total 1.2 USDT; this is not an itemized charge." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Itemized fill fees are available for comparison." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Known fees are listed for each fill." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Fees are listed for each fill, but per-fill values are not verified." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The evidence enumerates fees for each execution." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The exchange fees are available per trade." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Known fill fees are grouped by native coin." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Known fees are grouped by coin, not available per fill." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Known fees are grouped by coin rather than itemized per fill." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Known fill fees are itemized by native coin, not per execution." }), deterministic)).toBe(true);
    expect(validateModelReasoning(modelOutput({ limitations: ["Fees per execution are not available."] }), deterministic)).toBe(true);
    expect(modelReasoningValidationFailures(modelOutput({ interpretation: "The grouped total is 1.2 USDT, not 1.2 USDT per fill." }), deterministic)).toEqual([]);
    expect(validateModelReasoning(modelOutput({ interpretation: "No itemized fill fee amounts are in this evidence package." }), deterministic)).toBe(true);
    const withRecordCount: AskResponse = {
      ...deterministic,
      evidence: [...deterministic.evidence, { label: "Financial records reviewed", value: "43" }],
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "The separate financial-record fees have a value of 43." }), withRecordCount)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Measured costs include financial‑record fees, reported as 43 records." }), withRecordCount)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Your measured costs consist of fill fees and the 43 financial records kept separate from them." }), withRecordCount)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "There are 43 financial records, reported separately from known fill fees." }), withRecordCount)).toBe(true);
    expect(validateModelReasoning(modelOutput({ confidence: "high" }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "There is high confidence and strong evidence for this conclusion." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Coinbase data confirms the fee pattern." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Reuters data confirms the fee pattern." }), deterministic)).toBe(false);

    const negativeFees: AskResponse = {
      ...deterministic,
      finding: { headline: "Known fill-level fees: -1.2 USDT.", summary: "Fill-level fees only." },
      evidence: [{ label: "Known fill fees by coin", value: "-1.2 USDT" }],
      toolRuns: deterministic.toolRuns.map((tool) => ({ ...tool, summary: "-1.2 USDT" })),
    };
    expect(validateModelReasoning(modelOutput({
      finding: { headline: "Known fees are -1.2 USDT.", summary: "This answers the fee question directly." },
      interpretation: "Known fill fees are 1.2 USDT.",
    }), negativeFees)).toBe(false);
  });

  it("rejects unsupported relationships and relative judgments when no joined analysis or baseline exists", () => {
    const separateViews: AskResponse = {
      ...deterministic,
      limitations: ["The selected timing and range tools provide separate descriptive views; they do not calculate a joined association."],
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "Daily range drove the observed activity." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The timing pattern does not align with daily range." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Daily range drove activity, although we need to investigate whether fees mattered." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Daily range drove activity and we need to investigate whether fees mattered." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Daily range drove activity, yet we need to investigate whether fees mattered." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Daily range drove activity even though we need to investigate whether fees mattered." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Daily range drove activity, whereas whether fees mattered remains unknown." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The current evidence cannot determine whether daily range drove activity." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The current evidence does not support a relationship between daily range and activity." }), separateViews)).toBe(true);
    expect(modelReasoningValidationFailures(modelOutput({ interpretation: "A link between timing and fees cannot be established from these separate views." }), separateViews)).toEqual([]);
    expect(validateModelReasoning(modelOutput({ finding: { headline: "Separate views only", summary: "No verified causal relationship is established by the current evidence." } }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ limitations: ["The relationship is not calculated by these tools."] }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "No relationship exists between timing and fees." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "There is no basis to call the observed activity unusually high." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The timing pattern does not explain why the activity occurred." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The observed daily range was modest." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "There is no baseline to judge whether the observed range was modest." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The tools do not calculate whether the observed fees were higher." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The high-low range is available, but its relative size is not established." }), separateViews)).toBe(true);
    expect(modelReasoningValidationFailures(modelOutput({ interpretation: "The daily high–low range is available as descriptive candle context." }), {
      ...separateViews,
      marketContext: { available: true, matchedFills: 12, summary: "Median matched high–low range relative to daily open is available." },
    })).toEqual([]);
    expect(validateModelReasoning(modelOutput({ interpretation: "A missing baseline does not make the observed range modest." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The confidence is low because the range analysis is unavailable." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "This is a small sample of activity." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Typical release schedules and market-maker activity explain the timing." }), separateViews)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Obtain a verified event calendar to test the timing hypothesis." }), separateViews)).toBe(true);
    expect(validateModelReasoning(modelOutput({
      interpretation: "One hypothesis is that a news event could have influenced timing, but that has not been checked.",
      reasoningPoints: [{ kind: "hypothesis", statement: "A news event could have influenced timing.", rationale: "The timing observation leaves that possibility open.", evidenceLabels: ["Known fill fees by coin"], test: "Compare timestamps with a verified event calendar." }],
    }), separateViews)).toBe(true);
    expect(modelReasoningValidationFailures(modelOutput({
      interpretation: "A plausible alternative is that a liquidity window may have influenced timing.",
      reasoningPoints: [{ kind: "alternative", statement: "A liquidity window may have influenced timing.", rationale: "The timing observation leaves that possibility open.", evidenceLabels: ["Known fill fees by coin"], test: "Compare timestamps with verified liquidity data." }],
    }), separateViews)).toEqual([]);

    const highLowContext: AskResponse = {
      ...separateViews,
      marketContext: { available: true, matchedFills: 12, summary: "Median matched high–low range relative to daily open is available." },
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "The observed range was high." }), highLowContext)).toBe(false);

    const marketReturnOnly: AskResponse = {
      ...deterministic,
      evidence: [{ label: "Five-candle market return", value: "3%" }],
      toolRuns: [{ key: "analyze_market_regime", label: "Checking market regime", status: "completed", summary: "Five-candle market return was 3%.", sources: ["Bitget candles"] }],
    };
    expect(validateModelReasoning(modelOutput({
      finding: { headline: "Market context is available.", summary: "It does not verify account outcomes." },
      interpretation: "Your returns were positive.",
      reasoningPoints: [],
      evidenceLabels: ["Five-candle market return"],
      confidenceReasons: [],
      limitations: [],
    }), marketReturnOnly)).toBe(false);
    expect(modelReasoningValidationFailures(modelOutput({
      finding: { headline: "Market context is available.", summary: "It does not verify account outcomes." },
      interpretation: "The available records do not show or imply account profit.",
      reasoningPoints: [],
      evidenceLabels: ["Five-candle market return"],
      confidenceReasons: [],
      limitations: [],
    }), marketReturnOnly)).toEqual([]);
  });

  it("validates model-authored confidence reasons and limitations with the same fail-closed rules", () => {
    expect(validateModelReasoning(modelOutput({ confidenceReasons: ["The account was profitable."] }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ limitations: ["Reuters confirms this interpretation."] }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ limitations: ["A Reuters study confirms this interpretation."] }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ limitations: ["Bloomberg reported the same pattern."] }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ confidenceReasons: ["Glassnode metrics indicate the same pattern."] }), deterministic)).toBe(false);
  });

  it("rejects categorical contradictions and values absent from deterministic evidence", () => {
    expect(validateModelReasoning(modelOutput({ interpretation: "Known fill fees are denominated in BTC." }), deterministic)).toBe(false);

    const accountState: AskResponse = {
      ...deterministic,
      evidence: [
        ...deterministic.evidence,
        { label: "Assets", value: "0" },
        { label: "Positions", value: "0" },
        { label: "Completed trades", value: "Not yet reconstructable" },
        { label: "Buy / sell fills", value: "6 buy · 6 sell" },
      ],
      limitations: ["No current assets or positions were returned.", "Completed trades cannot yet be reconstructed."],
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "Current positions are available." }), accountState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Positions are available, but assets are not." }), accountState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Completed trades are reconstructed." }), accountState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "All fills were buys." }), accountState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ confidenceReasons: ["Daily candles match only a subset of fills."] }), {
      ...accountState,
      marketContext: { available: true, matchedFills: 12, summary: "Daily candle context matched 12 of 12 fills." },
    })).toBe(false);
    expect(validateModelReasoning(modelOutput({ confidenceReasons: ["A limited set of reconstructed trades is available."] }), accountState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The evidence contains 6 buy and 6 sell fills." }), accountState)).toBe(true);

    const buyOnlyState: AskResponse = {
      ...accountState,
      evidence: accountState.evidence.map((item) => item.label === "Buy / sell fills"
        ? { ...item, value: "12 buy · 0 sell" }
        : item),
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "Both buys and sells were observed." }), buyOnlyState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Both buys and sells were observed, not only buys." }), buyOnlyState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Sell fills were present." }), buyOnlyState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "No sell fills were observed." }), buyOnlyState)).toBe(true);

    const typedCategories: AskResponse = {
      ...accountState,
      evidence: [
        ...accountState.evidence,
        { label: "Activity by symbol", value: "BTCUSDT: 8 · ETHUSDT: 4" },
        { label: "Most active time window", value: "22:00–22:59 UTC (4 fills)" },
        { label: "Five-candle market regime", value: "0 uptrend · 3 downtrend · 1 neutral across 4 fill contexts" },
      ],
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "xrpusdt was the busiest market." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "ETHUSDT was the busiest market." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "BTCUSDT was the busiest market." }), typedCategories)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "USDT was the busiest market." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The observed fees were denominated in btc." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "BTCUSDT fees were observed." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Trading fees are 1.2 USDT." }), typedCategories)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Execution fees are 1.2 USDT." }), typedCategories)).toBe(true);
    expect(modelReasoningValidationFailures(modelOutput({ interpretation: "Transaction costs include 1.2 USDT in known fill fees." }), typedCategories)).toEqual([]);
    expect(validateModelReasoning(modelOutput({ interpretation: "The fills clustered in the morning." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "An uptrend regime was observed." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "A downtrend regime was observed." }), typedCategories)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Neutral was the dominant regime." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Downtrend was the dominant regime." }), typedCategories)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Every observed regime was downtrend." }), typedCategories)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Only downtrend contexts occurred." }), typedCategories)).toBe(false);

    expect(validateModelReasoning(modelOutput({ interpretation: "Buy fills dominated the sample." }), accountState)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Sells were the dominant side." }), accountState)).toBe(false);
    const buyHeavyState: AskResponse = {
      ...accountState,
      evidence: accountState.evidence.map((item) => item.label === "Buy / sell fills"
        ? { ...item, value: "8 buy · 4 sell" }
        : item),
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "Buy fills dominated the sample." }), buyHeavyState)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "Sells were the dominant side." }), buyHeavyState)).toBe(false);
  });

  it("requires domain claims to have matching deterministic evidence", () => {
    expect(validateModelReasoning(modelOutput({ interpretation: "A clock-based timing pattern is visible." }), deterministic)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Timing evidence was not analyzed." }), deterministic)).toBe(true);
    const withTiming: AskResponse = {
      ...deterministic,
      evidence: [...deterministic.evidence, { label: "Most active time window", value: "22:00–22:59 UTC" }],
      toolRuns: [...deterministic.toolRuns, { key: "analyze_trade_timing", label: "Checking trade timing", status: "completed", summary: "The most active observed UTC hour is available.", sources: ["Bitget fills"] }],
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "A clock-based timing observation is available." }), withTiming)).toBe(true);
    expect(validateModelReasoning(modelOutput({
      finding: { headline: "The timing window is available.", summary: "This is a clock-based observation." },
      interpretation: "The most active time window was 22:00–22:59 UTC (4 fills).",
      reasoningPoints: [], evidenceLabels: ["Most active time window"], confidenceReasons: [], limitations: [],
    }), {
      ...withTiming,
      evidence: [{ label: "Most active time window", value: "22:00–22:59 UTC (4 fills)" }],
    })).toBe(true);
    const withInterval: AskResponse = {
      ...deterministic,
      evidence: [...deterministic.evidence, { label: "Average interval between fills", value: "21h 27m" }],
      toolRuns: [...deterministic.toolRuns, { key: "analyze_trading_activity", label: "Checking trading activity", status: "completed", summary: "Average interval between fills is available.", sources: ["Bitget fills"] }],
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "Fill timing cadence is available as a descriptive observation." }), withInterval)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The average interval between fills is 21h 27m." }), withInterval)).toBe(true);
  });

  it("preserves the epistemic limits of selected app context", () => {
    const selectedContext: AskResponse = {
      ...deterministic,
      qualitativeEvidence: [
        { kind: "memory", label: "Selected RIKKU memory", statement: "A stored interpretation.", classification: "inference", confidence: "low", status: "active" },
        { kind: "pattern", label: "Selected RIKKU pattern", statement: "A candidate timing pattern.", classification: null, confidence: "low", status: "candidate" },
        { kind: "research", label: "Selected RIKKU research source", statement: "Market note · Publisher: Reuters", classification: null, confidence: null, status: null },
        { kind: "rule", label: "Selected RIKKU playbook rule", statement: "Pause after a loss.", classification: null, confidence: "moderate", status: "active" },
        { kind: "context", label: "Selected latest validated RIKKU analysis", statement: "Concentration was reported within one imported window.", classification: "prior_validated_analysis", confidence: "low", status: "completed" },
      ],
    };
    expect(validateModelReasoning(modelOutput({ interpretation: "The selected memory is a verified fact." }), selectedContext)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The selected pattern is established." }), selectedContext)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "Reuters reported the same account pattern." }), selectedContext)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "You followed the selected rule." }), selectedContext)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "This prior analysis independently proves a persistent concentration pattern." }), selectedContext)).toBe(false);
    expect(validateModelReasoning(modelOutput({ interpretation: "The selected analysis reported concentration only within its imported window; it is not independent evidence of persistence." }), selectedContext)).toBe(true);
    expect(validateModelReasoning(modelOutput({ interpretation: "The research contents were not provided; only stored metadata is available." }), selectedContext)).toBe(true);
  });

  it("accepts a grounded explanation of possible split executions without treating unresolved PnL as a claim", async () => {
    const response: AskResponse = {
      ...deterministic,
      question: "did my orders end up split into a bunch of separate executions?",
      finding: { headline: "The import has separate order and fill records.", summary: "A per-order execution map has not been verified." },
      interpretation: "The available totals cannot establish which fills belong to each order.",
      evidence: [
        { label: "Orders imported", value: "12" },
        { label: "Fills imported", value: "12" },
      ],
      toolRuns: [{ key: "get_import_summary", label: "Reading import summary", status: "completed", summary: "Orders and fills were imported as separate record types.", sources: ["Bitget import summary"] }],
    };
    const answer = modelOutput({
      finding: { headline: "The totals alone do not prove split executions.", summary: "Order-to-fill linking is needed before deciding whether an order was split." },
      interpretation: "An order can have separate executions, but the imported totals do not prove that happened here. To settle it, compare order identifiers with fill identifiers; realized profit or loss remains unverified.",
      reasoningPoints: [
        { kind: "observation", statement: "Orders and fills are separate imported record types.", rationale: "Their totals do not establish a per-order mapping.", evidenceLabels: ["Orders imported", "Fills imported"], test: null },
        { kind: "uncertainty", statement: "Split execution is not established from totals alone.", rationale: "The order-to-fill links have not been checked.", evidenceLabels: ["Orders imported", "Fills imported"], test: "Compare order and fill identifiers before checking realized PnL." },
      ],
      evidenceLabels: ["Orders imported", "Fills imported"],
      confidenceReasons: ["The import totals are verified, but linkage is not."],
      limitations: ["Per-order execution mapping is not yet verified."],
      suggestedFollowups: ["Could the matched executions show a profit or loss?"],
    });
    expect(modelReasoningValidationFailures(answer, response)).toEqual([]);
    const callModel = vi.fn(async () => answer);
    const result = await reasonAboutEvidence({ response, callModel });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(result.reasoningStatus).toBe("external_llm");
    expect(result.evidence).toEqual(response.evidence);
    expect(result.interpretation).toContain("order identifiers");
  });

  it("retries malformed structured output once and then fails safely", async () => {
    const callModel = vi.fn(async () => ({ wrong: true }));
    await expect(reasonAboutEvidence({ response: deterministic, callModel })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("fails closed after one regeneration if unsupported numeric claims persist", async () => {
    const callModel = vi.fn(async () => modelOutput({
      finding: { headline: "The fees prove a 99% cost burden.", summary: "Half of the activity carried the known fees." },
      interpretation: "The fees prove a 99% cost burden.",
      reasoningPoints: [
        { kind: "observation", statement: "The fees prove a 99% burden.", rationale: "Half the activity carried fees.", evidenceLabels: ["Known fill fees by coin"], test: null },
        { kind: "uncertainty", statement: "Half may be incomplete.", rationale: "Financial records were kept separate.", evidenceLabels: [], test: null },
      ],
    }));
    await expect(reasonAboutEvidence({ response: deterministic, callModel })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(validateModelReasoning(modelOutput({ interpretation: "Half of the activity carried the known fees." }), deterministic)).toBe(false);
  });

  it("performs at most one anti-repetition regeneration", async () => {
    const repeated = modelOutput();
    expect(isExcessivelyRepetitive(repeated, [{ question: "Earlier", conclusion: "Known fees are 1.2 USDT. This answers the fee question directly. The known total covers fill-level fees in the imported window only." }])).toBe(true);
    const callModel = vi.fn(async (args: { mode: "scout" | "analyst" | "investigator"; prompt: string; retryInstruction?: string }) => {
      void args;
      return repeated;
    });
    await expect(reasonAboutEvidence({ response: deterministic, recent: [{ question: "Earlier", conclusion: "Known fees are 1.2 USDT. This answers the fee question directly. The known total covers fill-level fees in the imported window only." }], callModel })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(callModel.mock.calls[1][0].retryInstruction).toBe("Answer only the new information need. Build on prior context instead of restating the previous response. Introduce new reasoning or evidence.");
    expect(callModel.mock.calls[1][0].prompt).toContain("Known fees are 1.2 USDT");
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
