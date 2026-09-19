import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, CircleDashed, Database, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";

type FeaturePageProps = {
  active: string;
  eyebrow: string;
  title: string;
  description: string;
  connectionStatus?: string | null;
  sideTitle: string;
  sideItems: string[];
  sourceStatus: string;
  sourceDescription: string;
  children: ReactNode;
};

export function FeaturePage({
  active,
  eyebrow,
  title,
  description,
  connectionStatus = null,
  sideTitle,
  sideItems,
  sourceStatus,
  sourceDescription,
  children,
}: FeaturePageProps) {
  return (
    <AppShell active={active} connectionStatus={connectionStatus}>
      <section className="workspace feature-workspace">
        <header className="feature-header">
          <div><p className="date-label">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
        </header>

        <section className="feature-grid feature-empty-grid">
          <div className="feature-main-panel">{children}</div>
          <aside className="feature-side-panel">
            <p className="section-kicker">{sideTitle.toUpperCase()}</p>
            <h2>{sideTitle}</h2>
            <ol>{sideItems.map((item, index) => <li key={item}><span>{String(index + 1).padStart(2, "0")}</span><p>{item}</p></li>)}</ol>
            <div className="source-note"><span>DATA STATUS</span><strong>{sourceStatus}</strong><p>{sourceDescription}</p></div>
            <div className="empty-security-note"><ShieldCheck size={14} /><span>Read-only access only</span><Database size={14} /><span>Evidence-linked results</span></div>
          </aside>
        </section>
      </section>
    </AppShell>
  );
}

export function FeatureEmptyState({
  title,
  description,
  actionHref,
  actionLabel,
}: {
  title: string;
  description: string;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <div className="feature-empty-panel">
      <span className="feature-empty-icon"><CircleDashed size={23} /></span>
      <p className="section-kicker">EVIDENCE-LIMITED</p>
      <h2>{title}</h2>
      <p>{description}</p>
      <Link className="landing-cta-primary" href={actionHref}>{actionLabel} <ArrowRight size={14} /></Link>
    </div>
  );
}

export function AskRikkuLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link className="landing-cta-primary" href={href}>{children} <ArrowRight size={14} /></Link>;
}

export function EvidenceMetrics({ items }: { items: Array<{ label: string; value: string | number; detail: string }> }) {
  return (
    <div className="evidence-grid" aria-label="Evidence summary">
      {items.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong><p>{item.detail}</p></div>)}
    </div>
  );
}
