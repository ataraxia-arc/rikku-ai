import Link from "next/link";
import { ArrowRight, BrainCircuit, Database, Sparkles } from "lucide-react";

export function HomeDashboard() {
  return (
    <section className="workspace">
      <header className="topbar">
        <div>
          <p className="date-label">DECISION INTELLIGENCE</p>
          <h1>Your RIKKU workspace</h1>
          <p className="headline-support">Your real account evidence will appear here after connection and import.</p>
        </div>
        <Link className="primary-button" href="/ask">Ask RIKKU <span>↗</span></Link>
      </header>

      <section className="empty-dashboard" aria-label="Empty workspace">
        <span className="empty-dashboard-mark"><Database size={24} /></span>
        <p className="section-kicker">NO TRADING DATA YET</p>
        <h2>Connect your history to begin.</h2>
        <p>RIKKU will build this workspace only from your authenticated Bitget data. No sample balances, trades, or findings are shown.</p>
        <Link className="landing-cta-primary" href="/onboarding">Connect Bitget <ArrowRight size={15} /></Link>
      </section>

      <section className="empty-capabilities">
        <article><Sparkles size={17} /><div><strong>Ask RIKKU</strong><p>Questions grounded in your evidence.</p></div></article>
        <article><BrainCircuit size={17} /><div><strong>Persistent memory</strong><p>Lessons connected to decisions and outcomes.</p></div></article>
        <article><Database size={17} /><div><strong>Source-aware analysis</strong><p>Coverage and confidence stay visible.</p></div></article>
      </section>
    </section>
  );
}
