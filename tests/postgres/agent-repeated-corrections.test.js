'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('repeated real stock corrections lead to an owner-reviewed count rule at the correct warehouse',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,browser}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const counts=require('../../src/accounting/postgres-physical-count'),reviews=require('../../src/autopilot/job-reviews');
 for(const quantity of [19,18,17])await counts.apply(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,countedQuantity:quantity,reasonCode:'count',idempotencyKey:randomUUID()});
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  if(tier==='starter'){await assert.rejects(reviews.run(db,ctx,'repeated-corrections'),e=>e.code==='entitlement_required');continue;}
  const result=await reviews.run(db,ctx,'repeated-corrections');assert.equal(result.rows.length,1);assert.equal(result.rows[0].Corrections,3);
  const page=await browser.get(result.rows[0].link).expect(200);assert(page.text.includes('value="'+f.location.id+'" selected'));
 }
 const notices=require('../../src/autopilot/operational-notices');await notices.refresh(db,ctx.workspaceId);
 assert((await notices.inbox(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='agent-notice-209'));
 const task=require('../../src/operations/agent-count-tasks'),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 await task.schedule(db,ctx,{locationId:f.location.id,counterId:ctx.actorId,days:7,firstDay:today});
 assert.equal((await db.query('SELECT interval_days FROM stockchief_runtime.agent_count_schedules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].interval_days,7);
 assert.equal((await reviews.run(db,ctx,'repeated-corrections')).rows.length,0);
 await notices.refresh(db,ctx.workspaceId);assert(!(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='agent-notice-209'));
 assert.equal(await f.balance(),17,'A rule suggestion and schedule never post a new count');
});
