'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const base='../../scripts/environment-agent-demo/';
test('actual SDK and disposable StockChief stop at native token preflight before any generation or business effect',{timeout:120000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-preflight-'));
 const budget=new(require(base+'budget').ExperimentBudget)(path.join(dir,'budget.db'),'OFFLINE SDK PREFLIGHT');
 const task=JSON.parse(fs.readFileSync('data/environment-agent-demo/codex-sdk-integration/proposed-live-task.json')).task;
 const wire=require(base+'codex-wire');
 const runtime=JSON.parse(fs.readFileSync(path.join(process.env.STOCKCHIEF_CODEX_ARTIFACT_DIR||'data/environment-agent-demo/codex-sdk-sol-high','runtime.json')));
 const certificate={passed:true,testOnly:true,image:runtime.image,sourceHash:require(base+'certification').sourceHash()};
 budget.approve({ceilingMicroUsd:1000000,approvalReference:'OFFLINE FAKE COUNT ONLY',expiresAt:new Date(Date.now()+120000).toISOString()});
 const journal=new(require(base+'pilot-journal').PilotJournal)(budget,{offline:true});journal.begin(task.id,'codex');
 const permit=require(base+'codex-live-permit').issue({budget,task:task.id,sourceHash:certificate.sourceHash,image:certificate.image,ceilingMicroUsd:1000000});
 const fixtures=require(base+'embedded-certification-fixtures');let counts=0,generations=0;
 process.env.STOCKCHIEF_CODEX_SDK_DEMO='1';
 try{
  const result=await require(base+'run-pilot').attempt({candidate:'codex',task,budget,certificate,credentials:{openai:'FAKE'},
   outputDirectory:path.join(dir,'attempt'),fixtures,approvalPolicy:fixtures.approvalPolicy,helperProvider:'openai',
   codexLivePermit:permit,offlineFetch:async()=>{generations++;throw Error('GENERATION_MUST_NOT_RUN');},
   countCodexInput:async body=>{counts++;assert.equal(body.model,wire.MODEL);assert.equal(body.reasoning.effort,wire.EFFORT);
    assert(body.input.some(i=>i.type==='additional_tools'));return {object:'response.input_tokens',input_tokens:(300000-3000*wire.PRICES.output)/wire.PRICES.input+1};}});
  assert.equal(counts,1);assert.equal(generations,0);assert.equal(result.modelCalls,0);assert.equal(result.browserToolCalls,0);
  assert.equal(result.status,'BLOCKED');assert.equal(result.interruptions[0].code,'CODEX_REQUEST_COST_CEILING');
  assert.equal(result.requiredApprovalsExecuted,0);assert.equal(result.verdict.businessOutcomeVerified,false);
  assert.equal(Number(JSON.parse(fs.readFileSync(path.join(dir,'attempt/goal.json'))).budget_minor),100);
  assert.deepEqual(result.verdict.after.stock,JSON.parse(fs.readFileSync(path.join(dir,'attempt/before.json'))).stock);
  assert.equal(budget.status().committed,0);
 }finally{delete process.env.STOCKCHIEF_CODEX_SDK_DEMO;budget.close();fs.rmSync(dir,{recursive:true,force:true});}
});
