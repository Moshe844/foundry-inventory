'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('customer-specific prices, discounts and net terms are applied and remain protected after a downgrade',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,browser,workflows}=f;
 await subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const assistant=require('../../src/assistant/postgres-service'),prices=require('../../src/pricing/postgres-service'),reviews=require('../../src/autopilot/job-reviews');
 const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
 await prices.setPrice(db,ctx,{skuId:sku,amountMinor:1001,currency:'USD'});
 const list={kind:'price_list',name:'Receiver trade prices',currency:'USD',scope:{customerIds:['fixture-customer']},entries:[{skuId:sku,minQuantity:1,unitPriceMinor:900},{skuId:sku,minQuantity:3,unitPriceMinor:800}]};
 const rule=(definition,extra={})=>assistant.prepareAction(db,ctx,'Set the agreed customer prices',{action:'pricing.rule.configure',pricingDefinition:JSON.stringify(definition),...extra});
 await subscribe('starter');await assert.rejects(rule(list),e=>e.code==='entitlement_required');
 for(const tier of ['growth','pro','enterprise']){await subscribe(tier);assert.equal((await rule(list)).status,'PREPARED');}
 await subscribe('growth');const approved=await rule(list);const created=await assistant.executeProposal(db,ctx,approved.proposal.id);await assistant.executeProposal(db,ctx,approved.proposal.id);
 const discount=await rule({kind:'promotion',name:'Receiver agreed discount',currency:'USD',scope:{customerIds:['fixture-customer']},discount:{type:'percent',value:1000}});await assistant.executeProposal(db,ctx,discount.proposal.id);
 await db.transaction(c=>require('../../src/sales/postgres-payment-terms').saveInTransaction(c,ctx,{customerId:'fixture-customer',kind:'ON_ACCOUNT',netDays:45,creditApproved:true,creditLimitMinor:100000}));
 const args={action:'create_sales_order',customer:'Receiver',sku:code,quantity:3,amount:null,currency:'USD',deliveryMethod:'PICKUP',location:f.location.name};
 const order=()=>assistant.prepareAction(db,ctx,'Draft the agreed customer order',args),orders=[];
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  if(tier==='starter'){
   await assert.rejects(order(),e=>e.code==='entitlement_required');await assert.rejects(reviews.run(db,ctx,'customer-pricing'),e=>e.code==='entitlement_required');
   await browser.get('/autopilot/reviews/customer-pricing').expect(402);continue;
  }
  const terms=await reviews.run(db,ctx,'customer-pricing');assert.equal(terms.rows.length,2);assert(terms.rows.every(r=>r['Payment terms']==='Net 45 days'));
  for(const row of terms.rows)await browser.get(row.link).expect(200);
  const page=await browser.get('/autopilot/reviews/customer-pricing').expect(200);assert.match(page.text,/Receiver agreed discount/);
  const p=await order();assert.match(p.proposal.summary,/Exact total \$21.60/);const done=await assistant.executeProposal(db,ctx,p.proposal.id);orders.push(done.result);
 }
 const selected=orders[0];await workflows.confirmSalesOrder(db,ctx,selected.salesOrderId,{idempotencyKey:randomUUID()});
 const shipment={idempotencyKey:randomUUID(),lines:[{lineId:selected.lineIds[0],quantity:3,locationId:f.location.id}]};
 const sent=await workflows.fulfillSalesOrder(db,ctx,selected.salesOrderId,shipment);await workflows.fulfillSalesOrder(db,ctx,selected.salesOrderId,shipment);
 const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,sent.invoiceId])).rows[0];
 assert.equal(Number(invoice.total_minor),2160);assert.equal(invoice.due_date,require('../../src/accounting/customer-money').addDays(invoice.issue_date,45));assert.equal(await f.balance(),17);
 const other=await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'Retail guest'});
 const ordinary=await assistant.prepareAction(db,ctx,'Draft a retail order',{...args,customer:other.name});assert.match(ordinary.proposal.summary,/Exact total \$30.03/);
 const held=await order();await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,held.proposal.id),e=>e.code==='entitlement_required');
 const source=orders[1],number=(await db.query('SELECT order_number FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,source.salesOrderId])).rows[0].order_number;
 await subscribe('growth');const revision=await assistant.prepareAction(db,ctx,'Increase this draft to four',{action:'sales_order.revise_draft_line',recordReference:number,sku:code,quantity:4});
 await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,revision.proposal.id),e=>e.code==='entitlement_required');
 const rules=(await require('../../src/pricing/postgres-promotions').list(db,ctx));const current=rules.find(r=>r.name===list.name);
 await subscribe('growth');const changed=await rule({...list,entries:[{skuId:sku,minQuantity:1,unitPriceMinor:700}]},{pricingRuleId:current.id,expectedRevision:1});
 await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,changed.proposal.id),e=>e.code==='entitlement_required');
 const disabled=await rule({...list,enabled:false},{pricingRuleId:current.id,expectedRevision:1});await assistant.executeProposal(db,ctx,disabled.proposal.id);
 assert.equal((await require('../../src/pricing/postgres-promotions').list(db,ctx)).find(r=>r.id===current.id).enabled,false,'Stopping a customer rule remains available after downgrade');
 assert.equal(Number((await db.query('SELECT quote FROM stockchief_runtime.pricing_order_snapshots WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,source.salesOrderId])).rows[0].quote.totalMinor),2160);
 assert.equal(await f.balance(),17);
});
