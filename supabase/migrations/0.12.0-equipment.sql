-- Fire equipment inspection board (0.12.0): the shared revision validation also accepts equipment items (category 장비)
-- and inspection sheets (category 점검). Safe to run more than once; it is also part of setup.sql.
begin;

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

commit;
