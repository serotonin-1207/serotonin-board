import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const U1 = '11111111-1111-1111-1111-111111111111',
  U2 = '12121212-1212-1212-1212-121212121212',
  U3 = '33333333-3333-3333-3333-333333333333',
  ADMIN = '99999999-9999-9999-9999-999999999999';
const ADMIN_CODE = 'admin-code-for-tests-0000';
const id = n => n.toString(16).padStart(32, '0');
const sha = text => `encode(sha256(convert_to('${text}','UTF8')),'hex')`;
async function as(user, dept = 'd1', member = true) {
  await db.exec('reset role;');
  if (member && user) await db.query('insert into public.serotonin_test_members(user_id,dept,name) values($1,$2,$3) on conflict do nothing', [user, dept, 'n-' + user.slice(0, 2)]);
  await db.query("select set_config('request.test.user',$1,false),set_config('request.test.jwt',$2,false)", [user, JSON.stringify({ is_anonymous: true })]);
  await db.exec('set role authenticated;');
}
async function sql(statement, params) {
  await db.exec('reset role;');
  return db.query(statement, params);
}
const note = (title, extra = {}) => ({ title, content: '', author: '홍길동', category: '인수인계', status: 'todo', pinned: false, deleted: false, ...extra });
const ev = (n, noteN, at, parents = [], extra = {}) => ({
  schema: 1, id: id(n), noteId: id(noteN), parents: parents.map(id), at, note: note('항목 ' + noteN, extra), actor: { id: 'orig-' + n, kind: 'anonymous' },
});
const restore = events => db.query('select public.serotonin_restore_events($1::jsonb) as r', [JSON.stringify(events)]).then(r => r.rows[0].r);
const events = () => db.query('select event, saved_at from public.serotonin_test_events order by (event->>\'at\'), id').then(r => r.rows);

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.test.user',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.test.jwt',true),''),'{}')::jsonb$$;
   create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
   create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
   alter table storage.objects enable row level security;
   grant usage on schema public,auth,storage to anon,authenticated,service_role;`);
  await db.exec(await fs.readFile('supabase/setup.sql', 'utf8'));
  await db.exec(`insert into public.serotonin_depts(id,name,rotating,code_hash) values('d1','1부서',true,${sha('code-one-1234567890')}),('d2','2부서',true,${sha('code-two-1234567890')});`);
  await db.exec(`insert into public.serotonin_settings(key,value) values('admin_code_hash',${sha(ADMIN_CODE)});`);
});
after(async () => {
  await db?.close();
});

test('the keep-alive ping works without any login', async () => {
  await db.exec('reset role;set role anon;');
  const r = await db.query('select public.serotonin_ping() as t');
  assert.ok(Date.parse(r.rows[0].t) > 0);
  await db.exec('reset role;');
});

test('restoring a backup brings back missing revisions with their original time, marks them restored and skips existing ones', async () => {
  await as(U1);
  const backup = [ev(1, 1, '2026-10-08T01:00:00.000Z'), ev(2, 1, '2026-10-09T03:00:00.000Z', [1], { status: 'done' }), ev(3, 2, '2026-10-09T01:00:00.000Z')];
  assert.deepEqual(await restore(backup), { added: 3, skipped: 0 });
  const rows = await events();
  assert.deepEqual(rows.map(r => r.event.at), ['2026-10-08T01:00:00.000Z', '2026-10-09T01:00:00.000Z', '2026-10-09T03:00:00.000Z']);
  assert.equal(rows[0].event.actor.kind, 'restored');
  assert.equal(rows[0].event.actor.original.kind, 'anonymous');
  assert.equal(rows[0].event.actor.id, U1);
  assert.ok(Date.now() - Date.parse(rows[0].saved_at) < 60000); // saved_at is the restore time, so other browsers receive the rows
  assert.deepEqual(await restore(backup), { added: 0, skipped: 3 }); // running it twice changes nothing
});

test('restore refuses broken or foreign data: missing parents, invalid notes, future times, other departments, huge batches', async () => {
  await as(U1);
  await assert.rejects(restore([ev(10, 5, '2026-10-09T01:00:00.000Z', [99])]), /Parent revision/);
  await assert.rejects(restore([ev(11, 6, '2026-10-09T01:00:00.000Z', [], { title: '' })]), /Invalid note/);
  await assert.rejects(restore([ev(12, 7, '2999-01-01T00:00:00.000Z')]), /Invalid revision time/);
  await assert.rejects(restore([{ ...ev(13, 8, '2026-10-09T01:00:00.000Z'), at: 'yesterday' }]), /Invalid revision time/);
  await assert.rejects(restore([ev(14, 1, '2026-10-09T05:00:00.000Z')]), /requires a parent/); // a second root for an existing note
  await assert.rejects(restore(Array.from({ length: 501 }, (_, i) => ev(1000 + i, 1000 + i, '2026-10-09T01:00:00.000Z'))), /Invalid restore batch/);
  await as(U2, 'd2');
  await assert.rejects(restore([ev(1, 1, '2026-10-08T01:00:00.000Z')]), /already used/); // d1's revision id
  assert.deepEqual(await restore([ev(20, 20, '2026-10-09T01:00:00.000Z')]), { added: 1, skipped: 0 });
  assert.equal((await db.query('select count(*)::int n from public.serotonin_test_events')).rows[0].n, 1); // d2 sees only its own
  await as(U3, 'd1', false);
  await assert.rejects(restore([ev(30, 30, '2026-10-09T01:00:00.000Z')]), /Access code required/);
});

test('saving still validates exactly as before after the refactor, and restored revisions are readable by build code', async () => {
  await as(U1);
  const append = input => db.query('select public.serotonin_append_test_event($1::jsonb) as e', [JSON.stringify(input)]).then(r => r.rows[0].e);
  await assert.rejects(append({ ...ev(40, 40, 'x'), note: note('', {}) }), /Invalid note/);
  const saved = await append({ ...ev(41, 41, 'x'), actor: undefined });
  assert.equal(saved.actor.kind, 'anonymous');
});

test('administrator login: wrong codes lock after five misses, the right code unlocks the admin functions only for that account', async () => {
  await as(ADMIN, 'd1', false);
  await assert.rejects(db.query('select public.serotonin_admin_overview()'), /Administrator required/);
  const login = code => db.query('select public.serotonin_admin_login($1) as r', [code]).then(r => r.rows[0].r);
  for (let i = 0; i < 5; i++) assert.deepEqual(await login('wrong-' + i), { admin: false, error: 'invalid' });
  assert.deepEqual(await login(ADMIN_CODE), { admin: false, error: 'locked' });
  await sql('delete from public.serotonin_test_join_failures');
  await as(ADMIN, 'd1', false);
  assert.deepEqual(await login(ADMIN_CODE), { admin: true });
  assert.equal((await db.query('select public.serotonin_is_admin() as a')).rows[0].a, true);
  await as(U2, 'd2');
  assert.equal((await db.query('select public.serotonin_is_admin() as a')).rows[0].a, false);
  await assert.rejects(db.query("select public.serotonin_admin_dept_create('x1','X',true)"), /Administrator required/);
});

test('an administrator manages departments and members but cannot read anyone\'s notes or files', async () => {
  await as(ADMIN, 'd1', false);
  const overview = (await db.query('select public.serotonin_admin_overview() as r')).rows[0].r;
  assert.deepEqual(overview.depts.map(d => d.id), ['d1', 'd2']);
  assert.equal(overview.depts.find(d => d.id === 'd1').events, 4); // 3 restored + 1 saved above
  assert.ok(overview.members.some(m => m.short === U1.slice(0, 8)));
  assert.equal((await db.query('select count(*)::int n from public.serotonin_test_events')).rows[0].n, 0); // not a member: no notes
  // create a department; its code works once, then a new code replaces it
  const created = (await db.query("select public.serotonin_admin_dept_create('rescue','구조대',false) as r")).rows[0].r;
  assert.match(created.code, /^([0-9a-f]{4}-){5}[0-9a-f]{4}$/);
  await assert.rejects(db.query("select public.serotonin_admin_dept_create('rescue','다시',true)"), /already exists/);
  await assert.rejects(db.query("select public.serotonin_admin_dept_create('Bad Id','x',true)"), /Invalid department id/);
  await as(U3, 'd1', false);
  const joined = (await db.query('select public.serotonin_join_test_board($1,$2) as r', [created.code, '신입']).then(r => r.rows[0].r));
  assert.equal(joined.dept.id, 'rescue');
  assert.equal(joined.dept.rotating, false);
  await as(ADMIN, 'd1', false);
  const next = (await db.query("select public.serotonin_admin_dept_newcode('rescue') as r")).rows[0].r;
  assert.notEqual(next.code, created.code);
  await as('44444444-4444-4444-4444-444444444444', 'd1', false);
  assert.equal((await db.query('select public.serotonin_join_test_board($1,$2) as r', [created.code, 'x']).then(r => r.rows[0].r)).member, false); // old code is dead
  await as(ADMIN, 'd1', false);
  assert.equal((await db.query("select public.serotonin_admin_dept_save('rescue','구조대(내근)',false,200) as r")).rows[0].r, true);
  await assert.rejects(db.query("select public.serotonin_admin_dept_save('rescue','x',false,5)"), /Quota/);
  assert.equal((await db.query("select public.serotonin_admin_member_remove($1::uuid) as r", [U3])).rows[0].r, true);
  const after = (await db.query('select public.serotonin_admin_overview() as r')).rows[0].r;
  assert.equal(after.depts.find(d => d.id === 'rescue').name, '구조대(내근)');
  assert.equal(after.depts.find(d => d.id === 'rescue').quotaMb, 200);
  assert.ok(!after.members.some(m => m.short === U3.slice(0, 8)));
});

test('only the service role can run the server-side purge, and a record is dropped only after its object is gone', async () => {
  await sql("insert into public.serotonin_files(id,dept,path,name,size,uploader_id,status,created_at,expires_at) values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','d1','d1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x.txt',5,$1,'ready',now()-interval '2 days',now()-interval '1 day')", [U1]);
  await sql("insert into storage.objects(bucket_id,name,metadata) values('board-files','d1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','{\"size\":5}')");
  await as(U1);
  await assert.rejects(db.query('select public.serotonin_purge_list()'), /permission denied/);
  await sql('reset role;');
  await db.exec('set role service_role;');
  const list = (await db.query('select public.serotonin_purge_list() as r')).rows[0].r;
  assert.equal(list.length, 1);
  assert.equal((await db.query("select public.serotonin_purge_forget(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid]) as n")).rows[0].n, 0); // object still stored: kept
  await db.exec('reset role;');
  await db.exec("delete from storage.objects where bucket_id='board-files'");
  await db.exec('set role service_role;');
  assert.equal((await db.query("select public.serotonin_purge_forget(array['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid]) as n")).rows[0].n, 1);
  await db.exec('reset role;');
  assert.equal((await db.query("select action from public.serotonin_file_log where file_name='x.txt'")).rows[0].action, 'expired');
});
