import { AskRikkuLink, FeatureEmptyState, FeaturePage } from "@/components/feature-page";
import { formatRecordCount, formatUtcDate } from "@/lib/workspace/presentation";
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
      {!readable ? (
        <FeatureEmptyState
          title="RIKKU could not read the playbook safely."
          description="No rule was created, changed, or removed. Ask RIKKU to review the data that could support a future rule."
          actionHref="/ask?prompt=What%20evidence%20would%20be%20needed%20before%20creating%20a%20personal%20trading%20rule"
          actionLabel="Ask RIKKU"
        />
      ) : rules.length === 0 ? (
        <FeatureEmptyState
          title="No personal rules have been saved."
          description="RIKKU will not generate a rule from the current limited history without an evidence-backed condition and outcome."
          actionHref="/ask?prompt=Help%20me%20review%20my%20imported%20Bitget%20activity%20before%20I%20define%20a%20personal%20rule"
          actionLabel="Ask RIKKU to review the evidence"
        />
      ) : (
        <>
          <div className="insight-table" aria-label="Personal rules">
            {rules.map((rule) => <article key={rule.id}>
              <div>
                <span>{rule.category} · {rule.status}</span>
                <h3>IF {rule.ifConditions}</h3>
                <p>THEN {rule.thenAction}</p>
                <p>Evidence: {rule.evidence} · Confidence: {rule.confidence} · Created: {formatUtcDate(rule.createdAt)}</p>
              </div>
              <strong>{rule.status.toUpperCase()}</strong>
            </article>)}
          </div>
          <AskRikkuLink href="/ask?prompt=Evaluate%20my%20stored%20personal%20rules%20against%20the%20available%20Bitget%20evidence">Ask RIKKU to evaluate these rules</AskRikkuLink>
        </>
      )}
    </FeaturePage>
  );
}
