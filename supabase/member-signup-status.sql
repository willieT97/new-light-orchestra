-- Lets the "Members sign up" page check one email address without seeing the members list.
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- (Also included at the end of schema.sql for new projects.)
--
-- Answers with one word:
--   not_listed  – the librarian hasn't added this email as a member yet
--   ready       – on the members list, no account yet: they can choose a password
--   has_account – already has an account: they should sign in instead

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
