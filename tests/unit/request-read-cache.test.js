'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),cache=require('../../src/lib/request-read-cache');
test('read reuse is restricted to a single request and key, concurrent requests and writes remain fresh',async()=>{
 let calls=0;const read=key=>cache.read(key,async()=>++calls);
 await cache.run(async()=>{assert.equal(await read('inventory-a:owner'),1);assert.equal(await read('inventory-a:owner'),1);assert.equal(await read('inventory-a:staff'),2);assert.equal(await read('inventory-b:owner'),3);});
 assert.equal(await read('inventory-a:owner'),4);await cache.run(async()=>assert.equal(await read('inventory-a:owner'),5));
 let release;const hold=new Promise(r=>release=r);await Promise.all([cache.run(async()=>{const first=await read('same');await hold;assert.equal(await read('same'),first);}),cache.run(async()=>{const value=await read('same');release();assert.equal(await read('same'),value);})]);assert.equal(calls,7);
 await cache.run(async()=>{await assert.rejects(cache.read('failure',()=>{throw Error('temporary');}));assert.equal(await cache.read('failure',()=>42),42);});
 await cache.middleware({method:'POST'},null,async()=>{const a=await read('same'),b=await read('same');assert.equal(b,a+1);});
});
