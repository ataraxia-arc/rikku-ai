import { AskRikkuLink, FeatureEmptyState, FeaturePage } from "@/components/feature-page";
import { formatRecordCount, formatUtcTimestamp } from "@/lib/workspace/presentation";
import { readPortfolioData } from "@/lib/workspace/read-workspace-data";

export const dynamic = "force-dynamic";

function connectionStatus(connected: boolean, lastSyncedAt: string | null, verifiedAt: string | null) {
  return connected ? lastSyncedAt ?? verifiedAt : null;
}

export default async function PortfolioPage() {
  const { connection, readable, assets, positions } = await readPortfolioData();
  const status = connectionStatus(connection.connected, connection.lastSyncedAt, connection.verifiedAt);
  const sourceStatus = !readable
    ? "Portfolio data unavailable"
    : connection.latestImport
      ? `Imported Bitget records · ${formatRecordCount(assets.length)} assets · ${formatRecordCount(positions.length)} positions`
      : "No completed Bitget import";

  return (
    <FeaturePage
      active="Portfolio"
      eyebrow="PORTFOLIO INTELLIGENCE"
      title="Portfolio"
      description="Current assets and positions reported by your read-only Bitget connection. RIKKU does not estimate missing values or invent allocations."
      connectionStatus={status}
      sideTitle="Portfolio evidence"
      sideItems={["Balances are shown only when Bitget returned them.", "Positions are current observations, not trade-history estimates.", "Ask RIKKU for analysis when enough source data exists."]}
      sourceStatus={sourceStatus}
      sourceDescription="No allocation, account value, or exposure chart is shown unless the connected account returned the underlying values."
    >
      {!readable ? (
        <FeatureEmptyState
          title="RIKKU could not read portfolio data safely."
          description="The connection was not changed. Try again from Ask RIKKU after confirming the imported data is available."
          actionHref="/ask?context=portfolio"
          actionLabel="Ask RIKKU"
        />
      ) : assets.length === 0 && positions.length === 0 ? (
        <FeatureEmptyState
          title="No current assets were returned by the connected Bitget account."
          description={`No current positions were returned either. Historical import evidence still includes ${connection.latestImport?.instruments ?? 0} observed instruments. RIKKU will not fabricate allocation, exposure, or account value.`}
          actionHref="/ask?context=portfolio"
          actionLabel="Ask RIKKU about available data"
        />
      ) : (
        <>
          <div className="compact-metrics">
            <article><span>ASSETS</span><strong>{formatRecordCount(assets.length)}</strong><p>Current records returned</p></article>
            <article><span>POSITIONS</span><strong>{formatRecordCount(positions.length)}</strong><p>Current records returned</p></article>
            <article><span>VALUATION</span><strong>Not calculated</strong><p>No synthetic account total</p></article>
          </div>
          {assets.length > 0 && <section className="insight-table" aria-label="Current assets">
            <p className="section-kicker">CURRENT ASSETS</p>
            {assets.map((asset) => <article key={`${asset.coin}-${asset.observedAt ?? "current"}`}>
              <div><span>{asset.coin}</span><h3>{asset.equity ?? asset.balance ?? "Value not reported"}</h3><p>Available: {asset.available ?? "not reported"} · Observed {formatUtcTimestamp(asset.observedAt)}</p></div>
              <strong>BITGET</strong>
            </article>)}
          </section>}
          {positions.length > 0 && <section className="insight-table" aria-label="Current positions">
            <p className="section-kicker">CURRENT POSITIONS</p>
            {positions.map((position) => <article key={`${position.category}-${position.symbol}-${position.side}`}>
              <div><span>{position.category} · {position.side}</span><h3>{position.symbol} · {position.quantity}</h3><p>Entry: {position.entryPrice ?? "not reported"} · Mark: {position.markPrice ?? "not reported"} · Observed {formatUtcTimestamp(position.observedAt)}</p></div>
              <strong>CURRENT</strong>
            </article>)}
          </section>}
          <div className="source-note"><span>NO SYNTHETIC PORTFOLIO METRICS</span><strong>Allocation and risk contribution remain unavailable.</strong><p>RIKKU needs a complete, valuated asset and position set before calculating them.</p></div>
          <AskRikkuLink href="/ask?context=portfolio">Ask RIKKU about my portfolio</AskRikkuLink>
        </>
      )}
    </FeaturePage>
  );
}
