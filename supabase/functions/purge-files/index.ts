// Edge Function: removes expired board files from Storage, then forgets their records.
// Called every 10 minutes by pg_cron (see supabase/migrations/0.8.0-cron.sql). It takes no input and only ever deletes
// files the database already reports as expired, so it needs no secret of its own; the service role key that it uses
// is provided by Supabase to the function automatically and never appears in this repository.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const listed = await db.rpc('serotonin_purge_list');
  if (listed.error) return Response.json({ ok: false, step: 'list', message: listed.error.message }, { status: 500 });
  const files: { id: string; path: string }[] = listed.data ?? [];
  if (!files.length) return Response.json({ ok: true, expired: 0, removed: 0 });

  // The stored objects go first (deleting rows with SQL would leave the bytes behind); records are forgotten afterwards.
  const removedObjects = await db.storage.from('board-files').remove(files.map(f => f.path));
  if (removedObjects.error) return Response.json({ ok: false, step: 'remove', message: removedObjects.error.message }, { status: 500 });
  const forgot = await db.rpc('serotonin_purge_forget', { p_ids: files.map(f => f.id) });
  if (forgot.error) return Response.json({ ok: false, step: 'forget', message: forgot.error.message }, { status: 500 });
  return Response.json({ ok: true, expired: files.length, removed: forgot.data });
});
