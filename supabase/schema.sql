-- New Light Orchestra: database, file storage and security rules.
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- Then add yourself as the first admin (see the bottom of this file).

-- ---------- Tables ----------

-- Who is allowed into the members' area. Keyed by email so the librarian can add
-- people before they ever sign in.
create table public.members (
  email      text primary key check (email = lower(email)),
  name       text not null,
  instrument text not null,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.pieces (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  composer   text not null default '',
  concert    text not null default '',
  created_at timestamptz not null default now()
);

create table public.parts (
  id         uuid primary key default gen_random_uuid(),
  piece_id   uuid not null references public.pieces(id) on delete cascade,
  instrument text not null,
  file_path  text not null unique,  -- path inside the private "music" storage bucket
  created_at timestamptz not null default now()
);

-- Filled in by the public "Join" and "Mailing list" forms.
create table public.join_requests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 200),
  email      text not null check (length(email) between 3 and 320),
  instrument text not null check (length(instrument) <= 100),
  level      text check (length(level) <= 100),
  message    text check (length(message) <= 2000),
  created_at timestamptz not null default now()
);

create table public.mailing_list (
  email      text primary key check (length(email) between 3 and 320),
  created_at timestamptz not null default now()
);

-- ---------- Helpers ----------
-- "security definer" lets these read the members table without tripping its own rules.

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where email = lower(auth.jwt() ->> 'email'));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where email = lower(auth.jwt() ->> 'email') and is_admin);
$$;

grant execute on function public.is_member(), public.is_admin() to anon, authenticated;

-- ---------- Row level security ----------
-- Nothing is readable unless a rule below allows it.

alter table public.members       enable row level security;
alter table public.pieces        enable row level security;
alter table public.parts         enable row level security;
alter table public.join_requests enable row level security;
alter table public.mailing_list  enable row level security;

grant select, insert, update, delete on public.members, public.pieces, public.parts to authenticated;
grant insert on public.join_requests, public.mailing_list to anon, authenticated;
grant select, delete on public.join_requests, public.mailing_list to authenticated;

-- Members see their own row; admins see and manage everyone.
create policy "Read own member row" on public.members
  for select to authenticated
  using (email = lower(auth.jwt() ->> 'email') or public.is_admin());
create policy "Admins manage members" on public.members
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Members can see the music list; admins manage it.
create policy "Members read pieces" on public.pieces
  for select to authenticated using (public.is_member());
create policy "Admins manage pieces" on public.pieces
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "Members read parts" on public.parts
  for select to authenticated using (public.is_member());
create policy "Admins manage parts" on public.parts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Anyone can submit the public forms; only admins can read them.
create policy "Anyone can ask to join" on public.join_requests
  for insert to anon, authenticated with check (true);
create policy "Admins read join requests" on public.join_requests
  for select to authenticated using (public.is_admin());
create policy "Admins delete join requests" on public.join_requests
  for delete to authenticated using (public.is_admin());

create policy "Anyone can subscribe" on public.mailing_list
  for insert to anon, authenticated with check (true);
create policy "Admins read mailing list" on public.mailing_list
  for select to authenticated using (public.is_admin());
create policy "Admins delete from mailing list" on public.mailing_list
  for delete to authenticated using (public.is_admin());

-- ---------- Music file storage ----------
-- A private bucket: files can only be fetched by signed-in members.

insert into storage.buckets (id, name, public, file_size_limit)
values ('music', 'music', false, 10485760)  -- 10 MB per file
on conflict (id) do nothing;

create policy "Members read music files" on storage.objects
  for select to authenticated
  using (bucket_id = 'music' and public.is_member());
create policy "Admins upload music files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'music' and public.is_admin());
create policy "Admins update music files" on storage.objects
  for update to authenticated
  using (bucket_id = 'music' and public.is_admin())
  with check (bucket_id = 'music' and public.is_admin());
create policy "Admins delete music files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'music' and public.is_admin());

-- ---------- Members sign-up page ----------
-- Lets the sign-up page check one email without seeing the members list:
-- 'not_listed', 'ready' (can choose a password) or 'has_account'.

create or replace function public.member_signup_status(check_email text)
returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not exists (select 1 from public.members where email = lower(trim(check_email)))
      then 'not_listed'
    when exists (select 1 from auth.users
                 where lower(email) = lower(trim(check_email)) and email_confirmed_at is not null)
      then 'has_account'
    else 'ready'
  end;
$$;

revoke all on function public.member_signup_status(text) from public;
grant execute on function public.member_signup_status(text) to anon, authenticated;

-- ---------- First admin ----------
-- Run this separately, with your own details (email in lower case):
--
-- insert into public.members (email, name, instrument, is_admin)
-- values ('you@example.com', 'Your Name', 'Conductor', true);
