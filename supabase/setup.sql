-- Serotonin board: Supabase schema (0.13.0). Safe to run more than once.
-- Run in a dedicated free Supabase project. Enable Anonymous Sign-Ins first.
-- Upgrading a project that ran an older setup.sql? Run supabase/migrations/0.5.0-departments.sql first.
begin;

-- Departments: each has its own access code (stored only as a SHA-256 hash) and sees only its own revisions.
-- rotating = true for 3-team 24h shifts (day changes at 09:00), false for office staff (day changes at midnight).
create table if not exists public.serotonin_depts (
  id text primary key check (id ~ '^[a-z0-9_-]{2,30}$'),
  name text not null check (length(btrim(name)) between 1 and 40),
  rotating boolean not null default true,
  code_hash text not null unique
);

create table if not exists public.serotonin_test_events (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  note_id text not null check (note_id ~ '^[a-f0-9]{32}$'),
  dept text not null references public.serotonin_depts(id),
  actor_id uuid not null,
  saved_at timestamptz not null default now(),
  event jsonb not null
);
create index if not exists serotonin_test_events_saved_at on public.serotonin_test_events(saved_at);
create index if not exists serotonin_test_events_dept_saved_at on public.serotonin_test_events(dept, saved_at);

-- An account (a browser's temporary account) belongs to exactly one department.
create table if not exists public.serotonin_test_members (
  user_id uuid primary key,
  dept text not null references public.serotonin_depts(id),
  name text,
  joined_at timestamptz not null default now()
);
create table if not exists public.serotonin_test_join_failures (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  failed_at timestamptz not null default now()
);

alter table public.serotonin_depts enable row level security;
alter table public.serotonin_test_events enable row level security;
alter table public.serotonin_test_members enable row level security;
alter table public.serotonin_test_join_failures enable row level security;
revoke all on public.serotonin_depts, public.serotonin_test_events, public.serotonin_test_members, public.serotonin_test_join_failures from public, anon, authenticated;
grant select on public.serotonin_test_events to authenticated;

create or replace function public.serotonin_my_dept() returns text
language sql stable security definer set search_path = '' as $$
  select dept from public.serotonin_test_members where user_id = auth.uid();
$$;
create or replace function public.serotonin_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.serotonin_test_members where user_id = auth.uid());
$$;
create or replace function public.serotonin_dept_info() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', d.id, 'name', d.name, 'rotating', d.rotating)
  from public.serotonin_test_members m join public.serotonin_depts d on d.id = m.dept
  where m.user_id = auth.uid();
$$;
revoke all on function public.serotonin_my_dept(), public.serotonin_is_member(), public.serotonin_dept_info() from public, anon;
grant execute on function public.serotonin_my_dept(), public.serotonin_is_member(), public.serotonin_dept_info() to authenticated;

drop policy if exists "test_users_read_events" on public.serotonin_test_events;
drop policy if exists "test_members_read_events" on public.serotonin_test_events;
drop policy if exists "dept_members_read_events" on public.serotonin_test_events;
create policy "dept_members_read_events" on public.serotonin_test_events for select to authenticated
  using (dept = public.serotonin_my_dept());

