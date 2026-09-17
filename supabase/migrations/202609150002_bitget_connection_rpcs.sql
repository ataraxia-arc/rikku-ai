begin;

create or replace function public.upsert_bitget_connection(
  p_credential_ciphertext bytea,
  p_credential_iv bytea,
  p_credential_auth_tag bytea,
  p_wrapped_data_key bytea,
  p_wrapped_data_key_iv bytea,
  p_key_version smallint,
  p_api_key_fingerprint text,
  p_external_uid text,
  p_adapter_version text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  connection_id uuid;
begin
  if current_user_id is null then
    raise exception 'authentication required';
  end if;

  update private.bitget_connections
  set revoked_at = now()
  where user_id = current_user_id
    and api_key_fingerprint <> p_api_key_fingerprint
    and revoked_at is null;

  insert into private.bitget_connections (
    user_id,
    credential_ciphertext,
    credential_iv,
    credential_auth_tag,
    wrapped_data_key,
    wrapped_data_key_iv,
    key_version,
    api_key_fingerprint,
    external_uid,
    adapter_version,
    read_only_attested_at,
    verified_at,
    revoked_at
  )
  values (
    current_user_id,
    p_credential_ciphertext,
    p_credential_iv,
    p_credential_auth_tag,
    p_wrapped_data_key,
    p_wrapped_data_key_iv,
    p_key_version,
    p_api_key_fingerprint,
    p_external_uid,
    p_adapter_version,
    now(),
    now(),
    null
  )
  on conflict (user_id, api_key_fingerprint)
  do update set
    credential_ciphertext = excluded.credential_ciphertext,
    credential_iv = excluded.credential_iv,
    credential_auth_tag = excluded.credential_auth_tag,
    wrapped_data_key = excluded.wrapped_data_key,
    wrapped_data_key_iv = excluded.wrapped_data_key_iv,
    key_version = excluded.key_version,
    external_uid = excluded.external_uid,
    adapter_version = excluded.adapter_version,
    read_only_attested_at = excluded.read_only_attested_at,
    verified_at = excluded.verified_at,
    revoked_at = null
  returning id into connection_id;

  update public.users
  set onboarding_state = 'bitget_connected', updated_at = now()
  where id = current_user_id;

  return connection_id;
end;
$$;

create or replace function public.get_bitget_connection_status()
returns table (
  connected boolean,
  verified_at timestamptz,
  last_synced_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from private.bitget_connections
      where user_id = auth.uid() and revoked_at is null
    ),
    (
      select c.verified_at
      from private.bitget_connections c
      where c.user_id = auth.uid() and c.revoked_at is null
      order by c.verified_at desc
      limit 1
    ),
    (
      select c.last_synced_at
      from private.bitget_connections c
      where c.user_id = auth.uid() and c.revoked_at is null
      order by c.verified_at desc
      limit 1
    );
$$;

create or replace function public.revoke_bitget_connection()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  affected integer;
begin
  if current_user_id is null then
    raise exception 'authentication required';
  end if;

  update private.bitget_connections
  set revoked_at = now()
  where user_id = current_user_id and revoked_at is null;
  get diagnostics affected = row_count;

  update public.users
  set onboarding_state = 'account_created', updated_at = now()
  where id = current_user_id;

  return affected > 0;
end;
$$;

revoke all on function public.upsert_bitget_connection(bytea, bytea, bytea, bytea, bytea, smallint, text, text, text) from public;
revoke all on function public.get_bitget_connection_status() from public;
revoke all on function public.revoke_bitget_connection() from public;
grant execute on function public.upsert_bitget_connection(bytea, bytea, bytea, bytea, bytea, smallint, text, text, text) to authenticated;
grant execute on function public.get_bitget_connection_status() to authenticated;
grant execute on function public.revoke_bitget_connection() to authenticated;

commit;
