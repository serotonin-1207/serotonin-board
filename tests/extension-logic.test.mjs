import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  DEFAULT_SETTINGS,
  addDays,
  badgeFor,
  dayLabel,
  dueAlerts,
  groupSchedules,
  handoverMinutes,
  kst,
  memoFrom,
  minutesOf,
  parseHandoverLine,
  parseHandoverLines,
  rangeLabel,
  timeLabel,
} from '../extension/src/logic.mjs';

const core = createRequire(import.meta.url)('../web/core.js');
const at = iso => Date.parse(iso);
const summary = (extra = {}) => ({
  dept: { id: 'd1', name: '1부서', rotating: true },
  today: '2026-10-12',
  schedules: [],
  handover: [],
  handoverCount: 0,
  ...extra,
});

test('Korean time and day helpers', () => {
  assert.deepEqual(kst(at('2026-10-11T23:30:00Z')), { day: '2026-10-12', minutes: 8 * 60 + 30 });
  assert.deepEqual(kst(at('2026-10-12T14:59:00Z')), { day: '2026-10-12', minutes: 23 * 60 + 59 });
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(dayLabel('2026-10-12'), '10/12(월)');
  assert.equal(timeLabel(485), '08:05');
  assert.equal(minutesOf('08:05'), 485);
  assert.equal(minutesOf('24:00'), null);
  assert.equal(minutesOf(''), null);
  assert.equal(rangeLabel({ from: '2026-10-12', to: '2026-10-14' }), '10/12(월) ~ 10/14(수)');
  assert.equal(rangeLabel({ from: '2026-10-12', to: '2026-10-12' }), '10/12(월)');
});

test('the badge shows the team of the shift day for rotating departments and the open handover count for office departments', () => {
  const teamOnDay = now => core.teamOn(core.dutyDay(now));
  // 08:30 KST on 10/12 is still the shift day 10/11 (team 1); from 09:00 KST it is team 2
  assert.equal(badgeFor(summary(), teamOnDay, at('2026-10-11T23:30:00Z')).text, '1');
  const nine = badgeFor(summary(), teamOnDay, at('2026-10-12T00:00:00Z'));
  assert.equal(nine.text, '2');
  assert.match(nine.title, /2팀/);
  const office = badgeFor(summary({ dept: { id: 'o', name: '내근', rotating: false }, handoverCount: 4 }), teamOnDay, Date.now());
  assert.equal(office.text, '4');
  assert.equal(badgeFor(summary({ dept: { id: 'o', name: '내근', rotating: false } }), teamOnDay, Date.now()).text, '');
  assert.equal(badgeFor(null, teamOnDay, Date.now()).text, '');
});

test('schedules are grouped into today, tomorrow and later', () => {
  const item = (title, from, to = from) => ({ kind: '기타', title, from, to });
  const groups = groupSchedules(
    summary({
      schedules: [
        item('연가', '2026-10-10', '2026-10-13'),
        item('훈련', '2026-10-12'),
        item('교육', '2026-10-13'),
        item('점검', '2026-10-20'),
        item('지난', '2026-10-01', '2026-10-02'),
      ],
    }),
  );
  assert.deepEqual(
    groups.today.map(x => x.title),
    ['연가', '훈련'],
  );
  assert.deepEqual(
    groups.tomorrow.map(x => x.title),
    ['교육'],
  );
  assert.deepEqual(
    groups.later.map(x => x.title),
    ['점검'],
  );
});

