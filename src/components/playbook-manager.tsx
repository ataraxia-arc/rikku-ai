"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PersonalRule } from "@/lib/workspace/read-workspace-data";
import { formatUtcDate } from "@/lib/workspace/presentation";

export function PlaybookManager({ rules }: { rules: PersonalRule[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<PersonalRule | null>(null);
  const [category, setCategory] = useState("");
  const [ifCondition, setIfCondition] = useState("");
  const [thenAction, setThenAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setEditing(null); setCategory(""); setIfCondition(""); setThenAction(""); setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const response = await fetch("/api/playbook", {
      method: editing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(editing ? { id: editing.id, category, ifCondition, thenAction } : { category, ifCondition, thenAction }),
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) { setError("RIKKU could not save this rule safely. Check the required fields and try again."); return; }
    reset(); router.refresh();
  }

  async function mutate(id: string, method: "PATCH" | "DELETE", status?: "active" | "paused") {
    if (busy || (method === "DELETE" && !window.confirm("Delete this user-created rule?"))) return;
    setBusy(true); setError("");
    const response = await fetch("/api/playbook", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(status ? { id, status } : { id }),
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) { setError("RIKKU could not update this rule safely."); return; }
    router.refresh();
  }

  return <section aria-labelledby="playbook-manager-title">
    <p className="section-kicker">USER-CREATED RULES</p>
    <h2 id="playbook-manager-title">Personal rule builder</h2>
    <form className="analysis-response" onSubmit={submit}>
      <label>Category<input required minLength={2} maxLength={80} value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Risk control" /></label>
      <label>IF<textarea required minLength={3} maxLength={500} value={ifCondition} onChange={(event) => setIfCondition(event.target.value)} placeholder="I am trading after a large loss" /></label>
      <label>THEN<textarea required minLength={3} maxLength={500} value={thenAction} onChange={(event) => setThenAction(event.target.value)} placeholder="Review position size before entering" /></label>
      {error ? <p role="alert">{error}</p> : null}
      <div className="home-import-actions">
        <button className="landing-cta-primary" type="submit" disabled={busy}>{editing ? "Save rule" : "Create rule"}</button>
        {editing ? <button className="landing-cta-secondary" type="button" onClick={reset} disabled={busy}>Cancel edit</button> : null}
      </div>
    </form>

    {rules.length === 0 ? <div className="source-note"><span>NO RULES YET</span><strong>Create a personal rule when you are ready.</strong><p>RIKKU will not invent an AI-generated rule from insufficient history.</p></div> : <div className="insight-table" aria-label="Personal rules">
      {rules.map((rule) => <article key={rule.id}>
        <div>
          <span>{rule.category} · {rule.status} · {rule.editable ? "User-created" : "RIKKU-generated"}</span>
          <h3>IF {rule.ifConditions}</h3><p>THEN {rule.thenAction}</p>
          <p>Origin: {rule.editable ? "User" : rule.evidence} · Confidence: {rule.confidence} · Created: {formatUtcDate(rule.createdAt)}</p>
          <div className="home-import-actions">
            {rule.editable ? <>
              <button type="button" className="data-window" disabled={busy} onClick={() => { setEditing(rule); setCategory(rule.category); setIfCondition(rule.ifConditions); setThenAction(rule.thenAction); }}>Edit</button>
              <button type="button" className="data-window" disabled={busy} onClick={() => void mutate(rule.id, "PATCH", rule.status === "paused" ? "active" : "paused")}>{rule.status === "paused" ? "Enable" : "Disable"}</button>
              <button type="button" className="data-window" disabled={busy} onClick={() => void mutate(rule.id, "DELETE")}>Delete</button>
            </> : null}
            <Link className="data-window" href={`/ask?context=rule:${rule.id}`}>Ask RIKKU about this rule</Link>
          </div>
        </div><strong>{rule.status.toUpperCase()}</strong>
      </article>)}
    </div>}
  </section>;
}
