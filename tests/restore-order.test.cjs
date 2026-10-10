const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../web/core.js');
const ex = require('../web/export.js');
const id = n => n.toString(16).padStart(32, '0');
const rev = (n, noteN, at, parents = []) => ({
  schema: 1, id: id(n), noteId: id(noteN), parents: parents.map(id), at,
  note: { title: '항목 ' + noteN, content: '', author: '홍길동', category: '인수인계', status: 'todo', pinned: false, deleted: false },
});
const text = events => JSON.stringify({ schema: 1, app: 'serotonin-board', events });

test('a backup file is parsed strictly: wrong shape, empty, or one bad revision rejects the whole file', () => {
  assert.equal(ex.parseBackup(text([rev(1, 1, '2026-10-08T01:00:00.000Z')]), core.validEvent).events.length, 1);
  assert.throws(() => ex.parseBackup('not json', core.validEvent), /JSON/);
  assert.throws(() => ex.parseBackup('{"schema":2,"events":[]}', core.validEvent), /백업 파일이 아닙니다/);
  assert.throws(() => ex.parseBackup(text([]), core.validEvent), /기록이 없습니다/);
  const bad = rev(2, 2, '2026-10-08T01:00:00.000Z');
  bad.note.title = '';
  assert.throws(() => ex.parseBackup(text([rev(1, 1, '2026-10-08T01:00:00.000Z'), bad]), core.validEvent), /올바르지 않은 기록/);
});

test('revisions are ordered parents first even when clocks disagree, and already stored ones are left out', () => {
  // the child claims an earlier time than its parent (clock skew)
  const parent = rev(1, 1, '2026-10-09T10:00:00.000Z');
  const child = rev(2, 1, '2026-10-09T09:00:00.000Z', [1]);
  const other = rev(3, 2, '2026-10-09T08:00:00.000Z');
  const ordered = ex.orderForRestore([child, other, parent], []);
  assert.ok(ordered.findIndex(e => e.id === parent.id) < ordered.findIndex(e => e.id === child.id));
  assert.equal(ordered.length, 3);
  // the parent already exists on the board: only the child is restored
  assert.deepEqual(ex.orderForRestore([parent, child, other], [parent.id, other.id]).map(e => e.id), [child.id]);
});

test('a backup whose history is incomplete or circular is refused instead of restored half way', () => {
  assert.throws(() => ex.orderForRestore([rev(2, 1, '2026-10-09T09:00:00.000Z', [1])], []), /빠져 있어/);
  assert.throws(() => ex.orderForRestore([rev(1, 1, '2026-10-09T09:00:00.000Z', [2]), rev(2, 1, '2026-10-09T09:01:00.000Z', [1])], []), /순환/);
});
