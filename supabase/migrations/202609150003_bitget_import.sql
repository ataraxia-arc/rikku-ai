begin;

-- A job belongs to the exact encrypted connection used by its worker.
alter table public.import_jobs
  add column connection_id uuid;

create unique index bitget_connections_id_user_idx
  on private.bitget_connections (id, user_id);

alter table public.import_jobs
  add constraint import_jobs_owned_connection_fk
  foreign key (connection_id, user_id)
  references private.bitget_connections (id, user_id) on delete cascade;

alter table public.import_jobs
  add column updated_at timestamptz not null default now();

create unique index bitget_one_active_import_per_user_idx
  on public.import_jobs (user_id, job_type)
  where job_type = 'bitget_initial' and status in ('queued', 'running');

create index bitget_import_jobs_user_requested_idx
  on public.import_jobs (user_id, requested_at desc);

-- Lease tokens are write capabilities and therefore never live in a public
-- table or browser-readable progress payload.
create table private.bitget_import_leases (
  job_id uuid primary key references public.import_jobs(id) on delete cascade,
  lease_token uuid not null,
  claimed_at timestamptz not null,
  heartbeat_at timestamptz not null,
  lease_expires_at timestamptz not null
);

alter table private.bitget_import_leases enable row level security;
revoke all on private.bitget_import_leases from public, anon, authenticated;
grant all on private.bitget_import_leases to service_role;

-- Existing exchange IDs already make orders, fills, assets, financial records,
-- and market candles retry-safe. These keys cover the two remaining mutable
-- collections the initial importer writes.
alter table public.trades add column reconstruction_key text;

create unique index trades_reconstruction_key_idx
  on public.trades (account_id, reconstruction_key);

create unique index analysis_result_input_fingerprint_idx
  on public.analysis_results (user_id, skill_key, input_fingerprint);

create unique index positions_account_instrument_side_idx
  on public.positions (account_id, category, symbol, position_side);