-- Presenting a department's code once makes this account a member of that department only.
-- Wrong codes are returned (not raised) so that the failure is recorded; five misses lock the account for an hour.
drop function if exists public.serotonin_join_test_board(text);
create or replace function public.serotonin_join_test_board(code text, display_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  found_dept text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.serotonin_is_member() then
    return jsonb_build_object('member', true, 'already', true, 'dept', public.serotonin_dept_info());
  end if;
  if (select count(*) from public.serotonin_test_join_failures where user_id = auth.uid() and failed_at > now() - interval '1 hour') >= 5
  then return jsonb_build_object('member', false, 'error', 'locked'); end if;
  select id into found_dept from public.serotonin_depts
    where code_hash = encode(sha256(convert_to(coalesce(code, ''), 'UTF8')), 'hex');
  if found_dept is not null then
    insert into public.serotonin_test_members(user_id, dept, name)
      values (auth.uid(), found_dept, nullif(left(btrim(coalesce(display_name, '')), 40), ''))
      on conflict do nothing;
    return jsonb_build_object('member', true, 'dept', public.serotonin_dept_info());
  end if;
  insert into public.serotonin_test_join_failures(user_id) values (auth.uid());
  return jsonb_build_object('member', false, 'error', 'invalid');
end;
$$;
revoke all on function public.serotonin_join_test_board(text, text) from public, anon;
grant execute on function public.serotonin_join_test_board(text, text) to authenticated;

create or replace function public.serotonin_test_connection() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return jsonb_build_object('userId',auth.uid(),'mode','public-test','member',public.serotonin_is_member(),'dept',public.serotonin_dept_info());
end;
$$;

revoke all on function public.serotonin_test_connection() from public, anon;
grant execute on function public.serotonin_test_connection() to authenticated;
commit;

-- ===== File sharing (0.7.0) =====
begin;

alter table public.serotonin_depts add column if not exists file_quota_bytes bigint not null default 419430400; -- 400 MB per department

create table if not exists public.serotonin_files (
  id uuid primary key default gen_random_uuid(),
  dept text not null references public.serotonin_depts(id),
  path text not null unique,
  name text not null check (length(name) between 1 and 200),
  size bigint not null check (size between 1 and 52428800),
  mime text check (length(mime) <= 100),
  uploader_id uuid not null,
  uploader_name text,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);
create index if not exists serotonin_files_dept_expires on public.serotonin_files(dept, expires_at);

-- Who uploaded or deleted what (no file contents). Read it in the SQL Editor; clients cannot.
create table if not exists public.serotonin_file_log (
  id bigint generated always as identity primary key,
  dept text not null,
  action text not null check (action in ('upload', 'delete', 'expired')),
  file_name text,
  size bigint,
  by_name text,
  at timestamptz not null default now()
);

alter table public.serotonin_files enable row level security;
alter table public.serotonin_file_log enable row level security;
revoke all on public.serotonin_files, public.serotonin_file_log from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('board-files', 'board-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- Step 1 of an upload: reserve the space and get the object path.
create or replace function public.serotonin_file_begin(p_name text, p_size bigint, p_mime text, p_keep_minutes int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  my text := public.serotonin_my_dept();
  fid uuid := gen_random_uuid();
  quota bigint;
  used bigint;
  who text;
  opath text;
  until timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if my is null then raise exception 'Access code required'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 200 then raise exception 'Invalid file name'; end if;
  if p_size is null or p_size not between 1 and 52428800 then raise exception 'File size must be between 1 byte and 50 MB'; end if;
  if p_keep_minutes is null or p_keep_minutes not between 1 and 10080 then raise exception 'Retention must be between 1 minute and 7 days'; end if;
  if (select count(*) from public.serotonin_files where uploader_id = auth.uid() and created_at > now() - interval '1 hour') >= 40
  then raise exception 'Too many uploads, please wait'; end if;
  select file_quota_bytes into quota from public.serotonin_depts where id = my;
  select coalesce(sum(size), 0) into used from public.serotonin_files where dept = my;
  if used + p_size > quota then raise exception 'Department file space is full'; end if;
  select m.name into who from public.serotonin_test_members m where m.user_id = auth.uid();
  opath := my || '/' || fid::text;
  insert into public.serotonin_files(id, dept, path, name, size, mime, uploader_id, uploader_name, expires_at)
    values (fid, my, opath, btrim(p_name), p_size, left(p_mime, 100), auth.uid(), who, now() + make_interval(mins => p_keep_minutes))
    returning expires_at into until;
  insert into public.serotonin_file_log(dept, action, file_name, size, by_name) values (my, 'upload', btrim(p_name), p_size, who);
  return jsonb_build_object('id', fid, 'path', opath, 'expiresAt', until);
end;
$$;

-- Step 3: the stored object must exist with the announced size before the file becomes visible.
create or replace function public.serotonin_file_finish(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  my text := public.serotonin_my_dept();
  rec public.serotonin_files%rowtype;
begin
  if auth.uid() is null or my is null then raise exception 'Access code required'; end if;
  update public.serotonin_files f set status = 'ready'
    where f.id = p_id and f.dept = my and f.uploader_id = auth.uid() and f.status = 'pending' and f.expires_at > now()
      and exists (select 1 from storage.objects o where o.bucket_id = 'board-files' and o.name = f.path and (o.metadata->>'size')::bigint = f.size)
    returning * into rec;
  if not found then raise exception 'Upload is not complete'; end if;
  return jsonb_build_object('id', rec.id, 'expiresAt', rec.expires_at);
end;
$$;

create or replace function public.serotonin_file_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  my text := public.serotonin_my_dept();
begin
  if auth.uid() is null or my is null then raise exception 'Access code required'; end if;
  return jsonb_build_object(
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path, 'name', f.name, 'size', f.size, 'mime', f.mime,
        'by', f.uploader_name, 'createdAt', f.created_at, 'expiresAt', f.expires_at) order by f.created_at desc)
      from public.serotonin_files f where f.dept = my and f.status = 'ready' and f.expires_at > now()), '[]'::jsonb),
    'used', (select coalesce(sum(size), 0) from public.serotonin_files where dept = my),
    'quota', (select file_quota_bytes from public.serotonin_depts where id = my));
end;
$$;

-- Expired files (and uploads that never finished) still occupying space; the client removes them through the Storage API.
create or replace function public.serotonin_file_expired() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  my text := public.serotonin_my_dept();
begin
  if auth.uid() is null or my is null then raise exception 'Access code required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path)) from (
    select id, path from public.serotonin_files
    where dept = my and (expires_at <= now() or (status = 'pending' and created_at < now() - interval '1 hour'))
    order by expires_at limit 200) f), '[]'::jsonb);
end;
$$;

-- After the object itself was removed through the Storage API, drop its record. Refuses while the object still exists.
create or replace function public.serotonin_file_forget(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  my text := public.serotonin_my_dept();
  rec public.serotonin_files%rowtype;
  who text;
begin
  if auth.uid() is null or my is null then raise exception 'Access code required'; end if;
  select * into rec from public.serotonin_files where id = p_id and dept = my;
  if not found then return false; end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'board-files' and o.name = rec.path) then
    raise exception 'File is still stored';
  end if;
  select m.name into who from public.serotonin_test_members m where m.user_id = auth.uid();
  delete from public.serotonin_files where id = p_id;
  insert into public.serotonin_file_log(dept, action, file_name, size, by_name)
    values (my, case when rec.expires_at <= now() then 'expired' else 'delete' end, rec.name, rec.size, who);
  return true;
end;
$$;

-- Storage permissions are decided by these helpers, never by the path alone.
create or replace function public.serotonin_file_can_upload(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.serotonin_files f
    where f.path = p_path and f.status = 'pending' and f.uploader_id = auth.uid() and f.dept = public.serotonin_my_dept()
      and f.created_at > now() - interval '1 hour');
$$;
create or replace function public.serotonin_file_can_access(p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.serotonin_files f where f.path = p_path and f.dept = public.serotonin_my_dept());
$$;

revoke all on function public.serotonin_file_begin(text, bigint, text, int), public.serotonin_file_finish(uuid), public.serotonin_file_list(),
  public.serotonin_file_expired(), public.serotonin_file_forget(uuid), public.serotonin_file_can_upload(text),
  public.serotonin_file_can_access(text) from public, anon;
grant execute on function public.serotonin_file_begin(text, bigint, text, int), public.serotonin_file_finish(uuid), public.serotonin_file_list(),
  public.serotonin_file_expired(), public.serotonin_file_forget(uuid), public.serotonin_file_can_upload(text),
  public.serotonin_file_can_access(text) to authenticated;

drop policy if exists "board_files_upload" on storage.objects;
drop policy if exists "board_files_read" on storage.objects;
drop policy if exists "board_files_delete" on storage.objects;
drop function if exists public.serotonin_file_can_read(text);
drop function if exists public.serotonin_file_can_delete(text);
create policy "board_files_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'board-files' and public.serotonin_file_can_upload(name));
create policy "board_files_read" on storage.objects for select to authenticated
  using (bucket_id = 'board-files' and public.serotonin_file_can_access(name));
