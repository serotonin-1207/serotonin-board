import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
const U1 = '11111111-1111-1111-1111-111111111111',
  ADMIN = '99999999-9999-9999-9999-999999999999';
const ADMIN_CODE = 'admin-code-for-tests-0000';
const id = n => n.toString(16).padStart(32, '0');
const sha = text => `encode(sha256(convert_to('${text}','UTF8')),'hex')`;
async function as(user) {
  await db.exec('reset role;');
  await db.query("select set_config('request.test.user',$1,false),set_config('request.test.jwt',$2,false)", [
    user,
    JSON.stringify({ is_anonymous: true }),
  ]);
  await db.exec('set role authenticated;');
}
async function sql(statement, params) {
  await db.exec('reset role;');
  return db.query(statement, params);
}
const sched = (title, extra = {}) => ({
  title,
  content: '',
  author: '홍길동',
  category: '일정',
  kind: '휴가',
  date: '2026-10-12',
  status: 'todo',
  pinned: false,
  deleted: false,
  ...extra,
});
// Insert a schedule revision straight into the table (saved_at is set by hand so the tests control the clock).
async function put(n, noteN, saved, { parents = [], at = saved, dept = 'd1', ...note } = {}) {
  const event = {
    schema: 1,
    id: id(n),
    noteId: id(noteN),
    parents: parents.map(id),
    at,
    note: sched('일정 ' + noteN, note),
    actor: { id: 'x', kind: 'anonymous' },
  };
  await sql('insert into public.serotonin_test_events(id,note_id,dept,actor_id,saved_at,event) values($1,$2,$3,$4,$5,$6::jsonb)', [
    id(n),
    id(noteN),
    dept,
    U1,
    saved,
    JSON.stringify(event),
  ]);
}
const due = (at, kind) =>
  sql('select public.serotonin_telegram_due_at($1::timestamptz) as j', [at]).then(r => r.rows[0].j.filter(j => !kind || j.kind === kind));
const done = (dept, kind, mark) => sql('select public.serotonin_telegram_done($1,$2,$3)', [dept, kind, mark]);

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
    `insert into public.serotonin_depts(id,name,rotating,code_hash) values('d1','1부서',true,${sha('code-one-1234567890')}),('d2','2부서',false,${sha('code-two-1234567890')});`,
  );
  await db.exec(`insert into public.serotonin_settings(key,value) values('admin_code_hash',${sha(ADMIN_CODE)});`);
  await db.exec(`insert into public.serotonin_admins(user_id) values('${ADMIN}');`);
});
after(async () => {
  await db?.close();
});

test('only administrators can use the Telegram settings and the server-only functions are closed to browsers', async () => {
  await as(U1);
  await assert.rejects(db.query('select public.serotonin_admin_telegram_list()'), /Administrator required/);
  await assert.rejects(db.query("select public.serotonin_admin_telegram_link_start('d1')"), /Administrator required/);
  await assert.rejects(db.query('select public.serotonin_telegram_due()'), /permission denied/);
  await assert.rejects(db.query("select public.serotonin_telegram_link_finish('x', 1)"), /permission denied/);
  await assert.rejects(db.query('select * from public.serotonin_telegram'), /permission denied/);
  await as(ADMIN);
  const list = (await db.query('select public.serotonin_admin_telegram_list() as l')).rows[0].l;
  assert.deepEqual(
    list.map(d => [d.id, d.linked, d.enabled]),
    [
      ['d1', false, false],
      ['d2', false, false],
    ],
  );
});

test('linking: a one-time code ties one chat to one department, expires, and a chat cannot serve two departments', async () => {
  await as(ADMIN);
  const code = (await db.query("select public.serotonin_admin_telegram_link_start('d1') as r")).rows[0].r.code;
  assert.match(code, /^[A-F0-9]{12}$/);
  assert.equal(
    (await sql('select link_hash from public.serotonin_telegram where dept=$1', ['d1'])).rows[0].link_hash.includes(code),
    false,
  ); // only a hash is kept
  const finish = (c, chat) => sql('select public.serotonin_telegram_link_finish($1,$2) as d', [c, chat]).then(r => r.rows[0].d);
  assert.equal(await finish('WRONGCODE000', -1001), null);
  assert.equal(await finish(code, -1001234567890), 'd1');
  assert.equal(await finish(code, -1001234567890), null); // single use
  const other = (await sql("select (public.serotonin_admin_telegram_link_start('d2')) as r")).rows[0].r.code;
  await assert.rejects(finish(other, -1001234567890), /Chat already linked/);
  await sql("update public.serotonin_telegram set link_expires = now() - interval '1 minute' where dept='d2'");
  assert.equal(await finish(other, -1009999), null); // expired
  assert.equal(Number((await sql("select public.serotonin_telegram_chat('d1') as c")).rows[0].c), -1001234567890);
});

