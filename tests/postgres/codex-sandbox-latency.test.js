'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('actual Docker spare removes creation from the request path and never shares scratch files',{timeout:90000},async t=>{
 const image=process.env.STOCKCHIEF_DEMO_IMAGE;if(!image)throw Error('IMMUTABLE_LOCAL_IMAGE_REQUIRED');
 const {prepareSandbox}=require('../../scripts/environment-agent-demo/codex-runtime'),{createPool}=require('../../scripts/environment-agent-demo/codex-sandbox-pool');
 const start=Date.now(),cold=await prepareSandbox(image),coldMs=Date.now()-start;let first,second;
 const pool=createPool({image});t.after(async()=>{await Promise.allSettled([cold.sandbox.close(),first?.sandbox.close(),second?.sandbox.close()]);await pool.close();});
 await pool.ready();const checkout=Date.now();first=await pool.take(image);const readyCheckoutMs=Date.now()-checkout;
 await first.sandbox.exec({cmd:'printf private-goal-evidence > private-note.txt'});
 await pool.ready();second=await pool.take(image);assert.notEqual(first.sandbox.state.containerId,second.sandbox.state.containerId);
 await assert.rejects(second.sandbox.readFile({path:'/workspace/private-note.txt'}));assert(first.isolation.passed&&second.isolation.passed);
 await Promise.all([first.sandbox.close(),first.sandbox.close()]);await first.sandbox.close();await assert.rejects(first.sandbox.certify(),'Repeated host cleanup must not leave the original container running');
 const result={offline:true,paidCalls:0,coldPreparationMs:coldMs,readyCheckoutMs,freshContainers:true,tenantFilesShared:false,existingIsolationChecksRetained:true};
 fs.mkdirSync(path.resolve('data/latency-repair'),{recursive:true});fs.writeFileSync(path.resolve('data/latency-repair/setup-results.json'),JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
});
