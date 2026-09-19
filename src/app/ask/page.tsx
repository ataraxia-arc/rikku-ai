import { AppShell } from "@/components/app-shell";
import { AskClient } from "@/components/ask-client";
import { readWorkspaceConnection } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

export default async function AskPage({ searchParams }: { searchParams: Promise<{ prompt?: string | string[] }> }) {
  const params = await searchParams;
  const initialPrompt = typeof params.prompt === "string" ? params.prompt : "";
  const connection = await readWorkspaceConnection();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  return <AppShell active="Ask RIKKU" connectionStatus={connectionStatus}><AskClient key={initialPrompt} initialPrompt={initialPrompt} /></AppShell>;
}
