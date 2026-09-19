"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp, BrainCircuit, Check, Database, Search, Sparkles, Zap } from "lucide-react";
import type { AskMode, AskResponse } from "@/lib/ask/types";

const modes = [
  { key: "scout", label: "Scout", icon: Zap, note: "Quick focused analysis" },
  { key: "analyst", label: "Analyst", icon: BrainCircuit, note: "Balanced evidence-backed analysis" },
  { key: "investigator", label: "Investigator", icon: Search, note: "Broader multi-tool evidence check" },
] as const;

type ChatMessage = {
  id: number;
  question: string;
  response?: AskResponse;
  error?: string;
  loading?: boolean;
};

const safeErrorCopy: Record<string, string> = {
  AUTH_REQUIRED: "Your RIKKU session expired. Sign in again.",
  SUPABASE_NOT_CONFIGURED: "RIKKU data services are not configured yet.",
  AUTH_UNAVAILABLE: "RIKKU could not verify your session. Try again shortly.",
  ASK_SENSITIVE_INPUT: "Do not enter API credentials or secrets in Ask RIKKU.",
  ASK_REQUEST_TOO_LARGE: "That question is too long. Please keep it under 500 characters.",
  ASK_INVALID_REQUEST: "Enter a short question about your imported activity.",
};

function displayError(code: unknown) {
  return typeof code === "string" && safeErrorCopy[code]
    ? safeErrorCopy[code]
    : "RIKKU could not prepare an evidence-backed answer. Try again shortly.";
}

function modeLabel(mode: AskMode) {
  return modes.find((item) => item.key === mode)?.label ?? "Analyst";
}

function statusLabel(status: AskResponse["status"]) {
  if (status === "needs_connection") return "CONNECTION REQUIRED";
  if (status === "needs_import") return "IMPORT REQUIRED";
  if (status === "insufficient_data") return "INSUFFICIENT DATA";
  return "RIKKU ANALYSIS";
}

