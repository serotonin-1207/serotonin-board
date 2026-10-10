-- Operations (0.8.0): keep-alive ping, server-side purge helpers, backup restore, administrator functions.
-- Safe to run more than once; it is also appended to setup.sql (which no longer carries the old append function).
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
