'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{hub}=require('../../src/assistant/postgres-goal-stream');
test('all Ask streams share one listener, match inventory and actor, and release the connection when closed',async()=>{
 let listens=0,stops=0,notify;const db={listen:async(channel,fn)=>{assert.equal(channel,'stockchief_ask_answers');listens++;notify=fn;return async()=>stops++;}},h=hub(db);assert.equal(h,hub(db));
 let a=0,b=0;const scope={workspaceId:'inventory-a',actorId:'actor-a',goalId:'goal-a'},stopA=await h.subscribe(scope,()=>a++),stopB=await h.subscribe({...scope,actorId:'actor-b'},()=>b++);
 assert.equal(listens,1);notify({payload:'not json'});notify({payload:JSON.stringify({goal:'goal-a',workspace:'inventory-b',actor:'actor-a'})});assert.equal(a,0);
 notify({payload:JSON.stringify({goal:'goal-a',workspace:'inventory-a',actor:'actor-a'})});assert.equal(a,1);assert.equal(b,0);
 await stopA();assert.equal(stops,0);await stopB();assert.equal(stops,1);await stopB();assert.equal(stops,1);
 const again=await h.subscribe(scope,()=>a++);assert.equal(listens,2);await again();assert.equal(stops,2);
});
