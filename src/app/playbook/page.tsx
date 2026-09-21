import { FeaturePage } from "@/components/feature-page";
import { PlaybookManager } from "@/components/playbook-manager";
import { formatRecordCount } from "@/lib/workspace/presentation";
import { readPlaybookData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

export default async function PlaybookPage() {
  const { connection, readable, rules } = await readPlaybookData();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  const sourceStatus = !readable ? "Playbook data unavailable" : `${formatRecordCount(rules.length)} stored personal rules`;

  return (
    <FeaturePage
      active="Playbook"
      eyebrow="MY RIKKU PLAYBOOK"
      title="Playbook"
      description="Personal IF→THEN rules are displayed only when a real rule record exists. RIKKU does not invent learned rules to fill the playbook."
      connectionStatus={connectionStatus}
      sideTitle="Rule quality"
      sideItems={["Conditions must be objectively assessable.", "Evidence links and confidence remain visible.", "Rules can be weakened or retired when evidence changes."]}
      sourceStatus={sourceStatus}
      sourceDescription="A missing evidence link is called out rather than replaced with a plausible explanation."
    >
      {!readable ? <div className="source-note"><span>PLAYBOOK UNAVAILABLE</span><strong>RIKKU could not read the playbook safely.</strong><p>No rule was created, changed, or removed.</p></div> : <PlaybookManager rules={rules} />}
    </FeaturePage>
  );
}
