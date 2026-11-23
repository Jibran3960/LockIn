-- LockIn shared group setup. Paste into Supabase > SQL Editor > Run.
create table if not exists public.items (
  grp text not null check (length(grp) >= 6), id text not null,
  data jsonb not null, updated_at timestamptz not null default now(),
  primary key (grp, id));
create table if not exists public.completions (
  grp text not null check (length(grp) >= 6), item_id text not null,
  ds text not null, member text not null,
  primary key (grp, item_id, ds, member));
create table if not exists public.members (
  grp text not null check (length(grp) >= 6), name text not null,
  primary key (grp, name));

alter table public.items enable row level security;
alter table public.completions enable row level security;
alter table public.members enable row level security;

grant select, insert, update, delete on public.items, public.completions, public.members to anon;

-- Each request must send its group code in the x-group-code header;
-- it can only touch rows with that exact code.
drop policy if exists grp_access on public.items;
drop policy if exists grp_access on public.completions;
drop policy if exists grp_access on public.members;
create policy grp_access on public.items for all to anon
  using (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''))
  with check (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''));
create policy grp_access on public.completions for all to anon
  using (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''))
  with check (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''));
create policy grp_access on public.members for all to anon
  using (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''))
  with check (grp = coalesce(current_setting('request.headers', true)::json->>'x-group-code', ''));
