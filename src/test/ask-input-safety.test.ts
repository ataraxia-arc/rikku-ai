import { describe, expect, it } from "vitest";
import { containsSensitiveAskInput, PERSISTED_ASK_QUESTION, scrubAskResponseForPersistence } from "@/lib/ask/input-safety";
import type { AskResponse } from "@/lib/ask/types";

const response: AskResponse = {
  version: "ask-evidence-v18",
  status: "completed",
  mode: "analyst",
  answerKind: "analysis",
  question: "Analyze my imported Bitget activity.",
  finding: { headline: "Imported data is available.", summary: "A safe test response." },
  interpretation: "A safe test response.",
  reasoningPoints: [],
  evidence: [],
  qualitativeEvidence: [],
  confidence: { level: "low", reasons: [] },
  limitations: [],
  marketContext: null,
  dataWindow: { start: null, end: null, label: null },
  sources: [],
  toolRuns: [],
  suggestedFollowups: [],
  reasoningStatus: "deterministic_fallback",
};

describe("Ask input safety", () => {
  it.each([
    "my API key is abc",
    "API_SECRET=should-not-be-stored",
    "passphrase: private value",
    "Authorization: Bearer this-token-is-private",
    `sb_${"secret"}_exampleTokenValue`,
    `sk-${"A".repeat(24)}`,
    `gsk_${"B".repeat(24)}`,
    "a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4",
    `eyJ${"A".repeat(12)}.${"B".repeat(16)}.${"C".repeat(20)}`,
    "-----BEGIN PRIVATE KEY-----",
  ])("rejects credential-shaped input", (input) => {
    expect(containsSensitiveAskInput(input), input).toBe(true);
  });

  it("allows an ordinary evidence question", () => {
    expect(containsSensitiveAskInput("How much did I pay in fees for imported fills?")).toBe(false);
  });

  it("omits a free-form question from a durable cached response", () => {
    const persisted = scrubAskResponseForPersistence(response);
    expect(persisted.question).toBe(PERSISTED_ASK_QUESTION);
    expect(JSON.stringify(persisted)).not.toContain(response.question);
  });
});
