import Link from "next/link";
import { DisconnectBitgetButton } from "@/components/disconnect-bitget-button";
import { FeaturePage } from "@/components/feature-page";
import { StartBitgetImportButton } from "@/components/start-bitget-import-button";
import { Button } from "@/components/ui/button";
import { formatCoverage, formatUtcTimestamp } from "@/lib/workspace/presentation";
import { readSettingsData } from "@/lib/workspace/read-workspace-data";
import { signOut } from "@/app/settings/actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { connection, readable, profile } = await readSettingsData();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  const sourceStatus = connection.connected ? "Verified read-only Bitget connection" : "No verified Bitget connection";

  return (
    <FeaturePage
      active="Settings"
      eyebrow="WORKSPACE CONTROLS"
      title="Settings"
      description="Connection, account, and workspace controls. No API secret, passphrase, or exchange credential is displayed here."
      connectionStatus={connectionStatus}
      sideTitle="Account safety"
      sideItems={["The connected Bitget key is read-only and encrypted server-side.", "Resync starts a real import; it never creates demo data.", "Disconnect revokes the stored RIKKU connection without exposing credentials."]}
      sourceStatus={sourceStatus}
      sourceDescription="Connection state and last sync are read from the authenticated workspace, not from browser storage."
    >
      <div className="insight-table" aria-label="Workspace settings">
        <article>
          <div><span>PROFILE</span><h3>{readable && profile?.displayName ? profile.displayName : "Profile details not available"}</h3><p>Timezone: {readable && profile?.timezone ? profile.timezone : "not reported"} · Base currency: {readable && profile?.baseCurrency ? profile.baseCurrency : "not reported"}</p></div>
          <strong>ACCOUNT</strong>
        </article>
        <article>
          <div><span>BITGET CONNECTION</span><h3>{connection.connected ? "Connected · read-only verified" : "Not connected"}</h3><p>{connection.connected ? `Last synced: ${formatUtcTimestamp(connection.lastSyncedAt)}${connection.latestImport ? ` · Coverage: ${formatCoverage(connection.latestImport.earliestRecordAt, connection.latestImport.latestRecordAt)}` : ""}` : "Connect a read-only Bitget account before importing account data."}</p></div>
          <strong>{connection.connected ? "ACTIVE" : "OFFLINE"}</strong>
        </article>
        <article>
          <div><span>REASONING PREFERENCE</span><h3>Chosen per Ask RIKKU conversation</h3><p>No workspace-wide reasoning preference is stored yet. Select Scout, Analyst, or Investigator when you ask a question.</p></div>
          <Link className="data-window" href="/ask">Open Ask RIKKU</Link>
        </article>
        <article>
          <div><span>PRIVACY &amp; DATA</span><h3>Read-only Bitget data</h3><p>RIKKU stores the verified connection securely and uses imported records for analysis. No exchange password is collected.</p></div>
          <strong>READ-ONLY</strong>
        </article>
      </div>
      <div className="home-import-actions" aria-label="Connection actions">
        {connection.connected ? <>
          <StartBitgetImportButton label="Resync Bitget" />
          <DisconnectBitgetButton />
        </> : <Link className="landing-cta-primary" href="/onboarding/bitget">Connect Bitget</Link>}
        <form action={signOut}><Button type="submit" variant="ghost">Sign out</Button></form>
      </div>
    </FeaturePage>
  );
}
