'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const {randomUUID}=require('node:crypto');
const reviews=require('../../src/autopilot/job-reviews'),policy=require('../../src/commercial/agent-plan');
const staffRequests=require('../../src/purchasing/agent-purchase-requests');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];

test('agent jobs run through paid plans, posted books, stock records and approved staff purchases',{timeout:240000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner,workflows}=f;
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),days=require('../../src/accounting/customer-money').addDays;
  async function plan(id){
    await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,$3,
      (SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' LIMIT 1),'ACTIVE')
      ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),owner.accountId,id]);
  }
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const line=(await db.query("SELECT * FROM purchase_order_lines WHERE workspace_id=$1 AND sku_id=$2",[ctx.workspaceId,sku])).rows[0];
  await db.query("UPDATE suppliers SET payment_terms='2/10 net 30' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:sku,lastUnitCost:1,leadTimeDays:4,unitsPerPurchaseUnit:1,isPreferred:true});
  const bill=await workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:line.purchase_order_id,supplierInvoiceNumber:'DUE-12',
    issueDate:today,dueDate:days(today,5),currency:'USD',idempotencyKey:'pay-run-bill',lines:[{purchaseOrderLineId:line.id,skuId:sku,quantity:2,unitCostMinor:100}]});
  assert.equal(bill.status,'OPEN');
  await db.query("UPDATE suppliers SET payment_terms='Net 30' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  await db.query('UPDATE purchase_orders SET expected_date=$2 WHERE id=$1',[line.purchase_order_id,today]);
  await plan('pro');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password});
  const data=await browser.get('/autopilot/reviews/payment-run');
  assert.equal(data.status,200);assert.match(data.text,/DUE-12|Fixture parts/);
  assert.match(data.text,/\$1\.96/);
  assert.equal((await reviews.run(db,ctx,'early-discounts')).rows[0]['Possible saving'],'$0.04');
  const forecast=await reviews.run(db,ctx,'cash-forecast');
  assert.equal(forecast.rows.length,13);
  const ask=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
  const inChat=await ask.prepare(null,db,ctx,'What should I pay this week?',{agentJob:'payment-run'});
  assert.match(inChat.rows[0]['Review amount'],/1\.96/);assert.equal(inChat.sources[0].href,'/autopilot/reviews/payment-run');
  const source=inChat.sources.find(s=>s.kind==='record'&&s.href==='/money/bills/'+bill.billId);
  assert.ok(source);await browser.get(source.href).expect(200);
  assert.equal(forecast.rows[0]['Supplier bills'],'$2.00');
  assert.equal(forecast.rows[4]['Unbilled PO goods'],'$2.00');
  assert.equal((await reviews.run(db,ctx,'stock-by-location',{filter:code})).rows[0].Units,'4');
  const move=(await reviews.run(db,ctx,'movement-history',{filter:code})).rows[0];assert.equal(Number(move.After),4);assert.equal(Number(move.Before),0);
  assert.equal((await reviews.run(db,ctx,'count-priorities')).rows[0].SKU,code);
  assert.equal((await reviews.run(db,ctx,'delivery-check')).rows[0].Received,'4');
  assert.equal((await reviews.run(db,ctx,'supplier-options')).rows[0]['Lead days'],'4');
  assert.equal(Number((await reviews.run(db,ctx,'supplier-scorecard')).rows[0]['Filled %']),100);
  const discrepant={supplierId:'fixture-supplier',purchaseOrderId:line.purchase_order_id,supplierInvoiceNumber:'OVER-32',issueDate:today,
    idempotencyKey:'disputed-invoice',currency:'USD',lines:[{purchaseOrderLineId:line.id,skuId:sku,quantity:3,unitCostMinor:150}]};
  const disputed=await workflows.recordSupplierInvoice(db,ctx,discrepant);
  assert.equal(disputed.status,'DISPUTED');
  const problems=(await reviews.run(db,ctx,'invoice-errors',{filter:'OVER-32'})).rows;
  assert.equal(problems.length,2);assert.ok(problems.some(r=>r['Previously billed']==='2'&&r.Received==='4'&&r.Invoiced==='3'));
  assert.ok(problems.some(r=>r.Problem.includes('unit price differs')));
  assert.equal((await reviews.run(db,ctx,'supplier-price-increases',{filter:code})).rows[0]['Supplier unit price'],'$1.50');
  assert.ok(!(await reviews.run(db,ctx,'payment-run')).rows.some(r=>r.link==='/money/bills/'+disputed.billId));
  await assert.rejects(workflows.recordSupplierInvoice(db,ctx,{...discrepant,idempotencyKey:'different-source',lines:[{...discrepant.lines[0],quantity:4}]}),/duplicate/);
  for(const tier of ['starter','growth','pro','enterprise']){
    await plan(tier);
    for(const d of reviews.definitions){
      const call=()=>reviews.run(db,ctx,d.key,{filter:d.requiresFilter?'some-exact-filter':''});
      if(policy.permits(tier,d.id,'suggest')){
        const result=await call();
        assert.equal(result.mode,policy.allowance(tier,d.id),tier+' '+d.key);
        assert.ok(Array.isArray(result.rows),tier+' '+d.key);
        if(result.mode==='suggest'){
          assert.ok(result.rows.length<=1,tier+' '+d.key);
          for(const row of result.rows)assert.deepEqual(Object.keys(row),['Suggestion'],tier+' '+d.key);
        }
      }
      else await assert.rejects(call(),e=>e.code==='entitlement_required',tier+' '+d.key);
      if(!policy.permits(tier,d.id,'automatic'))await assert.rejects(reviews.run(db,ctx,d.key,{scheduled:true}),e=>e.code==='entitlement_required',tier+' '+d.key);
    }
  }
  await plan('starter');
  const advice=await ask.prepare(null,db,ctx,'Which supplier should I review?',{agentJob:'supplier-options'});
  assert.match(advice.coverage,/up to one suggestion/);assert.equal(advice.sources.length,1);
  assert.equal((await reviews.run(db,ctx,'supplier-options')).rows[0].Suggestion.includes('Fixture parts'),true);
  await assert.rejects(reviews.run(db,ctx,'supplier-options',{scheduled:true}),e=>e.code==='entitlement_required');
  await browser.get('/autopilot/reviews/compare-quotes').expect(402);
  await assert.rejects(ask.prepare(null,db,ctx,'Compare supplier quotes',{agentJob:'compare-quotes'}),e=>e.code==='entitlement_required');
  await assert.rejects(staffRequests.page(db,ctx),/Growth/);
  await plan('growth');
  const initial=await browser.get('/purchasing/requests').expect(200);
  const input={_csrf:csrf(initial.text),requestKey:randomUUID(),sku:code,quantity:3,reason:'Dispatch team needs more parts',locationId:f.location.id};
  await browser.post('/purchasing/requests').type('form').send(input).expect(303);
  await browser.post('/purchasing/requests').type('form').send(input).expect(303);
  const listing=await staffRequests.page(db,ctx);assert.equal(listing.requests.length,1);
  const id=listing.requests[0].id;
  await plan('starter');
  await assert.rejects(staffRequests.decide(db,ctx,id,{decision:'approve',supplier:'Fixture parts'}),e=>e.code==='entitlement_required');
  await plan('growth');
  const staff={...ctx,actorId:'requesting-staff'};
  await db.query("INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('requesting-account','staff@example.test','Staff','unused',now())");
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,warehouse_location_ids,created_at) VALUES($1,$2,'requesting-account','Staff','staff',$3,now())",[staff.actorId,ctx.workspaceId,JSON.stringify([f.location.id]) ]);
  const staffInput={...input,requestKey:randomUUID(),quantity:2};
  await assert.rejects(staffRequests.submit(db,staff,{...staffInput,locationId:'foreign-location'}),/outside your assigned warehouses/);
  const staffRequest=await staffRequests.submit(db,staff,staffInput);
  assert.equal((await staffRequests.page(db,staff)).requests.length,1);
  await assert.rejects(staffRequests.decide(db,staff,staffRequest,{decision:'approve',supplier:'Fixture parts'}),/Only the owner/);
  await staffRequests.decide(db,ctx,staffRequest,{decision:'decline'});
  assert.equal((await staffRequests.page(db,staff)).requests[0].status,'DECLINED');
  const decisionPage=await browser.get('/purchasing/requests').expect(200);
  const approved=await browser.post('/purchasing/requests/'+id+'/decision').type('form').send({_csrf:csrf(decisionPage.text),decision:'approve',supplier:'Fixture parts'}).expect(303);
  const po=await staffRequests.decide(db,ctx,id,{decision:'approve',supplier:'Fixture parts'});
  assert.ok(approved.headers.location.endsWith(po));
  const saved=(await db.query('SELECT p.status,l.quantity_units FROM purchase_orders p JOIN purchase_order_lines l ON l.purchase_order_id=p.id WHERE p.id=$1',[po])).rows;
  assert.equal(saved.length,1);assert.equal(saved[0].status,'DRAFT');assert.equal(Number(saved[0].quantity_units),3);
  assert.equal(await f.balance(),4);assert.equal((await db.query('SELECT count(*) AS n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
  const roi=require('../../src/autopilot/time-saved');
  const sample={activity:'staff-request',manualMinutes:8,reviewMinutes:2,requestKey:randomUUID()};
  await roi.sample(db,ctx,sample);await roi.sample(db,ctx,sample);
  const monthly=await roi.report(db,ctx,'month');
  assert.deepEqual(monthly.rows.find(r=>r.key==='staff-request'),{key:'staff-request',label:'Create a purchase order from an approved staff request',count:1,samples:1,minutes:6});
  assert.deepEqual(monthly.amounts,[{currency:'USD',flagged:'$1.50',applied:'$0.00'}]);assert.equal(monthly.planPrice,'$499.00');
  const reportPage=await browser.get('/autopilot/time-saved?period=month').expect(200);
  assert.match(reportPage.text,/\$1\.50/);assert.match(reportPage.text,/\$499\.00/);
  // Record two more received orders. Each is one lead observation even when split across deliveries.
  for(const daysAgo of [6,9]){
    const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      expectedDate:today,idempotencyKey:'lead-po-'+daysAgo,lines:[{skuId:sku,quantityUnits:2,unitCost:1}]});
    await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:'approve-lead-'+daysAgo});
    await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:'place-lead-'+daysAgo});
    await db.query("UPDATE purchase_orders SET ordered_at=(now()-make_interval(days=>$2))::text WHERE id=$1",[order.purchaseOrderId,daysAgo]);
    for(const n of [1,2]) await workflows.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:'receive-lead-'+daysAgo+'-'+n,
      lines:[{lineId:order.lineIds[0],quantity:1,locationId:f.location.id}]});
  }
  const leads=(await reviews.run(db,ctx,'measured-lead-times',{filter:code})).rows[0];
  assert.equal(leads['Delivered orders'],3);assert.equal(Number(leads['Average actual days']),5);
  assert.equal(Number(leads['Configured days']),4);
  const planning=await require('../../src/forecasting/postgres-planning-service').position(db,ctx.workspaceId,{onlySkuIds:[sku]});
  assert.equal(planning[0].leadTimeDays,5);
  await plan('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '21 days')::text WHERE id=$1",[owner.accountId]);
  const returns=require('../../src/operations/postgres-returns'),assistant=require('../../src/assistant/postgres-service');
  const returned=await returns.requestSupplierReturn(db,ctx,{supplierId:'fixture-supplier',supplierBillId:bill.billId,expectedCreditMinor:100,idempotencyKey:randomUUID(),
    lines:[{skuId:sku,locationId:f.location.id,quantity:1}]});
  await returns.authorizeSupplierReturn(db,ctx,returned.supplierReturnId,{idempotencyKey:randomUUID()});
  await returns.shipSupplierReturn(db,ctx,returned.supplierReturnId,{idempotencyKey:randomUUID()});
  const beforeCredit=(await reviews.run(db,ctx,'supplier-credits')).rows;
  assert.equal(beforeCredit[0].Status,'Awaiting credit');assert.equal(beforeCredit[0].Amount,'$1.00');
  const credit=await assistant.prepareAction(db,ctx,'Apply received credit CN-101 for one dollar',{action:'supplier_return.reconcile',
    recordReference:returned.supplierReturnId,amount:'1.00',creditNumber:'CN-101',creditDate:today});
  assert.equal(credit.status,'PREPARED');
  await assistant.executeProposal(db,ctx,credit.proposal.id);await assistant.executeProposal(db,ctx,credit.proposal.id);
  const afterCredit=(await reviews.run(db,ctx,'supplier-credits')).rows;
  assert.equal(afterCredit.length,1);assert.equal(afterCredit[0].Status,'Applied to bill');assert.equal(afterCredit[0]['Credit or return'],'CN-101');
  assert.deepEqual((await roi.report(db,ctx,'month')).amounts,[{currency:'USD',flagged:'$1.50',applied:'$1.00'}]);
  const remaining=await db.query('SELECT balance_minor FROM accounting_supplier_bills WHERE id=$1',[bill.billId]);
  assert.equal(Number(remaining.rows[0].balance_minor),100);
  // One verified delivery provides eight units. Each paid tier records its own
  // supplier email and matches one physical unit; reapproving preserves one bill.
  const invoiceOrder=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:8,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,invoiceOrder.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,invoiceOrder.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,invoiceOrder.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:invoiceOrder.lineIds[0],quantity:8,locationId:f.location.id}]});
  const mailbox=randomUUID(),sender='invoices@example.test';
  await db.query("UPDATE suppliers SET email=$2 WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId,sender]);
  await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at) VALUES($1,$2,$1,'Invoice mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)",[mailbox,ctx.workspaceId]);
  const physical=await f.balance();
  for(const tier of ['starter','growth','pro','enterprise']){
    await plan(tier);
    const invoiceNumber='IN-'+tier;
    const source=await require('../../src/connections/postgres-mail').capture(db,{id:mailbox,workspace_id:ctx.workspaceId,provider_type:'gmail'},
      {messageId:randomUUID(),sender,subject:invoiceNumber,bodyText:invoiceNumber+' for '+invoiceOrder.poNumber+': one '+code+' at USD 1.00.'});
    const doc={supplierInvoiceNumber:invoiceNumber,currency:'USD',issueDate:today,documentTotalMinor:100,sourceMessageId:source.messageId,
      lines:[{sku:code,quantityBasis:'stock',quantity:1,unitCostMinor:100}]};
    const prepared=await assistant.prepareAction(db,ctx,'Match this supplier invoice to its PO and delivery',{action:'purchase_order.record_supplier_invoice',
      recordReference:invoiceOrder.purchaseOrderId,invoiceDocument:JSON.stringify(doc)});
    assert.equal(prepared.status,'PREPARED');
    assert.equal((await db.query('SELECT id FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_invoice_number=$2',[ctx.workspaceId,invoiceNumber])).rowCount,0);
    const savedBill=await assistant.executeProposal(db,ctx,prepared.proposal.id);
    assert.equal(savedBill.result.status,'OPEN');
    assert.equal((await assistant.executeProposal(db,ctx,prepared.proposal.id)).result.billId,savedBill.result.billId);
    const stored=await db.query('SELECT balance_minor,journal_entry_id FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_invoice_number=$2',[ctx.workspaceId,invoiceNumber]);
    assert.equal(stored.rowCount,1);assert.equal(Number(stored.rows[0].balance_minor),100);assert.ok(stored.rows[0].journal_entry_id);
  }
  assert.equal((await roi.report(db,ctx,'month')).rows.find(r=>r.key==='invoice-match').count,4);
  assert.equal(await f.balance(),physical);
  assert.equal((await db.query('SELECT id FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,0);
  await assert.rejects(reviews.run(db,{...ctx,actorId:'other-account'},'payment-run'),/owner/);
});
