const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNotes, handoverOn, validEvent } = require('../web/core.js');
const id = n => n.toString(16).padStart(32, '0');
// Shift day D runs 09:00 KST (00:00 UTC) on D to 09:00 KST on D+1. Times below are UTC.
function rev(n, noteN, at, parents, updates = {}) {
  return {
    schema: 1, id: id(n), noteId: id(noteN), parents: parents.map(id), at,
    note: { title: '항목 ' + noteN, content: '', author: '이은호', category: '인수인계', status: 'todo', pinned: false, deleted: false, ...updates },
  };
}
const day = (notes, d) => handoverOn(notes, d).map(i => [i.note.title, i.done ? 'done' : 'open', i.carriedDays]);

test('an unfinished item is carried to every following shift day, finished ones drop off the day after', () => {
  const notes = buildNotes([
    rev(1, 1, '2026-10-08T02:00:00.000Z', []),                                   // written on shift day 10-08
    rev(2, 1, '2026-10-10T03:00:00.000Z', [1], { status: 'done' }),               // completed on 10-10
    rev(3, 2, '2026-10-09T01:00:00.000Z', []),                                   // another item, never completed
  ]);
  assert.deepEqual(day(notes, '2026-10-07'), []);
  assert.deepEqual(day(notes, '2026-10-08'), [['항목 1', 'open', 0]]);
  assert.deepEqual(day(notes, '2026-10-09'), [['항목 1', 'open', 1], ['항목 2', 'open', 0]]);
  assert.deepEqual(day(notes, '2026-10-10'), [['항목 1', 'done', 2], ['항목 2', 'open', 1]]);   // checked on the day it was completed
  assert.deepEqual(day(notes, '2026-10-11'), [['항목 2', 'open', 2]]);                          // gone the next day
  assert.deepEqual(day(notes, '2026-10-20'), [['항목 2', 'open', 11]]);
});

test('the day changes at 09:00 Korean time, not at midnight', () => {
  const notes = buildNotes([rev(1, 1, '2026-10-09T16:30:00.000Z', [])]); // 01:30 KST on 10-10 still belongs to shift day 10-09
  assert.deepEqual(day(notes, '2026-10-09'), [['항목 1', 'open', 0]]);
  assert.deepEqual(day(notes, '2026-10-10'), [['항목 1', 'open', 1]]);
  const early = buildNotes([rev(1, 1, '2026-10-09T23:59:59.000Z', []), rev(2, 1, '2026-10-10T00:00:00.000Z', [1], { status: 'done' })]);
  assert.deepEqual(day(early, '2026-10-09'), [['항목 1', 'open', 0]]);   // completed at 09:00:00 KST on 10-10 = new shift day
  assert.deepEqual(day(early, '2026-10-10'), [['항목 1', 'done', 1]]);
});

test('reopening a finished item brings it back, deleting removes it from that day on while history stays', () => {
  const notes = buildNotes([
    rev(1, 1, '2026-10-08T01:00:00.000Z', []),
    rev(2, 1, '2026-10-08T05:00:00.000Z', [1], { status: 'done' }),
    rev(3, 1, '2026-10-10T01:00:00.000Z', [2], { status: 'todo' }),              // reopened on 10-10
    rev(4, 2, '2026-10-08T01:00:00.000Z', []),
    rev(5, 2, '2026-10-10T01:00:00.000Z', [4], { deleted: true }),                // deleted on 10-10
  ]);
  assert.deepEqual(day(notes, '2026-10-08'), [['항목 1', 'done', 0], ['항목 2', 'open', 0]]);
  assert.deepEqual(day(notes, '2026-10-09').map(r => r[0]), ['항목 2']);          // 항목 1 finished on 10-08, so absent on 10-09
  assert.deepEqual(day(notes, '2026-10-10'), [['항목 1', 'open', 2]]);
  assert.equal(notes.find(n => n.id === id(2)).history.length, 2);                // the deleted item's history is intact
});

test('important items come first, other categories and schedules are ignored', () => {
  const notes = buildNotes([
    rev(1, 1, '2026-10-08T01:00:00.000Z', []),
    rev(2, 2, '2026-10-08T02:00:00.000Z', [], { pinned: true }),
    rev(3, 3, '2026-10-08T03:00:00.000Z', [], { category: '업무 메모' }),
    rev(4, 4, '2026-10-08T04:00:00.000Z', [], { category: '일정', kind: '휴가', date: '2026-10-09' }),
  ]);
  assert.deepEqual(day(notes, '2026-10-08').map(r => r[0]), ['항목 2', '항목 1']);
  assert.ok(notes.every(n => validEvent(n.history[0])));
});
