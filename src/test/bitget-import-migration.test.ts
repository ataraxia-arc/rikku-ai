import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve("supabase/migrations/202609150003_bitget_import.sql"),
  "utf8",
).toLowerCase();

describe("Bitget import migration security", () => {
  it("binds jobs to verified connections owned by auth.uid()", () => {
    expect(sql).toContain("add constraint import_jobs_owned_connection_fk");
    expect(sql).toContain("foreign key (connection_id, user_id)");
    expect(sql).toContain("references private.bitget_connections (id, user_id)");
    expect(sql).toContain("current_user_id uuid := auth.uid()");
    expect(sql).toContain("where c.user_id = current_user_id");
    expect(sql).toContain("and c.revoked_at is null");
    expect(sql).toContain("and c.verified_at is not null");
    expect(sql).toContain("and c.read_only_attested_at is not null");
    expect(sql).toContain("raise exception 'verified bitget connection required'");
  });

  it("prevents duplicate active jobs and duplicate reconstructed records", () => {
    expect(sql).toContain("create unique index bitget_one_active_import_per_user_idx");
    expect(sql).toContain("status in ('queued', 'running')");
    expect(sql).toContain("for update");
    expect(sql).toContain("create unique index trades_reconstruction_key_idx");
    expect(sql).toContain("create unique index positions_account_instrument_side_idx");
    expect(sql).toContain("create unique index analysis_result_input_fingerprint_idx");
  });

  it("keeps worker leases private and fences expired workers from writing", () => {
    expect(sql).toContain("create table private.bitget_import_leases");
    expect(sql).toContain("alter table private.bitget_import_leases enable row level security");
    expect(sql).toContain("revoke all on private.bitget_import_leases from public, anon, authenticated");
    expect(sql).toContain("where lease.lease_expires_at <= now()");
    expect(sql).toContain("active_lease.lease_token is distinct from p_lease_token");
    expect(sql).toContain("active_lease.lease_expires_at <= now()");
  });

  it("returns only safe connection metadata to authenticated callers", () => {
    expect(sql).toContain("create function public.get_verified_bitget_connection_status()");
    expect(sql).toContain("connected boolean");
    expect(sql).toContain("verified boolean");
    expect(sql).toContain("connection_id uuid");
    expect(sql).toContain("grant execute on function public.get_verified_bitget_connection_status() to authenticated");
    const publicStatus = sql.split("create function public.get_verified_bitget_connection_status()")[1]
      .split("create function public.start_or_resume_bitget_import()")[0];
    expect(publicStatus).not.toContain("credential_ciphertext");
    expect(sql).toContain("grant execute on function public.get_bitget_import_connection(uuid, uuid) to service_role");
    expect(sql).not.toContain("grant execute on function public.get_bitget_import_connection(uuid, uuid) to authenticated");
  });

  it("restricts progress updates to the service role and allowlisted public fields", () => {
    expect(sql).toContain("create function public.update_bitget_import_job(");
    expect(sql).toContain("from jsonb_each(coalesce(p_progress, '{}'::jsonb)) e");
    expect(sql).toContain("'ordersimported', 'fillsimported', 'tradesreconstructed'");
    expect(sql).toContain("'analysisstatus'");
    expect(sql).toContain("'analysissamplesize'");
    expect(sql).toContain("grant execute on function public.claim_bitget_import_job(uuid) to service_role");
    expect(sql).toContain("grant execute on function public.heartbeat_bitget_import_job(uuid, uuid) to service_role");
    expect(sql).toContain("grant execute on function public.update_bitget_import_job(uuid, uuid, text, text, jsonb, text, timestamptz) to service_role");
    expect(sql).not.toContain("grant execute on function public.update_bitget_import_job(uuid, uuid, text, text, jsonb, text, timestamptz) to authenticated");
    expect(sql).toContain("revoke all on function public.update_bitget_import_job(uuid, uuid, text, text, jsonb, text, timestamptz) from public, anon, authenticated");
    expect(sql).toContain("revoke all on function public.get_bitget_import_connection(uuid, uuid) from public, anon, authenticated");
  });
});
