'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Registry,registry}=require('../../src/assistant/postgres-capability-registry');
const {operationSteps,nativeFieldName}=require('../../scripts/environment-agent-demo/contracts');

test('native argument aliases cannot change types, invent canonical fields or overwrite another argument',()=>{
 const product=registry.get('catalog.create_item'),catalogue={get:name=>name===product.name?product:null};
 assert(Object.isFrozen(product.agentArgumentAliases));assert.deepEqual(product.fields,['search','baseCode']);assert.equal(nativeFieldName(product,'search'),'itemName');
 const call=arguments_=>[{capability:product.name,arguments:arguments_,dependsOn:[]}];
 assert.deepEqual(operationSteps(call([{name:'itemName',value:'Literal arbitrary product name'},{name:'baseCode',value:'EXACT-7'}]),catalogue)[0].arguments,[{name:'search',value:'Literal arbitrary product name'},{name:'baseCode',value:'EXACT-7'}]);
 assert.deepEqual(operationSteps(call([{name:'search',value:'Older saved product name'}]),catalogue)[0].arguments,[{name:'search',value:'Older saved product name'}]);
 for(const arguments_ of [[{name:'itemName',value:'one'},{name:'search',value:'two'}],[{name:'search',value:'one'},{name:'itemName',value:'two'}],[{name:'workspaceId',value:'another-tenant'}]]){
  assert.throws(()=>operationSteps(call(arguments_),catalogue),error=>error.code==='TOOL_CONTRACT_INVALID'&&error.effectMayHaveOccurred===false);
 }
 for(const aliases of [{amount:'search'},{itemName:'absent'},{itemName:'search',locationName:'search'},{search:'search'}])assert.throws(()=>new Registry().register({...product,agentArgumentAliases:aliases}),/Invalid native argument alias/);
});
