import { AskRikkuLink, EvidenceMetrics, FeatureEmptyState, FeaturePage } from "@/components/feature-page";
import { formatCoverage, formatRecordCount } from "@/lib/workspace/presentation";
import { readRiskData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

export default async function RiskPage() {
  const { connection, importSummary } = await readRiskData();
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
          actionHref={connection.connected ? "/ask?prompt=What%20risk%20data%20is%20available%20for%20my%20Bitget%20account" : "/onboarding"}
          actionLabel={connection.connected ? "Ask RIKKU" : "Connect Bitget"}
        />
      ) : (
        <>
          <EvidenceMetrics items={[
            { label: "FILLS OBSERVED", value: formatRecordCount(importSummary.fills), detail: "Descriptive activity only" },
            { label: "MARKET CANDLES", value: formatRecordCount(importSummary.marketCandles), detail: "Imported market context" },
            { label: "COMPLETED TRADES", value: formatRecordCount(importSummary.completedTrades), detail: importSummary.completedTrades === 0 ? "Not yet reconstructable" : "Reconstructed" },
          ]} />
          <div className="source-note"><span>TAIL-RISK ANALYSIS</span><strong>{importSummary.completedTrades === 0 ? "Not available because completed trades cannot yet be reconstructed." : "No validated tail-risk result is stored yet."}</strong><p>Coverage: {formatCoverage(importSummary.earliestRecordAt, importSummary.latestRecordAt)}. The current import window is limited and should not be treated as a complete account history.</p></div>
          <div className="source-note"><span>PORTFOLIO EXPOSURE</span><strong>{importSummary.assets === 0 && importSummary.positions === 0 ? "Not available because the connected account returned no current assets or positions." : "Use Portfolio to review the current records Bitget returned."}</strong><p>RIKKU will not estimate holdings or leverage from orders and fills.</p></div>
          <AskRikkuLink href="/ask?prompt=Investigate%20my%20current%20risks%20using%20only%20available%20Bitget%20data">Investigate this risk evidence</AskRikkuLink>
        </>
      )}
    </FeaturePage>
  );
}