test('the handover reminder comes at 08:00 for rotating and 16:00 for office departments, once a day, inside a two-hour window', () => {
  const open = summary({ handoverCount: 5, handover: ['펌프', '호스', '무전기', '차량'].map(title => ({ title })) });
  const run = (when, extra = {}) => dueAlerts({ summary: open, settings: DEFAULT_SETTINGS, marks: {}, now: at(when), ...extra });
  assert.equal(run('2026-10-11T22:50:00Z').length, 0); // 07:50 KST: too early
  const [alert] = run('2026-10-11T23:10:00Z'); // 08:10 KST
  assert.equal(alert.kind, 'handover');
  assert.equal(alert.title, '인수인계 미완료 5건');
  assert.equal(alert.message, '펌프\n호스\n무전기\n…');
  assert.equal(alert.mark, '2026-10-12');
  assert.equal(run('2026-10-11T23:10:00Z', { marks: { handover: '2026-10-12' } }).length, 0); // already sent today
  assert.equal(run('2026-10-12T01:05:00Z').length, 0); // 10:05 KST: window over
  assert.equal(run('2026-10-11T23:10:00Z', { settings: { ...DEFAULT_SETTINGS, handoverAlert: false } }).length, 0);
  assert.equal(
    dueAlerts({ summary: summary({ handoverCount: 0 }), settings: DEFAULT_SETTINGS, marks: {}, now: at('2026-10-11T23:10:00Z') }).length,
    0,
  );
  const office = summary({ dept: { id: 'o', name: '내근', rotating: false }, handoverCount: 1, handover: [{ title: '문서' }] });
  assert.equal(dueAlerts({ summary: office, settings: DEFAULT_SETTINGS, marks: {}, now: at('2026-10-11T23:10:00Z') }).length, 0); // 08:10 is not the office time
  assert.equal(dueAlerts({ summary: office, settings: DEFAULT_SETTINGS, marks: {}, now: at('2026-10-12T07:10:00Z') }).length, 1); // 16:10 KST
  assert.equal(handoverMinutes({ handoverMinutes: 600 }, true), 600);
});

test('the schedule reminder is off by default and lists today', () => {
  const s = summary({ schedules: [{ kind: '훈련', title: '소방 훈련', from: '2026-10-12', to: '2026-10-12' }] });
  const now = at('2026-10-12T00:10:00Z'); // 09:10 KST
  assert.equal(dueAlerts({ summary: s, settings: DEFAULT_SETTINGS, marks: {}, now }).length, 0);
  const [alert] = dueAlerts({ summary: s, settings: { ...DEFAULT_SETTINGS, scheduleAlert: true }, marks: {}, now });
  assert.deepEqual([alert.kind, alert.title, alert.message], ['schedule', '오늘 일정 1건', '[훈련] 소방 훈련']);
  assert.equal(
    dueAlerts({ summary: s, settings: { ...DEFAULT_SETTINGS, scheduleAlert: true }, marks: { schedule: '2026-10-12' }, now }).length,
    0,
  );
});

test('selected text becomes handover items (bullets removed, @name assigns) or a memo with its source page', () => {
  assert.deepEqual(parseHandoverLine('- @홍길동 펌프 점검'), { title: '펌프 점검', assignee: '홍길동' });
  assert.deepEqual(parseHandoverLine('1) 호스 정리'), { title: '호스 정리' });
  assert.equal(parseHandoverLine('   '), null);
  assert.equal(parseHandoverLine('•  '), null);
  assert.equal(parseHandoverLine('가'.repeat(300)).title.length, 120);
  assert.equal(parseHandoverLines('a\n\nb\r\nc').length, 3);
  assert.equal(parseHandoverLines(Array.from({ length: 30 }, (_, i) => 'x' + i).join('\n')).length, 10);
  const memo = memoFrom('\n 공문 제목\n본문 내용', 'https://example.org/a');
  assert.equal(memo.title, '공문 제목');
  assert.equal(memo.content, '공문 제목\n본문 내용\n\n출처: https://example.org/a');
  assert.equal(memoFrom('글', 'chrome://settings').content, '글'); // only web pages are named as the source
  assert.ok(memoFrom('x'.repeat(20000), 'https://example.org').content.length <= 10000);
  const event = {
    schema: 1,
    id: 'a'.repeat(32),
    noteId: 'b'.repeat(32),
    parents: [],
    at: new Date().toISOString(),
    actor: { id: 'x', kind: 'display-only' },
  };
  for (const note of [
    { ...memoFrom('내용', 'https://e.org'), category: '업무 메모' },
    { title: '항목', assignee: '김', category: '인수인계' },
  ])
    assert.ok(core.validEvent({ ...event, note: { content: '', status: 'todo', pinned: false, deleted: false, author: '홍', ...note } }));
});
