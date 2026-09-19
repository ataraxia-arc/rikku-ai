import Link from "next/link";
import { ArrowRight, BrainCircuit, Database, Sparkles } from "lucide-react";
import { StartBitgetImportButton } from "@/components/start-bitget-import-button";

export type ImportedActivitySummary = {
  orders: number;
  fills: number;
  financialRecords: number;
  instruments: number;
  marketCandles: number;
  completedTrades: number;
  earliestRecordAt: string | null;
  latestRecordAt: string | null;
  lastSyncedAt: string | null;
};

export type LatestValidatedFinding = {
  headline: string;
  summary: string;
  confidence: "low" | "moderate" | "high" | "not_assessable" | null;
  createdAt: string | null;
};

function coverageLabel(earliest: string | null, latest: string | null) {
  if (!earliest || !latest) return "Coverage not reported";
  const start = new Date(earliest);
  const end = new Date(latest);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return "Coverage not reported";
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
  const long = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  return start.getUTCFullYear() === end.getUTCFullYear()
    ? `${short.format(start)} – ${long.format(end)}`
    : `${long.format(start)} – ${long.format(end)}`;
}

export function HomeDashboard({
  importedActivity,
  latestFinding = null,
  workspaceUnavailable = false,
}: {
  importedActivity?: ImportedActivitySummary | null;
  latestFinding?: LatestValidatedFinding | null;
  workspaceUnavailable?: boolean;
}) {
  const hasImport = Boolean(importedActivity);
  return (
    <section className="workspace">
      <header className="topbar">
        <div>
          <p className="date-label">DECISION INTELLIGENCE</p>
          <h1>Your RIKKU workspace</h1>
          <p className="headline-support">{hasImport ? "Your workspace is grounded in your imported Bitget records." : "Your real account evidence will appear here after connection and import."}</p>
        </div>
        <Link className="primary-button" href={hasImport ? "/ask?prompt=Analyze%20my%20imported%20Bitget%20activity" : "/ask"}>Ask RIKKU <span>↗</span></Link>
      </header>

      {hasImport && importedActivity ? (
        <section className="empty-dashboard" aria-label="Imported Bitget activity">
          <span className="empty-dashboard-mark"><Database size={24} /></span>
          <p className="section-kicker">REAL BITGET DATA</p>
          <h2>Your Bitget data is connected.</h2>
          <p>{coverageLabel(importedActivity.earliestRecordAt, importedActivity.latestRecordAt)} coverage. Values below are imported record counts, not estimates.</p>
          <div className="evidence-grid home-import-summary">
            <div><span>ORDERS</span><strong>{importedActivity.orders.toLocaleString()}</strong><p>Imported</p></div>
            <div><span>FILLS</span><strong>{importedActivity.fills.toLocaleString()}</strong><p>Imported</p></div>
            <div><span>FINANCIAL RECORDS</span><strong>{importedActivity.financialRecords.toLocaleString()}</strong><p>Imported</p></div>
            <div><span>INSTRUMENTS</span><strong>{importedActivity.instruments.toLocaleString()}</strong><p>Imported</p></div>
            <div><span>MARKET CANDLES</span><strong>{importedActivity.marketCandles.toLocaleString()}</strong><p>Imported</p></div>
            <div><span>COMPLETED TRADES</span><strong>{importedActivity.completedTrades.toLocaleString()}</strong><p>{importedActivity.completedTrades === 0 ? "Not yet reconstructable" : "Reconstructed"}</p></div>
          </div>
          <div className="home-import-actions">
            <Link className="landing-cta-primary" href="/ask?prompt=Analyze%20my%20imported%20Bitget%20activity">Analyze my activity <ArrowRight size={15} /></Link>
            <StartBitgetImportButton label="Resync Bitget" />
          </div>
          {latestFinding && <div className="source-note" aria-label="Latest validated RIKKU finding"><span>LATEST VALIDATED ANALYSIS{latestFinding.confidence ? ` · ${latestFinding.confidence.toUpperCase()}` : ""}</span><strong>{latestFinding.headline}</strong><p>{latestFinding.summary}</p><Link className="data-window" href="/ask?prompt=Review%20my%20latest%20validated%20RIKKU%20analysis">Ask RIKKU about this analysis</Link></div>}
          <p className="coverage-note">Assets and positions may be empty when Bitget returned none for this read-only sync.</p>
        </section>
      ) : workspaceUnavailable ? (
        <section className="empty-dashboard" aria-label="Workspace data unavailable">
          <span className="empty-dashboard-mark"><Database size={24} /></span>
          <p className="section-kicker">WORKSPACE UNAVAILABLE</p>
          <h2>RIKKU could not read your import status safely.</h2>
          <p>Your connection was not changed. Ask RIKKU can retry the authenticated evidence check without fabricating a dashboard state.</p>
          <Link className="landing-cta-primary" href="/ask">Ask RIKKU <ArrowRight size={15} /></Link>
        </section>
      ) : (
        <section className="empty-dashboard" aria-label="Empty workspace">
          <span className="empty-dashboard-mark"><Database size={24} /></span>
          <p className="section-kicker">NO TRADING DATA YET</p>
          <h2>Connect your history to begin.</h2>
          <p>RIKKU will build this workspace only from your authenticated Bitget data. No sample balances, trades, or findings are shown.</p>
          <Link className="landing-cta-primary" href="/onboarding">Connect Bitget <ArrowRight size={15} /></Link>
        </section>
      )}

      <section className="empty-capabilities">
        <article><Sparkles size={17} /><div><strong>Ask RIKKU</strong><p>Questions grounded in your evidence.</p></div></article>
        <article><BrainCircuit size={17} /><div><strong>Persistent memory</strong><p>Lessons connected to decisions and outcomes.</p></div></article>
        <article><Database size={17} /><div><strong>Source-aware analysis</strong><p>Coverage and confidence stay visible.</p></div></article>
      </section>
    </section>
  );
}
