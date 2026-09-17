import Link from "next/link";
import {
  ArrowRight,
  BrainCircuit,
  Check,
  Database,
  Fingerprint,
  Gauge,
  History,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";

const capabilities = [
  { icon: Fingerprint, title: "Behavioral Analysis", copy: "See recurring choices, timing, and execution habits." },
  { icon: BrainCircuit, title: "Trading Memory", copy: "Keep durable lessons connected to their evidence." },
  { icon: History, title: "Historical Scenario Retrieval", copy: "Bring relevant past situations into the current review." },
  { icon: Radar, title: "Market Regime Analysis", copy: "Place decisions inside volatility and market structure." },
  { icon: ShieldCheck, title: "Tail Risk", copy: "Keep concentrated downside visible before averages hide it." },
  { icon: Search, title: "Skeptic Engine", copy: "Challenge weak patterns, small samples, and easy narratives." },
];

const memoryFlow = ["Trade", "Context", "Decision", "Outcome", "Pattern", "Memory", "Better Review"];

const frameworks = [
  "Market context",
  "Volatility",
  "Regime",
  "Historical scenarios",
  "Behavioral patterns",
  "Decision memory",
  "Risk concentration",
  "Tail risk",
  "Confidence calibration",
  "Thesis tracking",
  "Personal rules",
  "Counter-evidence",
  "Fee-aware outcomes",
  "Source quality",
  "Skeptic checks",
];

export function PublicLanding({ authenticated = false }: { authenticated?: boolean }) {
  return (
    <main className="landing-page">
      <nav className="landing-nav" aria-label="Public navigation">
        <Link className="brand-lockup landing-brand" href="/" aria-label="RIKKU AI">
          <span className="brand-mark" aria-hidden="true">R</span>
          <div><p className="brand-name">RIKKU</p><p className="brand-ai">AI</p></div>
        </Link>
        <div className="landing-nav-links">
          <a href="#product">Product</a>
          <a href="#how-it-works">How It Works</a>
          <a href="#intelligence">Intelligence</a>
          <a href="#security">Security</a>
        </div>
        <div className="landing-nav-actions">
          {authenticated ? (
            <Link className="landing-primary-nav" href="/home">Open App <ArrowRight size={14} /></Link>
          ) : (
            <>
              <Link className="landing-login" href="/login">Log in</Link>
              <Link className="landing-primary-nav" href="/signup">Get Started <ArrowRight size={14} /></Link>
            </>
          )}
        </div>
      </nav>

      <section className="landing-hero" id="product">
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-copy">
          <p className="landing-eyebrow"><span /> TRADING MEMORY &amp; DECISION INTELLIGENCE</p>
          <h1>RIKKU analyzes<br />the market<br /><em>and you.</em></h1>
          <p className="hero-support">RIKKU combines your real trading history, market context, behavioral patterns, risk, and persistent memory to help you understand how you make decisions—not just what the market is doing.</p>
          <div className="hero-actions">
            <Link className="landing-cta-primary" href={authenticated ? "/home" : "/signup"}>
              {authenticated ? "Open App" : "Get Started Free"} <ArrowRight size={16} />
            </Link>
            <a className="landing-cta-secondary" href="#how-it-works">See How RIKKU Works</a>
          </div>
          <div className="hero-trust"><span><Check size={12} /> Read-only</span><span><Check size={12} /> Evidence-linked</span><span><Check size={12} /> Human controlled</span></div>
        </div>

        <div className="concept-preview" aria-label="Conceptual preview of Ask RIKKU">
          <div className="preview-topbar"><span><Sparkles size={14} /> ASK RIKKU</span><small>ANALYST</small></div>
          <div className="preview-question">How did I behave in similar volatility?</div>
          <div className="preview-analysis">
            <div className="preview-analysis-head"><span className="preview-rikku-mark">R</span><div><strong>Decision review</strong><small>Connecting market context to memory</small></div></div>
            <div className="preview-lines"><i /><i /><i /></div>
            <div className="preview-signals">
              <span><Database size={13} /> Evidence</span>
              <span><BrainCircuit size={13} /> Memory</span>
              <span><Gauge size={13} /> Confidence</span>
            </div>
          </div>
          <div className="preview-context"><span>MARKET CONTEXT</span><span>BEHAVIOR</span><span>RISK</span></div>
        </div>
      </section>

      <section className="landing-dual section-shell">
        <p className="section-index">01 · TWO SIDES OF THE SAME DECISION</p>
        <h2>It analyzes the market.<br /><span>It learns from your decisions.</span></h2>
        <div className="intelligence-dual">
          <article>
            <div className="dual-heading"><Radar size={20} /><p>MARKET INTELLIGENCE</p></div>
            <p>Context around the decision—volatility, regime, historical scenarios, risk, and source-aware research.</p>
            <div className="dual-tags"><span>Market context</span><span>Volatility</span><span>Regime</span><span>Historical scenarios</span><span>Risk</span><span>Research</span></div>
          </article>
          <article>
            <div className="dual-heading"><Fingerprint size={20} /><p>TRADER INTELLIGENCE</p></div>
            <p>Context inside the decision—behavior, recurring mistakes, memory, history, personal rules, and calibrated confidence.</p>
            <div className="dual-tags"><span>Behavioral patterns</span><span>Recurring mistakes</span><span>Trading memory</span><span>Decision history</span><span>Personal rules</span><span>Confidence</span></div>
          </article>
        </div>
      </section>

      <section className="memory-section section-shell">
        <div className="memory-copy">
          <p className="section-index">02 · RIKKU MEMORY</p>
          <h2>Your trading history should teach you something.</h2>
          <p>RIKKU builds persistent memory from your trades, market context, behaviors, decisions, outcomes, patterns, theses, and personal rules.</p>
        </div>
        <div className="memory-flow" aria-label="RIKKU memory flow">
          {memoryFlow.map((item, index) => (
            <div key={item}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item}</strong>{index < memoryFlow.length - 1 && <ArrowRight size={13} />}</div>
          ))}
        </div>
      </section>

      <section className="capabilities-section section-shell" id="intelligence">
        <div className="section-split-heading">
          <div><p className="section-index">03 · INTELLIGENCE</p><h2>Built to investigate,<br />not just summarize.</h2></div>
          <p>RIKKU connects evidence across the market and your own history, while keeping uncertainty visible.</p>
        </div>
        <div className="capability-list">
          {capabilities.map(({ icon: Icon, title, copy }, index) => (
            <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><Icon size={19} /><div><h3>{title}</h3><p>{copy}</p></div><ArrowRight size={14} /></article>
          ))}
        </div>
        <details className="framework-disclosure">
          <summary><span>15 analytical frameworks working underneath RIKKU</span><small>Explore the system</small></summary>
          <div>{frameworks.map((framework) => <span key={framework}>{framework}</span>)}</div>
        </details>
      </section>

      <section className="reasoning-section section-shell">
        <div><p className="section-index">04 · REASONING MODES</p><h2>Match the depth<br />to the decision.</h2></div>
        <div className="mode-rows">
          <article><span><Zap size={18} /></span><p>SCOUT</p><h3>Quick focused analysis.</h3><small>For a precise question that needs a rapid check.</small></article>
          <article className="mode-default"><span><BrainCircuit size={18} /></span><p>ANALYST · DEFAULT</p><h3>Balanced market + behavioral investigation.</h3><small>For everyday decisions that need context and evidence.</small></article>
          <article><span><Search size={18} /></span><p>INVESTIGATOR</p><h3>Deep multi-step research and evidence checking.</h3><small>For complex questions where the cost of being wrong is higher.</small></article>
        </div>
      </section>

      <section className="how-section section-shell" id="how-it-works">
        <div className="section-split-heading">
          <div><p className="section-index">05 · HOW IT WORKS</p><h2>From account<br />to intelligence.</h2></div>
          <p>Three clear steps. Your exchange remains under your control.</p>
        </div>
        <ol className="how-steps">
          <li><span>01</span><div><h3>Create your RIKKU account</h3><p>Use Google or email authentication to enter your private RIKKU workspace.</p></div></li>
          <li><span>02</span><div><h3>Connect Bitget read-only</h3><p>RIKKU may read supported account and trading information. It cannot trade, withdraw, transfer funds, or change leverage.</p></div></li>
          <li><span>03</span><div><h3>Ask RIKKU</h3><p>Investigate your real trading history, market context, behavior, memory, and risk.</p></div></li>
        </ol>
      </section>

      <section className="security-section section-shell" id="security">
        <div className="security-statement">
          <p className="section-index">06 · SECURITY</p>
          <h2>Your account<br /><span>stays yours.</span></h2>
          <p>RIKKU is an analytical system. It is not an autonomous trader and it never receives methods that can move your money.</p>
        </div>
        <div className="security-list">
          {["Read-only Bitget access", "Server-side credentials", "Encrypted storage", "No trading methods", "No withdrawals", "No transfers", "Human keeps final control"].map((item) => (
            <div key={item}><ShieldCheck size={15} /><span>{item}</span></div>
          ))}
        </div>
      </section>

      <section className="landing-final">
        <span className="final-orbit" aria-hidden="true"><Sparkles size={20} /></span>
        <h2>Turn trading history into<br /><em>decision intelligence.</em></h2>
        <div className="hero-actions">
          <Link className="landing-cta-primary" href={authenticated ? "/home" : "/signup"}>{authenticated ? "Open App" : "Get Started Free"} <ArrowRight size={16} /></Link>
          {!authenticated && <Link className="landing-cta-secondary" href="/login">Log in</Link>}
        </div>
      </section>

      <footer className="landing-footer">
        <Link className="brand-lockup landing-brand" href="/"><span className="brand-mark">R</span><div><p className="brand-name">RIKKU</p><p className="brand-ai">AI</p></div></Link>
        <p>Trading Memory &amp; Decision Intelligence</p>
        <span>ANALYSIS, NOT FINANCIAL ADVICE</span>
      </footer>
    </main>
  );
}
