'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cache=require('../../src/lib/versioned-read-model');
function fixture(){let received,state,committed;const db={query(){throw Error('Cached reads must never query a database revision.');},onCommittedWrite:callback=>{committed=callback;},subscribe(channel,notify,options){assert.equal(channel,'stockchief_read_models');received=notify;state=options.onState;return {ready:Promise.resolve(),connected:true};}};return {db,commit:ids=>committed(new Set(ids)),notify:(workspace,business)=>received({payload:JSON.stringify({workspace,business})}),state:value=>state(value)};}
test('cache hits make no revision query and committed notices invalidate only their inventory and domain',async()=>{
 const f=fixture();let calls=0;const read=(w,domain='business')=>cache.read(f.db,w,['same'],async()=>++calls,{domain});
 assert.equal(await read('a'),1);assert.equal(await read('a'),1);assert.equal(await read('b'),2);assert.equal(await read('a','all'),3);
 f.notify('a',false);assert.equal(await read('a'),1);assert.equal(await read('b'),2);assert.equal(await read('a','all'),4);
 f.notify('a',true);assert.equal(await read('a'),5);assert.equal(await read('b'),2);
 f.commit(['a']);assert.equal(await read('a'),6);assert.equal(await read('b'),2);
 f.state(false);assert.equal(await read('b'),7);f.state(true);assert.equal(await read('b'),8);
});
test('the existing TTL expires cached business values even if a notification is missed',async t=>{
 t.mock.timers.enable({apis:['Date'],now:0});const f=fixture();let n=0;const read=()=>cache.read(f.db,'a',['ttl'],async()=>++n,{domain:'business'});
 assert.equal(await read(),1);t.mock.timers.tick(59999);assert.equal(await read(),1);t.mock.timers.tick(2);assert.equal(await read(),2);
});
test('invalidation during an in-flight read never repopulates a superseded cache entry',async()=>{
 const f=fixture();let release,began;const started=new Promise(r=>began=r),first=cache.read(f.db,'a',['pending'],()=>new Promise(r=>{release=r;began();}));await started;
 f.notify('a',true);assert.equal(await cache.read(f.db,'a',['pending'],async()=>2),2);release(1);assert.equal(await first,1);assert.equal(await cache.read(f.db,'a',['pending'],async()=>3),2);
});
