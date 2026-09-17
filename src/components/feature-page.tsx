import Link from "next/link";
import { ArrowRight, CircleDashed, Database, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";

export function FeaturePage({
  active,
  eyebrow,
  title,
  description,
  emptyTitle,
  emptyDescription,
  sideTitle,
  sideItems,
}: {
  active: string;
  eyebrow: string;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  sideTitle: string;
  sideItems: string[];
}) {
  return (
    <AppShell active={active}>
      <section className="workspace feature-workspace">
        <header className="feature-header">
          <div><p className="date-label">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
        </header>

        <section className="feature-grid feature-empty-grid">
          <div className="feature-main-panel feature-empty-panel">
            <span className="feature-empty-icon"><CircleDashed size={23} /></span>
            <p className="section-kicker">AWAITING YOUR DATA</p>
            <h2>{emptyTitle}</h2>
            <p>{emptyDescription}</p>
            <Link className="landing-cta-primary" href="/onboarding">Connect Bitget <ArrowRight size={14} /></Link>
          </div>
          <aside className="feature-side-panel">
            <p className="section-kicker">{sideTitle.toUpperCase()}</p>
            <h2>{sideTitle}</h2>
            <ol>{sideItems.map((item, index) => <li key={item}><span>{String(index + 1).padStart(2, "0")}</span><p>{item}</p></li>)}</ol>
            <div className="source-note"><span>DATA STATUS</span><strong>No imported evidence</strong><p>RIKKU will show only information derived from your connected account.</p></div>
            <div className="empty-security-note"><ShieldCheck size={14} /><span>Read-only connection</span><Database size={14} /><span>Evidence-linked results</span></div>
          </aside>
        </section>
      </section>
    </AppShell>
  );
}
