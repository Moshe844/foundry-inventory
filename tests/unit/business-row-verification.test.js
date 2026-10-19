'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{unchangedRow}=require('../../src/assistant/business-row-verification');
const batch=rows=>({outcomes:[{result:{rows}}]});
test('current canonical facts follow unique original record identity across changed inbox ordering',()=>{
 const original=batch([{id:'one',href:'/record/one',reason:'First'},{id:'two',href:'/record/two',reason:'Second',amount:0}]),current=batch([{id:'new',href:'/record/new',reason:'Unrelated'},{id:'one',href:'/record/one',reason:'First'},{id:'two',href:'/record/two',reason:'Second',amount:0}]);
 assert.deepEqual(unchangedRow(original,current,'/outcomes/0/result/rows/1/reason'),{applicable:true,matched:true,value:'Second'});assert.equal(unchangedRow(original,current,'/outcomes/0/result/rows/1/amount').value,0);
});
test('deleted records, duplicate identities and changed factual values cannot be replaced by equal-looking siblings',()=>{
 const original=batch([{id:'a',amount:0},{id:'b',amount:0}]);
 assert.deepEqual(unchangedRow(original,batch([{id:'c',amount:0}]),'/outcomes/0/result/rows/1/amount'),{applicable:true,matched:false});
 assert.deepEqual(unchangedRow(original,batch([{id:'b',amount:0},{id:'b',amount:0}]),'/outcomes/0/result/rows/1/amount'),{applicable:true,matched:false});
 assert.equal(unchangedRow(original,batch([{id:'b',amount:99}]),'/outcomes/0/result/rows/1/amount').value,99,'Caller still checks the exact asserted value');
 assert.deepEqual(unchangedRow(batch([{href:'/list',amount:0},{href:'/list',amount:1}]),batch([]),'/outcomes/0/result/rows/1/amount'),{applicable:true,matched:false},'A shared list link cannot identify a record');
});
test('unidentified replacement rows cannot fall through to positional equality or navigation URL matching',()=>{
 const path='/outcomes/0/result/rows/0/amount';
 assert.deepEqual(unchangedRow(batch([{amount:0,label:'Original'}]),batch([{amount:0,label:'Other'}]),path),{applicable:true,matched:false});
 assert.deepEqual(unchangedRow(batch([{href:'/connection/shared',decision:'Old issue',amount:0}]),batch([{href:'/connection/shared',decision:'New issue',amount:0}]),path),{applicable:true,matched:false});
 assert.deepEqual(unchangedRow(batch([{id:'old',href:'/connection/shared',amount:0}]),batch([{id:'new',href:'/connection/shared',amount:0}]),path),{applicable:true,matched:false});
 assert.deepEqual(unchangedRow(batch([{measure:'Revenue',amount:0}]),batch([{measure:'Revenue',amount:0}]),path),{applicable:true,matched:true,value:0});
});
