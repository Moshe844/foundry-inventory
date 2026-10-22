'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const capabilities=require('../../src/autopilot/capabilities');

test('capability control levels keep investigation separate from business execution',()=>{
 for(const name of capabilities.NAMES){
  assert.equal(capabilities.modeAllows(name,'OBSERVE'),false,name);
  assert.equal(capabilities.modeAllows(name,'SUPERVISED'),name==='supplier_document_review',name);
  assert.equal(capabilities.modeAllows(name,'POLICY_AUTOMATED'),true,name);
  for(const unknown of [null,undefined,'','observe','AUTOMATED','OWNER'])assert.equal(capabilities.modeAllows(name,unknown),false,name);
 }
 assert.throws(()=>capabilities.modeAllows('unknown_document_operation','POLICY_AUTOMATED'),/no StockChief job/);
});
