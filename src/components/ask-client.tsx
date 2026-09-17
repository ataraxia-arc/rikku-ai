"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowUp, BrainCircuit, Check, Database, Search, Sparkles, Zap } from "lucide-react";

const modes = [
  { key: "scout", label: "Scout", icon: Zap, note: "Quick focused analysis" },
  { key: "analyst", label: "Analyst", icon: BrainCircuit, note: "Balanced market and behavioral investigation" },
  { key: "investigator", label: "Investigator", icon: Search, note: "Deep multi-step research and evidence checking" },
] as const;

export function AskClient() {
  const [mode, setMode] = useState<(typeof modes)[number]["key"]>("analyst");
  const [question, setQuestion] = useState("");
  const [submitted, setSubmitted] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed) {
      setSubmitted(trimmed);
      setQuestion("");
    }
  }

  return (
    <section className="workspace ask-workspace">
      <header className="feature-header ask-header">
        <div><p className="date-label">DECISION INTELLIGENCE</p><h1>Ask RIKKU</h1><p>Question the market—and the way you respond to it.</p></div>
      </header>

      <div className="ask-empty-stage">
        {submitted ? (
          <>
            <div className="user-question"><span>YOU</span><p>{submitted}</p></div>
            <article className="analysis-response analysis-empty-response">
              <div className="analysis-label"><span className="analysis-mark"><Sparkles size={15} /></span><div><strong>RIKKU ANALYSIS</strong><span>{modes.find((item) => item.key === mode)?.label} mode</span></div></div>
              <div className="analysis-finding"><span>DATA REQUIRED</span><h2>Connect your trading history to investigate this question.</h2><p>RIKKU will not generate a personal finding without evidence from your authenticated account.</p></div>
              <Link className="landing-cta-primary" href="/onboarding">Connect Bitget</Link>
            </article>
          </>
        ) : (
          <div className="ask-zero-state">
            <span><Database size={23} /></span>
            <p className="section-kicker">NO IMPORTED EVIDENCE</p>
            <h2>Your questions deserve real context.</h2>
            <p>Connect Bitget to let RIKKU investigate your actual trades, decisions, market context, and risk.</p>
            <Link className="landing-cta-secondary" href="/onboarding">Connect your history</Link>
          </div>
        )}
      </div>

      <form className="ask-composer" onSubmit={submit}>
        <label htmlFor="rikku-question" className="sr-only">Ask RIKKU about your trades, market, or decisions</label>
        <textarea id="rikku-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Ask RIKKU about your trades, market, or decisions…" rows={2} />
        <div className="composer-controls">
          <div className="reasoning-selector" aria-label="Reasoning mode">
            {modes.map((item) => {
              const Icon = item.icon;
              return <button type="button" key={item.key} className={mode === item.key ? "reasoning-active" : ""} onClick={() => setMode(item.key)} title={item.note}><Icon size={13} />{item.label}{mode === item.key && <Check size={11} />}</button>;
            })}
          </div>
          <div className="composer-tools"><span>Market</span><span>Memory</span><span>Behavior</span><span>Risk</span></div>
          <button className="composer-send" type="submit" aria-label="Send question" disabled={!question.trim()}><ArrowUp size={17} /></button>
        </div>
      </form>
    </section>
  );
}
