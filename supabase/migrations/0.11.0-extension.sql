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
    select distinct on (h.note_id) h.note_id, h.event->'note' as n, (h.event->>'at') as at, h.saved_at
    from heads h order by h.note_id, (h.event->>'at') collate "C" desc, h.id desc
  ), live as (
    select l.*, (l.n->>'category') as cat from latest l where not coalesce((l.n->>'deleted')::boolean, false)
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object('kind', s.n->>'kind', 'title', s.n->>'title', 'from', s.d1::text, 'to', s.d2::text) order by s.d1, s.n->>'title'), '[]'::jsonb)
       from (select l.n, (l.n->>'date')::date as d1, coalesce((l.n->>'endDate')::date, (l.n->>'date')::date) as d2 from live l where l.cat = '일정') s
       where s.d1 <= today + 14 and s.d2 >= today),
    (select coalesce(jsonb_agg(jsonb_build_object('title', x.n->>'title', 'assignee', x.n->>'assignee', 'pinned', coalesce((x.n->>'pinned')::boolean, false))
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
