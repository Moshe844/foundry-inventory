'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-channel-copy-fixture');
async function events(f){return (await f.db.query("SELECT status,units,idempotency_key,detail FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits' ORDER BY reserved_at,id",[f.ctx.workspaceId])).rows;}
test('Growth queues a full AI draft, records exact existing credits and requires finished-batch approval; concurrent dispatch and replay cannot duplicate work',{timeout:240000},async t=>{
 const f=await fixture(t),s=f.service;await f.subscribe('growth');
 const args={...f.input,language:'Français',tone:'warm',channelStyle:'marketplace',descriptionLimit:1800},preview=await s.preview(f.db,f.ctx,args);
 assert.equal(f.modelCalls(),0);assert(preview.estimatedCredits>=preview.credits);
 const saved=await s.save(f.db,f.ctx,{...args,sourceHash:preview.sourceHash,confirmed:'yes'});
 assert.equal((await s.screen(f.db,f.ctx,{id:saved.copyId})).latestRun.status,'PENDING');
 await assert.rejects(s.approve(f.db,f.ctx,saved.runId,{confirmed:'yes'}),/complete finished/);
 const dispatched=await Promise.all([s.processRun(f.db,f.ctx.workspaceId,saved.runId),s.processRun(f.db,f.ctx.workspaceId,saved.runId)]);
 assert(dispatched.some(x=>x.ready));assert.equal(f.modelCalls(),2);
 let page=await s.screen(f.db,f.ctx,{id:saved.copyId});assert.equal(page.latestRun.status,'READY');assert.equal(page.history.length,0);assert(page.latestRun.credits>=preview.credits);
 const ledger=await events(f);assert(ledger.every(e=>e.status==='COMMITTED'));assert.equal(page.latestRun.credits,ledger.reduce((n,e)=>n+Number(e.units),0));
 assert.equal(page.latestRun.source_snapshot.scope.language,'Français');assert.equal(page.latestRun.source_snapshot.scope.channel_style,'marketplace');
 const approvals=await Promise.all([s.approve(f.db,f.ctx,saved.runId,{confirmed:'yes'}),s.approve(f.db,f.ctx,saved.runId,{confirmed:'yes'})]);assert.equal(approvals[0].id,approvals[1].id);
 assert.equal((await s.save(f.db,f.ctx,{...args,sourceHash:preview.sourceHash,confirmed:'yes'})).replayed,true);assert.equal(f.modelCalls(),2);
 await f.subscribe('starter');page=await s.screen(f.db,f.ctx,{id:saved.copyId});assert.equal(page.allowed,false);assert.match(await s.download(f.db,f.ctx,approvals[0].id),/Parcel item/);
});
test('mid-batch failure releases base and every funded child credit while preserving actual provider expense; explicit retry finishes the whole action',{timeout:240000},async t=>{
 const f=await fixture(t),s=f.service,ids=[...f.item.skuIds];for(let n=0;n<20;n++)ids.push(...(await f.catalog.createItem(f.db,f.ctx,{name:'Synthetic product '+n,baseCode:'MID-'+n,trackingMode:'quantity'})).skuIds);
 const args={...f.input,skuIds:ids},p=await s.preview(f.db,f.ctx,args),saved=await s.save(f.db,f.ctx,{...args,sourceHash:p.sourceHash,confirmed:'yes'});
 f.failModelAt(3);const result=await s.processRun(f.db,f.ctx.workspaceId,saved.runId);assert.equal(result.failed,true);
 let page=await s.screen(f.db,f.ctx,{id:saved.copyId});assert.equal(page.latestRun.status,'FAILED');assert.equal(page.history.length,0);assert((await events(f)).every(e=>e.status==='REVERSED'));
 assert(Number((await f.db.query("SELECT sum(amount_minor) AS cost FROM commercial_cost_events WHERE workspace_id=$1 AND operation IN('model_input','model_output')",[f.ctx.workspaceId])).rows[0].cost)>0);
 f.failModelAt(null);const retry=await s.save(f.db,f.ctx,{...args,sourceHash:p.sourceHash,confirmed:'yes'});assert.equal(retry.runId,saved.runId);assert.equal((await s.processRun(f.db,f.ctx.workspaceId,retry.runId)).ready,true);await s.approve(f.db,f.ctx,retry.runId,{confirmed:'yes'});
 page=await s.screen(f.db,f.ctx,{id:saved.copyId});assert.equal(page.latestRun.document.length,21);assert.equal(page.history.length,1);
});
test('changed source, disabled/deleting owner and downgrade during dispatch withhold the complete batch and refund its credits',{timeout:240000},async t=>{
 const f=await fixture(t),s=f.service;
 const p=await s.preview(f.db,f.ctx,f.input),saved=await s.save(f.db,f.ctx,{...f.input,sourceHash:p.sourceHash,confirmed:'yes'});
 f.onModel(async n=>{if(n===1)await f.rename('Source changed during writing');});
 assert.equal((await s.processRun(f.db,f.ctx.workspaceId,saved.runId)).failed,true);assert((await events(f)).every(e=>e.status==='REVERSED'));
 f.onModel(null);const next=await s.preview(f.db,f.ctx,f.input);
 for(const stop of ['disabled','deleting']){
  const queued=await s.save(f.db,f.ctx,{...f.input,sourceHash:next.sourceHash,confirmed:'yes'}),before=f.modelCalls();
  if(stop==='disabled')await f.db.query("INSERT INTO platform_account_access(account_id,disabled_at,reason,changed_by) VALUES($1,now(),'Synthetic queued writing stop',$1)",[f.owner.accountId]);
  else await f.db.query('UPDATE workspaces SET deletion_requested_at=now() WHERE id=$1',[f.ctx.workspaceId]);
  assert.equal((await s.processRun(f.db,f.ctx.workspaceId,queued.runId)).failed,true);assert.equal(f.modelCalls(),before);assert((await events(f)).every(e=>e.status==='REVERSED'));
  if(stop==='disabled')await f.db.query('DELETE FROM platform_account_access WHERE account_id=$1',[f.owner.accountId]);else await f.db.query('UPDATE workspaces SET deletion_requested_at=NULL WHERE id=$1',[f.ctx.workspaceId]);
 }
 const queued=await s.save(f.db,f.ctx,{...f.input,sourceHash:next.sourceHash,confirmed:'yes'});await f.subscribe('starter');
 const before=f.modelCalls();assert.equal((await s.processRun(f.db,f.ctx.workspaceId,queued.runId)).failed,true);assert.equal(f.modelCalls(),before);assert((await events(f)).every(e=>e.status==='REVERSED'));
});
test('credit exhaustion blocks dispatch before provider work and finished drafts recheck source before approval',{timeout:240000},async t=>{
 const f=await fixture(t),s=f.service,ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(f.db,f.ctx.workspaceId);
 await f.db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('copy-no-credits',$1,'ai_work_credits',0,'Synthetic exhausted writing allowance')",[f.owner.accountId]);
 const p=await s.preview(f.db,f.ctx,f.input);await assert.rejects(s.save(f.db,f.ctx,{...f.input,sourceHash:p.sourceHash,confirmed:'yes'}),/limit|credits/i);assert.equal(f.modelCalls(),0);
 await f.db.query("DELETE FROM commercial_entitlement_overrides WHERE id='copy-no-credits'");
 const saved=await s.save(f.db,f.ctx,{...f.input,sourceHash:p.sourceHash,confirmed:'yes'});await s.processRun(f.db,f.ctx.workspaceId,saved.runId);await f.rename('Changed after draft was delivered');await assert.rejects(s.approve(f.db,f.ctx,saved.runId,{confirmed:'yes'}),/changed/);
 assert.equal((await s.screen(f.db,f.ctx,{id:saved.copyId})).history.length,0);assert((await ent.meterState(f.db,scope,'ai_work_credits')).capacityUsed>0);
});

