import Link from "next/link";
import {
  BookOpenText,
  BrainCircuit,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  Home,
  ListChecks,
  MoreHorizontal,
  Settings,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

const navigation = [
  { label: "Home", href: "/home", icon: Home },
  { label: "Ask RIKKU", href: "/ask", icon: Sparkles },
  { label: "Portfolio", href: "/portfolio", icon: BriefcaseBusiness },
  { label: "Memory", href: "/memory", icon: BrainCircuit },
  { label: "Patterns", href: "/patterns", icon: ChartNoAxesCombined },
  { label: "Research", href: "/research", icon: BookOpenText },
  { label: "Risk", href: "/risk", icon: ShieldAlert },
  { label: "Playbook", href: "/playbook", icon: ListChecks },
  { label: "Settings", href: "/settings", icon: Settings },
] as const;

export function AppShell({ active, children }: { active: string; children: React.ReactNode }) {
  return (
    <main className="app-frame">
      <aside className="sidebar">
        <Link className="brand-lockup" href="/home" aria-label="RIKKU AI app home">
          <span className="brand-mark" aria-hidden="true">R</span>
          <div>
            <p className="brand-name">RIKKU</p>
            <p className="brand-ai">AI</p>
          </div>
        </Link>

        <nav className="nav-list" aria-label="Primary navigation">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.label}
                href={item.href}
                className={item.label === active ? "nav-item nav-item-active" : "nav-item"}
              >
                <Icon className="nav-icon" aria-hidden="true" strokeWidth={1.7} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <Link className="connection-state" href="/onboarding/bitget">
            <span className="status-dot" />
            <span>Connect Bitget</span>
          </Link>
          <div className="profile-row">
            <span className="avatar">R</span>
            <div>
              <p>RIKKU User</p>
              <span>Personal workspace</span>
            </div>
            <button type="button" aria-label="Open profile menu"><MoreHorizontal size={17} /></button>
          </div>
        </div>
      </aside>
      {children}
    </main>
  );
}
