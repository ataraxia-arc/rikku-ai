# RIKKU AI

RIKKU AI is a personal trading-memory and decision-intelligence workspace. It is designed to connect read-only exchange history with market context, surface recurring behavior, and answer questions with evidence, uncertainty, and risk context.

## Current build

Current implementation includes:

- Premium responsive dashboard and Ask RIKKU experience
- Portfolio, memory, patterns, research, risk, playbook, and settings routes
- Supabase-ready email/password and Google authentication
- A navigable Bitget onboarding flow with an advanced, read-only main-account API connection
- PostgreSQL schema with row-level security, private credential storage, and Bitget import infrastructure
- Server-side read-only Bitget import routes, normalizers, trade reconstruction, and import-status UI
- Unit, security, type, lint, and production-build validation

No sample account balances, trades, or findings are shown as real data. No exchange credentials or real trading information are included in this repository.

## Bitget connection

`/onboarding/bitget` links to `/onboarding/bitget/connect`. The setup page explains the one-time read-only main-account connection and keeps credential entry in **Advanced connection**. The connection API verifies read-only permissions before encrypting and storing credentials. Missing authentication or encryption configuration returns a visible error.

Bitget Agentic OAuth is not used for this web onboarding: its official flow authorizes a separate Agentic account, not the user's normal main account or its prior trade history. The official MCP is local to an AI client and does not provide a documented multi-user web-app callback. Do not label this manual connection as OAuth or claim historical imports have run before they have.

## Technology

- Next.js 16, React 19, and TypeScript
- Tailwind CSS and reusable shadcn-style UI primitives
- Supabase Auth, PostgreSQL, Row Level Security, and pgvector
- Vitest, Testing Library, and Playwright
- Vercel deployment target

## Local setup

1. Copy `.env.example` to `.env.local` and add the Supabase values.
2. Install dependencies with `pnpm install`.
3. Start the app with `pnpm dev`.
4. Open `http://localhost:3000`.

## Validation

```text
pnpm run typecheck
pnpm run test
pnpm run test:e2e
pnpm run lint
pnpm run build
```

Database migrations are in `supabase/migrations/`, including the initial schema, connection RPCs, and import infrastructure. The first real-data import has not run; it requires a server-only Supabase key. Do not commit that key or other credentials.

## Security posture

Exchange access is read-only by design. Browser-facing database access is restricted by Row Level Security. Exchange secrets are reserved for an inaccessible private schema and must be encrypted before storage. RIKKU AI never places trades and never promises profit.
