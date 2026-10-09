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
