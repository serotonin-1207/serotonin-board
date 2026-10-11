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
