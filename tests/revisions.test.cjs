const test = require('node:test');
const assert = require('node:assert/strict');
const { validEvent, buildNotes, headKey, koreanDay } = require('../web/core.js');
const id = n => n.toString(16).padStart(32,'0');
function revision(n, parents=[], updates={}, noteId=id(50)) {
  return { schema:1,id:id(n),noteId,parents:parents.map(id),at:new Date(Date.UTC(2026,9,7,1,n)).toISOString(),
    note:{title:'인수인계 메모',content:'장비 점검 완료',author:'시험 작성자',category:'인수인계',status:'todo',pinned:false,deleted:false,...updates} };
}
test('a newer revision supersedes its parent and retains both in history',()=>{
  const [note]=buildNotes([revision(2,[1],{content:'수정한 내용'}),revision(1)]);
  assert.equal(note.content,'수정한 내용');assert.equal(note.history.length,2);assert.equal(note.conflict,false);
});
test('simultaneous edits survive and create two heads regardless of input order',()=>{
  const original=revision(1),alice=revision(2,[1],{content:'A 수정'}),bob=revision(3,[1],{content:'B 수정'});
  for(const list of [[original,alice,bob],[bob,alice,original]]){
    const [note]=buildNotes(list);assert.equal(note.conflict,true);assert.deepEqual(note.heads.map(e=>e.note.content),['A 수정','B 수정']);
  }
});
test('resolving all observed heads keeps every earlier revision',()=>{
  const [note]=buildNotes([revision(1),revision(2,[1]),revision(3,[1]),revision(4,[2,3],{content:'확인 후 통합'})]);
  assert.equal(note.conflict,false);assert.equal(note.content,'확인 후 통합');assert.equal(note.history.length,4);
});
test('an unseen simultaneous edit survives a partial resolution',()=>{
  const [note]=buildNotes([revision(1),revision(2,[1]),revision(3,[1]),revision(4,[2])]);
  assert.equal(note.conflict,true);assert.deepEqual(note.heads.map(e=>e.id),[id(3),id(4)]);
});
test('stale editor head keys change after another user saves',()=>{
  const [before]=buildNotes([revision(1)]),[after]=buildNotes([revision(1),revision(2,[1])]);
  assert.notEqual(headKey(before),headKey(after));assert.equal(headKey(null),'');
});
test('soft deletion and restore preserve the full revision history',()=>{
  const a=revision(1),b=revision(2,[1],{deleted:true}),c=revision(3,[2],{deleted:false});
  assert.equal(buildNotes([a,b])[0].deleted,true);
  const [restored]=buildNotes([a,b,c]);assert.equal(restored.deleted,false);assert.equal(restored.history.length,3);
});
test('malformed records and missing ancestors fail closed',()=>{
  assert.equal(validEvent(revision(1,[],{title:''})),false);
  assert.equal(validEvent({...revision(1),id:'../../secret'}),false);
  assert.equal(validEvent(revision(1,[],{author:'x'.repeat(41)})),false);
  assert.equal(validEvent(revision(1,[1])),false);
  assert.throws(()=>buildNotes([revision(2,[1])]),/이전 수정 기록/);
});
test('cycles are rejected even with a separate valid root',()=>{
  assert.throws(()=>buildNotes([revision(1),revision(2,[3]),revision(3,[2])]),/순환/);
});
test('timestamp skew cannot resurrect a parent over its child',()=>{
  const original=revision(1);original.at='2027-01-01T00:00:00.000Z';
  const [note]=buildNotes([original,revision(2,[1],{content:'자식 기록'})]);assert.equal(note.content,'자식 기록');
});
test('Seoul day rolls over at UTC 15:00',()=>{
  assert.equal(koreanDay('2026-10-07T14:59:59Z'),'2026-10-07');
  assert.equal(koreanDay('2026-10-07T15:00:00Z'),'2026-10-08');
});
