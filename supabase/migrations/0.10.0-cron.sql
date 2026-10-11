-- Runs the telegram-notify Edge Function every 5 minutes. Run after the function is deployed (verify JWT: off).
-- The project address below is public. Nothing is sent unless an administrator linked a chat and switched announcements on.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('serotonin-telegram') where exists (select 1 from cron.job where jobname = 'serotonin-telegram');
select cron.schedule(
  'serotonin-telegram',
  '*/5 * * * *',
  $$ select net.http_post(url := 'https://uszgkfwucpshubsrokhy.supabase.co/functions/v1/telegram-notify', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{"action":"tick"}'::jsonb) $$
);
