-- Schedules the purge-files Edge Function every 10 minutes. Run after the function is deployed (verify JWT: off).
-- The project address below is public. pg_cron stops while a free project is paused and resumes when it is restored.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('serotonin-purge-files') where exists (select 1 from cron.job where jobname = 'serotonin-purge-files');
select cron.schedule(
  'serotonin-purge-files',
  '*/10 * * * *',
  $$ select net.http_post(url := 'https://uszgkfwucpshubsrokhy.supabase.co/functions/v1/purge-files', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb) $$
);
