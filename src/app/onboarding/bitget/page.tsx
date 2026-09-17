import Link from "next/link";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BitgetConnectForm } from "@/components/bitget-connect-form";
import { requireOnboardingSession } from "@/lib/auth/require-onboarding-session";

export default async function BitgetOnboardingPage() {
  await requireOnboardingSession("/onboarding/bitget");
  return (
    <main className="onboarding-page">
      <header className="onboarding-header">
        <Link className="brand-lockup" href="/"><span className="brand-mark">R</span><div><p className="brand-name">RIKKU</p><p className="brand-ai">AI</p></div></Link>
        <Badge>STEP 2 OF 2</Badge>
      </header>
      <section className="onboarding-content bitget-onboarding-content">
        <div className="onboarding-intro">
          <span className="onboarding-icon"><KeyRound size={22} /></span>
          <p>CONNECT YOUR TRADING HISTORY</p>
          <h1>Bring your Bitget history into RIKKU</h1>
          <span>Connect your existing account once. RIKKU reads the history needed for analysis and cannot take action on your behalf.</span>
        </div>
        <div className="simple-connection-card">
          <div className="exchange-title">
            <span>B</span>
            <div><strong>Bitget</strong><small>Existing main account · Historical analysis</small></div>
            <Badge>READ-ONLY</Badge>
          </div>
          <BitgetConnectForm />
        </div>
        <div className="connection-safety-row">
          <span><ShieldCheck size={14} /> Permission checked before storage</span>
          <span><LockKeyhole size={14} /> Server-side encrypted credentials</span>
        </div>
      </section>
    </main>
  );
}