create policy "board_files_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'board-files' and public.serotonin_file_can_access(name));

commit;

-- ===== Operations (0.8.0) =====
begin;

-- ---------- keep-alive: a harmless database round trip anyone may call ----------
create or replace function public.serotonin_ping() returns timestamptz
language sql stable security definer set search_path = '' as $$ select now(); $$;
revoke all on function public.serotonin_ping() from public;
grant execute on function public.serotonin_ping() to anon, authenticated;

-- ---------- shared validation of one revision (used by saving and by restoring) ----------
create or replace function public.serotonin_validate_event(input jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  cat text;
begin
  if octet_length(input::text) > 65000 then raise exception 'Event payload too large'; end if;
  if jsonb_typeof(input) is distinct from 'object'
    or input->>'schema' is distinct from '1'
    or coalesce(input->>'id','') !~ '^[a-f0-9]{32}$'
    or coalesce(input->>'noteId','') !~ '^[a-f0-9]{32}$'
    or jsonb_typeof(input->'parents') is distinct from 'array'
    or jsonb_typeof(input->'note') is distinct from 'object'
  then raise exception 'Invalid event'; end if;
  if jsonb_array_length(input->'parents') > 100 then raise exception 'Too many parents'; end if;
  cat := coalesce(input#>>'{note,category}','');
  if ((input->'note') - array['title','content','author','category','status','pinned','deleted','kind','date','endDate','assignee',
                              'group','code','location','cycle','results']) <> '{}'::jsonb
    or jsonb_typeof(input#>'{note,title}') is distinct from 'string'
    or length(btrim(input#>>'{note,title}')) not between 1 and 120
    or jsonb_typeof(input#>'{note,content}') is distinct from 'string'
    or length(input#>>'{note,content}') > 10000
    or jsonb_typeof(input#>'{note,author}') is distinct from 'string'
    or length(btrim(input#>>'{note,author}')) not between 1 and 40
    or cat not in ('인수인계','공지사항','업무 메모','일정','템플릿','장비','점검')
    or coalesce(input#>>'{note,status}','') not in ('todo','doing','done')
    or jsonb_typeof(input#>'{note,pinned}') is distinct from 'boolean'
    or jsonb_typeof(input#>'{note,deleted}') is distinct from 'boolean'
  then raise exception 'Invalid note'; end if;
  -- Only handover items may name a person in charge.
  if (input->'note') ? 'assignee' and (
      cat <> '인수인계'
      or jsonb_typeof(input#>'{note,assignee}') is distinct from 'string'
      or length(btrim(input#>>'{note,assignee}')) not between 1 and 40)
  then raise exception 'Invalid note'; end if;
  -- Equipment fields only on equipment, results only on inspection sheets.
  if cat <> '장비' and (input->'note') ?| array['group','code','location','cycle'] then raise exception 'Invalid note'; end if;
  if cat <> '점검' and (input->'note') ? 'results' then raise exception 'Invalid note'; end if;
  if cat = '일정' then
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
  elsif cat = '장비' then
    if jsonb_typeof(input#>'{note,group}') is distinct from 'string'
      or length(btrim(input#>>'{note,group}')) not between 1 and 30 or length(input#>>'{note,group}') > 30
      or ((input->'note') ? 'code' and (jsonb_typeof(input#>'{note,code}') is distinct from 'string'
          or length(btrim(input#>>'{note,code}')) = 0 or length(input#>>'{note,code}') > 40))
      or ((input->'note') ? 'location' and (jsonb_typeof(input#>'{note,location}') is distinct from 'string'
          or length(btrim(input#>>'{note,location}')) = 0 or length(input#>>'{note,location}') > 40))
      or jsonb_typeof(input#>'{note,cycle}') is distinct from 'number'
      or (input#>>'{note,cycle}')::numeric <> trunc((input#>>'{note,cycle}')::numeric)
      or (input#>>'{note,cycle}')::numeric not between 1 and 366
      or (input->'note') ?| array['kind','date','endDate']
    then raise exception 'Invalid equipment'; end if;
  elsif cat = '점검' then
    if jsonb_typeof(input#>'{note,date}') is distinct from 'string'
      or input#>>'{note,date}' !~ '^\d{4}-\d{2}-\d{2}$'
      or (input->'note') ?| array['kind','endDate']
      or jsonb_typeof(input#>'{note,results}') is distinct from 'array'
      or jsonb_array_length(input#>'{note,results}') not between 1 and 300
    then raise exception 'Invalid inspection'; end if;
    perform (input#>>'{note,date}')::date;
    if exists (
        select 1 from jsonb_array_elements(input#>'{note,results}') r
        where jsonb_typeof(r) is distinct from 'object'
          or (r - array['e','r','m']) <> '{}'::jsonb
          or jsonb_typeof(r->'e') is distinct from 'string' or r->>'e' !~ '^[a-f0-9]{32}$'
          or jsonb_typeof(r->'r') is distinct from 'string' or r->>'r' not in ('정상','이상','수리','교체')
          or (r ? 'm' and (jsonb_typeof(r->'m') is distinct from 'string' or length(btrim(r->>'m')) = 0 or length(r->>'m') > 200)))
      or (select count(*) from jsonb_array_elements(input#>'{note,results}')) <>
         (select count(distinct r->>'e') from jsonb_array_elements(input#>'{note,results}') r)
    then raise exception 'Invalid inspection'; end if;
  elsif (input->'note') ?| array['kind','date','endDate'] then raise exception 'Invalid note'; end if;
  if exists(select 1 from jsonb_array_elements(input->'parents') p where jsonb_typeof(p) <> 'string')
    or (select count(*) from jsonb_array_elements_text(input->'parents')) <> (select count(distinct p) from jsonb_array_elements_text(input->'parents') p)
  then raise exception 'Invalid parent list'; end if;
end;
$$;
revoke all on function public.serotonin_validate_event(jsonb) from public, anon, authenticated;

create or replace function public.serotonin_append_test_event(input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  user_id uuid := auth.uid();
  my_dept text := public.serotonin_my_dept();
  parent_id text;
  record jsonb;
  old_record public.serotonin_test_events%rowtype;
begin
  if user_id is null then raise exception 'Authentication required'; end if;
  if my_dept is null then raise exception 'Access code required'; end if;
  perform public.serotonin_validate_event(input);
  lock table public.serotonin_test_events in share row exclusive mode;
  select * into old_record from public.serotonin_test_events where id=input->>'id';
  if found then
    if old_record.dept=my_dept and old_record.actor_id=user_id and old_record.note_id=input->>'noteId'
      and old_record.event->'note'=input->'note' and old_record.event->'parents'=input->'parents'
    then return old_record.event; end if;
    raise exception 'Revision ID already used';
  end if;
  if (select count(*) from public.serotonin_test_events where dept=my_dept) >= 20000 then raise exception 'Test revision limit reached'; end if;
  if (select count(*) from public.serotonin_test_events where actor_id=user_id and saved_at > now()-interval '1 minute') >= 30 then raise exception 'Please wait before saving again'; end if;
  for parent_id in select jsonb_array_elements_text(input->'parents') loop
    if parent_id !~ '^[a-f0-9]{32}$' or parent_id=input->>'id'
      or not exists(select 1 from public.serotonin_test_events where id=parent_id and note_id=input->>'noteId' and dept=my_dept)
    then raise exception 'Parent revision missing or belongs to another note'; end if;
  end loop;
  if jsonb_array_length(input->'parents')=0 and exists(select 1 from public.serotonin_test_events where note_id=input->>'noteId') then raise exception 'Existing note requires a parent revision'; end if;
  record := jsonb_build_object('schema',1,'id',input->>'id','noteId',input->>'noteId','parents',input->'parents',
    'at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'note',input->'note',
    'actor',jsonb_build_object('id',user_id,'kind',case when coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then 'anonymous' else 'account' end));
  insert into public.serotonin_test_events(id,note_id,dept,actor_id,event) values(input->>'id',input->>'noteId',my_dept,user_id,record);
  return record;
end;
$$;
revoke all on function public.serotonin_append_test_event(jsonb) from public, anon;
grant execute on function public.serotonin_append_test_event(jsonb) to authenticated;

-- ---------- restore from a backup file ----------
-- Revisions missing from this department are added back with their original time and content. Existing ones are
-- skipped. Every restored revision is marked actor.kind = 'restored' (the original actor is kept), so a restore is
-- always visible in the history; saved_at is the restore time so other browsers pick the rows up.
create or replace function public.serotonin_restore_events(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  my text := public.serotonin_my_dept();
  restorer uuid := auth.uid();
  ev jsonb;
  parent_id text;
  existing public.serotonin_test_events%rowtype;
  added int := 0;
  skipped int := 0;
  total int;
begin
  if restorer is null or my is null then raise exception 'Access code required'; end if;
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 500 then raise exception 'Invalid restore batch'; end if;
  lock table public.serotonin_test_events in share row exclusive mode;
  select count(*) into total from public.serotonin_test_events where dept = my;
  for ev in select value from jsonb_array_elements(p_events) loop
    perform public.serotonin_validate_event(ev);
    if coalesce(ev->>'at', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' or (ev->>'at')::timestamptz > now() + interval '1 minute'
    then raise exception 'Invalid revision time'; end if;
    select * into existing from public.serotonin_test_events where id = ev->>'id';
    if found then
      if existing.dept <> my then raise exception 'Revision ID already used'; end if;
      skipped := skipped + 1;
      continue;
    end if;
    if total + added >= 20000 then raise exception 'Test revision limit reached'; end if;
    for parent_id in select jsonb_array_elements_text(ev->'parents') loop
      if not exists (select 1 from public.serotonin_test_events where id = parent_id and note_id = ev->>'noteId' and dept = my)
      then raise exception 'Parent revision missing or belongs to another note'; end if;
    end loop;
    if jsonb_array_length(ev->'parents') = 0 and exists (select 1 from public.serotonin_test_events where note_id = ev->>'noteId')
    then raise exception 'Existing note requires a parent revision'; end if;
    insert into public.serotonin_test_events(id, note_id, dept, actor_id, event) values (
      ev->>'id', ev->>'noteId', my, restorer,
      jsonb_build_object('schema', 1, 'id', ev->>'id', 'noteId', ev->>'noteId', 'parents', ev->'parents', 'at', ev->>'at', 'note', ev->'note',
        'actor', jsonb_build_object('id', restorer, 'kind', 'restored', 'original', case when jsonb_typeof(ev->'actor') = 'object' then ev->'actor' else 'null'::jsonb end)));
    added := added + 1;
  end loop;
  return jsonb_build_object('added', added, 'skipped', skipped);
end;
$$;
revoke all on function public.serotonin_restore_events(jsonb) from public, anon;
grant execute on function public.serotonin_restore_events(jsonb) to authenticated;

-- ---------- server-side purge of expired files (called by the purge-files Edge Function with the service role) ----------
create or replace function public.serotonin_purge_list() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'path', x.path)), '[]'::jsonb) from (
    select id, path from public.serotonin_files
    where expires_at <= now() or (status = 'pending' and created_at < now() - interval '1 hour')
    order by expires_at limit 500) x;
$$;
create or replace function public.serotonin_purge_forget(p_ids uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare
  fid uuid;
  rec public.serotonin_files%rowtype;
  removed int := 0;
begin
  foreach fid in array p_ids loop
    select * into rec from public.serotonin_files where id = fid;
    if not found then continue; end if;
    if exists (select 1 from storage.objects o where o.bucket_id = 'board-files' and o.name = rec.path) then continue; end if;
    delete from public.serotonin_files where id = fid;
    insert into public.serotonin_file_log(dept, action, file_name, size, by_name) values (rec.dept, 'expired', rec.name, rec.size, null);
    removed := removed + 1;
  end loop;
  return removed;
end;
$$;
revoke all on function public.serotonin_purge_list(), public.serotonin_purge_forget(uuid[]) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.serotonin_purge_list(), public.serotonin_purge_forget(uuid[]) to service_role;
  end if;
end
$$;

-- ---------- administrator ----------
-- An account becomes administrator by entering the administrator code (stored only as a hash in serotonin_settings).
-- Administrators manage departments, codes and members; they gain no access to anyone's notes or files.
create table if not exists public.serotonin_admins (
  user_id uuid primary key,
  since timestamptz not null default now()
);
create table if not exists public.serotonin_settings (
  key text primary key,
  value text not null
);
alter table public.serotonin_admins enable row level security;
alter table public.serotonin_settings enable row level security;
revoke all on public.serotonin_admins, public.serotonin_settings from public, anon, authenticated;

create or replace function public.serotonin_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.serotonin_admins where user_id = auth.uid());
$$;

create or replace function public.serotonin_admin_login(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if public.serotonin_is_admin() then return jsonb_build_object('admin', true); end if;
  if (select count(*) from public.serotonin_test_join_failures where user_id = auth.uid() and failed_at > now() - interval '1 hour') >= 5
  then return jsonb_build_object('admin', false, 'error', 'locked'); end if;
  if exists (select 1 from public.serotonin_settings where key = 'admin_code_hash'
             and value = encode(sha256(convert_to(coalesce(p_code, ''), 'UTF8')), 'hex')) then
    insert into public.serotonin_admins(user_id) values (auth.uid()) on conflict do nothing;
    return jsonb_build_object('admin', true);
  end if;
  insert into public.serotonin_test_join_failures(user_id) values (auth.uid());
  return jsonb_build_object('admin', false, 'error', 'invalid');
end;
$$;

create or replace function public.serotonin_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  return jsonb_build_object(
    'depts', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'rotating', d.rotating,
        'quotaMb', d.file_quota_bytes / 1048576,
        'members', (select count(*) from public.serotonin_test_members m where m.dept = d.id),
        'events', (select count(*) from public.serotonin_test_events e where e.dept = d.id),
        'filesBytes', (select coalesce(sum(f.size), 0) from public.serotonin_files f where f.dept = d.id)) order by d.id), '[]'::jsonb)
      from public.serotonin_depts d),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('userId', m.user_id, 'short', left(m.user_id::text, 8), 'dept', m.dept,
        'name', m.name, 'joinedAt', m.joined_at) order by m.joined_at desc), '[]'::jsonb) from public.serotonin_test_members m),
    'admins', (select count(*) from public.serotonin_admins));
end;
$$;

-- A readable, random access code (96 bits). It is returned once; only its hash is stored.
create or replace function public.serotonin_make_code() returns text
language sql volatile set search_path = '' as $$
  select regexp_replace(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), '(.{4})(?=.)', '\1-', 'g');
$$;
revoke all on function public.serotonin_make_code() from public, anon, authenticated;

create or replace function public.serotonin_admin_dept_create(p_id text, p_name text, p_rotating boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  code text := public.serotonin_make_code();
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  if p_id is null or p_id !~ '^[a-z0-9_-]{2,30}$' then raise exception 'Invalid department id'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 40 then raise exception 'Invalid department name'; end if;
  if exists (select 1 from public.serotonin_depts where id = p_id) then raise exception 'Department id already exists'; end if;
  insert into public.serotonin_depts(id, name, rotating, code_hash)
    values (p_id, btrim(p_name), coalesce(p_rotating, true), encode(sha256(convert_to(code, 'UTF8')), 'hex'));
  return jsonb_build_object('id', p_id, 'code', code);
end;
$$;

create or replace function public.serotonin_admin_dept_save(p_id text, p_name text, p_rotating boolean, p_quota_mb int) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 40 then raise exception 'Invalid department name'; end if;
  if p_quota_mb is null or p_quota_mb not between 10 and 1000 then raise exception 'Quota must be between 10 and 1000 MB'; end if;
  update public.serotonin_depts set name = btrim(p_name), rotating = coalesce(p_rotating, true), file_quota_bytes = p_quota_mb::bigint * 1048576
    where id = p_id;
  return found;
end;
$$;

-- New code for a department: new members need it, existing members stay. The old code stops working at once.
create or replace function public.serotonin_admin_dept_newcode(p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  code text := public.serotonin_make_code();
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  update public.serotonin_depts set code_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex') where id = p_id;
  if not found then raise exception 'Unknown department'; end if;
  return jsonb_build_object('id', p_id, 'code', code);
end;
$$;

-- Removes an account from its department (it can join another one afterwards). Its past notes stay.
create or replace function public.serotonin_admin_member_remove(p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  delete from public.serotonin_test_members where user_id = p_user;
  return found;
end;
$$;

revoke all on function public.serotonin_is_admin(), public.serotonin_admin_login(text), public.serotonin_admin_overview(),
  public.serotonin_admin_dept_create(text, text, boolean), public.serotonin_admin_dept_save(text, text, boolean, int),
  public.serotonin_admin_dept_newcode(text), public.serotonin_admin_member_remove(uuid) from public, anon;
grant execute on function public.serotonin_is_admin(), public.serotonin_admin_login(text), public.serotonin_admin_overview(),
  public.serotonin_admin_dept_create(text, text, boolean), public.serotonin_admin_dept_save(text, text, boolean, int),
  public.serotonin_admin_dept_newcode(text), public.serotonin_admin_member_remove(uuid) to authenticated;

commit;

-- ===== Telegram announcements (0.10.0) =====
-- Announces schedules (category '일정') of a department in that department's own Telegram chat: a morning summary of today,
-- an evening notice of tomorrow, and new/changed/deleted schedules. Handover items are never announced.
-- The bot token is NOT stored here: it is an Edge Function secret (TELEGRAM_BOT_TOKEN) that the administrator enters in Supabase.
begin;

create table if not exists public.serotonin_telegram (
  dept text primary key references public.serotonin_depts(id) on delete cascade,
  chat_id bigint,
  enabled boolean not null default false,
  notify_morning boolean not null default true,
  notify_evening boolean not null default true,
  notify_changes boolean not null default true,
  morning_min int not null default 540 check (morning_min between 0 and 1439),
  evening_min int not null default 1080 check (evening_min between 0 and 1439),
  last_morning date,
  last_evening date,
  change_mark timestamptz not null default now(),
  link_hash text,
  link_expires timestamptz,
  last_error text
);
create unique index if not exists serotonin_telegram_chat on public.serotonin_telegram(chat_id) where chat_id is not null;
alter table public.serotonin_telegram enable row level security;
revoke all on public.serotonin_telegram from public, anon, authenticated;

-- Current state of every schedule note of a department (latest head revision, like BoardCore.buildNotes).
create or replace function public.serotonin_telegram_schedules(p_dept text)
returns table(note_id text, kind text, title text, first_day date, last_day date, deleted boolean, first_saved timestamptz, last_saved timestamptz)
language sql stable security definer set search_path = '' as $$
  with ev as (
    select e.id, e.note_id, e.event, e.saved_at from public.serotonin_test_events e
    where e.dept = p_dept and e.event->'note'->>'category' = '일정'
  ), refs as (
    select distinct ev.note_id, p.pid from ev, jsonb_array_elements_text(ev.event->'parents') as p(pid)
  ), heads as (
    select ev.* from ev where not exists (select 1 from refs r where r.note_id = ev.note_id and r.pid = ev.id)
  ), latest as (
    select distinct on (h.note_id) h.* from heads h order by h.note_id, (h.event->>'at') collate "C" desc, h.id desc
  )
  select l.note_id, l.event->'note'->>'kind', l.event->'note'->>'title',
    (l.event->'note'->>'date')::date,
    coalesce((l.event->'note'->>'endDate')::date, (l.event->'note'->>'date')::date),
    coalesce((l.event->'note'->>'deleted')::boolean, false),
    (select min(x.saved_at) from ev x where x.note_id = l.note_id),
    (select max(x.saved_at) from ev x where x.note_id = l.note_id)
  from latest l;
$$;

create or replace function public.serotonin_telegram_line(p_prefix text, p_kind text, p_title text, p_from date, p_to date) returns text
language sql immutable set search_path = '' as $$
  select '• ' || p_prefix || '[' || p_kind || '] ' || p_title
    || case when p_to > p_from
         then ' (' || extract(month from p_from)::int || '/' || extract(day from p_from)::int || '~'
              || extract(month from p_to)::int || '/' || extract(day from p_to)::int || ')'
         else '' end;
$$;

create or replace function public.serotonin_telegram_daylabel(p_day date) returns text
language sql immutable set search_path = '' as $$
  select extract(month from p_day)::int || '월 ' || extract(day from p_day)::int || '일('
    || (array['일','월','화','수','목','금','토'])[extract(dow from p_day)::int + 1] || ')';
$$;

-- Team on duty on a calendar day: team 1 on 2026-10-08, then 2, 3, 1 ... (same rule as BoardCore.teamOn).
create or replace function public.serotonin_telegram_team(p_day date) returns int
language sql immutable set search_path = '' as $$
  select (((p_day - date '2026-10-08') % 3) + 3) % 3 + 1;
$$;

-- Schedules covering a day as text lines (at most 15), or null when there are none.
create or replace function public.serotonin_telegram_day_text(p_dept text, p_day date) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  rows_ text[];
  n int;
begin
  select array_agg(public.serotonin_telegram_line('', s.kind, s.title, s.first_day, s.last_day) order by s.first_day, s.title, s.note_id), count(*)::int
    into rows_, n
    from public.serotonin_telegram_schedules(p_dept) s
    where not s.deleted and p_day between s.first_day and s.last_day;
  if n = 0 or rows_ is null then return null; end if;
  if n > 15 then
    return array_to_string(rows_[1:15], E'\n') || E'\n… 외 ' || (n - 15) || '건';
  end if;
  return array_to_string(rows_, E'\n');
end;
$$;

-- Messages that are due at p_now (nothing is sent here: the Edge Function sends them and then calls serotonin_telegram_done).
create or replace function public.serotonin_telegram_due_at(p_now timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  kst timestamp := p_now at time zone 'Asia/Seoul';
  today date := (p_now at time zone 'Asia/Seoul')::date;
  mins int := extract(hour from (p_now at time zone 'Asia/Seoul'))::int * 60 + extract(minute from (p_now at time zone 'Asia/Seoul'))::int;
  jobs jsonb := '[]'::jsonb;
  body text;
  lines text[];
  mark timestamptz;
begin
  for r in
    select t.*, d.name as dname, d.rotating from public.serotonin_telegram t
    join public.serotonin_depts d on d.id = t.dept
    where t.enabled and t.chat_id is not null
  loop
    if r.notify_morning and (r.last_morning is null or r.last_morning < today) and mins >= r.morning_min and mins < r.morning_min + 180 then
      body := public.serotonin_telegram_day_text(r.dept, today);
      if r.rotating or body is not null then
        jobs := jobs || jsonb_build_object('dept', r.dept, 'chat', r.chat_id, 'kind', 'morning', 'mark', today::text,
          'text', '📅 오늘 ' || public.serotonin_telegram_daylabel(today) || ' 일정'
            || case when r.rotating then E'\n근무: ' || public.serotonin_telegram_team(today) || '팀' else '' end
            || E'\n' || coalesce(body, '등록된 일정이 없습니다.'));
      else
        update public.serotonin_telegram set last_morning = today where dept = r.dept;
      end if;
    end if;

    if r.notify_evening and (r.last_evening is null or r.last_evening < today) and mins >= r.evening_min and mins < r.evening_min + 180 then
      body := public.serotonin_telegram_day_text(r.dept, today + 1);
      if body is null then
        update public.serotonin_telegram set last_evening = today where dept = r.dept;
      else
        jobs := jobs || jsonb_build_object('dept', r.dept, 'chat', r.chat_id, 'kind', 'evening', 'mark', today::text,
          'text', '🔔 내일 ' || public.serotonin_telegram_daylabel(today + 1) || ' 일정'
            || case when r.rotating then E'\n근무: ' || public.serotonin_telegram_team(today + 1) || '팀 (09:00 교대)' else '' end
            || E'\n' || body);
      end if;
    end if;

    if r.notify_changes then
      -- wait until three quiet minutes have passed since the last save, so that several edits go out as one message
      select max(e.saved_at) into mark from public.serotonin_test_events e
        where e.dept = r.dept and e.event->'note'->>'category' = '일정' and e.saved_at > r.change_mark;
      if mark is not null and mark <= p_now - interval '3 minutes' then
        select array_agg(public.serotonin_telegram_line(
            case when s.first_saved > r.change_mark then '새 일정 ' when s.deleted then '삭제 ' else '변경 ' end,
            s.kind, s.title, s.first_day, s.last_day) order by s.last_saved, s.note_id)
          into lines
          from public.serotonin_telegram_schedules(r.dept) s
          where s.last_saved > r.change_mark and not (s.deleted and s.first_saved > r.change_mark);
        if lines is null then
          update public.serotonin_telegram set change_mark = mark where dept = r.dept;
        else
          jobs := jobs || jsonb_build_object('dept', r.dept, 'chat', r.chat_id, 'kind', 'changes', 'mark', mark::text,
            'text', E'🗓 일정이 바뀌었습니다\n'
              || case when array_length(lines, 1) > 15 then array_to_string(lines[1:15], E'\n') || E'\n… 외 ' || (array_length(lines, 1) - 15) || '건'
                      else array_to_string(lines, E'\n') end);
        end if;
      end if;
    end if;
  end loop;
  return jobs;
end;
$$;
create or replace function public.serotonin_telegram_due() returns jsonb
language sql security definer set search_path = '' as $$ select public.serotonin_telegram_due_at(now()); $$;

-- The Edge Function reports a successful send: the message will not be sent again.
create or replace function public.serotonin_telegram_done(p_dept text, p_kind text, p_mark text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind = 'morning' then update public.serotonin_telegram set last_morning = p_mark::date, last_error = null where dept = p_dept;
  elsif p_kind = 'evening' then update public.serotonin_telegram set last_evening = p_mark::date, last_error = null where dept = p_dept;
  elsif p_kind = 'changes' then update public.serotonin_telegram set change_mark = p_mark::timestamptz, last_error = null where dept = p_dept;
  else raise exception 'Unknown kind'; end if;
end;
$$;
-- A failed send is remembered; a chat the bot can no longer write to switches the announcements off.
create or replace function public.serotonin_telegram_failed(p_dept text, p_message text, p_disable boolean) returns void
language sql security definer set search_path = '' as $$
  update public.serotonin_telegram set last_error = left(coalesce(p_message, 'error'), 200), enabled = enabled and not coalesce(p_disable, false)
  where dept = p_dept;
$$;
-- Finishes linking: the one-time code was typed in the chat. Returns the department, or null for an unknown/expired code.
create or replace function public.serotonin_telegram_link_finish(p_code text, p_chat bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare
  found_dept text;
begin
  select dept into found_dept from public.serotonin_telegram
    where link_hash = encode(sha256(convert_to(coalesce(p_code, ''), 'UTF8')), 'hex') and link_expires > now();
  if found_dept is null then return null; end if;
  if exists (select 1 from public.serotonin_telegram where chat_id = p_chat and dept <> found_dept) then raise exception 'Chat already linked'; end if;
  update public.serotonin_telegram set chat_id = p_chat, link_hash = null, link_expires = null, last_error = null where dept = found_dept;
  return found_dept;
end;
$$;
create or replace function public.serotonin_telegram_chat(p_dept text) returns bigint
language sql stable security definer set search_path = '' as $$
  select chat_id from public.serotonin_telegram where dept = p_dept;
$$;

revoke all on function public.serotonin_telegram_schedules(text), public.serotonin_telegram_line(text, text, text, date, date),
  public.serotonin_telegram_daylabel(date), public.serotonin_telegram_team(date), public.serotonin_telegram_day_text(text, date),
  public.serotonin_telegram_due_at(timestamptz), public.serotonin_telegram_due(), public.serotonin_telegram_done(text, text, text),
  public.serotonin_telegram_failed(text, text, boolean), public.serotonin_telegram_link_finish(text, bigint),
  public.serotonin_telegram_chat(text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.serotonin_telegram_due(), public.serotonin_telegram_done(text, text, text),
      public.serotonin_telegram_failed(text, text, boolean), public.serotonin_telegram_link_finish(text, bigint),
      public.serotonin_telegram_chat(text) to service_role;
  end if;
end
$$;

-- ---------- administrator screen ----------
create or replace function public.serotonin_admin_telegram_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name,
      'linked', t.chat_id is not null, 'enabled', coalesce(t.enabled, false),
      'morning', coalesce(t.notify_morning, true), 'evening', coalesce(t.notify_evening, true), 'changes', coalesce(t.notify_changes, true),
      'morningMin', coalesce(t.morning_min, 540), 'eveningMin', coalesce(t.evening_min, 1080),
      'linkPending', t.link_hash is not null and t.link_expires > now(), 'error', t.last_error) order by d.id)
    from public.serotonin_depts d left join public.serotonin_telegram t on t.dept = d.id), '[]'::jsonb);
end;
$$;

create or replace function public.serotonin_admin_telegram_save(p_dept text, p_enabled boolean, p_morning boolean, p_evening boolean,
  p_changes boolean, p_morning_min int, p_evening_min int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  cur public.serotonin_telegram%rowtype;
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  if not exists (select 1 from public.serotonin_depts where id = p_dept) then raise exception 'Unknown department'; end if;
  if p_morning_min is null or p_morning_min not between 0 and 1439 or p_evening_min is null or p_evening_min not between 0 and 1439
  then raise exception 'Invalid time'; end if;
  insert into public.serotonin_telegram(dept) values (p_dept) on conflict do nothing;
  select * into cur from public.serotonin_telegram where dept = p_dept;
  if coalesce(p_enabled, false) and cur.chat_id is null then raise exception 'Telegram chat not linked'; end if;
  -- switching on starts from now: older schedules are not announced afterwards
  update public.serotonin_telegram set
    enabled = coalesce(p_enabled, false),
    notify_morning = coalesce(p_morning, true), notify_evening = coalesce(p_evening, true), notify_changes = coalesce(p_changes, true),
    morning_min = p_morning_min, evening_min = p_evening_min,
    change_mark = case when coalesce(p_enabled, false) and not cur.enabled then now() else change_mark end,
    last_error = case when coalesce(p_enabled, false) and not cur.enabled then null else last_error end
    where dept = p_dept;
  return true;
end;
$$;

-- One-time code (12 characters, valid 15 minutes) to type in the chat as "/link@botname CODE". Only its hash is stored.
create or replace function public.serotonin_admin_telegram_link_start(p_dept text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  code text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  if not exists (select 1 from public.serotonin_depts where id = p_dept) then raise exception 'Unknown department'; end if;
  insert into public.serotonin_telegram(dept) values (p_dept) on conflict do nothing;
  update public.serotonin_telegram set link_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex'), link_expires = now() + interval '15 minutes'
    where dept = p_dept;
  return jsonb_build_object('dept', p_dept, 'code', code);
end;
$$;

create or replace function public.serotonin_admin_telegram_unlink(p_dept text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not public.serotonin_is_admin() then raise exception 'Administrator required'; end if;
  update public.serotonin_telegram set chat_id = null, enabled = false, link_hash = null, link_expires = null where dept = p_dept;
  return found;
end;
$$;

revoke all on function public.serotonin_admin_telegram_list(), public.serotonin_admin_telegram_save(text, boolean, boolean, boolean, boolean, int, int),
  public.serotonin_admin_telegram_link_start(text), public.serotonin_admin_telegram_unlink(text) from public, anon;
grant execute on function public.serotonin_admin_telegram_list(), public.serotonin_admin_telegram_save(text, boolean, boolean, boolean, boolean, int, int),
  public.serotonin_admin_telegram_link_start(text), public.serotonin_admin_telegram_unlink(text) to authenticated;

commit;

-- ===== Browser extension support (0.11.0) =====
-- One small call for the extension: the member's department, today's day, upcoming schedules and the open handover items.
-- Reads only the caller's own department. "Today" follows the department: 09:00 KST shift day for rotating departments, KST midnight otherwise.
begin;

create or replace function public.serotonin_member_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  my text := public.serotonin_my_dept();
  rot boolean;
  dname text;
  today date;
  sched jsonb;
  ho jsonb;
  ho_count int;
begin
  if auth.uid() is null or my is null then raise exception 'Access code required'; end if;
  select d.name, d.rotating into dname, rot from public.serotonin_depts d where d.id = my;
  today := case when rot then (now() at time zone 'UTC')::date else (now() at time zone 'Asia/Seoul')::date end;
  with ev as (
    select e.id, e.note_id, e.event, e.saved_at from public.serotonin_test_events e
    where e.dept = my and e.event->'note'->>'category' in ('일정', '인수인계')
  ), refs as (
    select distinct ev.note_id, p.pid from ev, jsonb_array_elements_text(ev.event->'parents') as p(pid)
  ), heads as (
    select ev.* from ev where not exists (select 1 from refs r where r.note_id = ev.note_id and r.pid = ev.id)
  ), latest as (
    select distinct on (h.note_id) h.note_id, h.event->'note' as n, (h.event->>'at') as at, h.saved_at,
      (select jsonb_agg(h2.id order by h2.id) from heads h2 where h2.note_id = h.note_id) as head_ids
    from heads h order by h.note_id, (h.event->>'at') collate "C" desc, h.id desc
  ), live as (
    select l.*, (l.n->>'category') as cat from latest l where not coalesce((l.n->>'deleted')::boolean, false)
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object('kind', s.n->>'kind', 'title', s.n->>'title', 'from', s.d1::text, 'to', s.d2::text) order by s.d1, s.n->>'title'), '[]'::jsonb)
       from (select l.n, (l.n->>'date')::date as d1, coalesce((l.n->>'endDate')::date, (l.n->>'date')::date) as d2 from live l where l.cat = '일정') s
       where s.d1 <= today + 14 and s.d2 >= today),
    (select coalesce(jsonb_agg(jsonb_build_object('id', x.note_id, 'heads', x.head_ids, 'note', x.n,
         'title', x.n->>'title', 'assignee', x.n->>'assignee', 'pinned', coalesce((x.n->>'pinned')::boolean, false))
       order by coalesce((x.n->>'pinned')::boolean, false) desc, x.saved_at), '[]'::jsonb)
       from (select * from live where cat = '인수인계' and n->>'status' <> 'done' order by coalesce((n->>'pinned')::boolean, false) desc, saved_at limit 50) x),
    (select count(*)::int from live where cat = '인수인계' and n->>'status' <> 'done')
  into sched, ho, ho_count;
  return jsonb_build_object('dept', jsonb_build_object('id', my, 'name', dname, 'rotating', rot), 'today', today::text,
    'schedules', sched, 'handover', ho, 'handoverCount', ho_count);
end;
$$;
revoke all on function public.serotonin_member_summary() from public, anon;
grant execute on function public.serotonin_member_summary() to authenticated;

commit;

-- ADMIN: create a department (run separately; node scripts/new-dept.mjs prints this with a generated code's hash,
-- so the code itself never has to be typed into SQL):
--   insert into public.serotonin_depts(id, name, rotating, code_hash)
--   values ('dept2', '2부서', true, '<sha256 hex of the access code>');
-- Rename:            update public.serotonin_depts set name = '구급대' where id = 'dept1';
-- Office (no shifts): update public.serotonin_depts set rotating = false where id = 'dept2';
-- Who joined where:  select d.name, m.name as person, m.joined_at from public.serotonin_test_members m join public.serotonin_depts d on d.id = m.dept order by 1, 3;
-- Same person in two departments (by typed name): select name, count(distinct dept) from public.serotonin_test_members where name is not null group by name having count(distinct dept) > 1;
-- Remove an account from its department (it can then join another): delete from public.serotonin_test_members where user_id = '<uuid>';
