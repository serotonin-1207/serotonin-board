import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const A = '11111111-1111-1111-1111-111111111111',
  A2 = '12121212-1212-1212-1212-121212121212',
  B = '22222222-2222-2222-2222-222222222222';
const MB = 1024 * 1024;
async function as(user, dept = 'd1', member = true) {
  await db.exec('reset role;');
  if (member && user)
    await db.query('insert into public.serotonin_test_members(user_id,dept,name) values($1,$2,$3) on conflict do nothing', [user, dept, '이름-' + user.slice(0, 2)]);
  await db.query("select set_config('request.test.user',$1,false),set_config('request.test.jwt',$2,false)", [user, JSON.stringify({ is_anonymous: true })]);
  await db.exec('set role authenticated;');
}
const begin = (name = '문서.pdf', size = 3 * MB, mime = 'application/pdf', minutes = 60) =>
  db.query('select public.serotonin_file_begin($1,$2,$3,$4) as r', [name, size, mime, minutes]).then(r => r.rows[0].r);
// What the Storage service does on upload: insert into storage.objects as the calling user (the policy applies).
const store = (path, size) =>
  db.query("insert into storage.objects(bucket_id,name,owner,metadata) values('board-files',$1,$2,$3)", [path, A, JSON.stringify({ size })]);
