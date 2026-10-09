const test = require('node:test');
const assert = require('node:assert/strict');
const { validEvent, buildNotes, teamOn, dutyDay, monthGrid, addDays, daysBetween } = require('../web/core.js');
const id = n => n.toString(16).padStart(32, '0');
function schedule(updates = {}, parents = []) {
  return {
    schema: 1, id: id(1), noteId: id(90), parents, at: '2026-10-08T01:00:00.000Z',
    note: { title: '홍길동 연차', content: '', author: '작성자', category: '일정', status: 'todo', pinned: false, deleted: false, kind: '휴가', date: '2026-10-12', ...updates },
  };
}

test('teams rotate 1 -> 2 -> 3 starting from 2026-10-08, before and after the anchor', () => {
  assert.deepEqual(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'].map(teamOn), [1, 2, 3, 1, 2]);
  assert.deepEqual(['2026-10-07', '2026-10-06', '2026-10-05'].map(teamOn), [3, 2, 1]);
  assert.equal(teamOn('2027-02-28'), ((daysBetween('2026-10-08', '2027-02-28') % 3) + 1));
});

test('shift day changes at 09:00 Korean time (00:00 UTC)', () => {
  assert.equal(dutyDay('2026-10-08T23:59:59+09:00'), '2026-10-08');
  assert.equal(dutyDay('2026-10-09T08:59:59+09:00'), '2026-10-08');
  assert.equal(dutyDay('2026-10-09T09:00:00+09:00'), '2026-10-09');
  assert.equal(teamOn(dutyDay('2026-10-09T08:00:00+09:00')), 1);
  assert.equal(teamOn(dutyDay('2026-10-09T09:00:00+09:00')), 2);
});

test('month grid is Sunday-first, whole weeks, and contains every day of the month', () => {
  const october = monthGrid(2026, 10);
  assert.equal(october.length % 7, 0);
  assert.equal(october[0], '2026-09-27');
  assert.ok(october.includes('2026-10-01') && october.includes('2026-10-31'));
  assert.equal(monthGrid(2026, 2).length, 28); // Feb 2026 starts on Sunday and has 28 days.
  assert.equal(monthGrid(2026, 8).length, 42); // Aug 2026 starts on Saturday and needs six rows.
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('schedules require a kind and a real date; memos must not carry schedule fields', () => {
  assert.equal(validEvent(schedule()), true);
  assert.equal(validEvent(schedule({ endDate: '2026-10-14' })), true);
  for (const bad of [{ kind: '출장' }, { kind: undefined }, { date: '2026-02-30' }, { date: '2026-1-5' }, { date: undefined }, { endDate: '2026-10-11' }, { endDate: '2026-10-14T00:00' }, { endDate: '2027-01-01' }])
    assert.equal(validEvent(schedule(bad)), false, JSON.stringify(bad));
  const memo = schedule({ category: '업무 메모' });
  assert.equal(validEvent(memo), false);
  delete memo.note.kind; delete memo.note.date;
  assert.equal(validEvent(memo), true);
});

test('schedule revisions keep history and conflicts like memos', () => {
  const first = schedule();
  const edit = { ...schedule({ date: '2026-10-13' }, [id(1)]), id: id(2), at: '2026-10-08T02:00:00.000Z' };
  const [note] = buildNotes([first, edit]);
  assert.equal(note.date, '2026-10-13');
  assert.equal(note.history.length, 2);
  assert.equal(note.conflict, false);
});
