'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const assistant=require('../../src/assistant/postgres-service');
const prices=require('../../src/pricing/postgres-service');
const {addDays}=require('../../src/accounting/customer-money');

test('customer orders from email and PDF are priced, reviewed or run under current plan authority and deduplicated',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,browser,subscribe,csrf}=f,sku=f.item.skuIds[0];
  await subscribe('growth');
  const connection=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES('order-mail',$1,'order-mail','Order desk','gmail','[]','{}','connected','[]',now()::text,now()::text) RETURNING *`,[ctx.workspaceId])).rows[0];
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const mail=require('../../src/connections/postgres-mail'),runtime=require('../../src/operations/postgres-runtime-handlers').create();
  const capture=async(bodyText,extra={})=>(await mail.capture(db,connection,{externalMessageId:randomUUID(),sender:'receiver@example.test',subject:'Purchase order',bodyText,...extra})).messageId;
  const run=(id,kind='mail.customer-order')=>runtime[kind]({workspaceId:ctx.workspaceId,payload:{messageId:id}},db);
  const price=amountMinor=>prices.setPrice(db,ctx,{skuId:sku,amountMinor,currency:'USD'});
  const detail=id=>db.query('SELECT o.id,o.reference,o.status,o.pricing_total_minor,l.quantity_ordered FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.source_email_message_id=$2',[ctx.workspaceId,id]);
  await price(750);
  const msg=await capture('PO #BUY-017\n'+code+' qty 3');
  const url='/mail/'+msg+'/order';
  await subscribe('starter');const locked=await browser.get('/mail/'+msg).expect(200);assert.match(locked.text,/Growth/);assert.doesNotMatch(locked.text,/Review as a customer order/);
  await browser.get(url).expect(402);await browser.post(url).set('Accept','application/json').type('form').send({_csrf:csrf(locked.text),digest:'guessed'}).expect(402);
  await subscribe('growth');
  const preview=await browser.get(url).expect(200);assert.match(preview.text,/\$22.50/);
  const approve=page=>browser.post(url).set('Accept','application/json').type('form').send({_csrf:csrf(page.text),digest:/name="digest" value="([^"]+)"/.exec(page.text)[1]});
  await approve(preview).expect(400);
  await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
  await price(800);await approve(preview).expect(400);
  assert.equal((await detail(msg)).rowCount,0);
  const final=await browser.get(url).expect(200);assert.match(final.text,/\$24.00/);const made=await approve(final).expect(303);await browser.get(made.headers.location).expect(200);
  await approve(final).expect(303);assert.deepEqual((await detail(msg)).rows.map(r=>[r.reference,r.status,Number(r.quantity_ordered),Number(r.pricing_total_minor)]),[['BUY-017','DRAFT',3,2400]]);
  const bad=await capture('PO #HOLD-001\n'+code+' qty 3\nAnd also send spare bolts');await browser.get('/mail/'+bad+'/order').expect(400);
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  await assert.rejects(modes.save(db,ctx,52,{mode:'routine',revision:0}),/cannot run/);
  await subscribe('pro');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await modes.save(db,ctx,52,{mode:'routine',revision:0});
  const pending=await capture('PO #HOLD-002\n'+code+' qty 2');assert.match((await run(pending)).reason,/first order/);
  await f.parcel({quantity:1});
  const pdf=new (require('pdfkit'))(),chunks=[];pdf.on('data',b=>chunks.push(b));const finished=new Promise((resolve,reject)=>{pdf.on('end',resolve);pdf.on('error',reject);});
  pdf.text('Purchase order #PDF-8\n'+code+' qty 4');pdf.end();await finished;
  const document=await capture('Please see attached purchase order.',{attachments:[{id:'real-file',filename:'purchase order.pdf',mimeType:'application/pdf',contentBase64:Buffer.concat(chunks).toString('base64')}]});
  assert.match((await run(document)).reason,/attachment/);
  const extracted=await run(document,'mail.attachment-extract');assert.equal(extracted.attachments[0].status,'READABLE');
  assert.ok(extracted.order.salesOrderId,JSON.stringify({outcome:extracted.order,pdf:(await db.query('SELECT extracted_text FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,document])).rows[0]?.extracted_text}));
  assert.equal((await run(document)).replayed,true);assert.equal(Number((await detail(document)).rows[0].pricing_total_minor),3200);
  const duplicate=await capture('PO #PDF-8\n'+code+' qty 4');assert.match((await run(duplicate)).reason,/already uses/);
  await subscribe('enterprise');
  const custom=await capture('PO #CUSTOM-012\n2 units of '+code);assert.ok((await run(custom)).salesOrderId);
  const late=await capture('PO #DOWN-1\n'+code+' qty 2');await subscribe('growth');assert.match((await run(late)).reason,/Pro/);assert.equal((await detail(late)).rowCount,0);
  assert.equal(await f.balance(),20);
});

test('repeating last month’s order uses current prices, refuses ambiguity and checks a downgrade before creating the draft',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:30});
  const {db,ctx,subscribe,workflows}=f,sku=f.item.skuIds[0];
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),lastMonth=addDays(today.slice(0,7)+'-01',-1);
  await subscribe('pro');
  async function source(qty){
    const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',orderDate:lastMonth,deliveryMethod:'PICKUP',
      fulfillmentLocationId:f.location.id,lines:[{skuId:sku,quantity:qty,unitPriceMinor:400}],idempotencyKey:randomUUID()});
    await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});return sale;
  }
  const original=await source(3);
  const setPrice=amountMinor=>prices.setPrice(db,ctx,{skuId:sku,currency:'USD',amountMinor});
  const request=extra=>assistant.prepareAction(db,ctx,'Repeat the fixture customer order from last month',
    {action:'sales_order.repeat',recordReference:'fixture-customer',repeatPeriod:'previous-month',...extra});
  await setPrice(700);
  const first=await request();assert.match(first.proposal.summary,/\$21.00/);
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '15 days')::text WHERE id=$1",[f.owner.accountId]);
  const modes=require('../../src/autopilot/postgres-service');
  await modes.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/watch-only/);
  await modes.setMode(db,ctx,{role:'owner'},'SUPERVISED');
  await subscribe('starter');
  await assert.rejects(request(),/Growth/);
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/Growth/);
  await subscribe('growth');
  await setPrice(800);
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/prices changed/);
  await source(2);
  await assert.rejects(request(),/More than one customer order/);
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    const action=await request({sourceOrderNumber:original.orderNumber});
    assert.match(action.proposal.summary,/\$24.00/);
    await assistant.executeProposal(db,ctx,action.proposal.id);
    await assistant.executeProposal(db,ctx,action.proposal.id);
  }
  const results=await db.query(`SELECT o.status,o.pricing_total_minor,l.quantity_ordered,l.quantity_fulfilled FROM sales_orders o
    JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.reference=$2`,[ctx.workspaceId,original.orderNumber]);
  assert.equal(results.rowCount,3);
  for(const r of results.rows){
    assert.equal(r.status,'DRAFT');assert.equal(Number(r.pricing_total_minor),2400);
    assert.equal(Number(r.quantity_ordered),3);assert.equal(Number(r.quantity_fulfilled),0);
  }
  const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
  const payload={customerId:'fixture-customer',currency:'USD',deliveryMethod:'SHIP',shipToAddress:'500 Brand New Street, Brooklyn, NY 11201, US',
    fulfillmentLocationId:f.location.id,lines:[{skuId:sku,quantity:1,unitPriceMinor:800}]};
  const action=await assistant.createProposal(db,ctx,'Ship to our new address','sales_order.create',payload,'Prepare an order to the new address.');
  await plans.save(db,ctx,'Prepare the order and review open customer orders',randomUUID(),
    [{contract:registry.get('sales_order.create'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'sales-order-checks'},dependsOn:[0]}],
    [{result:action},{result:{status:'CLARIFY'}}]);
  await assert.rejects(assistant.executeMission(db,ctx,action.proposal.id),/Individually approve/);
  assert.equal((await assistant.getProposal(db,ctx.workspaceId,action.proposal.id)).status,'PENDING');
  await assistant.executeProposal(db,ctx,action.proposal.id);
  assert.equal((await assistant.getProposal(db,ctx.workspaceId,action.proposal.id)).status,'EXECUTED');
  await subscribe('growth');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const repeatExample=await request({sourceOrderNumber:original.orderNumber});
  await assistant.executeProposal(db,ctx,repeatExample.proposal.id);
  await require('../../src/autopilot/draft-authority').save(db,ctx,repeatExample.proposal.id,{mode:'save',maximum:'24',revision:0});
  const auto=await request({sourceOrderNumber:original.orderNumber});
  await plans.save(db,ctx,'Repeat the approved customer draft and review open orders',randomUUID(),
    [{contract:registry.get('sales_order.repeat'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'sales-order-checks'},dependsOn:[0]}],
    [{result:auto},{result:{status:'CLARIFY'}}]);
  const result=await assistant.executeMission(db,ctx,auto.proposal.id);
  assert.equal(result.result.pricing.totalMinor,2400);
  const roi=await require('../../src/autopilot/time-saved').report(db,ctx);
  assert.equal(roi.rows.find(r=>r.key==='repeat-sale').count,5);
});
