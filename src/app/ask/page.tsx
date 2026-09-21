import { AppShell } from "@/components/app-shell";
import { AskClient } from "@/components/ask-client";
import { readSettingsData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

const contextPrompts: Record<string, string> = {
  portfolio: "What can you establish about my current portfolio from the latest Bitget sync?",
  memory: "What does RIKKU remember about me?",
  patterns: "Do you see any reliable behavioral patterns in my imported activity?",
  research: "What market context is available around my imported Bitget activity?",
  risk: "What risks can you currently measure?",
  playbook: "Evaluate my personal rules against the evidence currently available.",
  "latest-analysis": "Show me evidence against the latest RIKKU conclusion.",
};

export default async function AskPage({ searchParams }: { searchParams: Promise<{ prompt?: string | string[]; context?: string | string[] }> }) {
  const params = await searchParams;
  const requestedContext = typeof params.context === "string" ? params.context.slice(0, 80) : null;
  const contextId = requestedContext && /^(portfolio|memory|patterns|research|risk|playbook|latest-analysis|(?:memory|pattern|research|rule):[0-9a-f-]{36})$/i.test(requestedContext) ? requestedContext : null;
  const initialPrompt = typeof params.prompt === "string"
    ? params.prompt
    : contextId
      ? contextPrompts[contextId] ?? (contextId.startsWith("memory:") ? "Explain this selected memory and its evidence." : contextId.startsWith("pattern:") ? "Investigate this selected pattern and its counter-evidence." : contextId.startsWith("research:") ? "Explain how this selected research source relates to my imported activity." : contextId.startsWith("rule:") ? "Evaluate this selected personal rule against available evidence." : "")
      : "";
  const { connection, preferences } = await readSettingsData();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  return <AppShell active="Ask RIKKU" connectionStatus={connectionStatus}><AskClient key={`${contextId ?? ""}:${initialPrompt}`} initialPrompt={initialPrompt} contextId={contextId} defaultMode={preferences.defaultMode} /></AppShell>;
}
