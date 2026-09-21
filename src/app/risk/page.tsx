import { AskRikkuLink, EvidenceMetrics, FeatureEmptyState, FeaturePage } from "@/components/feature-page";
import { formatCoverage, formatRecordCount } from "@/lib/workspace/presentation";
import { readRiskData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

export default async function RiskPage() {
  const { connection, importSummary, analysis } = await readRiskData();
  const connectionStatus = connection.connected ? connection.lastSyncedAt ?? connection.verifiedAt : null;
  const sourceStatus = importSummary
    ? `${formatRecordCount(importSummary.fills)} fills · ${formatRecordCount(importSummary.marketCandles)} market candles`
    : "No completed Bitget import";

  return (
    <FeaturePage
      active="Risk"
      eyebrow="DOWNSIDE INTELLIGENCE"
      title="Risk"
      description="Only evidence-backed risk information is shown. RIKKU does not manufacture VaR, drawdown, or trade-level loss metrics from incomplete history."
      connectionStatus={connectionStatus}
      sideTitle="Risk limits"
      sideItems={["Completed trades are required for realized-PnL tail analysis.", "Current assets and positions are required for exposure calculations.", "A short import window limits any descriptive finding."]}
      sourceStatus={sourceStatus}
      sourceDescription="Risk values stay unavailable until their required source records can support them."
    >
      {!importSummary ? (
        <FeatureEmptyState
          title="Risk analysis needs a completed Bitget import."
          description="RIKKU has no imported records to assess, so no risk metric or alert is shown."
          actionHref={connection.connected ? "/ask?context=risk" : "/onboarding"}
          actionLabel={connection.connected ? "Ask RIKKU" : "Connect Bitget"}
        />
      ) : (
        <>
          <EvidenceMetrics items={[
            { label: "FILLS OBSERVED", value: formatRecordCount(importSummary.fills), detail: "Descriptive activity only" },
            { label: "MARKET CANDLES", value: formatRecordCount(importSummary.marketCandles), detail: "Imported market context" },
            { label: "COMPLETED TRADES", value: formatRecordCount(importSummary.completedTrades), detail: importSummary.completedTrades === 0 ? "Not yet reconstructable" : "Reconstructed" },
          ]} />
          {analysis && analysis.evidence.length > 0 ? <div className="insight-table" aria-label="Available deterministic risk evidence">
            {analysis.evidence.map((metric) => <article key={metric.label}><div><span>AVAILABLE</span><h3>{metric.label}</h3><p>{metric.value}{metric.detail ? ` · ${metric.detail}` : ""}</p></div><strong>REAL DATA</strong></article>)}
          </div> : null}
          <div className="source-note"><span>TAIL-RISK ANALYSIS</span><strong>{importSummary.completedTrades === 0 ? "Not available because completed trades cannot yet be reconstructed." : "No validated tail-risk result is stored yet."}</strong><p>Coverage: {formatCoverage(importSummary.earliestRecordAt, importSummary.latestRecordAt)}. The current import window is limited and should not be treated as a complete account history.</p></div>
          <div className="source-note"><span>PORTFOLIO EXPOSURE</span><strong>{importSummary.assets === 0 && importSummary.positions === 0 ? "Not available because the connected account returned no current assets or positions." : "Use Portfolio to review the current records Bitget returned."}</strong><p>RIKKU will not estimate holdings or leverage from orders and fills.</p></div>
          <AskRikkuLink href="/ask?context=risk">Ask RIKKU to investigate</AskRikkuLink>
        </>
      )}
    </FeaturePage>
  );
}
