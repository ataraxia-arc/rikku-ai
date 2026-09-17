begin;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;
create schema if not exists private;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'UTC',
  base_currency text not null default 'USD',
  onboarding_state text not null default 'account_created',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.bitget_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  credential_ciphertext bytea not null,
  credential_iv bytea not null,
  credential_auth_tag bytea not null,
  wrapped_data_key bytea not null,
  wrapped_data_key_iv bytea not null,
  key_version smallint not null default 1,
  api_key_fingerprint text not null,
  external_uid text,
  adapter_version text not null default 'uta-v3',
  read_only_attested_at timestamptz,
  verified_at timestamptz,
  last_synced_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, api_key_fingerprint)
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  connection_id uuid not null references private.bitget_connections(id) on delete cascade,
  external_account_id text not null,
  account_mode text,
  asset_mode text,
  hold_mode text,
  base_currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_account_id)
);

create table public.instruments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null,
  symbol text not null,
  base_coin text,
  quote_coin text,
  price_increment numeric(38,18),
  quantity_increment numeric(38,18),
  source text not null default 'bitget',
  source_updated_at timestamptz,
  unique (user_id, source, category, symbol)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  coin text not null,
  equity numeric(38,18),
  balance numeric(38,18),
  available numeric(38,18),
  locked numeric(38,18),
  debt numeric(38,18),
  usd_value numeric(38,8),
  observed_at timestamptz not null,
  unique (account_id, coin)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  external_order_id text not null,
  client_order_id text,
  category text not null,
  symbol text not null,
  side text not null,
  order_type text,
  order_status text,
  position_side text,
  trade_side text,
  margin_mode text,
  margin_coin text,
  reduce_only boolean,
  requested_quantity numeric(38,18),
  executed_quantity numeric(38,18),
  executed_value numeric(38,18),
  requested_price numeric(38,18),
  average_price numeric(38,18),
  leverage numeric(20,8),
  source_created_at timestamptz not null,
  source_updated_at timestamptz,
  raw_schema_version text not null,
  imported_at timestamptz not null default now(),
  unique (account_id, external_order_id)
);

create table public.trade_fills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  external_execution_id text not null,
  external_order_id text,
  execution_link_id text,
  category text not null,
  symbol text not null,
  side text not null,
  trade_side text,
  liquidity_role text,
  execution_price numeric(38,18) not null,
  execution_quantity numeric(38,18) not null,
  execution_value numeric(38,18),
  execution_pnl numeric(38,18),
  fee_amount numeric(38,18),
  fee_coin text,
  executed_at timestamptz not null,
  raw_schema_version text not null,
  imported_at timestamptz not null default now(),
  unique (account_id, external_execution_id)
);

create table public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  category text not null,
  symbol text not null,
  direction text not null,
  opened_at timestamptz not null,
  closed_at timestamptz,
  quantity numeric(38,18) not null,
  entry_price numeric(38,18) not null,
  exit_price numeric(38,18),
  gross_pnl numeric(38,18),
  net_pnl numeric(38,18),
  fees numeric(38,18),
  funding numeric(38,18),
  initial_risk numeric(38,18),
  r_multiple numeric(24,10),
  reconstruction_quality text not null default 'unknown',
  reconstruction_version text not null,
  created_at timestamptz not null default now()
);

create table public.trade_fill_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  trade_id uuid not null references public.trades(id) on delete cascade,
  fill_id uuid not null references public.trade_fills(id) on delete cascade,
  allocated_quantity numeric(38,18) not null check (allocated_quantity > 0),
  unique (trade_id, fill_id)
);

create table public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  category text not null,
  symbol text not null,
  position_side text not null,
  quantity numeric(38,18) not null,
  entry_price numeric(38,18),
  mark_price numeric(38,18),
  unrealized_pnl numeric(38,18),
  leverage numeric(20,8),
  margin_mode text,
  observed_at timestamptz not null
);

create table public.financial_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  external_record_id text not null,
  category text not null,
  symbol text,
  coin text,
  record_type text not null,
  fee numeric(38,18),
  amount numeric(38,18),
  balance numeric(38,18),
  recorded_at timestamptz not null,
  unique (account_id, external_record_id)
);

create table public.portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  account_equity numeric(38,8),
  unrealized_pnl numeric(38,8),
  effective_equity numeric(38,8),
  maintenance_margin numeric(38,8),
  initial_margin numeric(38,8),
  margin_ratio numeric(24,12),
  leverage numeric(20,8),
  observed_at timestamptz not null
);

create table public.portfolio_snapshot_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  snapshot_id uuid not null references public.portfolio_snapshots(id) on delete cascade,
  item_type text not null,
  symbol_or_coin text not null,
  quantity numeric(38,18),
  usd_value numeric(38,8),
  weight numeric(24,12),
  risk_contribution numeric(24,12)
);

create table public.market_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null,
  symbol text not null,
  interval text not null,
  observed_at timestamptz not null,
  open numeric(38,18), high numeric(38,18), low numeric(38,18), close numeric(38,18), volume numeric(38,18),
  return_1 numeric(24,12), return_5 numeric(24,12), volatility numeric(24,12), trend_score numeric(24,12),
  source text not null,
  unique (user_id, source, category, symbol, interval, observed_at)
);

