'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),compare=require('../../src/assistant/browser-control-verification').unchangedControl;
const fixture=require('../fixtures/codex-repeated-form-controls.json');
const screen=()=>({controls:structuredClone(fixture.controls).map((c,i)=>({...c,ref:'old:'+i,evidencePath:'/controls/'+i}))});
test('exact recorded repeated grouping fields retain their ordered identity in a fully unchanged control sequence',()=>{
 const old=screen(),fresh=screen();fresh.controls.forEach((c,i)=>{c.ref='new:'+i;});
 for(const index of [1,2])for(const field of ['label','value','options']){
  const result=compare(old,fresh,'/controls/'+index+'/'+field);assert.equal(result.matched,true,'Repeated fields are valid HTML; an unchanged complete sequence anchors each ordinal');assert.deepEqual(result.value,old.controls[index][field]);
 }
 assert.equal(compare({screen:old},{screen:fresh},'/screen/controls/2/value').matched,true);
 assert.equal(compare(old,fresh,'/controls/1/ref').matched,false,'Opaque handles remain unusable as business facts');
});
test('changed or structurally ambiguous repeated fields cannot borrow an unchanged neighbour',()=>{
 const old=screen();
 for(const mutate of [
  s=>{s.controls[1].value='sku';},
  s=>{s.controls[1].options[1].label='Changed option';},
  s=>{s.controls.splice(1,0,structuredClone(s.controls[1]));},
  s=>{s.controls.splice(1,1);},
  s=>{s.controls[1].form.action='/different-operation';},
  s=>{s.controls[1].required=true;},
  s=>{s.controls.unshift({...s.controls[0],name:'unfamiliar-field'});}
 ]){const fresh=screen();mutate(fresh);assert.equal(compare(old,fresh,'/controls/1/value').matched,false);assert.equal(compare(old,fresh,'/controls/2/value').matched,false);}
});
