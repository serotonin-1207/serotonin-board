-- Upgrade a project that ran setup.sql 0.3.x/0.4.x to departments (0.5.0).
-- Run this file and then the new supabase/setup.sql, together, in the SQL Editor. Existing revisions, accounts and the
-- current access code move to the first department ("dept1"); rename it afterwards if you like.
begin;

create table if not exists public.serotonin_depts (
  id text primary key check (id ~ '^[a-z0-9_-]{2,30}$'),
  name text not null check (length(btrim(name)) between 1 and 40),
  rotating boolean not null default true,
  code_hash text not null unique
);
alter table public.serotonin_depts enable row level security;
revoke all on public.serotonin_depts from public, anon, authenticated;

-- The existing access code becomes the first department's code.
do $$
begin
  if to_regclass('public.serotonin_test_secret') is not null then
    insert into public.serotonin_depts(id, name, rotating, code_hash)
      select 'dept1', '1부서', true, code_hash from public.serotonin_test_secret where id = 1
      on conflict (id) do nothing;
  end if;
  if not exists (select 1 from public.serotonin_depts where id = 'dept1')
     and (exists (select 1 from public.serotonin_test_events) or exists (select 1 from public.serotonin_test_members)) then
    raise exception 'No access code was set, so existing data cannot be assigned to a department. Set a code first.';
  end if;
end
$$;

alter table public.serotonin_test_events add column if not exists dept text references public.serotonin_depts(id);
update public.serotonin_test_events set dept = 'dept1' where dept is null;
alter table public.serotonin_test_events alter column dept set not null;
create index if not exists serotonin_test_events_dept_saved_at on public.serotonin_test_events(dept, saved_at);

alter table public.serotonin_test_members add column if not exists dept text references public.serotonin_depts(id);
alter table public.serotonin_test_members add column if not exists name text;
update public.serotonin_test_members set dept = 'dept1' where dept is null;
alter table public.serotonin_test_members alter column dept set not null;

drop table if exists public.serotonin_test_secret;
commit;
