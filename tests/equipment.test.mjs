import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const core = createRequire(import.meta.url)('../web/core.js');
let db;
const U1 = '11111111-1111-1111-1111-111111111111';
const sha = text => `encode(sha256(convert_to('${text}','UTF8')),'hex')`;
let counter = 1;
const hex = () => (counter++).toString(16).padStart(32, '0');
const E1 = 'e'.repeat(32),
  E2 = 'f'.repeat(32);
const base = { content: '', author: '홍길동', status: 'todo', pinned: false, deleted: false };
const equipment = (extra = {}) => ({ ...base, title: '공기호흡기 1호', category: '장비', group: '호흡보호장비', cycle: 30, ...extra });
const sheet = (extra = {}) => ({
  ...base,
  title: '일일 점검',
  category: '점검',
  date: '2026-10-12',
  results: [{ e: E1, r: '정상' }],
  ...extra,
});
const event = note => ({
  schema: 1,
  id: hex(),
  noteId: hex(),
  parents: [],
  at: '2026-10-12T01:00:00.000Z',
  note,
  actor: { id: 'x', kind: 'display-only' },
});

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
  await db.exec(`insert into public.serotonin_depts(id,name,rotating,code_hash) values('d1','1부서',true,${sha('a')});`);
  await db.query('insert into public.serotonin_test_members(user_id,dept,name) values($1,$2,$3)', [U1, 'd1', 'n']);
  await db.query("select set_config('request.test.user',$1,false),set_config('request.test.jwt',$2,false)", [
    U1,
    JSON.stringify({ is_anonymous: true }),
  ]);
  await db.exec('set role authenticated;');
});
after(async () => {
  await db?.close();
});
const serverAccepts = note =>
  db.query('select public.serotonin_append_test_event($1::jsonb)', [JSON.stringify(event(note))]).then(
    () => true,
    () => false,
  );

const cases = [
  ['equipment', equipment(), true],
  ['equipment with number and place', equipment({ code: 'SCBA-01 / 2대', location: '1번 차고' }), true],
  ['equipment without group', equipment({ group: undefined }), false],
  ['equipment with empty group', equipment({ group: '  ' }), false],
  ['equipment with long group', equipment({ group: '가'.repeat(31) }), false],
  ['equipment with fractional cycle', equipment({ cycle: 1.5 }), false],
  ['equipment with zero cycle', equipment({ cycle: 0 }), false],
  ['equipment with long cycle', equipment({ cycle: 367 }), false],
  ['equipment with text cycle', equipment({ cycle: '30' }), false],
  ['equipment with empty code', equipment({ code: '' }), false],
  ['equipment with long location', equipment({ location: 'x'.repeat(41) }), false],
  ['equipment with a date', equipment({ date: '2026-10-12' }), false],
  ['equipment with results', equipment({ results: [{ e: E1, r: '정상' }] }), false],
  ['equipment with assignee', equipment({ assignee: '김' }), false],
  ['sheet', sheet(), true],
  [
    'sheet with memo and several items',
    sheet({
      results: [
        { e: E1, r: '이상', m: '압력 낮음' },
        { e: E2, r: '교체' },
      ],
    }),
    true,
  ],
  ['sheet without date', sheet({ date: undefined }), false],
  ['sheet with bad date', sheet({ date: '2026-02-30' }), false],
  ['sheet with no items', sheet({ results: [] }), false],
  [
    'sheet with too many items',
    sheet({ results: Array.from({ length: 301 }, (_, i) => ({ e: i.toString(16).padStart(32, '0'), r: '정상' })) }),
    false,
  ],
  ['sheet with unknown result', sheet({ results: [{ e: E1, r: '양호' }] }), false],
  ['sheet with bad equipment id', sheet({ results: [{ e: 'abc', r: '정상' }] }), false],
  [
    'sheet with the same item twice',
    sheet({
      results: [
        { e: E1, r: '정상' },
        { e: E1, r: '이상' },
      ],
    }),
    false,
  ],
  ['sheet with extra item field', sheet({ results: [{ e: E1, r: '정상', x: 1 }] }), false],
  ['sheet with empty memo', sheet({ results: [{ e: E1, r: '정상', m: '' }] }), false],
  ['sheet with long memo', sheet({ results: [{ e: E1, r: '정상', m: 'x'.repeat(201) }] }), false],
  ['sheet with equipment field', sheet({ group: '구조' }), false],
  ['sheet with end date', sheet({ endDate: '2026-10-13' }), false],
  ['memo with equipment field', { ...base, title: '메모', category: '업무 메모', cycle: 30 }, false],
  ['memo with results', { ...base, title: '메모', category: '업무 메모', results: [] }, false],
  ['schedule with equipment field', { ...base, title: '훈련', category: '일정', kind: '훈련', date: '2026-10-12', group: 'x' }, false],
  ['plain memo still fine', { ...base, title: '메모', category: '업무 메모' }, true],
  ['schedule still fine', { ...base, title: '훈련', category: '일정', kind: '훈련', date: '2026-10-12' }, true],
];

