"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AiPreferences } from "@/lib/workspace/read-workspace-data";

export function AiSettingsForm({ initial }: { initial: AiPreferences }) {
  const router = useRouter();
  const [defaultMode, setDefaultMode] = useState(initial.defaultMode);
  const [responseStyle, setResponseStyle] = useState(initial.responseStyle);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save() {
    setStatus("saving");
    const result = await fetch("/api/settings/ai", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultMode, responseStyle }),
    }).catch(() => null);
    setStatus(result?.ok ? "saved" : "error");
    if (result?.ok) router.refresh();
  }

  return <article>
    <div><span>AI PREFERENCES</span><h3>Default reasoning and response style</h3>
      <label>Default reasoning mode<select value={defaultMode} onChange={(event) => setDefaultMode(event.target.value as AiPreferences["defaultMode"])}><option value="scout">Scout</option><option value="analyst">Analyst</option><option value="investigator">Investigator</option></select></label>
      <label>Response style<select value={responseStyle} onChange={(event) => setResponseStyle(event.target.value as AiPreferences["responseStyle"])}><option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
      {status === "error" ? <p role="alert">RIKKU could not save these preferences safely.</p> : null}
      {status === "saved" ? <p role="status">AI preferences saved.</p> : null}
    </div>
    <button className="data-window" type="button" disabled={status === "saving"} onClick={() => void save()}>{status === "saving" ? "Saving…" : "Save AI settings"}</button>
  </article>;
}
