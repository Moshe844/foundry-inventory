'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('business language/time preferences are tenant-scoped and stale failed credits recover without releasing unknown provider cost',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,prefs=require('../../src/assistant/postgres-answer-preferences'),ent=require('../../src/commercial/entitlements');await prefs.save(db,ctx,{answerLanguage:'he',timeZone:'America/New_York'});const current=await prefs.read(db,ctx);assert.equal(current.answerLanguage,'he');assert.match(prefs.instructions(current),/"language":"Hebrew"/);await assert.rejects(prefs.save(db,{...ctx,actorId:'foreign'},{answerLanguage:'fr',timeZone:'Europe/Paris'}),/permission|allowed|role/i);assert.equal((await prefs.read(db,ctx)).answerLanguage,'he');
 const scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId),goalId='credit-failed-goal',key=ctx.workspaceId+':codex-staging:'+goalId;await db.query(`INSERT INTO stockchief_runtime.assistant_goals(id,workspace_id,actor_user_id,request_key,original_request,status,checkpoint,budget_minor,expires_at) VALUES($1,$2,$3,'credit-fixture','Unfinished fixture request','BLOCKED','{"runtime":"codex-staging"}'::jsonb,100,now()+interval '1 day')`,[goalId,ctx.workspaceId,ctx.actorId]);await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:key});await db.query("UPDATE commercial_usage_events SET occurred_at=now()-interval '1 day' WHERE account_id=$1 AND idempotency_key=$2",[scope.accountId,key]);const bounds=ent.periodBounds(await ent.subscriptionFor(db,scope.accountId));await db.query(`INSERT INTO commercial_model_cost_holds(id,account_id,workspace_id,idempotency_key,period_start,period_end,model,provider,operation,maximum_minor,status,goal_id) VALUES('unknown-credit-cost',$1,$2,'unknown-fixture',$3,$4,'fixture','fixture','ask',91,'UNKNOWN',$5)`,[scope.accountId,ctx.workspaceId,bounds.start.toISOString(),bounds.end.toISOString(),goalId]);const costBefore=(await db.query("SELECT * FROM commercial_model_cost_holds WHERE id='unknown-credit-cost'")).rows[0],maintenance=require('../../src/assistant/postgres-credit-maintenance');assert.equal((await maintenance.recover(db,{workspaceId:ctx.workspaceId})).releasedCredits,1);assert.deepEqual((await db.query("SELECT * FROM commercial_model_cost_holds WHERE id='unknown-credit-cost'")).rows[0],costBefore);assert.equal((await ent.meterState(db,scope,'ai_work_credits')).reserved,0);assert.equal((await maintenance.recover(db,{workspaceId:ctx.workspaceId})).releasedCredits,0);
 const retried=await ent.reserveUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:key,retryReversed:true});assert.equal(retried.retried,true);
});

test('a fast exact stock answer uses the saved language and rejects altered figures without charging',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t);
 const {db,ctx}=f,assistant=require('../../src/assistant/postgres-service'),prefs=require('../../src/assistant/postgres-answer-preferences');
 const {pricedUsage}=require('../helpers/postgres-model-fixture');
 await f.subscribe('pro');await prefs.save(db,ctx,{answerLanguage:'he'});
 const sku=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 let calls=0;
 const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',async complete(request){
  calls++;
  assert.equal(request.schemaName,'stockchief_localize_recorded_answer');
  assert.match(request.system,/"language":"Hebrew"/);
  const {verifiedAnswer}=JSON.parse(request.prompt);
  assert.equal((verifiedAnswer.match(/⟦\d+⟧/g)||[]).length,6);
  assert.doesNotMatch(verifiedAnswer,/Dispatch|Parcel item|PARCEL-/);
  return {data:{answer:calls===1?'⟦1⟧ (⟦2⟧) — ⟦3⟧ יחידות במלאי. ⟦4⟧ במיקום ⟦5⟧ — ⟦6⟧.':'999 יחידות במלאי'},usage:pricedUsage()};
 }};
 const ask=usageKey=>assistant.ask(db,ctx,`How many units of ${sku} do we have?`,{provider,usageKey});
 const localized=await ask('localized-direct-pass');
 assert.match(localized.answer,/4 יחידות במלאי/);
 assert.match(localized.answer,/Dispatch — 4/);assert(localized.answer.includes(sku));
 const rejected=await ask('localized-direct-failure');
 assert.match(rejected.answer,/4 units on hand/);assert.doesNotMatch(rejected.answer,/999/);
 const usage=(await db.query(`SELECT status FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits'
  AND idempotency_key LIKE '%:direct-language:%' ORDER BY occurred_at,id`,[ctx.workspaceId])).rows;
 assert.deepEqual(usage.map(row=>row.status),['COMMITTED','REVERSED']);
 await prefs.save(db,ctx,{answerLanguage:'auto'});
 assert.match((await ask('direct-no-model')).answer,/4 units on hand/);assert.equal(calls,2);
});
