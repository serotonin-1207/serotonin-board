import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import core from '../web/core.js';
let db;
const a='11111111-1111-1111-1111-111111111111',b='22222222-2222-2222-2222-222222222222';
const id=n=>n.toString(16).padStart(32,'0');
const make=(n,noteId=n,parents=[])=>({schema:1,id:id(n),noteId:id(noteId),parents:parents.map(id),at:'2000-01-01T00:00:00Z',actor:{id:b,kind:'account'},note:{title:'DB 시험',content:'내용',author:'표시 이름',category:'업무 메모',status:'todo',pinned:false,deleted:false}});
const CODE='test-access-code-0000';
async function actor(user=a,anonymous=true,member=true){await db.exec('reset role;');if(member&&user)await db.query('insert into public.serotonin_test_members(user_id) values($1) on conflict do nothing',[user]);await db.query("select set_config('request.test.user',$1,false),set_config('request.test.jwt',$2,false)",[user,JSON.stringify({is_anonymous:anonymous})]);await db.exec('set role authenticated;');}
async function append(event){return (await db.query('select public.serotonin_append_test_event($1::jsonb) as event',[JSON.stringify(event)])).rows[0].event;}
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.test.user',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.test.jwt',true),''),'{}')::jsonb$$;
 grant usage on schema public,auth to anon,authenticated;`);
 await db.exec(await fs.readFile('supabase/setup.sql','utf8'));
 await db.query("insert into public.serotonin_test_secret(id,code_hash) values(1,encode(sha256(convert_to($1,'UTF8')),'hex'))",[CODE]);
 await actor();
});
after(async()=>{await db?.close();});

test('database assigns authenticated actor and server time, ignoring forged fields',async()=>{
 const saved=await append(make(1));assert.equal(saved.actor.id,a);assert.equal(saved.actor.kind,'anonymous');assert.notEqual(saved.at,'2000-01-01T00:00:00Z');assert.equal(core.validEvent(saved),true);
});
test('authenticated users can read, but cannot insert, overwrite or erase revisions directly',async()=>{
 assert.equal((await db.query('select count(*)::int as n from public.serotonin_test_events')).rows[0].n,1);
 for(const sql of ['insert into public.serotonin_test_events select * from public.serotonin_test_events','update public.serotonin_test_events set event=event','delete from public.serotonin_test_events'])await assert.rejects(db.exec(sql),/permission denied/);
});
test('unauthenticated role cannot read or invoke save and connection functions',async()=>{
 await db.exec('set role anon;');
 for(const sql of ['select * from public.serotonin_test_events','select public.serotonin_append_test_event(null)','select public.serotonin_test_connection()'])await assert.rejects(db.exec(sql),/permission denied/);
 await actor();
});
test('same request can be retried, but its ID cannot be used to overwrite content or actor',async()=>{
 const first=await append(make(2));assert.deepEqual(await append(make(2)),first);
 const changed=make(2);changed.note.content='다른 내용';await assert.rejects(append(changed),/already used/);
 await actor(b);await assert.rejects(append(make(2)),/already used/);await actor();
});
test('missing parent, parent from another note, duplicate parents and new root for existing note are rejected',async()=>{
 await assert.rejects(append(make(3,1,[999])),/Parent revision/);
 await assert.rejects(append(make(3,3,[1])),/Parent revision/);
 await assert.rejects(append(make(3,1,[1,1])),/Invalid parent/);
 await assert.rejects(append(make(3,1,[])),/requires a parent/);
});
test('two users edits from the same parent survive; resolution preserves full history',async()=>{
 const left=await append(make(4,1,[1]));await actor(b);const right=await append(make(5,1,[1]));
 const rows=(await db.query("select event from public.serotonin_test_events where note_id=$1",[id(1)])).rows.map(r=>r.event);
 assert.equal(core.buildNotes(rows)[0].conflict,true);assert.equal(right.actor.id,b);assert.equal(left.actor.id,a);
 const resolved=await append(make(6,1,[4,5]));const notes=core.buildNotes([...rows,resolved]);assert.equal(notes[0].conflict,false);assert.equal(notes[0].history.length,4);await actor();
});
test('unknown note fields, wrong booleans and empty authors are rejected',async()=>{
 for(const changes of [{deleted:'false'},{author:''},{other:{id:a}}]){const event=make(7);Object.assign(event.note,changes);await assert.rejects(append(event),/Invalid note/);}
});
test('registered accounts are distinguished from anonymous accounts without claiming real identity',async()=>{
 await actor(b,false);const saved=await append(make(8));assert.equal(saved.actor.kind,'account');assert.equal(saved.actor.id,b);await actor();
});
test('authenticated role without a user ID cannot impersonate an account',async()=>{
 await actor('');await assert.rejects(append(make(9)),/Authentication required/);assert.equal((await db.query('select count(*)::int as n from public.serotonin_test_events')).rows[0].n,0);await actor();
});
test('server limits repeated writes from one anonymous account',async()=>{
 await actor('33333333-3333-3333-3333-333333333333');
 for(let n=100;n<130;n++)await append(make(n));
 await assert.rejects(append(make(130)),/wait before saving/);await actor();
});
test('calendar schedules are validated by the database; memos cannot carry schedule fields',async()=>{
 const event=(n,fields)=>{const e=make(n);Object.assign(e.note,{category:'일정',kind:'휴가',date:'2026-10-12'},fields);return e;};
 const saved=await append(event(200,{endDate:'2026-10-14'}));assert.equal(core.validEvent(saved),true);assert.equal(saved.note.endDate,'2026-10-14');
 for(const [n,fields] of [[201,{kind:'출장'}],[202,{date:'2026-02-30'}],[203,{date:'2026-10-12',endDate:'2026-10-11'}],[204,{endDate:'2027-01-01'}],[205,{date:undefined}],[206,{endDate:null}]])await assert.rejects(append(event(n,fields)),/Invalid (schedule|note)|out of range/);
 const memo=make(207);memo.note.date='2026-10-12';await assert.rejects(append(memo),/Invalid note/);
});
test('accounts that never presented the access code can neither read nor write',async()=>{
 const stranger='44444444-4444-4444-4444-444444444444';await actor(stranger,true,false);
 assert.equal((await db.query('select count(*)::int as n from public.serotonin_test_events')).rows[0].n,0);
 await assert.rejects(append(make(300)),/Access code required/);
 assert.equal((await db.query('select public.serotonin_test_connection() as c')).rows[0].c.member,false);
 for(const sql of ['select * from public.serotonin_test_members','select * from public.serotonin_test_secret','select * from public.serotonin_test_join_failures'])await assert.rejects(db.exec(sql),/permission denied/);
 await actor();
});
test('the access code admits an account once; wrong codes are refused and locked after five misses',async()=>{
 const join=async code=>(await db.query('select public.serotonin_join_test_board($1) as r',[code])).rows[0].r;
 const good='55555555-5555-5555-5555-555555555555',bad='66666666-6666-6666-6666-666666666666';
 await actor(good,true,false);assert.deepEqual(await join(CODE),{member:true});
 assert.equal((await db.query('select public.serotonin_test_connection() as c')).rows[0].c.member,true);
 assert.equal((await append(make(301))).actor.id,good);
 await actor(bad,true,false);
 for(let n=0;n<5;n++)assert.deepEqual(await join('wrong-'+n),{member:false,error:'invalid'});
 assert.deepEqual(await join(CODE),{member:false,error:'locked'});
 assert.equal((await db.query('select public.serotonin_test_connection() as c')).rows[0].c.member,false);
 await actor();
});
