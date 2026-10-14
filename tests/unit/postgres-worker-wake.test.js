'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('notification wakeups retain one execution and coalesce while work is active',async()=>{
 const queue=require('../../src/operations/postgres-job-queue'),original=queue.processOne;
 let calls=0,concurrent=0,maximum=0,release;
 const held=new Promise(resolve=>{release=resolve;});
 queue.processOne=async()=>{calls++;concurrent++;maximum=Math.max(maximum,concurrent);try{if(calls===2)await held;}finally{concurrent--;}};
 const worker=require('../../src/operations/postgres-worker').start({},{intervalMs:60000});
 try{
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  worker.wake();for(let i=0;i<12;i++)worker.wake();assert.equal(calls,2);assert.equal(maximum,1);
  release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,3);assert.equal(maximum,1);
  await worker.stop();worker.wake();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,3);
 }finally{release();await worker.stop();queue.processOne=original;}
});
