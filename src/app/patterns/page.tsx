import { AskRikkuLink, FeatureEmptyState, FeaturePage } from "@/components/feature-page";
import { formatCoverage, formatRecordCount } from "@/lib/workspace/presentation";
import { readPatternData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

export default async function PatternsPage() {
  const { connection, readable, patterns } = await readPatternData();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  const sourceStatus = !readable
    ? "Pattern data unavailable"
    : `${formatRecordCount(patterns.length)} stored pattern records`;

  return (
    <FeaturePage
      active="Patterns"
      eyebrow="BEHAVIORAL PATTERN VALIDATION"
      title="Patterns"
      description="Only stored candidate and validated patterns are shown here. RIKKU does not turn a small collection of fills into a behavioral finding."
      connectionStatus={connectionStatus}
      sideTitle="Skeptic checks"
      sideItems={["Sample size must be recorded or explicitly unknown.", "Supporting and counter-evidence stay visible together.", "Confidence is the stored assessment, not a page-level guess."]}
      sourceStatus={sourceStatus}
      sourceDescription="Pattern status is read from stored validation records; no pattern is inferred at render time."
    >
      {!readable ? (
        <FeatureEmptyState
          title="RIKKU could not read pattern records safely."
          description="No pattern was created or changed. Ask RIKKU to assess what the imported evidence can support."
          actionHref="/ask?prompt=What%20patterns%20can%20be%20safely%20assessed%20from%20my%20imported%20Bitget%20activity"
          actionLabel="Ask RIKKU"
        />
      ) : patterns.length === 0 ? (
        <FeatureEmptyState
          title="RIKKU has not collected enough evidence to establish a reliable pattern yet."
          description="No candidate, promising, validated, weakened, or retired pattern has been stored for this workspace."
          actionHref="/ask?prompt=Do%20you%20see%20any%20reliable%20patterns%20in%20my%20imported%20Bitget%20activity"
          actionLabel="Ask RIKKU to investigate"
        />
      ) : (
        <>
          <div className="insight-table" aria-label="Stored patterns">
            {patterns.map((pattern) => <article key={pattern.id}>
              <div>
                <span>{pattern.status.toUpperCase()} · {pattern.type}</span>
                <h3>{pattern.claim}</h3>
                <p>Confidence: {pattern.confidence} · Supporting evidence: {pattern.supportingEvidence} · Counter-evidence: {pattern.counterEvidence}</p>
                <p>Sample size: not recorded · Data window: {formatCoverage(pattern.firstObservedAt, pattern.lastObservedAt)}</p>
              </div>
              <strong>{pattern.status.toUpperCase()}</strong>
            </article>)}
          </div>
          <AskRikkuLink href="/ask?prompt=Investigate%20the%20stored%20RIKKU%20patterns%20and%20their%20counter-evidence">Ask RIKKU about these patterns</AskRikkuLink>
        </>
      )}
    </FeaturePage>
  );
}
