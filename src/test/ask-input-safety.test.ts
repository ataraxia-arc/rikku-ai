import { describe, expect, it } from "vitest";
import { containsSensitiveAskInput, PERSISTED_ASK_QUESTION, scrubAskResponseForPersistence } from "@/lib/ask/input-safety";
import type { AskResponse } from "@/lib/ask/types";

const response: AskResponse = {
  version: "ask-deterministic-v1",
  status: "completed",
  mode: "analyst",
  question: "Analyze my imported Bitget activity.",
  finding: { headline: "Imported data is available.", summary: "A safe test response." },
  evidence: [],
  confidence: { level: "low", reasons: [] },
  limitations: [],
  marketContext: null,
  dataWindow: { start: null, end: null, label: null },
  sources: [],
  toolRuns: [],
};

describe("Ask input safety", () => {
  it.each([
    "my API key is abc",
    "API_SECRET=should-not-be-stored",
    "passphrase: private value",
    "Authorization: Bearer this-token-is-private",
    `sb_${"secret"}_exampleTokenValue`,
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
