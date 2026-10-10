-- File sharing (0.7.0). Additive and safe to run more than once; it is also appended to setup.sql.
-- Files live in a private Storage bucket under "<department>/<file id>", are visible only to the same department,
-- are kept for at most 7 days (they leave the file list the moment they expire and are removed right after), and
-- any department member may delete them. Expired objects stay visible to the department's members only so they can
-- be removed: PostgreSQL requires a row to be visible before it can be deleted.
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