test('switching on needs a linked chat; unlinking switches off', async () => {
  await as(ADMIN);
  await assert.rejects(db.query("select public.serotonin_admin_telegram_save('d2', true, true, true, true, 540, 1080)"), /not linked/);
  await assert.rejects(db.query("select public.serotonin_admin_telegram_save('d1', true, true, true, true, 2000, 1080)"), /Invalid time/);
  await db.query("select public.serotonin_admin_telegram_save('d1', true, true, true, true, 540, 1080)");
  const list = (await db.query('select public.serotonin_admin_telegram_list() as l')).rows[0].l;
  assert.equal(list[0].enabled, true);
  assert.equal(list[0].linked, true);
  await db.query("select public.serotonin_admin_telegram_unlink('d1')");
  assert.equal((await db.query('select public.serotonin_admin_telegram_list() as l')).rows[0].l[0].enabled, false);
  await sql("update public.serotonin_telegram set chat_id=-1001, enabled=true, change_mark='2026-10-01T00:00:00Z' where dept='d1'");
});

test('morning summary names today team and schedules at the set time, once a day, and handover items never appear', async () => {
  await put(1, 1, '2026-10-05T00:00:00Z', { title: '홍길동 연가', date: '2026-10-11', endDate: '2026-10-13' });
  await put(2, 2, '2026-10-05T00:00:00Z', { title: '소방 훈련', kind: '훈련', date: '2026-10-12' });
  await put(3, 3, '2026-10-05T00:00:00Z', { title: '내일 교육', kind: '교육', date: '2026-10-13' });
  await put(4, 4, '2026-10-05T00:00:00Z', { title: '인수인계 항목', category: '인수인계', date: undefined, kind: undefined });
  await put(5, 5, '2026-10-05T00:00:00Z', { title: '다른 부서 일정', dept: 'd2', date: '2026-10-12' });
  assert.equal((await due('2026-10-11T23:30:00Z', 'morning')).length, 0); // 08:30 KST is before 09:00
  const [job] = await due('2026-10-12T00:05:00Z', 'morning'); // Monday 09:05 KST
  assert.equal(job.dept, 'd1');
  assert.equal(job.chat, -1001);
  assert.equal(job.text, '📅 오늘 10월 12일(월) 일정\n근무: 2팀\n• [휴가] 홍길동 연가 (10/11~10/13)\n• [훈련] 소방 훈련');
  assert.ok(!job.text.includes('인수인계') && !job.text.includes('다른 부서') && !job.text.includes('내일 교육'));
  assert.equal((await due('2026-10-12T00:10:00Z', 'morning')).length, 1); // not marked yet: retried on the next run
  await done('d1', 'morning', job.mark);
  assert.equal((await due('2026-10-12T00:10:00Z', 'morning')).length, 0);
  assert.equal((await due('2026-10-12T04:00:00Z', 'morning')).length, 0); // nothing more later that day
  assert.equal((await due('2026-10-13T00:05:00Z', 'morning')).length, 1); // next day again
});

test('the evening notice lists tomorrow with the team that comes on, and is skipped when nothing is planned', async () => {
  const [job] = await due('2026-10-12T09:05:00Z', 'evening'); // 18:05 KST
  assert.equal(job.text, '🔔 내일 10월 13일(화) 일정\n근무: 3팀 (09:00 교대)\n• [휴가] 홍길동 연가 (10/11~10/13)\n• [교육] 내일 교육');
  await done('d1', 'evening', job.mark);
  assert.equal((await due('2026-10-12T09:30:00Z', 'evening')).length, 0);
  assert.equal((await due('2026-10-14T09:05:00Z', 'evening')).length, 0); // nothing on 10/15: no message, and it is remembered
  assert.equal((await sql("select last_evening::text d from public.serotonin_telegram where dept='d1'")).rows[0].d, '2026-10-14');
});

