'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {matches}=require('../../scripts/environment-agent-demo/interface-search');
const registry=require('../../src/assistant/postgres-capability-registry').registry;
test('recorded alert/test/stock searches use actual contract schema and whole terms',()=>{
 const policy=registry.get('policy.propose'),native={...policy,fields:[...policy.fields,...policy.agentFields]};
 assert.equal(`${native.name} ${native.description}`.toLowerCase().includes('alert'),false,'Recorded first search previously missed this contract');
 assert.equal(matches(native,'alert'),true);
 assert.equal(matches(native,'stock alerts'),true);
 assert.equal(matches(native,'notification threshold'),true);
 assert.equal(matches(native,'supplier terms'),true);
 const accounting=registry.get('connection.map_account');assert(accounting.description.includes('latest'));
 assert.equal(`${accounting.name} ${accounting.description}`.toLowerCase().includes('test'),true,'Recorded unrelated accounting result');
 assert.equal(matches(accounting,'test'),false);assert.equal(matches(accounting,'stock'),false);
 assert.equal(matches(accounting,'account'),true,'Relevant accounting discovery still works');
 const dynamic={name:'unfamiliar.interface',description:'Dynamically changed interface',fields:{payload:{jsonSchema:{properties:{copperMultiplier:{type:'number'}}}}}};
 assert.equal(matches(dynamic,'copper multiplier'),true,'New field discovery does not require adding search aliases');
});
