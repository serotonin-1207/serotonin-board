-- Serotonin board: Supabase schema (0.5.0, departments). Safe to run more than once.
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
  if ((input->'note') - array['title','content','author','category','status','pinned','deleted','kind','date','endDate','assignee']) <> '{}'::jsonb
    or jsonb_typeof(input#>'{note,title}') is distinct from 'string'
    or length(btrim(input#>>'{note,title}')) not between 1 and 120
    or jsonb_typeof(input#>'{note,content}') is distinct from 'string'
    or length(input#>>'{note,content}') > 10000
    or jsonb_typeof(input#>'{note,author}') is distinct from 'string'
    or length(btrim(input#>>'{note,author}')) not between 1 and 40
    or coalesce(input#>>'{note,category}','') not in ('인수인계','공지사항','업무 메모','일정','템플릿')
    or coalesce(input#>>'{note,status}','') not in ('todo','doing','done')
    or jsonb_typeof(input#>'{note,pinned}') is distinct from 'boolean'
    or jsonb_typeof(input#>'{note,deleted}') is distinct from 'boolean'
  then raise exception 'Invalid note'; end if;
  -- Only handover items may name a person in charge.
  if (input->'note') ? 'assignee' and (
      input#>>'{note,category}' <> '인수인계'
      or jsonb_typeof(input#>'{note,assignee}') is distinct from 'string'
      or length(btrim(input#>>'{note,assignee}')) not between 1 and 40)
  then raise exception 'Invalid note'; end if;
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

-- ADMIN: create a department (run separately; node scripts/new-dept.mjs prints this with a generated code's hash,
-- so the code itself never has to be typed into SQL):
--   insert into public.serotonin_depts(id, name, rotating, code_hash)
--   values ('dept2', '2부서', true, '<sha256 hex of the access code>');
-- Rename:            update public.serotonin_depts set name = '구급대' where id = 'dept1';
-- Office (no shifts): update public.serotonin_depts set rotating = false where id = 'dept2';
-- Who joined where:  select d.name, m.name as person, m.joined_at from public.serotonin_test_members m join public.serotonin_depts d on d.id = m.dept order by 1, 3;
-- Same person in two departments (by typed name): select name, count(distinct dept) from public.serotonin_test_members where name is not null group by name having count(distinct dept) > 1;
-- Remove an account from its department (it can then join another): delete from public.serotonin_test_members where user_id = '<uuid>';
