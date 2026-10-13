'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {localPath}=require('../../src/assistant/agent-navigation-path');
test('browser handoff paths reject external, ambiguous and encoded redirect targets without a route catalogue',()=>{
 for(const value of ['//evil.test','/\\evil.test','/%2f%2fevil.test','/%252f%252fevil.test','https://evil.test',
  '/a/../logout','/x\nheader','/%0dheader','/%5cevil.test','/bad%'])assert.equal(localPath(value),null,value);
 for(const value of ['/new-screen-'+Date.now(),'/unknown/record?filter=blue%20widget','/settings'])assert.equal(localPath(value),value);
});
test('governed-only work does not initialize the browser; concurrent browser calls share one goal-local setup',async()=>{
 let starts=0,calls=0;
 const lazy=require('../../scripts/environment-agent-demo/lazy-browser').lazyBrowser(async()=>{
  starts++;return {act:async()=>++calls,restore:async()=>++calls};
 });
 assert.equal(starts,0);
 assert.deepEqual(await Promise.all([lazy.act({}),lazy.act({}),lazy.restore('/')]),[1,2,3]);
 assert.equal(starts,1);
});
test('a genuine blocked report retains its reason instead of being mislabeled as a page delivery failure',async()=>{
 const result=await require('../../src/assistant/postgres-codex-verification').verify(null,null,{checkpoint:{clientIntegration:1}},
  JSON.stringify({status:'blocked',answer:'The required source record is unavailable.'}));
 assert.equal(result.verified,false);assert.equal(result.answer,'The required source record is unavailable.');
});
