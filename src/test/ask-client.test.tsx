import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskClient } from "@/components/ask-client";
import type { AskResponse } from "@/lib/ask/types";

const response: AskResponse = {
  version: "ask-evidence-v18",
  status: "completed",
  mode: "analyst",
  answerKind: "analysis",
  question: "Analyze my imported Bitget activity.",
  finding: { headline: "12 imported fills across 5 instruments.", summary: "Descriptive imported-data analysis." },
  interpretation: "Descriptive imported-data analysis.",
  reasoningPoints: [{ kind: "uncertainty", statement: "The sample does not establish a persistent pattern.", rationale: "Completed trades are unavailable.", evidenceLabels: ["Fills analyzed"], test: "Compare the same signal after future imports." }],
  evidence: [{ label: "Fills analyzed", value: "12" }],
  qualitativeEvidence: [],
  confidence: { level: "low", reasons: ["12 fills are descriptive evidence."] },
  limitations: ["Completed trades cannot yet be reconstructed because opening inventory inside the imported Bitget history window is unknown."],
  marketContext: { available: true, summary: "Daily candle context matched 12 fills.", matchedFills: 12 },
  dataWindow: { start: "2026-07-08T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z", label: "Jul 8 – Aug 4, 2026" },
  sources: [{ label: "Bitget fills" }, { label: "Bitget daily candles" }],
  toolRuns: [
    { key: "get_import_summary", label: "Reading imported activity", status: "completed", summary: "Imported activity read.", sources: ["Bitget import summary"] },
    { key: "run_skeptic_check", label: "Validating evidence", status: "completed", summary: "Low confidence cap applied.", sources: ["Bitget import summary"] },
  ],
  suggestedFollowups: [],
  reasoningStatus: "deterministic_fallback",
};

type AskFetchResponse = { ok: boolean; json: () => Promise<{ ok: boolean; response: AskResponse }> };

describe("Ask RIKKU client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("auto-runs a deep-linked prompt and renders structured source-backed output", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<AskFetchResponse>>(async () => ({ ok: true, json: async () => ({ ok: true, response }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);

    expect(await screen.findByText("12 imported fills across 5 instruments.")).toBeDefined();
    expect(screen.getByText("FINDING")).toBeDefined();
    expect(screen.getByText("EVIDENCE")).toBeDefined();
    expect(screen.getByText("CONFIDENCE")).toBeDefined();
    expect(screen.getByText("LIMITATIONS")).toBeDefined();
    expect(screen.getByText("DATA WINDOW")).toBeDefined();
    expect(screen.getByText("SOURCES USED")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/ask", expect.objectContaining({ method: "POST" }));
    const firstRequest = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(firstRequest.body))).toMatchObject({
      question: "Analyze my imported Bitget activity.", mode: "analyst", history: [], contextId: null,
    });
  });

  it("carries bounded prior user questions into an accessible follow-up request", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<AskFetchResponse>>(async () => ({ ok: true, json: async () => ({ ok: true, response }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);
    await screen.findByText("12 imported fills across 5 instruments.");

    const input = screen.getByLabelText(/Ask RIKKU about your imported trades/i);
    fireEvent.change(input, { target: { value: "What about fees?" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(secondRequest.body))).toMatchObject({
      question: "What about fees?",
      history: [{
        question: "Analyze my imported Bitget activity.",
        conclusion: expect.stringContaining("12 imported fills across 5 instruments."),
      }],
    });
  });

  it("shows a safe non-blank failure message when the API rejects a request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, code: "AUTH_REQUIRED" }) })));
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);
    expect((await screen.findByRole("alert")).textContent).toContain("Your RIKKU session expired. Sign in again.");
  });

  it("shows a safe network failure without surfacing exception details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("synthetic internal network detail");
    }));
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("RIKKU could not reach the evidence service. Try again shortly.");
    expect(alert.textContent).not.toContain("synthetic internal network detail");
  });

  it("shows a safe generic failure for a non-JSON API response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => {
        throw new SyntaxError("unexpected HTML response");
      },
    })));
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("RIKKU could not prepare an evidence-backed answer. Try again shortly.");
    expect(alert.textContent).not.toContain("unexpected HTML response");
  });

  it.each([
    ["ASK_SENSITIVE_INPUT", "Do not enter API credentials or secrets in Ask RIKKU."],
    ["ASK_INVALID_REQUEST", "Enter a short question about your imported activity."],
    ["ASK_REQUEST_TOO_LARGE", "That question is too long. Please keep it under 500 characters."],
    ["SUPABASE_NOT_CONFIGURED", "RIKKU data services are not configured yet."],
    ["AUTH_UNAVAILABLE", "RIKKU could not verify your session. Try again shortly."],
  ])("renders the safe %s API error", async (code, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, code }) })));
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);
    expect((await screen.findByRole("alert")).textContent).toContain(expected);
  });

  it("shows a bounded retry delay when Ask RIKKU is rate limited", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, code: "ASK_RATE_LIMITED", retryAfterSeconds: 17 }) })));
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);
    expect((await screen.findByRole("alert")).textContent).toContain("Try again in 17 seconds.");
  });

  it("shows a safe message when selected RIKKU context no longer exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ ok: false, code: "ASK_CONTEXT_NOT_FOUND" }) })));
    render(<AskClient initialPrompt="Challenge the latest conclusion." contextId="latest-analysis" />);
    expect((await screen.findByRole("alert")).textContent).toContain("That saved RIKKU context is no longer available.");
  });

  it("shows only truthful planned analysis steps while an answer is running", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);

    expect(screen.getByText("Understanding your question…")).toBeDefined();
    expect(screen.getByText("Checking relevant verified evidence…")).toBeDefined();
    expect(screen.getByText("Validating the answer…")).toBeDefined();
    expect(screen.getByText("Preparing the answer…")).toBeDefined();
  });

  it("renders a deterministic fallback notice without claiming Groq interpretation", async () => {
    const fallback: AskResponse = {
      ...response,
      reasoningStatus: "deterministic_fallback",
      reasoningProvider: undefined,
      reasoningNotice: "RIKKU's reasoning service is temporarily unavailable. Your imported data remains safe; the answer below comes directly from deterministic evidence.",
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, response: fallback }) })));
    render(<AskClient initialPrompt="Analyze my imported Bitget activity." />);

    expect(await screen.findByText("REASONING STATUS")).toBeDefined();
    expect(screen.getByText(fallback.reasoningNotice!)).toBeDefined();
    expect(screen.getByText(/Analyst mode · deterministic evidence/)).toBeDefined();
    expect(screen.queryByText(/Groq interpretation/)).toBeNull();
  });
});
