-- MIT Asset cloud workspace (run in Supabase → SQL Editor)
-- Free tier: https://supabase.com

create table if not exists public.mit_workspace (
  workspace_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.mit_workspace enable row level security;

-- Internal shared workspace: anyone with your project anon key can read/write.
-- Keep this project private to your IT team. Do not publish the key publicly.
drop policy if exists "mit_workspace_anon_all" on public.mit_workspace;
create policy "mit_workspace_anon_all"
  on public.mit_workspace
  for all
  to anon, authenticated
  using (true)
  with check (true);

-- Optional: seed empty workspace
insert into public.mit_workspace (workspace_id, payload)
values ('main', '{}'::jsonb)
on conflict (workspace_id) do nothing;
