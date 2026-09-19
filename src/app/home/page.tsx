import { AppShell } from "@/components/app-shell";
import { HomeDashboard, type ImportedActivitySummary, type LatestValidatedFinding } from "@/components/home-dashboard";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readWorkspaceConnection } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function latestFindingFromResult(value: unknown, confidence: unknown, createdAt: unknown): LatestValidatedFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  const finding = result.finding && typeof result.finding === "object" && !Array.isArray(result.finding)
    ? result.finding as Record<string, unknown>
    : null;
  const headline = stringValue(finding?.headline) ?? (result.status === "insufficient_data" ? "Latest analysis: insufficient data" : null);
  const summary = stringValue(finding?.summary) ?? stringValue(result.summary);
  if (!headline || !summary) return null;
  const level = stringValue(confidence);
  return {
    headline: headline.slice(0, 240),
    summary: summary.slice(0, 500),
    confidence: level === "low" || level === "moderate" || level === "high" || level === "not_assessable" ? level : null,
    createdAt: typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null,
  };
}

async function readLatestValidatedFinding(): Promise<LatestValidatedFinding | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return null;
    const { data } = await supabase
      .from("analysis_results")
      .select("result,confidence,created_at")
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return latestFindingFromResult(data?.result, data?.confidence, data?.created_at);
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const [connection, latestFinding] = await Promise.all([readWorkspaceConnection(), readLatestValidatedFinding()]);
  const latestImport = connection.latestImport;
  const importedActivity: ImportedActivitySummary | null = latestImport ? {
    ...latestImport,
    lastSyncedAt: connection.lastSyncedAt ?? latestImport.completedAt,
  } : null;
  const workspaceUnavailable = connection.authenticated && (!connection.connectionReadable || !connection.importReadable);
  return (
    <AppShell active="Home" connectionStatus={connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null}>
      <HomeDashboard importedActivity={importedActivity} latestFinding={latestFinding} workspaceUnavailable={workspaceUnavailable} />
    </AppShell>
  );
}
