-- MIT Asset cloud workspace (run in Supabase → SQL Editor)
-- Free tier: https://supabase.com

create table if not exists public.mit_workspace (
  workspace_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.mit_workspace enable row level security;

-- Internal shared workspace for your IT team.
-- Anyone with the project anon key can read/write this table.
-- Hardening tips:
--  1) Do not share Project URL + anon key outside your team
--  2) Later: replace this open policy with Supabase Auth + per-user policies
--  3) Restrict API keys in Supabase Dashboard → Settings → API if needed

drop policy if exists "mit_workspace_anon_all" on public.mit_workspace;
create policy "mit_workspace_anon_all"
  on public.mit_workspace
  for all
  to anon, authenticated
  using (true)
  with check (true);

insert into public.mit_workspace (workspace_id, payload)
values ('main', '{}'::jsonb)
on conflict (workspace_id) do nothing;

-- ── Network presence heartbeats (agents POST via Edge Function) ─────────────
-- PWA (anon) can SELECT only. Writes require service role inside the Edge Function.

create table if not exists public.mit_heartbeats (
  workspace_id text not null default 'main',
  agent_id text not null,
  asset_tag text,
  hostname text,
  mac_address text,
  last_seen timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  primary key (workspace_id, agent_id)
);

create index if not exists mit_heartbeats_last_seen_idx
  on public.mit_heartbeats (workspace_id, last_seen desc);

alter table public.mit_heartbeats enable row level security;

drop policy if exists "mit_heartbeats_anon_select" on public.mit_heartbeats;
create policy "mit_heartbeats_anon_select"
  on public.mit_heartbeats
  for select
  to anon, authenticated
  using (true);

-- No anon INSERT/UPDATE/DELETE — Edge Function uses service role key.

-- ── Subsidiary (app field) ───────────────────────────────────────────────────
-- Assets and device users store optional "subsidiary" in mit_workspace.payload:
--   payload->'assets'->n->>'subsidiary'
--   payload->'users'->n->>'subsidiary'
-- Excel import/export columns: Subsidiary (also accepts Company / Entity / BU).
-- There is no separate assets row table; the workspace JSON is the source of truth.

-- Optional lookup catalog (manage in SQL Editor if you want a fixed list):
create table if not exists public.mit_subsidiaries (
  workspace_id text not null default 'main',
  name text not null,
  code text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, name)
);

alter table public.mit_subsidiaries enable row level security;

drop policy if exists "mit_subsidiaries_anon_all" on public.mit_subsidiaries;
create policy "mit_subsidiaries_anon_all"
  on public.mit_subsidiaries
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- ── Device allocation requests (public form → Edge Function insert) ─────────
-- Public allocate.html never holds the anon key. Submissions go through the
-- device-allocation Edge Function (service role). The authenticated PWA
-- uses the anon key for SELECT / UPDATE / DELETE only — never INSERT.

create table if not exists public.mit_allocation_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null default 'main',
  full_name text not null,
  email text not null,
  department text,
  subsidiary text,
  job_role text,
  notes text,
  signature_name text not null,
  confirmed_receipt boolean not null default false,
  device_ids jsonb not null default '[]'::jsonb,
  devices jsonb not null default '[]'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  reject_reason text,
  processed_at timestamptz,
  processed_by text,
  created_at timestamptz not null default now()
);

create index if not exists mit_allocation_requests_workspace_status_idx
  on public.mit_allocation_requests (workspace_id, status, created_at desc);

alter table public.mit_allocation_requests enable row level security;

drop policy if exists "mit_allocation_requests_anon_select" on public.mit_allocation_requests;
create policy "mit_allocation_requests_anon_select"
  on public.mit_allocation_requests
  for select
  to anon, authenticated
  using (true);

drop policy if exists "mit_allocation_requests_anon_update" on public.mit_allocation_requests;
create policy "mit_allocation_requests_anon_update"
  on public.mit_allocation_requests
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "mit_allocation_requests_anon_delete" on public.mit_allocation_requests;
create policy "mit_allocation_requests_anon_delete"
  on public.mit_allocation_requests
  for delete
  to anon, authenticated
  using (true);

-- No anon INSERT policy — only the Edge Function (service role) inserts rows.


