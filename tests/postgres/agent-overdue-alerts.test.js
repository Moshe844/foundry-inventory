'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 168 is alone on every plan. The worker's routine check raises a dated
// alert for each purchase order past its expected date with goods still to
// come, each customer order not shipped by the date promised, each shipped
// parcel past its delivery date, and each customer invoice or supplier bill
// unpaid past its due date. The date follows the record, and the alert clears
// when goods arrive, the order ships or is delivered, or the invoice is paid.
// Alerts reach the app, Needs you and email like job 166.
test('late orders, shipments and invoices alert and clear through the worker on every plan and email only when StockChief may act',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe,location,workflows,shipping}=f,ws=ctx.workspaceId;
  const alerts=require('../../src/autopilot/agent-alerts'),overdue=require('../../src/autopilot/overdue-alerts');
  const reviews=require('../../src/autopilot/job-reviews'),needs=require('../../src/projections/postgres-service');
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
  const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  const check=()=>db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  const today=await require('../../src/lib/business-time').today(db,ws),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const sku=f.item.skuIds[0];
  const open=async()=>(await db.query(`SELECT kind,reference,due::text AS due FROM stockchief_runtime.agent_operational_notices
    WHERE workspace_id=$1 AND job_id=168 AND NOT resolved ORDER BY kind,reference`,[ws])).rows.map(r=>r.kind+' '+r.reference+' due '+r.due);
  const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);

  // A purchase order a day late, and one still on time.
  const purchase=async expectedDate=>{
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,expectedDate,
      idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:2,unitCost:1}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    return po;
  };
  const latePo=await purchase(day(-1));await purchase(day(3));
  // A customer order promised for yesterday and not shipped, and one for tomorrow.
  const order=async neededBy=>{
    const o=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,neededBy,
      idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:900}]});
    await workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    return o;
  };
  const lateOrder=await order(day(-1));await order(day(1));
  // A parcel past its delivery date, whose invoice is also overdue.
  const parcel=await f.parcel({quantity:2});
  await shipping.markPacked(db,ctx,parcel.shipmentId);
  await shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-LATE'});
  await db.query('UPDATE sales_shipments SET expected_delivery_date=$2 WHERE id=$1',[parcel.shipmentId,day(-2)]);
  await db.query('UPDATE accounting_customer_invoices SET due_date=$2 WHERE sales_order_id=$1',[parcel.order.salesOrderId,day(-5)]);
  const shipmentNumber=(await db.query('SELECT shipment_number FROM sales_shipments WHERE id=$1',[parcel.shipmentId])).rows[0].shipment_number;
  const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ws,parcel.order.salesOrderId])).rows[0];
  // A supplier bill past its due date.
  const line=(await db.query('SELECT id,purchase_order_id FROM purchase_order_lines WHERE workspace_id=$1 ORDER BY created_at LIMIT 1',[ws])).rows[0];
  await workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:line.purchase_order_id,supplierInvoiceNumber:'BILL-LATE',
    issueDate:today,dueDate:today,currency:'USD',idempotencyKey:randomUUID(),lines:[{purchaseOrderLineId:line.id,skuId:sku,quantity:2,unitCostMinor:100}]});
  await db.query("UPDATE accounting_supplier_bills SET due_date=$2 WHERE workspace_id=$1 AND supplier_invoice_number='BILL-LATE'",[ws,day(-3)]);

  const expected=['Customer invoice '+invoice.invoice_number+' due '+day(-5),'Customer order '+lateOrder.orderNumber+' due '+day(-1),
    'Purchase order '+latePo.poNumber+' due '+day(-1),'Shipment '+shipmentNumber+' due '+day(-2),'Supplier bill BILL-LATE due '+day(-3)];
  // No plan: the check raises nothing.
  await check();assert.deepEqual(await open(),[]);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);await check();
    assert.deepEqual(await open(),expected,tier);
    const notice=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-168');
    assert.equal(notice.title,'Overdue orders, shipments and invoices');assert.match(notice.happened,/^5 outstanding orders, shipments or invoices\. Earliest due date /);
    const review=await reviews.run(db,ctx,overdue.key,{scheduled:true});
    assert.deepEqual(review.rows.map(r=>[r.Type,r['Days late'],r.Problem]),[['Customer invoice',5,'Unpaid past its due date'],['Supplier bill',3,'Unpaid past its due date'],
      ['Shipment',2,'Past its expected delivery date'],['Customer order',1,'Not shipped by the date promised'],['Purchase order',1,'Goods not received by the expected date']]);
    const page=await browser.get(overdue.path).expect(200);
    assert.match(page.text,new RegExp(lateOrder.orderNumber));assert.match(page.text,/How you get these alerts/);
  }
  assert.equal(await audits('Alerts updated'),1);
  await check();await check();
  assert.equal(await audits('Alerts updated'),1,'Replays add nothing.');

  // The date follows the record; the alert clears when the work is done.
  await db.query('UPDATE purchase_orders SET expected_date=$2 WHERE id=$1',[latePo.purchaseOrderId,day(-4)]);
  await check();
  assert.ok((await open()).includes('Purchase order '+latePo.poNumber+' due '+day(-4)));
  await workflows.receivePurchaseOrder(db,ctx,latePo.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'LATE-ARRIVAL',
    lines:[{lineId:latePo.lineIds[0],quantity:2,locationId:location.id}]});
  const sent=await shipping.prepare(db,ctx,lateOrder.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:lateOrder.lineIds[0],locationId:location.id,quantity:1}]});
  await shipping.setPackages(db,ctx,sent.shipmentId,[{weightGrams:350,lengthMm:200,widthMm:150,heightMm:100}]);
  await shipping.markPacked(db,ctx,sent.shipmentId);await check();
  assert.ok((await open()).some(a=>a.startsWith('Customer order '+lateOrder.orderNumber)),'Packed is not shipped.');
  await shipping.handoff(db,ctx,sent.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TRACK-ON-ITS-WAY'});
  await db.query("UPDATE sales_shipments SET status='DELIVERED' WHERE id=$1",[parcel.shipmentId]);
  await check();
  assert.deepEqual(await open(),[expected[0],expected[4]]);
  await workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:invoice.id,method:'cash',paymentDate:today,
    amountMinor:Number(invoice.balance_minor),idempotencyKey:randomUUID()});
  await check();
  assert.deepEqual(await open(),[expected[4]]);

  // Email: held during the first 14 days, then one email for the waiting alerts.
  await subscribe('starter');
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  const page=await browser.get(overdue.path).expect(200);
  await browser.post('/autopilot/alerts/168').type('form').send({_csrf:f.csrf(page.text),mailbox:connector,revision:'0'}).expect(303);
  await check();
  let panel=await alerts.panel(db,ctx,168);
  assert.equal(panel.waiting,1);assert.match(panel.note,/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await check();
  assert.equal((await alerts.panel(db,ctx,168)).waiting,0);
  const communication=async()=>(await db.query('SELECT * FROM customer_communications WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[ws])).rows[0];
  const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
  const delivered=[],provider={send:async({message})=>{delivered.push(message);return {externalMessageId:'accepted-'+message.id};}};
  let email=await communication();
  await mail.executeSendEffect(db,ws,await effect(email.id),{provider});
  assert.equal(delivered[0].recipient,f.email);assert.equal(delivered[0].subject,'Overdue: Supplier bill BILL-LATE');
  assert.match(delivered[0].body,/- Supplier bill BILL-LATE \(Fixture parts\)\. Unpaid past its due date: due \d{4}-\d{2}-\d{2}, 3 days late\./);

  // Pause and Ask me first hold the email of a new late record; the owner
  // can send it from the page under Ask me first.
  await autopilot.pause(db,ctx,{role:'owner'},'Month end');
  const another=await purchase(day(-2));await check();
  panel=await alerts.panel(db,ctx,168);assert.equal(panel.waiting,1);assert.match(panel.note,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await modes.save(db,ctx,168,{mode:'ask',revision:0});
  await check();
  panel=await alerts.panel(db,ctx,168);assert.match(panel.note,/Ask me first/);assert.equal(panel.canSendNow,true);
  const sendPage=await browser.get(overdue.path).expect(200);
  await browser.post('/autopilot/alerts/168/send').type('form').send({_csrf:f.csrf(sendPage.text)}).expect(303);
  email=await communication();
  assert.match(email.body,new RegExp('Purchase order '+another.poNumber+' \\(Fixture parts\\)\\. Goods not received by the expected date'));
  assert.equal(await audits('Alert email queued'),2);
  // The supplier is paid before the second email is sent: nothing goes out.
  await modes.save(db,ctx,168,{mode:'inherit',revision:1});
  await workflows.receivePurchaseOrder(db,ctx,another.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'ARRIVED',
    lines:[{lineId:another.lineIds[0],quantity:2,locationId:location.id}]});
  await check();
  await assert.rejects(mail.executeSendEffect(db,ws,await effect(email.id),{provider}),/cleared before the email was sent/);
  assert.equal(delivered.length,1);
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===168).allowed,['inherit','watch','ask']);

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+overdue.path);
    assert(await tab.getByRole('heading',{name:'Find late orders, shipments and invoices',exact:true}).isVisible());
    assert(await tab.getByRole('heading',{name:'How you get these alerts'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'overdue-alerts-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