const finish = id => db.query('select public.serotonin_file_finish($1::uuid) as r', [id]).then(r => r.rows[0].r);
const list = () => db.query('select public.serotonin_file_list() as r').then(r => r.rows[0].r);
async function adminExec(sql) {
  await db.exec('reset role;');
  return db.exec(sql);
}
async function admin(sql, params) {
  await db.exec('reset role;');
  return db.query(sql, params);
}

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.test.user',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.test.jwt',true),''),'{}')::jsonb$$;
   create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
   create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now());
   alter table storage.objects enable row level security;
   grant usage on schema public,auth,storage to anon,authenticated;
   grant select,insert,delete on storage.objects to authenticated;`);
  await db.exec(await fs.readFile('supabase/setup.sql', 'utf8'));
  await db.exec(`insert into public.serotonin_depts(id,name,rotating,code_hash) values('d1','1부서',true,'a'),('d2','2부서',true,'b');`);
});
after(async () => {
  await db?.close();
});

test('upload flow: reserve, store the object, finish; then the file is listed with its usage', async () => {
  await as(A);
  const r = await begin();
  assert.match(r.path, /^d1\/[0-9a-f-]{36}$/);
  assert.equal((await list()).files.length, 0); // still pending, invisible
  await store(r.path, 3 * MB);
  await finish(r.id);
  const l = await list();
  assert.equal(l.files.length, 1);
  assert.equal(l.files[0].name, '문서.pdf');
  assert.equal(l.used, 3 * MB);
  assert.equal(l.quota, 400 * MB);
  assert.ok(Date.parse(l.files[0].expiresAt) - Date.now() < 61 * 60000);
});

test('the Storage insert policy only lets the uploader write the reserved path', async () => {
  await as(A2, 'd1');
  const mine = await begin('내것.txt', MB);
  await as(A);
  await assert.rejects(store(mine.path, MB), /row-level security/); // another user cannot fill someone else's reservation
  await assert.rejects(store('d1/00000000-0000-0000-0000-000000000000', MB), /row-level security/); // no reservation, no write
  await as(A2);
  await assert.rejects(store('d2/anything', MB), /row-level security/); // not even into another department's folder
  await store(mine.path, MB);
  await finish(mine.id);
  assert.equal((await list()).files.length, 2);
});

test('finish refuses when the stored size differs from the announced size, or nothing was stored', async () => {
  await as(A);
  const wrong = await begin('x.bin', 2 * MB);
  await assert.rejects(finish(wrong.id), /not complete/); // nothing stored yet
  await store(wrong.path, 5);
  await assert.rejects(finish(wrong.id), /not complete/); // wrong size
});

test('another department can neither list, read nor delete the file; a non-member cannot reserve space', async () => {
  await as(B, 'd2');
  assert.equal((await list()).files.length, 0);
  assert.equal((await db.query("select count(*)::int n from storage.objects where bucket_id='board-files'")).rows[0].n, 0); // read policy hides the rows
  await db.query("delete from storage.objects where bucket_id='board-files'"); // delete policy matches nothing
  await as(A);
  assert.ok((await db.query("select count(*)::int n from storage.objects where bucket_id='board-files'")).rows[0].n >= 1); // d1's object survived
  await as('33333333-3333-3333-3333-333333333333', 'd1', false);
  await assert.rejects(begin(), /Access code required/);
});

test('retention is capped at 7 days and file size at 50 MB; quota and upload rate are enforced', async () => {
  await as(A);
  await assert.rejects(begin('a', MB, null, 10081), /Retention/);
  await assert.rejects(begin('a', MB, null, 0), /Retention/);
  await assert.rejects(begin('a', 51 * MB, null, 60), /50 MB/);
  const seven = await begin('이레.txt', MB, 'text/plain', 10080); // exactly 7 days is allowed
  assert.ok(Date.parse(seven.expiresAt) - Date.now() <= 7 * 24 * 3600000 + 1000);
  await admin("update public.serotonin_depts set file_quota_bytes = 10 * 1048576 where id = 'd1'");
  await as(A);
  await assert.rejects(begin('fill.bin', 40 * MB, null, 60), /space is full/); // used + new > quota
  await admin("update public.serotonin_depts set file_quota_bytes = 419430400 where id = 'd1'");
  await admin("delete from public.serotonin_files where dept='d1' and name in ('x.bin','이레.txt','내것.txt')");
  await as(A);
  for (let i = 0; i < 40; i++) await begin('r' + i, 1, null, 60).catch(() => {});
  await assert.rejects(begin('over', 1, null, 60), /Too many uploads/);
});

test('expired files leave the list at once, are reported for removal, and the record is forgotten only after the object is gone', async () => {
  await adminExec("delete from public.serotonin_files where dept='d1'; delete from storage.objects; delete from public.serotonin_file_log;");
  await as(A2, 'd1'); // a fresh account so the hourly upload limit of the previous test does not apply
  const r = await begin('곧만료.txt', MB, 'text/plain', 60);
  await store(r.path, MB);
  await finish(r.id);
  assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n, 1); // readable now
  await admin("update public.serotonin_files set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1", [r.id]);
  await as(A2);
  assert.equal((await list()).files.length, 0); // gone from the list
  assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n, 1); // still visible to its own department, only so it can be removed
  await as(B, 'd2');
  assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n, 0); // another department never sees it
  await as(A2);
  const expired = (await db.query('select public.serotonin_file_expired() as r')).rows[0].r;
  assert.deepEqual(expired.map(e => e.path), [r.path]);
  await admin("update public.serotonin_test_members set name = '정리하는사람' where user_id = $1", [A2]);
  await as(A2);
  await assert.rejects(db.query('select public.serotonin_file_forget($1::uuid)', [r.id]), /still stored/); // object not removed yet
  await as(A2);
  await db.query("delete from storage.objects where bucket_id='board-files' and name=$1", [r.path]);
  assert.equal((await db.query('select public.serotonin_file_forget($1::uuid) as r', [r.id])).rows[0].r, true);
  assert.equal((await list()).files.length, 0);
  const log = (await admin("select action, file_name from public.serotonin_file_log where dept='d1' and file_name='곧만료.txt' order by id")).rows;
  assert.deepEqual(log.map(l => l.action), ['upload', 'expired']);
});

test('any department member can delete a file immediately; the log records it without file contents', async () => {
  await adminExec("delete from public.serotonin_files where dept='d1'; delete from storage.objects; delete from public.serotonin_file_log;");
  await as(A2, 'd1');
  const r = await begin('지울것.txt', MB, 'text/plain', 60);
  await store(r.path, MB);
  await finish(r.id);
  await as('44444444-4444-4444-4444-444444444444', 'd1'); // a different member of the same department
  assert.equal((await list()).files.length, 1);
  await db.query("delete from storage.objects where bucket_id='board-files' and name=$1", [r.path]);
  assert.equal((await db.query('select public.serotonin_file_forget($1::uuid) as r', [r.id])).rows[0].r, true);
  assert.equal((await list()).files.length, 0);
  const log = (await admin('select action, by_name from public.serotonin_file_log order by id')).rows;
  assert.deepEqual(log.map(l => l.action), ['upload', 'delete']);
  assert.ok(log[1].by_name.startsWith('이름-44'));
});

test('clients have no direct access to the file tables', async () => {
  await as(A);
  for (const sql of ['select * from public.serotonin_files', 'select * from public.serotonin_file_log', 'delete from public.serotonin_files'])
    await assert.rejects(db.exec(sql), /permission denied/);
});
