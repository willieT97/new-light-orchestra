-- Lets Librarian tools show whether each member has set up their account.
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- (Also included at the end of schema.sql for new projects.)
--
-- For every member, one of:
--   set_up      – has an account and has confirmed their email
--   unconfirmed – chose a password but hasn't clicked the confirmation email yet
--   none        – hasn't started
-- plus when they last signed in. Only admins get an answer; for anyone else it's empty.

create or replace function public.member_account_statuses()
returns table (email text, status text, last_sign_in timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.email,
         case when u.id is null then 'none'
              when u.email_confirmed_at is null then 'unconfirmed'
              else 'set_up' end,
         u.last_sign_in_at
  from public.members m
  left join auth.users u on lower(u.email) = m.email
  where public.is_admin();
$$;

revoke all on function public.member_account_statuses() from public;
grant execute on function public.member_account_statuses() to authenticated;
