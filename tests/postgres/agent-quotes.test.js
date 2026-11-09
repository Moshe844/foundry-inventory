'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const assistant=require('../../src/assistant/postgres-service');
test('agent quotes enforce every tier, current prices, customer acceptance and replay',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const price=amount=>db.transaction(c=>require('../../src/pricing/postgres-service').setPricesInTransaction(c,ctx,[{skuId:sku,amountMinor:amount,currency:'USD'}]));
  await price(1200);
  const valid=await require('../../src/lib/business-time').today(db,ctx.workspaceId),until=require('../../src/accounting/customer-money').addDays(valid,10);
  const args={action:'sales_quote.create',recordReference:'Receiver',quoteValidUntil:until,orderLines:JSON.stringify([{sku:code,quantity:3}])};
  const prepare=()=>assistant.prepareAction(db,ctx,'Quote three parcel items',args);
  for(const tier of ['starter','growth']){await subscribe(tier);await assert.rejects(prepare(),e=>e.code==='entitlement_required');}
  for(const tier of ['pro','enterprise']){await subscribe(tier);const preview=await prepare();assert.match(preview.proposal.summary,/\$36\.00/);}
  const obsolete=await prepare();await price(1300);await assert.rejects(assistant.executeProposal(db,ctx,obsolete.proposal.id),/changed/);
  const reviewed=await prepare();
  await subscribe('growth');await assert.rejects(assistant.executeProposal(db,ctx,reviewed.proposal.id),e=>e.code==='entitlement_required');
  await subscribe('pro');await assistant.executeProposal(db,ctx,reviewed.proposal.id);await assistant.executeProposal(db,ctx,reviewed.proposal.id);
  const quote=(await db.query('SELECT * FROM sales_quotations WHERE workspace_id=$1',[ctx.workspaceId])).rows;
  assert.equal(quote.length,1);assert.equal(quote[0].pricing.totalMinor,3900);assert.equal(quote[0].status,'OPEN');
  const accepted=()=>assistant.prepareAction(db,ctx,'The customer accepted their quote',{action:'sales_quote.accept',recordReference:quote[0].quote_number});
  await subscribe('starter');await assert.rejects(accepted(),e=>e.code==='entitlement_required');
  for(const tier of ['growth','pro','enterprise']){await subscribe(tier);assert.equal((await accepted()).status,'PREPARED');}
  await subscribe('growth');const consent=await accepted();await assistant.executeProposal(db,ctx,consent.proposal.id);await assistant.executeProposal(db,ctx,consent.proposal.id);
  const result=await require('../../src/sales/postgres-quotes').get(db,ctx.workspaceId,quote[0].id);
  assert.equal(result.status,'ACCEPTED');assert(result.sales_order_id);
  assert.equal((await db.query('SELECT count(*)::int n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  const order=(await db.query('SELECT o.status,s.quote FROM sales_orders o JOIN stockchief_runtime.pricing_order_snapshots s ON s.workspace_id=o.workspace_id AND s.id=o.pricing_quote_id WHERE o.id=$1',[result.sales_order_id])).rows[0];
  assert.equal(order.status,'DRAFT');assert.equal(order.quote.totalMinor,3900);assert.equal(await f.balance(),4);
  await assert.rejects(accepted(),/open quotation/);
  await subscribe('pro');await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const next=await assistant.prepareAction(db,ctx,'Quote four items',{...args,orderLines:JSON.stringify([{sku:code,quantity:4}])});
  const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
  await plans.save(db,ctx,'Prepare the new quote and inspect product data',randomUUID(),[
    {contract:registry.get('sales_quote.create'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}],
    [{result:next},{result:{status:'CLARIFY'}}]);
  await assert.rejects(assistant.executeMission(db,ctx,next.proposal.id),e=>e.code==='entitlement_required');
  await require('../../src/autopilot/draft-authority').save(db,ctx,reviewed.proposal.id,{mode:'save',maximum:'100',revision:0});
  await assistant.executeMission(db,ctx,next.proposal.id);
  assert.equal((await db.query('SELECT count(*)::int n FROM sales_quotations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,2);
});