test('changes go out as one message after a quiet period: new, changed, deleted; new-then-deleted stays silent', async () => {
  await sql("update public.serotonin_telegram set change_mark='2026-10-12T01:00:00Z' where dept='d1'");
  await put(10, 10, '2026-10-12T02:00:00Z', { title: '장비 점검', kind: '기타', date: '2026-10-20' });
  await put(11, 3, '2026-10-12T02:01:00Z', {
    title: '내일 교육(시간 변경)',
    kind: '교육',
    date: '2026-10-13',
    parents: [3],
    at: '2026-10-12T02:01:00Z',
  });
  await put(12, 2, '2026-10-12T02:02:00Z', {
    title: '소방 훈련',
    kind: '훈련',
    date: '2026-10-12',
    deleted: true,
    parents: [2],
    at: '2026-10-12T02:02:00Z',
  });
  await put(13, 13, '2026-10-12T02:03:00Z', { title: '곧 취소될 일정', date: '2026-10-21' });
  await put(14, 13, '2026-10-12T02:03:30Z', {
    title: '곧 취소될 일정',
    date: '2026-10-21',
    deleted: true,
    parents: [13],
    at: '2026-10-12T02:03:30Z',
  });
  assert.equal((await due('2026-10-12T02:05:00Z', 'changes')).length, 0); // still inside the three quiet minutes
  const [job] = await due('2026-10-12T02:10:00Z', 'changes');
  assert.equal(job.text, '🗓 일정이 바뀌었습니다\n• 새 일정 [기타] 장비 점검\n• 변경 [교육] 내일 교육(시간 변경)\n• 삭제 [훈련] 소방 훈련');
  await done('d1', 'changes', job.mark);
  assert.equal((await due('2026-10-12T02:20:00Z', 'changes')).length, 0);
  await put(15, 10, '2026-10-12T03:00:00Z', {
    title: '장비 점검',
    kind: '기타',
    date: '2026-10-21',
    parents: [10],
    at: '2026-10-12T03:00:00Z',
  });
  const [again] = await due('2026-10-12T03:10:00Z', 'changes');
  assert.equal(again.text, '🗓 일정이 바뀌었습니다\n• 변경 [기타] 장비 점검');
});

test('a note with two unmerged latest revisions uses the newest one, and a note renamed after announcing is a change', async () => {
  await put(20, 20, '2026-10-12T04:00:00Z', { title: '갈라진 일정', date: '2026-10-25' });
  await put(21, 20, '2026-10-12T04:01:00Z', { title: '갈라진 일정 A', date: '2026-10-25', parents: [20], at: '2026-10-12T04:01:00Z' });
  await put(22, 20, '2026-10-12T04:02:00Z', { title: '갈라진 일정 B', date: '2026-10-25', parents: [20], at: '2026-10-12T04:02:00Z' });
  const rows = (await sql("select title from public.serotonin_telegram_schedules('d1') where note_id=$1", [id(20)])).rows;
  assert.deepEqual(
    rows.map(r => r.title),
    ['갈라진 일정 B'],
  );
});

test('failures are remembered; a refused chat switches announcements off', async () => {
  await sql("select public.serotonin_telegram_failed('d1','network',false)");
  let row = (await sql("select enabled, last_error from public.serotonin_telegram where dept='d1'")).rows[0];
  assert.deepEqual([row.enabled, row.last_error], [true, 'network']);
  await sql("select public.serotonin_telegram_failed('d1','Forbidden: bot was kicked',true)");
  row = (await sql("select enabled, last_error from public.serotonin_telegram where dept='d1'")).rows[0];
  assert.deepEqual([row.enabled, row.last_error], [false, 'Forbidden: bot was kicked']);
  assert.equal((await due('2026-10-13T00:05:00Z')).length, 0);
});

test('an office department has no team line and no empty morning message', async () => {
  await sql(
    "insert into public.serotonin_telegram(dept, chat_id, enabled, change_mark) values('d2', -2002, true, '2026-10-01T00:00:00Z') on conflict (dept) do update set chat_id=-2002, enabled=true",
  );
  const [job] = (await due('2026-10-12T00:05:00Z', 'morning')).filter(j => j.dept === 'd2');
  assert.equal(job.text, '📅 오늘 10월 12일(월) 일정\n• [휴가] 다른 부서 일정');
  assert.equal((await due('2026-10-20T00:05:00Z', 'morning')).filter(j => j.dept === 'd2').length, 0); // nothing on 10/20: no message at all
});
