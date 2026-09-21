import { AskRikkuLink, EvidenceMetrics, FeatureEmptyState, FeaturePage } from "@/components/feature-page";
import { formatCoverage, formatRecordCount, formatUtcTimestamp } from "@/lib/workspace/presentation";
import { readResearchData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

function safeSourceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export default async function ResearchPage() {
  const { connection, readable, sources } = await readResearchData();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  const importSummary = connection.latestImport;
  const sourceStatus = !readable
    ? "Research data unavailable"
    : `${formatRecordCount(sources.length)} stored research sources`;

  return (
    <FeaturePage
      active="Research"
      eyebrow="SOURCE-AWARE RESEARCH"
      title="Research"
      description="Saved external sources and imported market context, kept separate so RIKKU never presents stored candles as news or a thesis as a fact."
      connectionStatus={connectionStatus}
      sideTitle="Research discipline"
      sideItems={["Sources include their publisher and retrieval time when stored.", "Imported market candles are context, not external research.", "A question can be handed to Ask RIKKU with its data limits intact."]}
      sourceStatus={sourceStatus}
      sourceDescription="RIKKU displays no invented news, publisher, source date, or thesis evidence."
    >
      {!readable ? (
        <FeatureEmptyState
          title="RIKKU could not read research records safely."
          description="No external source or thesis link was changed. Ask RIKKU to review the market context that is available."
          actionHref="/ask?context=research"
          actionLabel="Ask RIKKU"
        />
      ) : sources.length === 0 ? (
        <>
          <FeatureEmptyState
            title="External research sources are not configured yet."
            description="No external research record is stored for this workspace. RIKKU will not fabricate headlines, publishers, or claim that news has been retrieved."
            actionHref="/ask?context=research"
            actionLabel="Ask RIKKU about market context"
          />
          {importSummary && <div className="source-note"><span>IMPORTED MARKET CONTEXT</span><strong>{formatRecordCount(importSummary.marketCandles)} market candles available.</strong><p>Coverage: {formatCoverage(importSummary.earliestRecordAt, importSummary.latestRecordAt)}. Candles are not a substitute for external research sources.</p></div>}
        </>
      ) : (
        <>
          {importSummary && <EvidenceMetrics items={[
            { label: "SOURCES", value: formatRecordCount(sources.length), detail: "Stored research records" },
            { label: "MARKET CANDLES", value: formatRecordCount(importSummary.marketCandles), detail: "Imported market context" },
            { label: "COVERAGE", value: formatCoverage(importSummary.earliestRecordAt, importSummary.latestRecordAt), detail: "Imported Bitget window" },
          ]} />}
          <div className="insight-table" aria-label="Research sources">
            {sources.map((source) => {
              const sourceUrl = safeSourceUrl(source.url);
              return <article key={source.id}>
                <div>
                  <span>{source.publisher ?? "Publisher not recorded"}</span>
                  <h3>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">{source.title}</a> : source.title}</h3>
                  <p>Published: {formatUtcTimestamp(source.publishedAt)} · Retrieved: {formatUtcTimestamp(source.retrievedAt)}{sourceUrl ? "" : " · Source URL is unavailable"}</p>
                  <AskRikkuLink href={`/ask?context=research:${source.id}`}>Ask RIKKU about this source</AskRikkuLink>
                </div>
                <strong>SOURCE</strong>
              </article>;
            })}
          </div>
          <AskRikkuLink href="/ask?context=research">Ask RIKKU about this research</AskRikkuLink>
        </>
      )}
    </FeaturePage>
  );
}
