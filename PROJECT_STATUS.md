# RIKKU AI Project Status

## COMPLETED

- Ask RIKKU now uses a server-only reasoning-provider abstraction over authoritative deterministic evidence, with official OpenAI Responses and custom OpenAI-compatible Chat Completions providers.
- Groq is configured locally through the provider abstraction with `openai/gpt-oss-120b`; JSON output is parsed, normalized, and validated by RIKKU before display.
- The authenticated six-turn live acceptance conversation passed against the real imported Bitget dataset. Every response used Groq, follow-ups retained context, and deterministic fallback was not used.
- Scout, Analyst, and Investigator map to the required GPT-5.6 models, reasoning levels, and bounded tool budgets.
- Ask threads persist per authenticated user, include only five recent exchanges, and perform one bounded anti-repetition retry.
- Memory search/filter/sort/detail, structured page-to-Ask context, AI preferences, and user-owned Playbook CRUD are implemented.
- Home and supporting workspace routes use real records or explicit honest empty states; no demo portfolio or trading metrics remain.
- Bitget verification remains read-only, encrypted server-side, and rejects unsafe permission modes.
- Browser responses omit Bitget account identifiers and API-key fingerprints.

## CURRENT STATE

- The complete release-health gate passes; this document records the GitHub checkpoint state.
- The Groq key, base URL, and model are present only in ignored local configuration and are detected server-side. The browser and tracked-source secret scans pass.

## NEXT EXACT TASK

1. Link this checkout to the existing Vercel project.
2. Configure `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` as server-only Vercel environment variables.
3. Deploy the committed checkpoint and run the same authenticated production smoke conversation.

## BLOCKERS

- This checkout has no local `.vercel/project.json`, so the target Vercel project is not yet safely resolved.
- The server-only Groq configuration has not yet been added to Vercel; production reasoning must retain its deterministic fallback until that is done.

## LAST TEST RESULTS

- TypeScript: passed (`pnpm run typecheck`).
- Lint: passed (`pnpm run lint`).
- Unit/integration tests: 27 files, 193 tests passed (`pnpm test`).
- Browser smoke tests: 8 passed across desktop and mobile (`pnpm run test:e2e`).
- Production build: passed (`pnpm run build`).

## IMPORTANT SECURITY NOTES

- `.env.local` is ignored and must remain untracked.
- Bitget API credentials are encrypted server-side and never returned to the browser.
- Ask RIKKU rejects credential-shaped input before model or persistence. Per-user thread questions are stored for follow-up context; generated response blobs omit the duplicated question.
- A selected reasoning provider receives only bounded questions, recent conclusion summaries, structured context, and credential-free deterministic evidence. The official OpenAI provider uses `store: false`; Groq/custom OpenAI-compatible output is parsed, normalized, stripped of unsupported claims, and validated locally before display.
- The local provider key is absent from tracked files and the compiled browser bundle.
- Do not log, commit, transmit, or regenerate Supabase, Bitget, or encryption credentials.

## REAL DATA STATUS

- Verified read-only Bitget connection is present locally.
- Current imported coverage: Jul 8 – Aug 4, 2026.
- Imported records: 12 orders, 12 fills, 43 financial records, 5 instruments, and 435 market candles.
- Completed trades are not yet reconstructable because opening inventory before the import window is unknown.

## DEPLOYMENT STATUS

- Not deployed from this functional pass. Local live verification and release gates are complete; Vercel linking and server-only `LLM_*` configuration remain before deployment.