-- This is safe for browser use. The private table remains unreadable through
-- PostgREST, and no credential material or external account ID is returned.
create function public.get_verified_bitget_connection_status()
returns table (
  connected boolean,
  verified boolean,
  connection_id uuid,
  verified_at timestamptz,
  last_synced_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  active_connection private.bitget_connections%rowtype;
  is_verified boolean;
begin
  if current_user_id is null then
    raise exception 'authentication required';
  end if;

  select c.* into active_connection
  from private.bitget_connections c
  where c.user_id = current_user_id
    and c.revoked_at is null
  order by c.verified_at desc nulls last, c.created_at desc
  limit 1;

  is_verified := coalesce(active_connection.id is not null
    and active_connection.verified_at is not null
    and active_connection.read_only_attested_at is not null
    and nullif(btrim(active_connection.external_uid), '') is not null, false);

  return query select
    active_connection.id is not null,
    is_verified,
    case when is_verified then active_connection.id else null::uuid end,
    case when is_verified then active_connection.verified_at else null::timestamptz end,
    case when is_verified then active_connection.last_synced_at else null::timestamptz end;
end;
$$;

-- Lock the user's row to serialize double-clicks and retries. The partial
-- unique index also prevents two active initial jobs if a caller races.
create function public.start_or_resume_bitget_import()
returns table (
  job_id uuid,
  connection_id uuid,
  status text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  verified_connection_id uuid;
  active_job_id uuid;
  active_job_status text;
begin
  if current_user_id is null then
    raise exception 'authentication required';
  end if;

  perform 1 from public.users u where u.id = current_user_id for update;
  if not found then
    raise exception 'user profile required';
  end if;

  select c.id into verified_connection_id
  from private.bitget_connections c
  where c.user_id = current_user_id
    and c.revoked_at is null
    and c.verified_at is not null
    and c.read_only_attested_at is not null
    and nullif(btrim(c.external_uid), '') is not null
  order by c.verified_at desc, c.created_at desc
  limit 1;

  if verified_connection_id is null then
    raise exception 'verified Bitget connection required';
  end if;

  -- A previous connection must not retain the user's only active job slot.
  update public.import_jobs j
  set status = 'failed',
      safe_error_code = 'CONNECTION_REPLACED',
      updated_at = now(),
      completed_at = now()
  where j.user_id = current_user_id
    and j.job_type = 'bitget_initial'
    and j.status in ('queued', 'running')
    and j.connection_id is distinct from verified_connection_id;

  select j.id, j.status into active_job_id, active_job_status
  from public.import_jobs j
  where j.user_id = current_user_id
    and j.connection_id = verified_connection_id
    and j.job_type = 'bitget_initial'
    and j.status in ('queued', 'running')
  limit 1;

  if active_job_id is null then
    insert into public.import_jobs as new_job (
      user_id, connection_id, job_type, status, current_stage
    ) values (
      current_user_id, verified_connection_id, 'bitget_initial', 'queued', 'connection_verified'
    )
    returning new_job.id, new_job.status into active_job_id, active_job_status;
  end if;

  return query select active_job_id, verified_connection_id, active_job_status;
end;
$$;

-- Exactly one trusted worker may claim a job. Expired leases can be reclaimed
-- without creating a second job or exposing a token to the browser.
create function public.claim_bitget_import_job(p_job_id uuid)
returns table (
  claimed boolean,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  import_job public.import_jobs%rowtype;
  new_token uuid;
  new_expiry timestamptz;
begin
  select j.* into import_job
  from public.import_jobs j
  join private.bitget_connections c
    on c.id = j.connection_id and c.user_id = j.user_id
  where j.id = p_job_id
    and j.job_type = 'bitget_initial'
    and j.status in ('queued', 'running')
    and c.revoked_at is null
    and c.verified_at is not null
    and c.read_only_attested_at is not null
  for update of j;

  if import_job.id is null then
    return query select false, null::uuid, null::timestamptz;
    return;
  end if;

  insert into private.bitget_import_leases as lease (
    job_id, lease_token, claimed_at, heartbeat_at, lease_expires_at
  ) values (
    p_job_id, pg_catalog.gen_random_uuid(), now(), now(), now() + interval '5 minutes'
  )
  on conflict (job_id) do update
    set lease_token = excluded.lease_token,
        claimed_at = excluded.claimed_at,
        heartbeat_at = excluded.heartbeat_at,
        lease_expires_at = excluded.lease_expires_at
    where lease.lease_expires_at <= now()
  returning lease.lease_token, lease.lease_expires_at into new_token, new_expiry;

  if new_token is null then
    return query select false, null::uuid, null::timestamptz;
    return;
  end if;

  update public.import_jobs j
  set status = 'running', updated_at = now()
  where j.id = p_job_id;

  return query select true, new_token, new_expiry;
end;
$$;

create function public.heartbeat_bitget_import_job(
  p_job_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  job_status text;
  lease_renewed boolean;
begin
  select j.status into job_status
  from public.import_jobs j
  join private.bitget_connections c
    on c.id = j.connection_id and c.user_id = j.user_id
  where j.id = p_job_id and j.job_type = 'bitget_initial'
    and c.revoked_at is null
    and c.verified_at is not null
    and c.read_only_attested_at is not null
  for update of j;

  if job_status is null or job_status not in ('queued', 'running') then
    return false;
  end if;

  update private.bitget_import_leases l
  set heartbeat_at = now(),
      lease_expires_at = now() + interval '5 minutes'
  where l.job_id = p_job_id
    and l.lease_token = p_lease_token
    and l.lease_expires_at > now()
  returning true into lease_renewed;

  if coalesce(lease_renewed, false) then
    update public.import_jobs j set updated_at = now() where j.id = p_job_id;
  end if;

  return coalesce(lease_renewed, false);
end;
$$;

-- PostgREST intentionally does not expose the private schema. Give only the
-- trusted service role a narrowly scoped encrypted-blob reader for a job's
-- exact user-owned verified connection. No browser role can execute it.
create function public.get_bitget_import_connection(
  p_connection_id uuid,
  p_user_id uuid
)
returns table (
  credential_ciphertext bytea,
  credential_iv bytea,
  credential_auth_tag bytea,
  wrapped_data_key bytea,
  wrapped_data_key_iv bytea,
  key_version smallint,
  external_uid text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.credential_ciphertext, c.credential_iv, c.credential_auth_tag,
         c.wrapped_data_key, c.wrapped_data_key_iv, c.key_version, c.external_uid
  from private.bitget_connections c
  where c.id = p_connection_id and c.user_id = p_user_id
    and c.revoked_at is null
    and c.verified_at is not null
    and c.read_only_attested_at is not null
    and nullif(btrim(c.external_uid), '') is not null
    and c.key_version = 1
  limit 1;
$$;

-- Only the trusted service-role worker may report progress. The public JSON
-- column receives allowlisted counts/timestamps, never arbitrary API data.
create function public.update_bitget_import_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_status text,
  p_current_stage text,
  p_progress jsonb,
  p_safe_error_code text,
  p_completed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_job public.import_jobs%rowtype;
  active_lease private.bitget_import_leases%rowtype;
  safe_progress jsonb;
begin
  if p_status is null or p_status not in ('queued', 'running', 'completed', 'failed') then
    raise exception 'invalid import status';
  end if;
  if p_current_stage is not null and
     (length(p_current_stage) > 64 or p_current_stage !~ '^[a-z][a-z0-9_]*$') then
    raise exception 'invalid import stage';
  end if;
  if p_safe_error_code is not null and
     (length(p_safe_error_code) > 64 or p_safe_error_code !~ '^[A-Z][A-Z0-9_]*$') then
    raise exception 'invalid safe error code';
  end if;
  if p_status = 'failed' and p_safe_error_code is null then
    raise exception 'safe error code required';
  end if;
  if p_progress is not null and jsonb_typeof(p_progress) <> 'object' then
    raise exception 'invalid import progress';
  end if;

  select j.* into existing_job
  from public.import_jobs j
  where j.id = p_job_id and j.job_type = 'bitget_initial'
  for update;

  if existing_job.id is null then
    return false;
  end if;
  if existing_job.status in ('completed', 'failed') then
    return false;
  end if;
  if existing_job.status = 'running' and p_status = 'queued' then
    raise exception 'import status cannot move backwards';
  end if;

  select l.* into active_lease
  from private.bitget_import_leases l
  where l.job_id = p_job_id
  for update;

  if active_lease.job_id is null
     or active_lease.lease_token is distinct from p_lease_token
     or active_lease.lease_expires_at <= now() then
    return false;
  end if;
  if p_status <> 'failed' and not exists (
    select 1 from private.bitget_connections c
    where c.id = existing_job.connection_id
      and c.user_id = existing_job.user_id
      and c.revoked_at is null
      and c.verified_at is not null
      and c.read_only_attested_at is not null
  ) then
    return false;
  end if;

  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
  into safe_progress
  from jsonb_each(coalesce(p_progress, '{}'::jsonb)) e
  where (e.key in (
      'ordersImported', 'fillsImported', 'tradesReconstructed',
      'financialRecordsImported', 'assetsImported', 'positionsImported',
      'instrumentsImported', 'marketSnapshotsImported'
    ) and jsonb_typeof(e.value) = 'number'
      and (e.value #>> '{}') ~ '^(0|[1-9][0-9]*)$')
    or (e.key in ('earliestRecordAt', 'latestRecordAt')
      and jsonb_typeof(e.value) = 'string'
      and (e.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$')
    or (e.key = 'analysisStatus'
      and e.value in ('"completed"'::jsonb, '"insufficient_data"'::jsonb))
    or (e.key = 'analysisSampleSize'
      and jsonb_typeof(e.value) = 'number'
      and (e.value #>> '{}') ~ '^(0|[1-9][0-9]*)$');

  update public.import_jobs j
  set status = p_status,
      current_stage = p_current_stage,
      progress = j.progress || safe_progress,
      updated_at = now(),
      safe_error_code = case when p_status = 'failed' then p_safe_error_code else null end,
      completed_at = case when p_status in ('completed', 'failed')
        then coalesce(p_completed_at, now()) else null end
  where j.id = p_job_id;

  if p_status = 'completed' then
    update private.bitget_connections c
    set last_synced_at = coalesce(p_completed_at, now())
    where c.id = existing_job.connection_id
      and c.user_id = existing_job.user_id
      and c.revoked_at is null;
  end if;

  if p_status in ('completed', 'failed') then
    delete from private.bitget_import_leases l where l.job_id = p_job_id;
  else
    update private.bitget_import_leases l
    set heartbeat_at = now(), lease_expires_at = now() + interval '5 minutes'
    where l.job_id = p_job_id;
  end if;

  return true;
end;
$$;

revoke all on function public.get_verified_bitget_connection_status() from public, anon, authenticated;
revoke all on function public.start_or_resume_bitget_import() from public, anon, authenticated;
revoke all on function public.claim_bitget_import_job(uuid) from public, anon, authenticated;
revoke all on function public.heartbeat_bitget_import_job(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_bitget_import_connection(uuid, uuid) from public, anon, authenticated;
revoke all on function public.update_bitget_import_job(uuid, uuid, text, text, jsonb, text, timestamptz) from public, anon, authenticated;

grant execute on function public.get_verified_bitget_connection_status() to authenticated;
grant execute on function public.start_or_resume_bitget_import() to authenticated;
grant execute on function public.claim_bitget_import_job(uuid) to service_role;
grant execute on function public.heartbeat_bitget_import_job(uuid, uuid) to service_role;
grant execute on function public.get_bitget_import_connection(uuid, uuid) to service_role;
grant execute on function public.update_bitget_import_job(uuid, uuid, text, text, jsonb, text, timestamptz) to service_role;

commit;
