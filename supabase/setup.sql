-- Public comparison TEST board only. New tables, no existing board data touched.
-- Run in a dedicated free Supabase test project. Enable Anonymous Sign-Ins first.
begin;
create table if not exists public.serotonin_test_events (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  note_id text not null check (note_id ~ '^[a-f0-9]{32}$'),
  actor_id uuid not null,
  saved_at timestamptz not null default now(),
  event jsonb not null
);
alter table public.serotonin_test_events enable row level security;
revoke all on public.serotonin_test_events from public, anon, authenticated;
grant select on public.serotonin_test_events to authenticated;

-- Access code gate: the project URL and publishable key are public, so a temporary account alone must not grant
-- access. An account becomes a member only by presenting the access code once (see serotonin_join_test_board).
create table if not exists public.serotonin_test_members (
  user_id uuid primary key,
  joined_at timestamptz not null default now()
);
create table if not exists public.serotonin_test_secret (
  id int primary key check (id = 1),
  code_hash text not null
);
create table if not exists public.serotonin_test_join_failures (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  failed_at timestamptz not null default now()
);
alter table public.serotonin_test_members enable row level security;
alter table public.serotonin_test_secret enable row level security;
alter table public.serotonin_test_join_failures enable row level security;
revoke all on public.serotonin_test_members, public.serotonin_test_secret, public.serotonin_test_join_failures from public, anon, authenticated;

create or replace function public.serotonin_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.serotonin_test_members where user_id = auth.uid());
$$;
revoke all on function public.serotonin_is_member() from public, anon;
grant execute on function public.serotonin_is_member() to authenticated;

drop policy if exists "test_users_read_events" on public.serotonin_test_events;
drop policy if exists "test_members_read_events" on public.serotonin_test_events;
create policy "test_members_read_events" on public.serotonin_test_events for select to authenticated using (public.serotonin_is_member());

