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

