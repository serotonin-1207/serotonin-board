-- Templates and assignee (0.9.0): the shared revision validation also accepts the 템플릿 category and an optional
-- assignee on handover items. Safe to run more than once; it is also part of setup.sql.
begin;

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

commit;
