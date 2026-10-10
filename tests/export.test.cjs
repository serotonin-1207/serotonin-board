const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../web/core.js');
const ex = require('../web/export.js');
const id = n => n.toString(16).padStart(32, '0');
function rev(n, noteN, at, parents, updates = {}) {
  return { schema: 1, id: id(n), noteId: id(noteN), parents: parents.map(id), at, actor: { id: 'a', kind: 'anonymous' },
    note: { title: '항목 ' + noteN, content: '', author: '이은호', category: '인수인계', status: 'todo', pinned: false, deleted: false, ...updates } };
}
const events = [
  rev(1, 1, '2026-10-08T01:00:00.000Z', [], { content: '야간, "이상음" 있음\n재확인' }),
  rev(2, 1, '2026-10-09T03:00:00.000Z', [1], { content: '야간, "이상음" 있음\n재확인', status: 'done', author: '김철수' }),
  rev(3, 2, '2026-10-09T01:00:00.000Z', [], { title: '=HYPERLINK("http://x")' }),
];
const notes = core.buildNotes(events);
const lines = csv => csv.replace(/^\ufeff/, '').split('\r\n').filter(Boolean);

test('CSV is UTF-8 with BOM, quotes commas, quotes and line breaks, and neutralises spreadsheet formulas', () => {
  assert.ok(ex.itemsCsv(notes).startsWith('\ufeff'));
  assert.equal(ex.csvCell('a,b'), '"a,b"');
  assert.equal(ex.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(ex.csvCell('줄1\n줄2'), '"줄1\n줄2"');
  for (const risky of ['=1+1', '+1', '-1', '@SUM(A1)']) assert.equal(ex.csvCell(risky), "'" + risky);
  assert.equal(ex.csvCell(null), '');
  assert.equal(ex.csvCell(0), '0');
  assert.ok(ex.itemsCsv(notes).includes(`"'=HYPERLINK(""http://x"")"`) || ex.itemsCsv(notes).includes("'=HYPERLINK"));
});

test('items file has one row per item with completion time and person; revisions file has every revision in time order', () => {
  const items = lines(ex.itemsCsv(notes));
  assert.equal(items.length, 3); // header + 2 items
  const first = items.find(l => l.includes('항목 1'));
  assert.ok(first.includes('완료') && first.includes('김철수') && first.includes('2026-10-09 12:00:00')); // 03:00Z = 12:00 KST
  const revs = lines(ex.revisionsCsv(events));
  assert.equal(revs.length, 1 + 3);
  assert.ok(revs[1].startsWith('2026-10-08 10:00:00') && revs[3].startsWith('2026-10-09 12:00:00'));
});

test('the handover log rebuilds each day as it looked, including carry-over', () => {
  const log = lines(ex.logbookCsv(core, notes.filter(n => n.id === id(1)), '2026-10-11', true, core.teamOn));
  // item 1: written 10-08, done 10-09 -> rows for 10-08 (open), 10-09 (done), none on 10-10/10-11
  assert.equal(log.length, 1 + 2);
  assert.ok(log[1].startsWith('2026-10-08,') && log[1].includes('미완료'));
  assert.ok(log[2].startsWith('2026-10-09,') && log[2].includes(',완료,'));
  const office = lines(ex.logbookCsv(core, notes.filter(n => n.id === id(1)), '2026-10-11', false, core.teamOn));
  assert.ok(!office[0].includes('근무 팀'));
});

test('the JSON backup keeps every revision and the department', () => {
  const data = JSON.parse(ex.backupJson(events, { department: { id: 'dept1', name: '1부서' }, version: '0.6.0' }));
  assert.equal(data.events.length, 3);
  assert.equal(data.department.name, '1부서');
  assert.equal(data.app, 'serotonin-board');
});