test('dead interrupted writing jobs release every reserved credit and expose a retryable failed state',{timeout:240000},async t=>{
 const f=await fixture(t),s=f.service,p=await s.preview(f.db,f.ctx,f.input),saved=await s.save(f.db,f.ctx,{...f.input,sourceHash:p.sourceHash,confirmed:'yes'});
 const queue=require('../../src/operations/postgres-job-queue'),job=await queue.claim(f.db,{owner:'interrupted-copy-worker',kinds:[s.kind],leaseMs:1000});
 await f.db.query('UPDATE stockchief_runtime.jobs SET max_attempts=1 WHERE id=$1',[job.id]);
 await queue.claim(f.db,{owner:'recovery-copy-worker',kinds:[s.kind],now:Date.now()+5000});
 const page=await s.screen(f.db,f.ctx,{id:saved.copyId});assert.equal(page.latestRun.status,'FAILED');assert.match(page.latestRun.issue,/interrupted/);assert((await events(f)).every(e=>e.status==='REVERSED'));assert.equal(f.modelCalls(),0);
});

test('daily provider safety limits preserve completed internal pages for a later whole-batch continuation and release failed-run credits',{timeout:240000},async t=>{
 const f=await fixture(t),s=f.service,ids=[...f.item.skuIds];for(let n=0;n<20;n++)ids.push(...(await f.catalog.createItem(f.db,f.ctx,{name:'Continuing product '+n,baseCode:'CONT-'+n,trackingMode:'quantity'})).skuIds);
 const args={...f.input,skuIds:ids},preview=await s.preview(f.db,f.ctx,args),saved=await s.save(f.db,f.ctx,{...args,sourceHash:preview.sourceHash,confirmed:'yes'}),old=process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY;
 process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY='2';t.after(()=>{if(old===undefined)delete process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY;else process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY=old;});
 assert.equal((await s.processRun(f.db,f.ctx.workspaceId,saved.runId)).failed,true);let page=await s.screen(f.db,f.ctx,{id:saved.copyId});assert.equal(page.latestRun.resume_progress,true);assert(page.latestRun.document.length>0);assert((await events(f)).every(e=>e.status==='REVERSED'));
 process.env.STOCKCHIEF_AI_MAX_MODEL_ATTEMPTS_PER_DAY='250';await s.save(f.db,f.ctx,{...args,sourceHash:preview.sourceHash,confirmed:'yes'});assert.equal((await s.processRun(f.db,f.ctx.workspaceId,saved.runId)).ready,true);assert.equal(f.modelCalls(),4);await s.approve(f.db,f.ctx,saved.runId,{confirmed:'yes'});page=await s.screen(f.db,f.ctx,{id:saved.copyId});assert.equal(page.selectedVersion.document.length,21);
});
