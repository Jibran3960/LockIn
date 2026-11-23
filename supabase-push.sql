-- LockIn notifications setup. Paste into Supabase > SQL Editor > Run (after supabase-setup.sql).
alter table public.completions add column if not exists created_at timestamptz not null default now();
alter table public.completions add column if not exists notify boolean not null default false;

create table if not exists public.push_subs (
  grp text not null check (length(grp) >= 6), member text not null,
  endpoint text primary key, p256dh text not null, auth text not null,
  created_at timestamptz not null default now());
alter table public.push_subs enable row level security;
grant select, insert, update, delete on public.push_subs to anon;
drop policy if exists grp_access on public.push_subs;
create policy grp_access on public.push_subs for all to anon
  using (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''))
  with check (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''));

-- Log of notifications already sent (server only: RLS on, no policy for anon).
create table if not exists public.push_log (
  key text primary key, sent_at timestamptz not null default now());
alter table public.push_log enable row level security;
