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
});
