-- Upgrade an already-deployed 0.3.x project to 0.4.0 (record limit 1000 -> 20000, read index). Run once in the Supabase SQL Editor.
create index if not exists serotonin_test_events_saved_at on public.serotonin_test_events(saved_at);
do $$
declare d text;
begin
  select pg_get_functiondef('public.serotonin_append_test_event(jsonb)'::regprocedure) into d;
  if position('>= 1000 then raise exception ''Test revision limit' in d) = 0 then
    raise exception 'limit text not found (already updated?)';
  end if;
  execute replace(d, '>= 1000 then raise exception ''Test revision limit', '>= 20000 then raise exception ''Test revision limit');
end
$$;
