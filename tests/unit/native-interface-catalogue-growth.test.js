'use strict';const test=require('node:test'),assert=require('node:assert/strict'),gateway=require('../../scripts/environment-agent-demo/gateway'),presentation=require('../../scripts/environment-agent-demo/interface-presentation'),registry=require('../../src/assistant/postgres-capability-registry').registry;
test('native startup evicts optional dataset detail before catalogue growth can block every Ask request',()=>{
 const entries=registry.list(),sample=entries.find(e=>e.name==='shipping.label'),extra=Array.from({length:20},(_,i)=>({...sample,name:'fixture.future_operation_'+i})),catalogue={list:()=>[...entries,...extra]};
 const clock=require('../../src/lib/business-time').context('America/New_York'),packet=gateway.initialContractsSnapshot(catalogue,{role:'owner'},{clock}),compact=presentation.compact(packet);assert(Buffer.byteLength(JSON.stringify(compact))<=28000);assert.deepEqual(presentation.expand(compact),packet);assert.deepEqual(packet.clock,clock);
 assert.deepEqual(Object.values(packet.operationIndex).flat().sort(),[...entries,...extra].map(e=>e.name).sort());assert.equal(packet.indexComplete,true);assert.equal(packet.readArgumentsComplete,true);assert.equal(packet.readDescriptionsComplete,true);
 assert.deepEqual(packet.operations.filter(e=>e.kind==='read').map(e=>e.name).sort(),entries.filter(e=>e.kind==='read').map(e=>e.name).sort());
});
