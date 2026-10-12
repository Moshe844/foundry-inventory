'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const base='../../scripts/environment-agent-demo/';
test('proposed one-dollar allocation needs a matching immutable approval and cannot raise the existing goal maximum',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-proposed-budget-'));
 const budget=new(require(base+'budget').ExperimentBudget)(path.join(dir,'budget.db'),'OFFLINE PROPOSAL');
 try{
  const journal=new(require(base+'pilot-journal').PilotJournal)(budget,{attempts:1});journal.begin('task','codex');
  const policy=require(base+'codex-live-permit'),options={budget,task:'task',sourceHash:require(base+'certification').sourceHash(),image:'sha256:'+'a'.repeat(64),ceilingMicroUsd:1000000};
  assert.throws(()=>policy.issue(options),/NOT_CERTIFIED/);
  budget.approve({ceilingMicroUsd:1000000,approvalReference:'OFFLINE ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});
  assert.throws(()=>policy.issue({...options,ceilingMicroUsd:750000}),/NOT_CERTIFIED/);
  assert.throws(()=>policy.issue({...options,ceilingMicroUsd:1010000}),/NOT_CERTIFIED/);
  const permit=policy.issue(options);assert.equal(policy.assert(permit,{budget}).goalBudgetMinor,100);
  assert.throws(()=>budget.approve({ceilingMicroUsd:2000000,approvalReference:'TOP UP',expiresAt:new Date(Date.now()+60000).toISOString()}),/immutable/);
 }finally{budget.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('one-slot native preflight counts the exact request and enforces 30 cents before generation, without retry',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-live-gate-'));
 const budget=new(require(base+'budget').ExperimentBudget)(path.join(dir,'budget.db'),'OFFLINE-ONLY');
 budget.approve({ceilingMicroUsd:750000,approvalReference:'FAKE TRANSPORT',expiresAt:new Date(Date.now()+60000).toISOString()});
 const journal=new(require(base+'pilot-journal').PilotJournal)(budget,{attempts:1});journal.begin('task','codex');
 const policy=require(base+'codex-live-permit');
 const options={budget,task:'task',sourceHash:require(base+'certification').sourceHash(),image:'sha256:'+'a'.repeat(64)};
 const permit=policy.issue(options);assert.throws(()=>policy.assert({},options),/NOT_CERTIFIED/);
 assert.throws(()=>policy.assert(permit,{...options,task:'other'}),/NOT_CERTIFIED/);
 const wire=require(base+'codex-wire');
 const request={model:wire.MODEL,reasoning:{effort:wire.EFFORT},input:[{role:'user',content:'Unfamiliar independent goal.'}]};
 const boundary=(300000-3000*wire.PRICES.output)/wire.PRICES.input;
 let count=boundary,counters=0,generations=0,begins=0;
 const commercial={begin:async c=>{begins++;assert.equal(c.upperBoundMicroUsd,300000);return c;},complete:async()=>{},unknown:async()=>{},release:async()=>{}};
 const relay=await require(base+'relay').createRelay({budget,credentials:{openai:'OFFLINE_STUB_NO_REAL_KEY'},commercial,
  countCodexInput:async body=>{counters++;assert.deepEqual(body,require(base+'codex-wire').countRequest(require(base+'codex-wire').normalize(request).body));return {object:'response.input_tokens',input_tokens:count};},
  fetchImpl:async(_url,init)=>{generations++;return require('../helpers/codex-offline-response').final(JSON.parse(init.body),generations,'Offline contract result.');}});
 t.after(async()=>{await relay.close();budget.close();fs.rmSync(dir,{recursive:true,force:true});});
 const args={candidate:'codex',task:'task',provider:'openai',goalId:'g',ctx:{workspaceId:'w',actorId:'a'},fundingKey:'f',authorize:async()=>{},wireProfile:'codex',requestGate:async()=>{}};
 assert.throws(()=>relay.grant(args),/NOT_CERTIFIED/);
 const transport=relay.grant({...args,livePermit:permit});
 transport.setNativeSession({identity:{goalId:'g',workspaceId:'w',actorId:'a',candidate:'codex'},
  codexReplay:async()=>null,codexPending:async()=>{},codexDelivered:async()=>{}});
 const call=()=>fetch(transport.openaiBaseURL+'/responses',{method:'POST',headers:{authorization:`Bearer ${transport.token}`,'content-type':'application/json'},body:JSON.stringify(request)});
 assert.equal((await call()).status,200);assert.equal(generations,1);assert.equal(begins,1);
 count=boundary+1;assert.equal((await call()).status,400);assert.equal(transport.lastBlock().code,'CODEX_REQUEST_COST_CEILING');
 assert.equal(generations,1);assert.equal(begins,1);assert.equal(counters,2);
 assert.equal((await call()).status,403);assert.equal(counters,2);assert.equal(generations,1);
 assert.throws(()=>journal.begin('task','codex'));assert.throws(()=>policy.issue(options),/NOT_CERTIFIED/);
 budget.stop();assert.throws(()=>policy.assert(permit,{budget}),/NOT_CERTIFIED/);
});
test('approved three-dollar shared allocation preserves the one-dollar canonical goal maximum and cannot be topped up',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-three-dollar-'));
 const budget=new(require(base+'budget').ExperimentBudget)(path.join(dir,'budget.db'),'OFFLINE THREE DOLLAR');
 try{
  const journal=new(require(base+'pilot-journal').PilotJournal)(budget,{attempts:1});journal.begin('task','codex');
  budget.approve({ceilingMicroUsd:3000000,approvalReference:'OFFLINE ONLY',expiresAt:new Date(Date.now()+60000).toISOString()});
  const policy=require(base+'codex-live-permit'),options={budget,task:'task',sourceHash:require(base+'certification').sourceHash(),image:'sha256:'+'a'.repeat(64),ceilingMicroUsd:3000000};
  assert.throws(()=>policy.issue({...options,ceilingMicroUsd:3010000}),/NOT_CERTIFIED/);
  const permit=policy.issue(options);assert.equal(policy.assert(permit,{budget}).goalBudgetMinor,100);
  assert.equal(budget.status().ceiling,3000000);
  assert.throws(()=>budget.approve({ceilingMicroUsd:4000000,approvalReference:'TOPUP',expiresAt:new Date(Date.now()+60000).toISOString()}),/immutable/);
  budget.stop();assert.throws(()=>policy.assert(permit,{budget}),/NOT_CERTIFIED/);
 }finally{budget.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('an unfinished authorization survives a host-process restart without another slot, allowance or retry of unknown costs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-authorization-')),filename=path.join(dir,'budget.db');
 const budget=new(require(base+'budget').ExperimentBudget)(filename,'OFFLINE-AUTHORIZATION');
 try{
  budget.approve({ceilingMicroUsd:750000,approvalReference:'FAKE PROCESS RESTART ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
  const journal=new(require(base+'pilot-journal').PilotJournal)(budget,{attempts:1});journal.begin('task','codex');
  const policy=require(base+'codex-live-permit'),options={budget,task:'task',sourceHash:require(base+'certification').sourceHash(),image:'sha256:'+'a'.repeat(64)};
  const original=policy.issue(options);policy.bind(original,{goalId:'same-goal',workspaceId:'same-workspace',actorId:'same-actor',candidate:'codex'});
  const call=budget.reserve({candidate:'codex',task:'task',upperBoundMicroUsd:55000});budget.settle(call,900);
  const script=`const {ExperimentBudget}=require('./scripts/environment-agent-demo/budget');const b=new ExperimentBudget(process.argv[1],'OFFLINE-AUTHORIZATION');const p=require('./scripts/environment-agent-demo/codex-live-permit');try{const token=p.recover({budget:b,task:'task',sourceHash:process.argv[2],image:process.argv[3]});p.assert(token,{budget:b,task:'task'});process.stdout.write(JSON.stringify({ceiling:b.status().ceiling,committed:b.status().committed,calls:b.status().calls}));}finally{b.close();}`;
  const restored=JSON.parse(require('node:child_process').execFileSync(process.execPath,['-e',script,filename,options.sourceHash,options.image],{encoding:'utf8',windowsHide:true}));
  assert.deepEqual(restored,{ceiling:750000,committed:900,calls:1});assert.throws(()=>journal.begin('task','codex'));
  const recovered=policy.recover(options);
  assert.throws(()=>policy.bind(recovered,{goalId:'new-goal',workspaceId:'same-workspace',actorId:'same-actor',candidate:'codex'}),/BINDING_MISMATCH/);
  assert.throws(()=>policy.bind(recovered,{goalId:'same-goal',workspaceId:'other-workspace',actorId:'same-actor',candidate:'codex'}),/BINDING_MISMATCH/);
  assert.throws(()=>policy.recover({...options,task:'other'}),/NOT_CERTIFIED/);assert.throws(()=>policy.recover({...options,image:'sha256:'+'b'.repeat(64)}),/NOT_CERTIFIED/);
  const unknown=budget.reserve({candidate:'codex',task:'task',upperBoundMicroUsd:55000});budget.unknown(unknown,'FAKE LOST RECEIPT');
  assert.throws(()=>policy.recover(options),/NOT_CERTIFIED/);budget.stop();assert.throws(()=>policy.recover(options),/NOT_CERTIFIED/);
 }finally{budget.close();fs.rmSync(dir,{recursive:true,force:true});}
});