-- Wrong codes are returned (not raised) so that the failure is recorded; five misses lock the account for an hour.
create or replace function public.serotonin_join_test_board(code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.serotonin_is_member() then return jsonb_build_object('member', true); end if;
  if (select count(*) from public.serotonin_test_join_failures where user_id = auth.uid() and failed_at > now() - interval '1 hour') >= 5
  then return jsonb_build_object('member', false, 'error', 'locked'); end if;
  if exists(select 1 from public.serotonin_test_secret where id = 1 and code_hash = encode(sha256(convert_to(coalesce(code, ''), 'UTF8')), 'hex')) then
    insert into public.serotonin_test_members(user_id) values (auth.uid()) on conflict do nothing;
    return jsonb_build_object('member', true);
  end if;
  insert into public.serotonin_test_join_failures(user_id) values (auth.uid());
  return jsonb_build_object('member', false, 'error', 'invalid');
end;
$$;
revoke all on function public.serotonin_join_test_board(text) from public, anon;
grant execute on function public.serotonin_join_test_board(text) to authenticated;

create or replace function public.serotonin_test_connection() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return jsonb_build_object('userId',auth.uid(),'mode','public-test','member',public.serotonin_is_member());
end;
$$;

create or replace function public.serotonin_append_test_event(input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  user_id uuid := auth.uid();
  parent_id text;
  record jsonb;
  old_record public.serotonin_test_events%rowtype;
begin
  if user_id is null then raise exception 'Authentication required'; end if;
  if not public.serotonin_is_member() then raise exception 'Access code required'; end if;
  if octet_length(input::text) > 65000 then raise exception 'Event payload too large'; end if;
  if jsonb_typeof(input) is distinct from 'object'
    or input->>'schema' is distinct from '1'
    or coalesce(input->>'id','') !~ '^[a-f0-9]{32}$'
    or coalesce(input->>'noteId','') !~ '^[a-f0-9]{32}$'
    or jsonb_typeof(input->'parents') is distinct from 'array'
    or jsonb_typeof(input->'note') is distinct from 'object'
  then raise exception 'Invalid event'; end if;
  if jsonb_array_length(input->'parents') > 100 then raise exception 'Too many parents'; end if;
  if ((input->'note') - array['title','content','author','category','status','pinned','deleted','kind','date','endDate']) <> '{}'::jsonb
    or jsonb_typeof(input#>'{note,title}') is distinct from 'string'
    or length(btrim(input#>>'{note,title}')) not between 1 and 120
    or jsonb_typeof(input#>'{note,content}') is distinct from 'string'
    or length(input#>>'{note,content}') > 10000
    or jsonb_typeof(input#>'{note,author}') is distinct from 'string'
    or length(btrim(input#>>'{note,author}')) not between 1 and 40
    or coalesce(input#>>'{note,category}','') not in ('인수인계','공지사항','업무 메모','일정')
    or coalesce(input#>>'{note,status}','') not in ('todo','doing','done')
    or jsonb_typeof(input#>'{note,pinned}') is distinct from 'boolean'
    or jsonb_typeof(input#>'{note,deleted}') is distinct from 'boolean'
  then raise exception 'Invalid note'; end if;
  -- Calendar schedules: category '일정' requires kind and date (endDate optional, at most 60 days later).
  -- Other categories must not carry schedule fields.
  if input#>>'{note,category}' = '일정' then
    if jsonb_typeof(input#>'{note,date}') is distinct from 'string'
      or input#>>'{note,date}' !~ '^\d{4}-\d{2}-\d{2}$'
      or coalesce(input#>>'{note,kind}','') not in ('휴가','교육','교대','훈련','기타')
    then raise exception 'Invalid schedule'; end if;
    perform (input#>>'{note,date}')::date;
    if (input->'note') ? 'endDate' then
      if jsonb_typeof(input#>'{note,endDate}') is distinct from 'string'
        or input#>>'{note,endDate}' !~ '^\d{4}-\d{2}-\d{2}$'
        or (input#>>'{note,endDate}')::date < (input#>>'{note,date}')::date
        or (input#>>'{note,endDate}')::date - (input#>>'{note,date}')::date > 60
      then raise exception 'Invalid schedule'; end if;
    end if;
  elsif (input->'note') ?| array['kind','date','endDate'] then raise exception 'Invalid note'; end if;
  if exists(select 1 from jsonb_array_elements(input->'parents') p where jsonb_typeof(p) <> 'string')
    or (select count(*) from jsonb_array_elements_text(input->'parents')) <> (select count(distinct p) from jsonb_array_elements_text(input->'parents') p)
  then raise exception 'Invalid parent list'; end if;
  -- Serializes this small test board; avoids quota races and parent creation races.
  lock table public.serotonin_test_events in share row exclusive mode;
  select * into old_record from public.serotonin_test_events where id=input->>'id';
  if found then
    if old_record.actor_id=user_id and old_record.note_id=input->>'noteId'
      and old_record.event->'note'=input->'note' and old_record.event->'parents'=input->'parents'
    then return old_record.event; end if;
    raise exception 'Revision ID already used';
  end if;
  if (select count(*) from public.serotonin_test_events) >= 1000 then raise exception 'Test revision limit reached'; end if;
  if (select count(*) from public.serotonin_test_events where actor_id=user_id and saved_at > now()-interval '1 minute') >= 30 then raise exception 'Please wait before saving again'; end if;
  for parent_id in select jsonb_array_elements_text(input->'parents') loop
    if parent_id !~ '^[a-f0-9]{32}$' or parent_id=input->>'id'
      or not exists(select 1 from public.serotonin_test_events where id=parent_id and note_id=input->>'noteId')
    then raise exception 'Parent revision missing or belongs to another note'; end if;
  end loop;
  if jsonb_array_length(input->'parents')=0 and exists(select 1 from public.serotonin_test_events where note_id=input->>'noteId') then raise exception 'Existing note requires a parent revision'; end if;
  record := jsonb_build_object('schema',1,'id',input->>'id','noteId',input->>'noteId','parents',input->'parents',
    'at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'note',input->'note',
    'actor',jsonb_build_object('id',user_id,'kind',case when coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then 'anonymous' else 'account' end));
  insert into public.serotonin_test_events(id,note_id,actor_id,event) values(input->>'id',input->>'noteId',user_id,record);
  return record;
end;
$$;
revoke all on function public.serotonin_test_connection() from public, anon;
revoke all on function public.serotonin_append_test_event(jsonb) from public, anon;
grant execute on function public.serotonin_test_connection() to authenticated;
grant execute on function public.serotonin_append_test_event(jsonb) to authenticated;
commit;

-- ADMIN STEP (run separately, with your own long random code; never commit or share this SQL with the code in it):
--   insert into public.serotonin_test_secret(id, code_hash)
--   values (1, encode(sha256(convert_to('여기에-16자-이상-접속-코드', 'UTF8')), 'hex'))
--   on conflict (id) do update set code_hash = excluded.code_hash;
-- Until a code is set, nobody can join. Changing the code does not remove accounts that already joined.
