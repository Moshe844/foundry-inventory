'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const program=require('../../scripts/environment-agent-demo/openai-program-budget');
function setup(t){
 const filename=path.resolve(__dirname,'../../data',`offline-openai-budget-${randomUUID()}.sqlite`);
 const budget=new program.ExperimentBudget(filename,'offline-openai-program'),clients=[budget];
 t.after(()=>{for(const client of clients)client.close();for(const suffix of ['','-wal','-shm'])if(fs.existsSync(filename+suffix))fs.unlinkSync(filename+suffix);});
 program.configure(budget);
 budget.approve({ceilingMicroUsd:program.CEILING,approvalReference:'OFFLINE synthetic approval; zero network',
  expiresAt:new Date(Date.now()+3600000).toISOString(),allocations:[{candidate:'openai',ceilingMicroUsd:program.CEILING}]});
 return {budget,filename,clients};
}
test('phase ceilings and 130 total slot limits are enforced durably without borrowing',t=>{
 const {budget,filename,clients}=setup(t);
 for(const [phase,policy]of Object.entries(program.PHASES)){
  const manifest={primary:'openai',phase,sourceHash:'offline-source',tasks:Array.from({length:policy.attempts},(_,i)=>({id:`${phase}--${i}`}))};
  program.register(budget,manifest);program.register(budget,manifest);
  assert.throws(()=>program.register(budget,{...manifest,tasks:[{id:`${phase}--extra`}]}),/ATTEMPT_LIMIT/);
 }
 const oldClient=new program.ExperimentBudget(filename,budget.experiment);clients.push(oldClient);
 const call=oldClient.reserve({candidate:'openai',task:'core--0',upperBoundMicroUsd:75000000});oldClient.settle(call,75000000,{offline:true});
 assert.throws(()=>oldClient.reserve({candidate:'openai',task:'core--1',upperBoundMicroUsd:1}),/PHASE_CEILING/);
 assert.equal(program.scoped(budget,'core').candidateStatus('openai').remaining,0);
 assert.equal(program.scoped(budget,'repair').candidateStatus('openai').remaining,15000000);
 const repair=budget.reserve({candidate:'openai',task:'repair--0',upperBoundMicroUsd:1000});budget.unknown(repair,'offline unknown');
 assert.throws(()=>budget.reserve({candidate:'openai',task:'staging--0',upperBoundMicroUsd:1}),/UNRESOLVED/);
 assert.equal(budget.status().committed,75001000);
});
test('unregistered tasks, another candidate, source replacement and refills fail closed',t=>{
 const {budget}=setup(t),manifest={primary:'openai',phase:'core',sourceHash:'frozen',tasks:[{id:'core--one'}]};
 program.register(budget,manifest);
 assert.throws(()=>budget.reserve({candidate:'openai',task:'unknown',upperBoundMicroUsd:1}),/UNAPPROVED_CERTIFICATION_SLOT/);
 assert.throws(()=>budget.reserve({candidate:'claude',task:'core--one',upperBoundMicroUsd:1}),/CANDIDATE_NOT_ALLOCATED/);
 assert.throws(()=>program.register(budget,{...manifest,sourceHash:'changed'}),/IMMUTABLE_CERTIFICATION_SLOT/);
 assert.throws(()=>budget.approve({ceilingMicroUsd:program.CEILING,approvalReference:'refill',expiresAt:new Date(Date.now()+3600000).toISOString()}),/immutable/);
 budget.stop();assert.throws(()=>budget.reserve({candidate:'openai',task:'core--one',upperBoundMicroUsd:1}),/LOCKED/);
});