create table public.trade_context (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  trade_id uuid not null references public.trades(id) on delete cascade,
  regime text,
  pre_entry_return numeric(24,12),
  volatility_percentile numeric(24,12),
  volume_percentile numeric(24,12),
  trend_score numeric(24,12),
  strategy_class text,
  sentiment_label text,
  event_context jsonb not null default '{}'::jsonb,
  data_quality jsonb not null default '{}'::jsonb,
  context_version text not null,
  unique (trade_id, context_version)
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  question text not null,
  reasoning_mode text not null check (reasoning_mode in ('scout','analyst','investigator')),
  status text not null,
  tool_plan jsonb not null default '[]'::jsonb,
  evidence_map jsonb,
  data_window tstzrange,
  model_version text,
  quant_version text,
  latency_ms integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.analysis_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete cascade,
  skill_key text not null,
  skill_version text not null,
  input_fingerprint text not null,
  result jsonb not null,
  sample_size integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  confidence text not null check (confidence in ('low','moderate','high','very_high','not_assessable')),
  confidence_reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table public.behavior_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  metric_key text not null,
  value numeric(38,18),
  unit text,
  population_definition jsonb not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  sample_size integer not null,
  method_version text not null,
  created_at timestamptz not null default now()
);

create table public.patterns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  pattern_type text not null,
  claim text not null,
  status text not null check (status in ('candidate','promising','validated','weakened','retired')),
  effect_size numeric(24,12),
  confidence text not null,
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  validation_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pattern_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  pattern_id uuid not null references public.patterns(id) on delete cascade,
  trade_id uuid references public.trades(id) on delete set null,
  analysis_result_id uuid references public.analysis_results(id) on delete set null,
  direction text not null check (direction in ('supporting','contradicting','neutral')),
  weight numeric(24,12) not null default 1,
  rationale text not null
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  memory_type text not null check (memory_type in ('trade','market_context','decision','behavioral','pattern','rule','thesis')),
  statement text not null,
  classification text not null check (classification in ('fact','inference','hypothesis','weak_evidence','strong_evidence')),
  payload jsonb not null default '{}'::jsonb,
  salience numeric(10,6) not null default 0,
  confidence text not null,
  valid_from timestamptz,
  valid_to timestamptz,
  status text not null default 'candidate',
  source_run_id uuid references public.agent_runs(id) on delete set null,
  supersedes_id uuid references public.memories(id) on delete set null,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memory_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  memory_id uuid not null references public.memories(id) on delete cascade,
  evidence_type text not null,
  evidence_id uuid,
  direction text not null,
  source_label text,
  observed_at timestamptz
);

create table public.user_theses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  symbol text,
  claim text not null,
  horizon text not null,
  initial_confidence numeric(8,6),
  current_confidence numeric(8,6),
  invalidation_conditions jsonb not null default '[]'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.thesis_updates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  thesis_id uuid not null references public.user_theses(id) on delete cascade,
  evidence_summary text not null,
  update_method text not null,
  prior_confidence numeric(8,6),
  posterior_confidence numeric(8,6),
  likelihood_assumptions jsonb,
  direction text not null,
  created_at timestamptz not null default now()
);

create table public.personal_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null,
  if_conditions jsonb not null,
  then_action text not null,
  origin_memory_id uuid references public.memories(id) on delete set null,
  origin_pattern_id uuid references public.patterns(id) on delete set null,
  confidence text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.rule_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  rule_id uuid not null references public.personal_rules(id) on delete cascade,
  trade_id uuid references public.trades(id) on delete set null,
  result text not null check (result in ('followed','violated','not_assessable')),
  outcome jsonb,
  explanation text,
  evaluated_at timestamptz not null default now()
);

create table public.research_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  thesis_id uuid references public.user_theses(id) on delete set null,
  title text not null,
  publisher text,
  url text not null,
  published_at timestamptz,
  retrieved_at timestamptz not null,
  reliability jsonb not null default '{}'::jsonb,
  content_hash text not null
);

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  job_type text not null,
  status text not null,
  current_stage text,
  progress jsonb not null default '{}'::jsonb,
  safe_error_code text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.sync_cursors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  endpoint_key text not null,
  category text not null default '',
  cursor_value text,
  coverage_start timestamptz,
  coverage_end timestamptz,
  last_success_at timestamptz,
  unique (account_id, endpoint_key, category)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  action text not null,
  target_type text,
  target_id uuid,
  request_id text,
  safe_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index orders_user_time_idx on public.orders (user_id, source_created_at desc);
create index fills_user_time_idx on public.trade_fills (user_id, executed_at desc);
create index trades_user_symbol_time_idx on public.trades (user_id, symbol, opened_at desc);
create index context_regime_idx on public.trade_context (user_id, regime);
create index market_symbol_time_idx on public.market_snapshots (user_id, symbol, observed_at desc);
create index memories_lookup_idx on public.memories (user_id, memory_type, status, created_at desc);
create index patterns_lookup_idx on public.patterns (user_id, status, updated_at desc);

alter table private.bitget_connections enable row level security;
revoke all on schema private from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
grant usage on schema private to service_role;
grant all on all tables in schema private to service_role;

alter table public.users enable row level security;
create policy "users_read_own" on public.users for select to authenticated using ((select auth.uid()) = id);

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'accounts','instruments','assets','orders','trade_fills','trades','trade_fill_links','positions',
    'financial_records','portfolio_snapshots','portfolio_snapshot_items','market_snapshots','trade_context',
    'agent_runs','analysis_results','behavior_metrics','patterns','pattern_evidence','memories','memory_evidence',
    'user_theses','thesis_updates','personal_rules','rule_evaluations','research_sources','import_jobs','sync_cursors','audit_events'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name || '_read_own', table_name);
  end loop;
end $$;

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.users (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

commit;
