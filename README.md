# RIKKU AI

Trading Memory & Decision Intelligence

> Markets remember prices. RIKKU remembers decisions.

[Live demo](https://rikku-ai.vercel.app/) · [Source code](https://github.com/ataraxia-arc/rikku-ai)

## What RIKKU Does

RIKKU analyzes both the market and the trader using real Bitget trading history. It brings imported orders, fills, fees, portfolio records, and market context into one workspace, then helps traders ask what happened, explore possible explanations, and understand what the evidence cannot establish.

Ask RIKKU is the main experience. Supporting workspaces preserve trading memory, portfolio context, research, risk evidence, and personal rules. Every finding is bounded by the records actually available.

## Core Thesis

RIKKU is an **AI Trading Desk**, not an autonomous trading bot.

- Deterministic tools calculate facts.
- The LLM interprets evidence.
- The Skeptic layer checks unsupported claims and limits confidence.
- The human makes the final decision.

An interpretation is not a measured fact. A hypothesis is not a proven behavior. RIKKU keeps those distinctions visible.

## Main Features

- **Ask RIKKU:** natural-language analysis grounded in imported records and deterministic calculations.
- **Trading Memory:** evidence-linked findings with search, filtering, and detail views.
- **Portfolio context:** actual imported assets and positions, with honest empty states when none are available.
- **Behavioral and pattern analysis:** descriptive activity analysis and a workspace for stored patterns, supporting evidence, and counter-evidence. Limited samples do not become proven behavioral claims.
- **Research workspace:** stored research sources and imported market context, clearly distinguished from each other.
- **Risk analysis:** available deterministic evidence and explicit limits when trade reconstruction or portfolio data is insufficient.
- **Playbook and rules:** user-owned rules that support review and decision discipline.
- **Multi-turn reasoning:** bounded conversation context, alternative explanations, counter-evidence, and uncertainty handling.
- **Deterministic fallback:** verified evidence remains available when external reasoning cannot complete safely.

Some workspaces expose the available evidence and data gaps while their advanced analytics remain on the roadmap.

## Real Validation Data

The following counts were **observed in the connected validation account**, not generated as demo data. They describe one imported window, not all trading history or a result every user will see.

| Imported record | Observed count |
| --- | ---: |
| Orders | 12 |
| Fills | 12 |
| Financial records | 43 |
| Instruments | 5 |
| Market candles | 435 |

**Observed coverage: Jul 8–Aug 4, 2026.**

**0 completed trades were reconstructed** because opening inventory could not be proven from the available window. RIKKU refuses to invent cost basis, PnL, or win rate. Fill-level activity and known fees can still be analyzed without pretending that fills are completed trades.

## Architecture

```text
Plain language question
  → semantic/reasoning layer
  → deterministic RIKKU tools
  → verified evidence
  → LLM reasoning
  → Skeptic validation
  → natural answer
```

The semantic layer interprets the question and selects from a strict read-only tool allowlist. Deterministic code retrieves and calculates the evidence. The LLM receives a bounded evidence package and conversation context; server-side validation checks its structured response before display. Financial metrics remain authoritative only when supplied by RIKKU's deterministic tools.

| Technology | Role |
| --- | --- |
| Next.js / React / TypeScript | Web application and server routes |
| Supabase | Authentication, PostgreSQL persistence, and row-level security |
| Bitget APIs | Read-only account, trading-history, and market-data retrieval |
| Groq · `openai/gpt-oss-120b` | External interpretation and reasoning through the provider abstraction |
| Vercel | Production hosting |
| Vitest / Testing Library / Playwright | Automated verification |

The provider abstraction also retains the existing OpenAI provider and support for configured OpenAI-compatible APIs.

## Security

- Read-only Bitget integration with positive permission verification before credentials are stored.
- No order placement, withdrawals, transfers, cancellations, or leverage changes in the Bitget gateway.
- Credentials are handled server-side; persisted Bitget credentials are encrypted in private storage.
- Supabase row-level security protects user data.
- No secret values in the browser bundle, model prompts, or committed configuration.
- Credential-shaped Ask input is rejected before reasoning or persistence; operational diagnostics redact sensitive values.

The current main-account onboarding uses a one-time read-only API-key connection. Google signs the user into RIKKU; it does not authorize Bitget. This release does not present the manual connection as Bitget OAuth.

## Reliability

- Deterministic fallback when the LLM provider is unavailable, rate-limited, or returns an invalid response.
- Exact imported coverage is shown rather than claiming complete account history.
- Insufficient-data states replace unsupported metrics and conclusions.
- Unknown non-critical API fields are tolerated, while ambiguous permissions fail closed.

**Release validation at application commit `8c06ae1`:** TypeScript, lint, 247 tests, and the production build passed. Production homepage, login, `/home`, `/ask`, and real Bitget data were verified. The latest production reasoning smoke test reached Groq's HTTP 429 daily token quota and safely used deterministic fallback; it did not verify a successful Groq-generated answer on that request.

## Live Demo

[Open RIKKU AI](https://rikku-ai.vercel.app/)

Sign in to access a private workspace. Connecting your own Bitget account requires a read-only key. The public demo does not grant access to another user's validation account or private records.

## Setup

1. Install a Node.js version supported by the pinned Next.js release and the pnpm version declared in [package.json](package.json).
2. Clone this repository and run `pnpm install`.
3. Copy [.env.example](.env.example) to `.env.local` and configure the variables below. Add the preferred Supabase server key variable if it is absent from the template.
4. Apply the SQL files in [supabase/migrations](supabase/migrations) in filename order to your Supabase project. Configure authentication providers and allowed callback URLs for your own local and production origins.
5. Run `pnpm dev` and open [localhost:3000](http://localhost:3000).

Environment variable **names only**:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public Supabase publishable key |
| `NEXT_PUBLIC_SITE_URL` | Public application origin |
| `SUPABASE_SECRET_KEY` | Preferred server-only Supabase key for privileged import operations |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional legacy fallback for the server-only Supabase key |
| `BITGET_CREDENTIAL_ENCRYPTION_KEY` | Server-only encryption key; preserve it to decrypt existing connections |
| `LLM_API_KEY` | Server-only alternative reasoning provider key |
| `LLM_BASE_URL` | Alternative provider's compatible API endpoint |
| `LLM_MODEL` | Alternative provider model identifier |
| `OPENAI_API_KEY` | Optional server-only key for the retained OpenAI provider |

Configure all three `LLM_*` variables together for the alternative provider. Keep `.env.local` ignored by Git. Store production secrets in the hosting provider's environment settings; never use a `NEXT_PUBLIC_` prefix for privileged keys or exchange credentials. Enter Bitget credentials only through the authenticated connection form.

Existing verification commands:

```sh
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run test:e2e
pnpm run build
```

## Known Limitations

- Bitget's accessible history depends on the endpoint, account, and available window; an import is not a guarantee of lifetime history.
- Incomplete opening inventory can prevent completed-trade reconstruction and derived cost-basis, PnL, win-rate, and trade-level risk metrics.
- Groq Free Tier rate limits can temporarily force deterministic fallback.
- Some advanced planned behavioral and risk analytics are not production-complete. Workspaces show available evidence or honest empty states.
- External research sources are not yet configured for the observed validation workspace.
- Validation so far covers a small real dataset; broader user and history coverage is still needed.

## Roadmap

- Broader supported history coverage.
- More behavioral and risk modules.
- External research sources.
- Reality/rToken integration.
- Broader user validation.
