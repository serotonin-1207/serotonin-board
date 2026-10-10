import {test} from 'node:test';
import assert from 'node:assert/strict';
import core from '../web/core.js';
import {canonical,publicSupabaseConfig,SupabaseStorage} from '../src/storage.mjs';
globalThis.window={BoardCore:core};
const event={schema:1,id:'a'.repeat(32),noteId:'b'.repeat(32),parents:[],at:'2026-10-08T00:00:00Z',note:{title:'클라우드 시험',content:'내용',author:'시험',category:'업무 메모',status:'todo',pinned:false,deleted:false},actor:{id:'server-id',kind:'anonymous'}};
test('only https Supabase project addresses and public publishable keys are accepted',()=>{
 assert.equal(publicSupabaseConfig('https://example.supabase.co','sb_publishable_test').url,'https://example.supabase.co');
 for(const [url,key] of [['http://example.supabase.co','sb_publishable_test'],['https://example.com','sb_publishable_test'],['https://example.supabase.co/path','sb_publishable_test'],['https://example.supabase.co','sb_secret_test'],['https://example.supabase.co','service_role']])assert.throws(()=>publicSupabaseConfig(url,key));
});
test('JSON comparison ignores object key order but preserves array order',()=>{
 assert.equal(canonical({x:1,y:[1,2]}),canonical({y:[1,2],x:1}));assert.notEqual(canonical([1,2]),canonical([2,1]));
});
test('save requires matching server payload and a separate matching read-back',async()=>{
 const storage=new SupabaseStorage({maxEvents:1000},{});storage.session=async()=>({id:'server-id'});
 let readback=event;
 storage.client={rpc:async()=>({data:event}),from:()=>({select:()=>({eq:()=>({single:async()=>({data:{event:readback}})})})})};
 assert.deepEqual(await storage.append(event),event);
 readback={...event,note:{...event.note,content:'손상'}};await assert.rejects(storage.append(event),/내용 확인/);
 const changed={...event,note:{...event.note,title:'다른 요청'}};await assert.rejects(storage.append(changed),/요청과 다릅니다/);
});

test('after the first full read only newer rows are fetched, with an overlap, and a periodic full re-read', async () => {
  const mk = (n, savedAt) => ({ saved_at: savedAt, event: { ...event, id: n.toString(16).padStart(32, '0'), noteId: n.toString(16).padStart(32, '0') } });
  const rows = [mk(1, '2026-10-09T10:00:00.000000+00:00'), mk(2, '2026-10-09T10:05:00.000000+00:00')];
  const calls = [];
  const storage = new SupabaseStorage({ maxEvents: 20000 }, {});
  storage.session = async () => ({ id: 'u' });
  storage.dept = { id: 'd1', name: '1부서', rotating: true };
  storage.client = {
    from: () => {
      const q = { since: null };
      const api = {
        select: () => api, order: () => api,
        gte: (col, value) => { q.since = value; return api; },
        range: async () => { calls.push(q.since); return { data: q.since ? rows.filter(r => Date.parse(r.saved_at) >= Date.parse(q.since)) : rows, error: null }; },
      };
      return api;
    },
  };
  const first = await storage.list(new Map());
  assert.equal(first.length, 2);
  assert.equal(calls[0], null); // full read
  rows.push(mk(3, '2026-10-09T10:09:00.000000+00:00'));
  const second = await storage.list(new Map(first.map(e => [e.id, e])));
  assert.equal(second.length, 3);
  assert.ok(calls[1]); // incremental
  assert.ok(Date.parse(calls[1]) <= Date.parse('2026-10-09T10:05:00Z') && Date.parse(calls[1]) >= Date.parse('2026-10-09T10:02:30Z')); // 2 min before the newest row seen
  const third = await storage.list(new Map(second.map(e => [e.id, e])));
  assert.equal(third.length, 3); // overlap re-reads rows without duplicating them
  for (let i = 0; i < 2000; i++) await storage.list(new Map(third.map(e => [e.id, e])));
  assert.ok(calls.filter(c => c === null).length >= 2); // safety-net full re-read happened again
});
