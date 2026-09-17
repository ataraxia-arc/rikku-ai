import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { signInWithGoogle, signInWithPassword, signUpWithPassword } from "@/app/login/actions";

export function AuthPanel({ mode, message, next }: { mode: "login" | "signup"; message?: string; next?: string }) {
  const signup = mode === "signup";
  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Link className="brand-lockup" href="/"><span className="brand-mark">R</span><div><p className="brand-name">RIKKU</p><p className="brand-ai">AI</p></div></Link>
        <div className="auth-statement"><p>MARKETS REMEMBER PRICES.</p><h1>RIKKU remembers<br />decisions.</h1><span>Trading Memory &amp; Decision Intelligence</span></div>
        <div className="auth-principle"><LockKeyhole size={15} /><p>Read-only by design. RIKKU analyzes your history and cannot place trades or move funds.</p></div>
      </section>
      <section className="auth-form-panel">
        <div className="auth-form-wrap">
          <span className="auth-step">RIKKU ACCOUNT · STEP 1 OF 2</span>
          <h2>{signup ? "Create your account" : "Welcome back"}</h2>
          <p>{signup ? "Start building a private memory of your trading decisions." : "Continue to your decision intelligence workspace."}</p>
          {message && <div className="auth-notice" role="status">{message}</div>}
          <form action={signInWithGoogle}>{!signup && <input type="hidden" name="next" value={next} />}<Button type="submit" variant="outline" className="w-full"><span className="google-mark">G</span> Continue with Google</Button></form>
          <p className="google-auth-note">Google signs you into RIKKU only. Bitget is connected separately.</p>
          <div className="auth-divider"><span>or continue with email</span></div>
          <form action={signup ? signUpWithPassword : signInWithPassword} className="auth-fields">
            {!signup && <input type="hidden" name="next" value={next} />}
            <label htmlFor="email">Email</label><Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
            <label htmlFor="password">Password</label><Input id="password" name="password" type="password" autoComplete={signup ? "new-password" : "current-password"} required minLength={8} placeholder="At least 8 characters" />
            <Button type="submit" className="mt-2 w-full">{signup ? "Create account" : "Sign in"}</Button>
          </form>
          <p className="auth-switch">{signup ? "Already have an account?" : "New to RIKKU?"} <Link href={signup ? "/login" : "/signup"}>{signup ? "Sign in" : "Create an account"}</Link></p>
          <p className="auth-legal">By continuing, you agree that RIKKU is an analytical tool—not financial advice or an autonomous trading system.</p>
        </div>
      </section>
    </main>
  );
}