test('the browser and the database accept and refuse the same equipment and inspection records', async () => {
  for (const [name, note, expected] of cases) {
    assert.equal(core.validEvent(event(note)), expected, 'browser: ' + name);
    assert.equal(await serverAccepts(note), expected, 'database: ' + name);
  }
});

// Notes as BoardCore.buildNotes returns them (only the fields the status functions read).
const eq = (id, title, cycle, extra = {}) => ({
  id,
  category: '장비',
  title,
  group: extra.group || '구조장비',
  cycle,
  deleted: false,
  at: '2026-10-01T00:00:00Z',
  ...extra,
});
const sh = (id, date, results, extra = {}) => ({
  id,
  category: '점검',
  title: date + ' 점검',
  date,
  results,
  author: '홍길동',
  deleted: false,
  at: date + 'T01:00:00Z',
  ...extra,
});

test('equipment status: latest result wins, due date follows the cycle, and attention covers never-checked, overdue and not-normal items', () => {
  const A = 'a'.repeat(32),
    B = 'b'.repeat(32),
    C = 'c'.repeat(32),
    D = 'd'.repeat(32),
    X = '9'.repeat(32);
  const notes = [
    eq(A, '유압 절단기', 7),
    eq(B, '공기호흡기', 30, { group: '호흡보호장비' }),
    eq(C, '구명로프', 30),
    eq(D, '버린 장비', 30, { deleted: true }),
    sh('1'.repeat(32), '2026-10-01', [
      { e: A, r: '이상', m: '칼날 마모' },
      { e: B, r: '정상' },
    ]),
    sh('2'.repeat(32), '2026-10-03', [{ e: A, r: '정상' }]),
    sh('3'.repeat(32), '2026-10-11', [{ e: A, r: '교체' }], { deleted: true }), // a sheet in the trash does not count
    sh('4'.repeat(32), '2026-09-01', [{ e: B, r: '수리' }]), // older than the 10/01 result
    sh('5'.repeat(32), '2026-10-02', [{ e: X, r: '정상' }]),
  ];
  const list = core.equipmentStatus(notes, '2026-10-12');
  assert.deepEqual(
    list.map(x => x.note.title),
    ['구명로프', '유압 절단기', '공기호흡기'],
  ); // by group, then name; trash left out
  const [rope, cutter, scba] = list;
  assert.deepEqual([rope.last, rope.due, rope.attention], [null, null, true]);
  assert.deepEqual(
    [cutter.last.date, cutter.last.result, cutter.due, cutter.daysLeft, cutter.overdue, cutter.attention],
    ['2026-10-03', '정상', '2026-10-10', -2, true, true],
  );
  assert.deepEqual([scba.last.result, scba.due, scba.daysLeft, scba.overdue, scba.attention], ['정상', '2026-10-31', 19, false, false]);
  const history = core.inspectionHistory(notes, A);
  assert.deepEqual(
    history.map(h => [h.date, h.result, h.memo]),
    [
      ['2026-10-03', '정상', ''],
      ['2026-10-01', '이상', '칼날 마모'],
    ],
  );
  assert.deepEqual(core.inspectionHistory(notes, C), []);
});

test('equipment and cumulative inspection spreadsheets', () => {
  const ex = createRequire(import.meta.url)('../web/export.js');
  const A = 'a'.repeat(32),
    B = 'b'.repeat(32);
  const history = [{ at: '2026-10-01T00:00:00.000Z', note: { author: '등록자' } }];
  const notes = [
    eq(A, '유압 절단기', 7, { code: 'C-1', location: '구조차', content: '비고', history }),
    eq(B, '버린 로프', 30, { deleted: true, history }),
    sh(
      '1'.repeat(32),
      '2026-10-01',
      [
        { e: A, r: '이상', m: '=마모' },
        { e: B, r: '정상' },
      ],
      { content: '월간', at: '2026-10-01T01:00:00.000Z' },
    ),
    sh('2'.repeat(32), '2026-10-03', [{ e: A, r: '정상' }], { content: '', at: '2026-10-03T01:00:00.000Z' }),
  ];
  const list = ex
    .equipmentCsv(core, notes, '2026-10-12')
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');
  assert.equal(list.length, 2); // header + the one item in use
  assert.match(list[1], /^구조장비,유압 절단기,C-1,구조차,7,2026-10-03,정상,,홍길동,2026-10-10,-2,기한 지남,비고,등록자,/);
  const log = ex
    .inspectionsCsv(core, notes)
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n');
  assert.equal(log.length, 4); // every result, including the one of the item now in the trash
  assert.match(log[1], /^2026-10-01,구조장비,버린 로프,,정상,,홍길동,2026-10-01 점검,월간,2026-10-01 10:00:00,삭제됨$/);
  assert.match(log[2], /^2026-10-01,구조장비,유압 절단기,C-1,이상,'=마모,/); // formula-looking text stays text in Excel
  assert.match(log[3], /^2026-10-03,구조장비,유압 절단기,C-1,정상,/);
});
