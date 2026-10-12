'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const {ExperimentBudget}=require('../../scripts/environment-agent-demo/budget');
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-budget-'));
  t.after(()=>{
    for(const budget of opened)budget.close();
    const resolved=fs.realpathSync(directory);
    if(!resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep+'stockchief-budget-'))throw new Error('Unsafe cleanup');
    fs.rmSync(resolved,{recursive:true,force:true});
  });const opened=[];return experiment=>{const budget=new ExperimentBudget(path.join(directory,'budget.sqlite'),experiment);opened.push(budget);return budget;};}
function approve(budget){budget.approve({ceilingMicroUsd:5000000,approvalReference:'UNIT TEST ONLY - no provider calls',expiresAt:new Date(Date.now()+60000).toISOString()});}

test('explicit operator reconciliation retains full unknown exposure and cannot refund or refill it',t=>{
 const open=fixture(t),budget=open('pilot');approve(budget);
 const id=budget.reserve({candidate:'adaptive',task:'one',upperBoundMicroUsd:4000000});budget.unknown(id,'lost receipt');
 assert.throws(()=>budget.accountUnknownAtMaximum(id),/Explicit/);
 const result=budget.accountUnknownAtMaximum(id,{evidenceReference:'test transport investigation',acknowledgeUnverifiedCharge:true});
 assert.equal(result.committed,4000000);assert.equal(result.remaining,1000000);assert.equal(result.unresolved,0);
 assert.throws(()=>budget.settle(id,0),/cannot be refunded/);
 assert.throws(()=>approve(budget),/immutable/);
 assert.throws(()=>budget.reserve({candidate:'claude',task:'one',upperBoundMicroUsd:1000001}),/CEILING/);
 const next=budget.reserve({candidate:'claude',task:'one',upperBoundMicroUsd:1000000});budget.settle(next,1000000);
 assert.equal(budget.status().remaining,0);
});
test('locked by default; immutable aggregate approval survives restart and case resets',t=>{
  const open=fixture(t);let budget=open('pilot');
  const request={candidate:'openai',task:'one',upperBoundMicroUsd:2000000};
  assert.throws(()=>budget.reserve(request),/PAID_TESTING_LOCKED/);assert.equal(budget.status().ceiling,0);
  approve(budget);const first=budget.reserve(request);budget.settle(first,1500000);budget.close();
  budget=open('pilot');
  assert.equal(budget.status().remaining,3500000);assert.throws(()=>approve(budget),/immutable/);
  const second=budget.reserve({...request,candidate:'claude',task:'two',upperBoundMicroUsd:3500000});
  budget.settle(second,3500000);assert.throws(()=>budget.reserve({...request,candidate:'adaptive'}),/SPENDING_CEILING/);
});
test('independent connections serialize candidates; uncertain calls block retries and never refund',t=>{
  const open=fixture(t),a=open('pilot'),b=open('pilot');approve(a);
  const id=a.reserve({candidate:'claude',task:'one',upperBoundMicroUsd:4000000});
  assert.throws(()=>b.reserve({candidate:'openai',task:'one',upperBoundMicroUsd:2000000}),/UNRESOLVED/);
  a.unknown(id,'lost streaming response');assert.equal(b.status().committed,4000000);
  assert.throws(()=>b.reserve({candidate:'claude-retry',task:'one',upperBoundMicroUsd:100000}),/UNRESOLVED/);
  b.settle(id,2500000,{source:'verified usage receipt'});assert.equal(a.status().remaining,2500000);
  assert.throws(()=>a.settle(id,0),/Conflicting/);
});
test('underestimated charge stops all candidates; reported spend is never clamped',t=>{
  const budget=fixture(t)('pilot');approve(budget);
  const id=budget.reserve({candidate:'grader',task:'one',upperBoundMicroUsd:100});
  assert.throws(()=>budget.settle(id,200),/PRICE_BOUND_VIOLATION/);
  assert.equal(budget.status().committed,200);assert.equal(budget.status().stopped,1);
  assert.throws(()=>budget.reserve({candidate:'adaptive',task:'two',upperBoundMicroUsd:100}),/LOCKED/);
});
test('concurrent processes cannot each spend the same shared reservation',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-budget-process-'));
  const filename=path.join(directory,'shared.sqlite');const budget=new ExperimentBudget(filename,'pilot');
  t.after(()=>{budget.close();const resolved=fs.realpathSync(directory);
    if(!resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep+'stockchief-budget-process-'))throw new Error('Unsafe cleanup');
    fs.rmSync(resolved,{recursive:true,force:true});});approve(budget);
  const script=`const {ExperimentBudget}=require(process.argv[1]);const b=new ExperimentBudget(process.argv[2],'pilot');
    try{b.reserve({candidate:process.argv[3],task:'concurrent',upperBoundMicroUsd:4000000});console.log('RESERVED');}
    catch(e){console.log(e.message);}finally{b.close();}`;
  const results=await Promise.all(['openai','claude','adaptive','retry'].map(candidate=>promisify(execFile)(process.execPath,
    ['-e',script,require.resolve('../../scripts/environment-agent-demo/budget'),filename,candidate],{windowsHide:true})));
  assert.equal(results.filter(r=>r.stdout.trim()==='RESERVED').length,1);
  assert.equal(results.filter(r=>r.stdout.trim()==='UNRESOLVED_MODEL_CALL').length,3);
  assert.equal(budget.status().committed,4000000);assert.equal(budget.status().calls,1);
});
