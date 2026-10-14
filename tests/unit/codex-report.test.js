'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const wire=require('../../scripts/environment-agent-demo/codex-report'),conversation=require('../../src/assistant/agent-conversation');
function report(fields={}){return {version:1,status:'completed',outcome:'answer',answer:'Verified result',question:null,missingInformation:[],tier:null,reason:null,
 claims:[{evidenceId:'durable-observation',path:'/records',valueJson:JSON.stringify([{unknownField:'discovered',quantity:0,available:false}]),historical:false}],navigation:null,workProducts:[],nextActions:[],...fields};}
test('native final decoding preserves arbitrary discovered evidence and all conversation handoffs',()=>{
 const completed=conversation.parse(wire.decode(JSON.stringify(report())));
 assert.deepEqual(completed.claims[0].value,[{unknownField:'discovered',quantity:0,available:false}]);assert.equal(completed.navigation,undefined);
 for(const [status,fields]of [
  ['needs_user',{question:'Which location should receive these?',missingInformation:['location']}],
  ['needs_reasoning',{tier:'complex',reason:'Several dependent decisions require stronger reasoning.'}],
  ['blocked',{answer:'The required provider is unavailable.'}]
 ]){
  const value=conversation.parse(wire.decode(JSON.stringify(report({status,claims:[],outcome:null,...fields}))));
  assert.equal(value.status,status);
 }
 assert.equal(wire.schema.additionalProperties,false);assert.deepEqual(wire.schema.required,Object.keys(wire.schema.properties));
});
test('format conversion cannot turn prose, malformed claim values or missing evidence into verified completion',()=>{
 const prose='The purchase is a draft and needs a unit cost. Nothing was sent or changed.';
 assert.equal(wire.decode(prose),prose);assert.equal(conversation.parse(prose),null);
 assert.throws(()=>wire.decode(JSON.stringify(report({claims:[{evidenceId:'recorded',path:'/text',valueJson:'invalid json',historical:false}]}))),/INVALID_NATIVE_CLAIM_ENCODING/);
 const valid=conversation.parse(wire.decode(JSON.stringify(report())));
 assert.equal(conversation.classify({report:valid,verified:false}).status,'BLOCKED');
 const old={status:'completed',outcome:'answer',answer:'Old verified result',claims:[{evidenceId:'old',path:'/quantity',value:2}]};
 assert.deepEqual(JSON.parse(wire.decode(JSON.stringify(old))),old,'Existing native checkpoints remain readable without rewriting their history');
});
