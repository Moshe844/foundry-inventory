'use strict';const test=require('node:test'),assert=require('node:assert/strict'),planner=require('../../src/assistant/postgres-capability-planner'),registry=require('../../src/assistant/postgres-capability-registry').registry;
test('new operations cannot expand the planner past its cost bound or disappear from the complete operation index',()=>{
 const entries=registry.list(),extra=Array.from({length:30},(_,i)=>({name:'fixture.operation_'+i,description:'A distinct future business operation with its complete registered authority contract.',kind:'mutation',fields:['recordReference','quantity'],permission:'ADMIN'})),catalogue={list:()=>[...entries,...extra]};
 const prompt=planner.systemFor(catalogue),encoded=JSON.parse(prompt.split('Registered capability contracts: ')[1]);assert(prompt.length<24000);const indexed=new Map(encoded.mutations.map(row=>[row.n,row.a]));for(const row of [...entries,...extra].filter(e=>e.kind==='mutation'))assert.equal(indexed.get(row.name),row.fields.join(','));assert.match(prompt,/All changes need approval/);
});
test('a tighter provider allowance retains every operation and rejects invented alternatives',()=>{
 const prompt=planner.systemFor(registry,{compact:true,maximumBytes:21000}),encoded=JSON.parse(prompt.split('Registered capability contracts: ')[1]);assert(Buffer.byteLength(prompt)<21000);
 const indexed=new Map(encoded.mutations.map(r=>[r.n,r.a]));for(const entry of registry.list().filter(e=>e.kind==='mutation'))assert.equal(indexed.get(entry.name),entry.fields.join(','));
 assert.equal(planner.parseSteps({steps:[],closestAlternative:'invented.operation',clarifyingQuestion:''},registry).closestAlternative,null);
 const known=registry.list().find(e=>e.discovery);assert(known);assert.equal(planner.parseSteps({steps:[],closestAlternative:known.name,clarifyingQuestion:''},registry).closestAlternative,known.name);
});
