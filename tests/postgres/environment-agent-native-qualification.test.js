'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('native SDKs qualify eighteen reasoning-heavy turns against unchanged commercial ceilings without paid calls',async()=>{
 const results=[];
 for(const candidate of ['openai','claude'])results.push(await require('../../scripts/environment-agent-demo/offline-qualification').qualify(candidate,{stress:true,turns:18}));
 const fs=require('node:fs'),path=require('node:path'),cert=require('../../scripts/environment-agent-demo/certification');
 fs.mkdirSync(cert.directory,{recursive:true});fs.writeFileSync(path.join(cert.directory,'checkpoint-native-qualification.json'),JSON.stringify({
  sourceHash:cert.sourceHash(),checkedAt:new Date().toISOString(),results,paidCalls:0},null,2));
 assert.equal(results[0].qualified,true,JSON.stringify(results[0]));
 assert.ok(results.every(r=>r.unresolved===0),JSON.stringify(results));
 assert.equal(results[1].qualified,true,JSON.stringify(results[1]));
 assert.ok(results.every(r=>r.context.some(e=>e.itemsDropped>0||e.beforeBytes>e.afterBytes)),JSON.stringify(results));
});