function AnswerCard({ response }: { response: AskResponse }) {
  const connectHref = response.status === "needs_connection" ? "/onboarding/bitget" : "/onboarding/import";
  const connectLabel = response.status === "needs_connection" ? "Connect Bitget" : "Import Bitget activity";
  return (
    <article className="analysis-response">
      <div className="analysis-label">
        <span className="analysis-mark"><Sparkles size={15} /></span>
        <div><strong>{statusLabel(response.status)}</strong><span>{modeLabel(response.mode)} mode · deterministic tools</span></div>
      </div>
      <div className="analysis-finding">
        <span>FINDING</span>
        <h2>{response.finding.headline}</h2>
        <p>{response.finding.summary}</p>
      </div>

      {response.evidence.length > 0 && (
        <div className="analysis-columns">
          <section>
            <span>EVIDENCE</span>
            <ul>
              {response.evidence.map((metric) => <li key={metric.label}><Check size={13} /><div><strong>{metric.label}: </strong>{metric.value}{metric.detail ? <small> — {metric.detail}</small> : null}</div></li>)}
            </ul>
          </section>
          <section>
            <span>CONFIDENCE</span>
            <p><strong>{response.confidence.level.toUpperCase()}</strong></p>
            <ul>
              {response.confidence.reasons.map((reason) => <li key={reason}><Check size={13} />{reason}</li>)}
            </ul>
          </section>
        </div>
      )}

      {(response.marketContext || response.dataWindow.label) && (
        <div className="analysis-columns">
          <section>
            <span>MARKET CONTEXT</span>
            <p>{response.marketContext?.summary ?? "Market context was not required for this question."}</p>
            {response.marketContext?.regimeSummary ? <p>{response.marketContext.regimeSummary}</p> : null}
          </section>
          <section>
            <span>DATA WINDOW</span>
            <p>{response.dataWindow.label ?? "Not reported"}</p>
          </section>
        </div>
      )}

      {(response.limitations.length > 0 || response.sources.length > 0 || response.toolRuns.length > 0) && (
        <div className="analysis-columns">
          <section>
            <span>LIMITATIONS</span>
            {response.limitations.length ? <ul>{response.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul> : <p>No additional limitations were reported.</p>}
          </section>
          <section>
            <span>SOURCES USED</span>
            {response.sources.length ? <ul>{response.sources.map((source) => <li key={source.label}>{source.label}{source.detail ? ` — ${source.detail}` : ""}</li>)}</ul> : <p>No personal data source was used.</p>}
          </section>
        </div>
      )}

      {response.toolRuns.length > 0 && (
        <details className="historical-row">
          <summary>Tool execution</summary>
          <ul>
            {response.toolRuns.map((tool) => <li key={tool.key}><strong>{tool.label}</strong> · {tool.status.replace("_", " ")} — {tool.summary}</li>)}
          </ul>
        </details>
      )}
      {response.status === "needs_connection" || response.status === "needs_import" ? <Link className="landing-cta-primary" href={connectHref}>{connectLabel}</Link> : null}
    </article>
  );
}

export function AskClient({ initialPrompt = "" }: { initialPrompt?: string }) {
  const promptFromRoute = initialPrompt.trim().slice(0, 500);
  const [mode, setMode] = useState<AskMode>("analyst");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messageId = useRef(0);
  const history = useRef<string[]>([]);
  const initialPromptStarted = useRef(false);
  const [isRunning, setIsRunning] = useState(false);

  const ask = useCallback(async (nextQuestion: string, requestedMode: AskMode = mode) => {
    const trimmed = nextQuestion.trim().slice(0, 500);
    if (!trimmed || isRunning) return;
    const id = ++messageId.current;
    const priorQuestions = history.current.slice(-8);
    history.current = [...history.current, trimmed].slice(-8);
    setMessages((previous) => [...previous, { id, question: trimmed, loading: true }]);
    setIsRunning(true);
    try {
      const result = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, mode: requestedMode, history: priorQuestions }),
      });
      let payload: unknown;
      try {
        payload = await result.json();
      } catch {
        payload = null;
      }
      const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
      const answer = record.response;
      if (!result.ok || !answer || typeof answer !== "object") {
        setMessages((previous) => previous.map((message) => message.id === id ? { ...message, loading: false, error: displayError(record.code) } : message));
        return;
      }
      setMessages((previous) => previous.map((message) => message.id === id ? { ...message, loading: false, response: answer as AskResponse } : message));
    } catch {
      setMessages((previous) => previous.map((message) => message.id === id ? { ...message, loading: false, error: "RIKKU could not reach the evidence service. Try again shortly." } : message));
    } finally {
      setIsRunning(false);
    }
  }, [isRunning, mode]);

  useEffect(() => {
    if (!promptFromRoute || initialPromptStarted.current) return;
    initialPromptStarted.current = true;
    void ask(promptFromRoute, "analyst");
  }, [ask, promptFromRoute]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    setQuestion("");
    void ask(trimmed);
  }

  return (
    <section className="workspace ask-workspace">
      <header className="feature-header ask-header">
        <div><p className="date-label">DECISION INTELLIGENCE</p><h1>Ask RIKKU</h1><p>Answers are generated from imported evidence and deterministic tools—not invented trading metrics.</p></div>
      </header>

      <div className="ask-empty-stage" aria-live="polite">
        {messages.length ? messages.map((message) => (
          <div key={message.id}>
            <div className="user-question"><span>YOU</span><p>{message.question}</p></div>
            {message.loading ? (
              <article className="analysis-response analysis-empty-response" aria-label="RIKKU is analyzing imported data">
                <div className="analysis-label"><span className="analysis-mark"><Sparkles size={15} /></span><div><strong>READING REAL DATA</strong><span>{modeLabel(mode)} tool plan in progress</span></div></div>
                <div className="analysis-finding"><span>ANALYSIS PROGRESS</span><h2>Preparing an evidence-backed answer.</h2><p>RIKKU is running its mode-specific deterministic tool plan against only the imported records required by this question.</p></div>
                <ul className="analysis-progress" aria-label="Analysis steps">
                  <li>Reading imported activity</li>
                  <li>Running mode-specific evidence checks</li>
                  <li>Validating evidence and limitations</li>
                  <li>Preparing the answer</li>
                </ul>
              </article>
            ) : null}
            {message.response ? <AnswerCard response={message.response} /> : null}
            {message.error ? <article className="analysis-response" role="alert"><div className="analysis-finding"><span>ASK RIKKU</span><h2>Analysis could not start.</h2><p>{message.error}</p></div></article> : null}
          </div>
        )) : (
          <div className="ask-zero-state">
            <span><Database size={23} /></span>
            <p className="section-kicker">EVIDENCE-DRIVEN ANALYSIS</p>
            <h2>Ask about what your imported data can actually show.</h2>
            <p>RIKKU reports unsupported questions as insufficient data instead of filling gaps with fictional trades, PnL, or behavior.</p>
            <Link className="landing-cta-secondary" href="/onboarding">Review Bitget connection</Link>
          </div>
        )}
      </div>

      <form className="ask-composer" onSubmit={submit}>
        <label htmlFor="rikku-question" className="sr-only">Ask RIKKU about your imported trades, market, or decisions</label>
        <textarea id="rikku-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask RIKKU about your imported trades, market, or decisions…" rows={2} maxLength={500} disabled={isRunning} />
        <div className="composer-controls">
          <div className="reasoning-selector" aria-label="Reasoning mode">
            {modes.map((item) => {
              const Icon = item.icon;
              return <button type="button" key={item.key} className={mode === item.key ? "reasoning-active" : ""} onClick={() => setMode(item.key)} title={item.note} disabled={isRunning}><Icon size={13} />{item.label}{mode === item.key && <Check size={11} />}</button>;
            })}
          </div>
          <div className="composer-tools"><span>Imported activity</span><span>Evidence</span><span>Memory</span><span>Risk limits</span></div>
          <button className="composer-send" type="submit" aria-label="Send question" disabled={!question.trim() || isRunning}><ArrowUp size={17} /></button>
        </div>
      </form>
    </section>
  );
}
