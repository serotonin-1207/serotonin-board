import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const U1 = '11111111-1111-1111-1111-111111111111',
  U2 = '22222222-2222-2222-2222-222222222222',
  U3 = '33333333-3333-3333-3333-333333333333';
const id = n => n.toString(16).padStart(32, '0');
const sha = text => `encode(sha256(convert_to('${text}','UTF8')),'hex')`;
async function as(user, dept) {
  await db.exec('reset role;');
  if (dept)
    await db.query('insert into public.serotonin_test_members(user_id,dept,name) values($1,$2,$3) on conflict do nothing', [
      user,
      dept,
      'n',
    ]);
  await db.query("select set_config('request.test.user',$1,false),set_config('request.test.jwt',$2,false)", [
    user,
    JSON.stringify({ is_anonymous: true }),
  ]);
  await db.exec('set role authenticated;');
}
async function put(n, noteN, note, { parents = [], dept = 'd1', saved = '2026-10-10T00:00:00Z' } = {}) {
  const base = { title: 't' + noteN, content: '', author: '홍길동', status: 'todo', pinned: false, deleted: false };
  const event = {
    schema: 1,
    id: id(n),
    noteId: id(noteN),
    parents: parents.map(id),
    at: saved,
    note: { ...base, ...note },
    actor: { id: 'x', kind: 'anonymous' },
  };
  await db.exec('reset role;');
  await db.query('insert into public.serotonin_test_events(id,note_id,dept,actor_id,saved_at,event) values($1,$2,$3,$4,$5,$6::jsonb)', [
    id(n),
    id(noteN),
    dept,
    U1,
    saved,
    JSON.stringify(event),
  ]);
}
const summary = () => db.query('select public.serotonin_member_summary() as s').then(r => r.rows[0].s);

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
  await db.exec(
    `insert into public.serotonin_depts(id,name,rotating,code_hash) values('d1','1부서',true,${sha('a')}),('d2','2부서',false,${sha('b')});`,
  );
});
after(async () => {
  await db?.close();
});

test('the summary is for members only', async () => {
  await as(U3);
  await assert.rejects(summary(), /Access code required/);
  await db.exec('reset role; set role anon;');
  await assert.rejects(summary(), /permission denied/);
});

test('it lists upcoming schedules and open handover items of the own department only, and skips finished, deleted and old ones', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const plus = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  await put(1, 1, { category: '일정', kind: '훈련', title: '소방 훈련', date: today });
  await put(2, 2, { category: '일정', kind: '휴가', title: '연가', date: plus(-1), endDate: plus(2) });
  await put(3, 3, { category: '일정', kind: '교육', title: '먼 일정', date: plus(30) });
  await put(4, 4, { category: '일정', kind: '교육', title: '지난 일정', date: plus(-9), endDate: plus(-5) });
  await put(5, 5, { category: '일정', kind: '기타', title: '삭제된 일정', date: today });
  await put(
    6,
    5,
    { category: '일정', kind: '기타', title: '삭제된 일정', date: today, deleted: true },
    { parents: [5], saved: '2026-10-10T01:00:00Z' },
  );
  await put(7, 7, { category: '인수인계', title: '펌프 점검', assignee: '김철수' });
  await put(8, 8, { category: '인수인계', title: '끝난 항목' });
  await put(9, 8, { category: '인수인계', title: '끝난 항목', status: 'done' }, { parents: [8], saved: '2026-10-10T01:00:00Z' });
  await put(10, 10, { category: '인수인계', title: '고정 항목', pinned: true }, { saved: '2026-10-10T02:00:00Z' });
  await put(11, 11, { category: '공지사항', title: '공지' });
  await put(12, 12, { category: '일정', kind: '훈련', title: '다른 부서', date: today }, { dept: 'd2' });
  await put(13, 13, { category: '인수인계', title: '다른 부서 항목' }, { dept: 'd2' });
  await as(U1, 'd1');
  const s = await summary();
  assert.deepEqual(s.dept, { id: 'd1', name: '1부서', rotating: true });
  assert.equal(s.today, today);
  assert.deepEqual(
    s.schedules.map(x => x.title),
    ['연가', '소방 훈련'],
  );
  assert.deepEqual(s.schedules[0], { kind: '휴가', title: '연가', from: plus(-1), to: plus(2) });
  assert.deepEqual(
    s.handover.map(x => x.title),
    ['고정 항목', '펌프 점검'],
  );
  assert.equal(s.handover[1].assignee, '김철수');
  // what the extension needs to mark an item done: its id, its latest revision ids and its current note
  assert.equal(s.handover[1].id, id(7));
  assert.deepEqual(s.handover[1].heads, [id(7)]);
  assert.equal(s.handover[1].note.title, '펌프 점검');
  assert.equal(s.handover[1].note.category, '인수인계');
  assert.equal(s.handoverCount, 2);
  await as(U2, 'd2');
  const other = await summary();
  assert.equal(other.dept.rotating, false);
  assert.deepEqual(
    other.schedules.map(x => x.title),
    ['다른 부서'],
  );
  assert.deepEqual(
    other.handover.map(x => x.title),
    ['다른 부서 항목'],
  );
});
