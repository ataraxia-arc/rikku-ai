import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve("supabase/migrations/202609150001_initial_schema.sql"),
  "utf8",
).toLowerCase();
const connectionMigration = readFileSync(
  resolve("supabase/migrations/202609150002_bitget_connection_rpcs.sql"),
  "utf8",
).toLowerCase();
const askRoute = readFileSync(resolve("src/app/api/ask/route.ts"), "utf8");
const openAiReasoner = readFileSync(resolve("src/lib/ask/openai-reasoner.ts"), "utf8");
const reasoningProvider = readFileSync(resolve("src/lib/ask/reasoning-provider.ts"), "utf8");

describe("initial database migration security", () => {
  it("keeps exchange credentials outside the public schema", () => {
    expect(migration).toContain("create schema if not exists private");
    expect(migration).toContain("create table private.bitget_connections");
    expect(migration).toContain(
      "revoke all on schema private from anon, authenticated",
    );
    expect(migration).toContain(
      "revoke all on all tables in schema private from anon, authenticated",
    );
  });

  it("enables row-level security and limits browser access to reads", () => {
    expect(migration).toContain(
      "alter table private.bitget_connections enable row level security",
    );
    expect(migration).toContain(
      "execute format('alter table public.%i enable row level security'",
    );
    expect(migration).toContain("revoke all on all tables in schema public from anon");
    expect(migration).toContain(
      "grant select on all tables in schema public to authenticated",
    );
  });

  it("exposes only user-scoped connection operations", () => {
    expect(connectionMigration).toContain("security definer");
    expect(connectionMigration).toContain("current_user_id uuid := auth.uid()");
    expect(connectionMigration).toContain(
      "grant execute on function public.upsert_bitget_connection",
    );
    expect(connectionMigration).toContain(
      "grant execute on function public.revoke_bitget_connection() to authenticated",
    );
    expect(connectionMigration).toContain(
      "revoke all on function public.upsert_bitget_connection",
    );
  });

  it("keeps conversation retrieval user-scoped and reasoning credentials server-only", () => {
    expect(askRoute).toContain('.eq("user_id", userId)');
    expect(askRoute).toContain('.contains("evidence_map", { threadId })');
    expect(openAiReasoner).toContain('import "server-only"');
    expect(reasoningProvider).toContain('import "server-only"');
    expect(reasoningProvider).toContain('value(env, "OPENAI_API_KEY")');
    expect(reasoningProvider).toContain('value(env, "LLM_API_KEY")');
    expect(reasoningProvider).toContain('value(env, "LLM_BASE_URL")');
    expect(reasoningProvider).toContain('value(env, "LLM_MODEL")');
    expect(reasoningProvider).not.toContain("NEXT_PUBLIC_OPENAI");
    expect(reasoningProvider).not.toContain("NEXT_PUBLIC_LLM");
  });
});
