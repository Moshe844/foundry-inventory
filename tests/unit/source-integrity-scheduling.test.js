'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{execFile}=require('node:child_process');

test('a real integrity worker result survives a parent check-phase pause while every request still computes the full source hash',{timeout:45000},async()=>{
 const root=path.resolve(__dirname,'../..'),code=`
 const assert=require('node:assert/strict'),root=${JSON.stringify(root)},checker=require(root+'/scripts/environment-agent-demo/source-hash-worker');
 (async()=>{
  const expected=require(root+'/scripts/environment-agent-demo/certification').sourceHash();
  assert.equal(await checker.sourceHash(),expected);
  let pending,started;
  await new Promise(resolve=>setImmediate(()=>{
   started=Date.now();pending=checker.sourceHash();
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,16000);resolve();
  }));
  assert.equal(await pending,expected);
  process.stdout.write(JSON.stringify({matched:true,elapsedMs:Date.now()-started}));
 })().catch(error=>{process.stderr.write(error.code||error.message);process.exitCode=1;});`;
 const stdout=await new Promise((resolve,reject)=>execFile(process.execPath,['-e',code],{cwd:root,windowsHide:true,timeout:40000,maxBuffer:1000000},(error,out,err)=>error?reject(new Error('The isolated integrity scheduling regression failed: '+err,{cause:error})):resolve(out)));
 const result=JSON.parse(stdout);assert.equal(result.matched,true);assert(result.elapsedMs>=15000,'Exercise the actual deadline while the worker can finish independently');
});
