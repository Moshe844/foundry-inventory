'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('monthly suggestions use real approvals and measured review time and respect each plan',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,workflows}=f;
  await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const assistant=require('../../src/assistant/postgres-service'),created=[];
  for(let attempt=0;attempt<3;attempt++){
    const ids=[];
    for(let count=0;count<2;count++)ids.push((await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:1,unitCost:2}]})).purchaseOrderId);
    const numbers=(await db.query('SELECT po_number FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY po_number',[ctx.workspaceId,ids])).rows.map(r=>r.po_number).join(',');
    const proposal=await assistant.prepareAction(db,ctx,'Combine these supplier drafts '+attempt,{action:'purchase_order.combine_drafts',sourceOrders:numbers});
    await assistant.executeProposal(db,ctx,proposal.proposal.id);created.push(proposal.proposal.id);
  }
  const time=require('../../src/autopilot/time-saved');
  await time.sample(db,ctx,{activity:'combine-purchases',manualMinutes:'10',reviewMinutes:'2',requestKey:randomUUID()});
  const reviews=require('../../src/autopilot/job-reviews');
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);const report=await reviews.run(db,ctx,'automation-opportunities');
    if(tier==='starter')assert.equal(report.rows.length,0);
    else{assert.equal(report.rows.length,1);assert.equal(report.rows[0]['Reviewed examples'],3);assert.equal(report.rows[0]['Potential hours per month'],0.1);}
  }
  const handler=require('../../src/operations/postgres-runtime-handlers').create()['planning.automation-opportunities'];
  await db.transaction(c=>handler({workspaceId:ctx.workspaceId,payload:{}},c));
  assert.equal((await db.transaction(c=>handler({workspaceId:ctx.workspaceId,payload:{}},c))).duplicate,true);
  const notices=require('../../src/autopilot/operational-notices');
  await notices.refresh(db,ctx.workspaceId);
  assert((await notices.inbox(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='agent-notice-206'));
  await require('../../src/autopilot/draft-authority').save(db,ctx,created[0],{mode:'save',maximum:'10',revision:0});
  assert.equal((await reviews.run(db,ctx,'automation-opportunities')).rows.length,0);
  assert.equal((await reviews.run(db,ctx,'learned-routines')).rows.length,1);
  await notices.refresh(db,ctx.workspaceId);assert(!(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='agent-notice-206'));
  await subscribe('starter');await assert.rejects(reviews.run(db,ctx,'learned-routines'),e=>e.code==='entitlement_required');
  assert.equal(await f.balance(),4);
});
