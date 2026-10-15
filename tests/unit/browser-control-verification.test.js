'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {unchangedControl}=require('../../src/assistant/browser-control-verification');
test('recorded live control facts survive new handles and changed observation positions',()=>{
 const fixture=require('../fixtures/codex-browser-control-encoding.json');
 const first=fixture.claims.find(c=>c.path==='/controls/0');
 assert.notDeepEqual(fixture.previous.controls[0],first.value,'The model actually copied the compact wire representation');
 assert.deepEqual(require('../../scripts/environment-agent-demo/browser-presentation').compact(fixture.previous).controls[0],first.value);
 for(const claim of fixture.claims)assert(unchangedControl(fixture.previous,fixture.current,claim.path).matched,claim.path);
 const reordered={controls:[...fixture.current.controls].reverse()};
 assert.equal(unchangedControl(fixture.previous,reordered,'/controls/0/value').matched,true);
 assert.equal(unchangedControl({screen:fixture.previous},{screen:reordered},'/screen/controls/0/value').matched,true);
 assert.equal(unchangedControl(fixture.previous,fixture.current,'/controls/0/ref').matched,false);
 assert.equal(unchangedControl(fixture.previous,fixture.current,'/controls/0/optionsNextRef').matched,false);
});
test('changed form facts, duplicate fields and matching values in unrelated controls fail closed',()=>{
 const f=require('../fixtures/codex-browser-control-encoding.json'),clone=()=>structuredClone(f.current);
 for(const [key,value]of Object.entries({value:'999',name:'another_field',disabled:true,required:false,min:'2',readOnly:true})){
  const current=clone();current.controls[0][key]=value;
  assert.equal(unchangedControl(f.previous,current,'/controls/0/value').matched,false,key);
 }
 const changed=clone();changed.controls[0].form.action='/different-operation';assert.equal(unchangedControl(f.previous,changed,'/controls/0').matched,false);
 const duplicate=clone();duplicate.controls.push(structuredClone(duplicate.controls[0]));assert.equal(unchangedControl(f.previous,duplicate,'/controls/0').matched,false);
 const moved=clone();moved.controls[0].value='999';moved.controls[1].value=f.previous.controls[0].value;
 assert.equal(unchangedControl(f.previous,moved,'/controls/0/value').matched,false,'Unrelated equal value does not prove the original field');
 assert.equal(unchangedControl(f.previous,f.current,'/controls/0/__proto__').matched,false);
});
