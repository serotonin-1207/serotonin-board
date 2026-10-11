import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const core = createRequire(import.meta.url)('../web/core.js');
let db;
const U = '11111111-1111-1111-1111-111111111111';
const id = n => n.toString(16).padStart(32, '0');
const base = { title: '항목', content: '', author: '이은호', category: '인수인계', status: 'todo', pinned: false, deleted: false };
const ev = (n, note) => ({ schema: 1, id: id(n), noteId: id(n), parents: [], at: '2026-10-11T01:00:00.000Z', note: { ...base, ...note } });
const append = e => db.query('select public.serotonin_append_test_event($1::jsonb) as e', [JSON.stringify(e)]).then(r => r.rows[0].e);

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.test.user',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select '{"is_anonymous":true}'::jsonb$$;
   create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
   create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb);
   alter table storage.objects enable row level security;
   grant usage on schema public,auth,storage to anon,authenticated;`);
  await db.exec(await fs.readFile('supabase/setup.sql', 'utf8'));
  await db.exec(`insert into public.serotonin_depts(id,name,rotating,code_hash) values('d1','1부서',true,'a');
   insert into public.serotonin_test_members(user_id,dept,name) values('${U}','d1','이은호');`);
  await db.query("select set_config('request.test.user',$1,false)", [U]);
  await db.exec('set role authenticated;');
});
after(async () => {
  await db?.close();
});

test('the database accepts templates and an assignee on handover items only, with the same rules as the page', async () => {
  const template = ev(1, { category: '템플릿', title: '야간 점검', content: '펌프 확인\n무전기 충전\n차량 주유' });
  assert.equal(core.validEvent(template), true);
  assert.equal((await append(template)).note.category, '템플릿');
  const assigned = ev(2, { assignee: '홍길동' });
  assert.equal(core.validEvent(assigned), true);
  assert.equal((await append(assigned)).note.assignee, '홍길동');
  for (const [n, note] of [
    [3, { category: '업무 메모', assignee: '홍길동' }],
    [4, { category: '템플릿', assignee: '홍길동' }],
    [5, { assignee: '' }],
    [6, { assignee: 'x'.repeat(41) }],
    [7, { assignee: 7 }],
    [8, { category: '일정', kind: '휴가', date: '2026-10-12', assignee: '홍길동' }],
  ]) {
    const e = ev(n, note);
    assert.equal(core.validEvent(e), false, 'page accepts ' + JSON.stringify(note));
    await assert.rejects(append(e), /Invalid (note|schedule)/, 'database accepts ' + JSON.stringify(note));
  }
});

test('earlier revisions without an assignee stay valid, and a note can drop its assignee by omitting it', async () => {
  const plain = ev(10, {});
  assert.equal(core.validEvent(plain), true);
  assert.equal((await append(plain)).note.assignee, undefined);
  const dropped = JSON.parse(JSON.stringify({ ...ev(11, { assignee: undefined }) }));
  assert.equal('assignee' in dropped.note, false);
  assert.equal(core.validEvent(dropped), true);
});
