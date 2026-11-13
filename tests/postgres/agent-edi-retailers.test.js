'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 185: EDI orders, ship notices (ASN) and invoices with big retailers.
// Starter and Growth are excluded; Pro needs the paid EDI add-on; Custom
// includes it. Each retailer is set up once. Its 850 orders become customer
// orders; StockChief confirms one when the prices match the retailer's last
// confirmed order, the ship-to is known and the order is within the owner's
// limit, then sends the 855, each 856 once the goods leave and the 810 once
// the order is invoiced, all through the EDI provider interface (here a
// scripted test network). A mismatch or an unknown retailer stops and asks;
// pause, Ask me first and the first 14 days leave the work for a person.
test('retailer EDI documents run on their own from real orders, shipments and invoices, and stop and ask on a mismatch',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,browser,subscribe,workflows}=f,ws=ctx.workspaceId;
  const edi=require('../../src/connections/postgres-orderful-test'),providers=require('../../src/connections/edi-providers');
  const needs=require('../../src/projections/postgres-service'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const net=require('../helpers/edi-test-provider').ediNetwork();t.after(providers.register('edi-test',net.factory));
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,today=await require('../../src/lib/business-time').today(db,ws);
  const SELLER='US-SELLER',A='RETAILER-A',Z='RETAILER-Z';
  const address={name:'Receiving',addressLine1:'25 Main Street',city:'Albany',stateOrProvinceCode:'NY',postalCode:'12201',countryCode:'US'};
  const po=(number,{quantity=2,price='3.25',sku=code,shipTo=address}={})=>({purchaseOrderNumber:number,purchaseOrderDate:today,purpose:'original',purchaseOrderType:'standalone',
    parties:{shipTo},lineItems:[{purchaseOrderLineId:'1',productIds:{vendorItemNumber:sku},quantity:{value:String(quantity),unitOfMeasure:'each'},unitCostPrice:price}]});
  const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
  const order=async number=>(await db.query(`SELECT o.*,e.hold_reason,e.source_id FROM stockchief_runtime.orderful_orders e JOIN sales_orders o ON o.id=e.sales_order_id WHERE e.workspace_id=$1 AND e.purchase_order_number=$2`,[ws,number])).rows[0];
  const types=()=>net.sent.map(s=>s.type.slice(0,3)+':'+(s.document.purchaseOrderNumber||s.document.orders[0].purchaseOrderNumber));
  const waiting=async()=>(await needs.needs(db,ws,ctx.actorId)).filter(n=>n.sourceId==='retail-edi').map(n=>n.title);
  const form=async()=>f.csrf((await browser.get('/autopilot/orderful').expect(200)).text);
  const first=net.deliver({sender:A,receiver:SELLER,message:po('PO-0')});
  const config={provider:'edi-test',apiKey:net.apiKey,buyer:A,seller:SELLER,customerId:'fixture-customer',locationId:f.location.id,currency:'USD',transactionId:first};

  // An account on its older terms sees the plan card; Starter, Growth and Pro without the add-on are locked.
  await db.query('DELETE FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId]);
  assert.match((await browser.get('/autopilot/orderful').expect(200)).text,/data-agent-plan-locked/);
  for(const tier of ['starter','growth','pro']){
    await subscribe(tier);
    await assert.rejects(edi.connect(db,ctx,config),e=>e.code==='entitlement_required');
    assert.match((await browser.get('/autopilot/orderful').expect(402)).text,/EDI requires Pro with the EDI add-on, or Custom/);
  }
  // Pro with the paid EDI add-on.
  const customer='cus_edi_'+randomUUID().slice(0,8),scope={accountId:f.owner.accountId,workspaceId:ws},addons=require('../../src/commercial/capacity-addons');
  await db.query('UPDATE account_subscriptions SET stripe_customer_id=$2 WHERE account_id=$1',[scope.accountId,customer]);
  await db.query("UPDATE commercial_capacity_products SET stripe_price_id=id WHERE id='agent-pro-edi'");
  const {order:purchase}=await addons.begin(db,scope,{productId:'agent-pro-edi',quantity:1,idempotencyKey:randomUUID(),origin:'https://example.test'},
    {testMode:true,provider:{retrievePrice:async id=>({id,active:true,type:'recurring',currency:'usd',unit_amount:29900,recurring:{interval:'month'}}),
    createCapacityCheckout:async x=>({id:'cs_'+x.orderId,url:'https://example.test/checkout'})}});
  const time=Math.floor(Date.now()/1000),subscription='sub_'+purchase.id;
  const event=(type,obj)=>db.transaction(c=>addons.receive(c,{id:'evt_'+randomUUID(),created:time,type,data:{object:obj}}));
  await event('checkout.session.completed',{id:'cs_'+purchase.id,mode:'subscription',customer,subscription,metadata:{stockchief_capacity_order_id:purchase.id,stockchief_account_id:scope.accountId}});
  await event('invoice.paid',{id:'in_'+purchase.id,status:'paid',currency:'usd',total:29900,customer,subscription,lines:{has_more:false,data:[{quantity:1,price:{id:'agent-pro-edi'},period:{start:time-1,end:time+86400}}]}});
  await edi.connect(db,ctx,config);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stockchief_runtime.agent_edi_retailers WHERE workspace_id=$1 AND partner_id=$2 AND NOT automatic`,[ws,A])).rows[0].n,1,'The first retailer is set up for a person.');

  // The first 14 days: StockChief only reads the retailer documents in; it imports and sends nothing.
  await edi.configure(db,ctx,'enable');await db.transaction(edi.schedule);
  const job={workspaceId:ws,payload:(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE kind='orderful.test-inbox' AND workspace_id=$1",[ws])).rows[0].payload};
  const poll=()=>edi.poll(db,job);
  net.deliver({sender:A,receiver:SELLER,message:po('PO-1')});
  assert.equal((await poll()).held,true);assert.equal(await order('PO-1'),undefined);
  assert.match((await db.query('SELECT last_issue FROM stockchief_runtime.orderful_rules WHERE workspace_id=$1',[ws])).rows[0].last_issue,/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[scope.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // A retailer the owner handles: the order comes in as a draft and waits for a person, and so does its acknowledgment.
  assert.equal((await poll()).processed,1);
  let o=await order('PO-1');assert.equal(o.status,'DRAFT');assert.equal(await audits(edi.IMPORTED),1);
  assert.deepEqual(await waiting(),['1 retailer order waits for you to confirm']);
  await workflows.confirmSalesOrder(db,ctx,o.id,{idempotencyKey:'person-confirms-po-1'});
  await poll();assert.deepEqual(net.sent,[]);
  assert.deepEqual(await waiting(),['1 retailer order has a document to send']);
  await browser.post('/autopilot/orderful/'+o.source_id+'/ack/'+o.id+'/send').type('form').send({_csrf:await form()}).expect(303);
  assert.deepEqual(types(),['855:PO-1']);assert.equal(net.sent[0].buyer,A);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND after_state->>'automatic'='false'`,[ws,edi.SENT])).rows[0].n,1);

  // The owner lets StockChief handle retailer A up to $50 an order.
  let page=await browser.get('/autopilot/orderful').expect(200);
  const revision=/name="partnerId" value="RETAILER-A"><input type="hidden" name="revision" value="(\d+)"/.exec(page.text)[1];
  await browser.post('/autopilot/orderful/retailers').type('form').send({_csrf:f.csrf(page.text),partnerId:A,revision,name:'Retailer A',customerId:'fixture-customer',
    locationId:f.location.id,currency:'USD',maxOrder:'50.00',automatic:'yes'}).expect(303);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stockchief_runtime.agent_edi_retailers WHERE workspace_id=$1 AND automatic AND max_order_minor=5000`,[ws])).rows[0].n,1);

  // Same prices, a known ship-to, within the limit: confirmed and acknowledged on its own; a replay sends nothing again.
  net.deliver({sender:A,receiver:SELLER,message:po('PO-2')});
  let result=await poll();assert.equal(result.confirmed,1);assert.equal(result.sent,1);
  o=await order('PO-2');assert.equal(o.status,'CONFIRMED');assert.equal(o.hold_reason,null);assert.equal(await audits(edi.CONFIRMED),1);
  assert.deepEqual(types(),['855:PO-1','855:PO-2']);
  await poll();assert.equal(net.sent.length,2,'A replay sends nothing twice.');

  // The goods leave: the ship notice goes, with the tracking number; the order is invoiced, so the invoice follows.
  const line=(await db.query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1',[o.id])).rows[0];
  const parcel=await f.shipping.prepare(db,ctx,o.id,{idempotencyKey:'edi-pack-2',lines:[{lineId:line.id,locationId:f.location.id,quantity:2}]});
  await f.shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:100,lengthMm:130,widthMm:90,heightMm:80}]);
  await f.shipping.markPacked(db,ctx,parcel.shipmentId);
  await poll();assert.equal(net.sent.length,2,'No ship notice before the goods leave.');
  await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z-EDI-2'});
  result=await poll();assert.equal(result.sent,2);
  assert.deepEqual(types().slice(2),['856:PO-2','810:PO-2']);
  assert.equal(net.sent[2].document.orders[0].items[0].quantityShipped.value,'2');assert.equal(net.sent[2].document.references.trackingNumber,'1Z-EDI-2');
  assert.equal(net.sent[3].document.invoiceTotal,'6.50');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND after_state->>'automatic'='true'`,[ws,edi.SENT])).rows[0].n,3);

  // Facts that do not match stop and ask: a changed price, a new ship-to, an order over the limit, an unknown item and an unknown retailer.
  net.deliver({sender:A,receiver:SELLER,message:po('PO-3',{price:'2.99'})});
  net.deliver({sender:A,receiver:SELLER,message:po('PO-4',{shipTo:{...address,addressLine1:'9 New Dock Road'}})});
  net.deliver({sender:A,receiver:SELLER,message:po('PO-5',{quantity:20})});
  net.deliver({sender:A,receiver:SELLER,message:po('PO-6',{sku:'NO-SUCH-SKU'})});
  net.deliver({sender:Z,receiver:SELLER,message:po('PO-7')});
  result=await poll();assert.equal(result.confirmed,0);assert.equal(net.sent.length,4,'Nothing goes to a retailer when facts do not match.');
  assert.match((await order('PO-3')).hold_reason,/pays \$2\.99 for .*last confirmed order paid \$3\.25/);
  assert.match((await order('PO-4')).hold_reason,/new address/);
  assert.match((await order('PO-5')).hold_reason,/over your limit of \$50\.00/);
  for(const n of ['PO-3','PO-4','PO-5'])assert.equal((await order(n)).status,'DRAFT');
  const issues=(await db.query('SELECT business_number,issue FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND issue IS NOT NULL ORDER BY business_number',[ws])).rows;
  assert.deepEqual(issues.map(i=>i.business_number),['PO-6','PO-7']);
  assert.match(issues[0].issue,/Match a unique vendor SKU/);assert.match(issues[1].issue,/No retailer is set up for EDI ID RETAILER-Z/);
  assert.deepEqual(await waiting(),['2 retail EDI documents need you','3 retailer orders wait for you to confirm']);
  page=await browser.get('/autopilot/orderful').expect(200);
  assert.match(page.text,/No retailer is set up for EDI ID RETAILER-Z/);assert.match(page.text,/Waits for you to confirm the order/);
  // Setting the retailer up reads its order in.
  await db.query(`INSERT INTO customers(id,workspace_id,name,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('retailer-z',$1,'Retailer Z','1 Z Plaza, Troy, NY 12180','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  await edi.saveRetailer(db,ctx,{partnerId:Z,name:'Retailer Z',customerId:'retailer-z',locationId:f.location.id,currency:'USD'});
  assert.equal((await poll()).processed,1);
  o=await order('PO-7');assert.equal(o.customer_id,'retailer-z');assert.equal(o.status,'DRAFT');
  // A person confirms a held order; its acknowledgment then goes on its own.
  await workflows.confirmSalesOrder(db,ctx,(await order('PO-4')).id,{idempotencyKey:'person-confirms-po-4'});
  await poll();assert.deepEqual(types().slice(4),['855:PO-4']);

  // Ask me first: new orders still come in as drafts, but nothing is confirmed or sent until the owner allows it again.
  await modes.save(db,ctx,185,{mode:'ask',revision:0});
  net.deliver({sender:A,receiver:SELLER,message:po('PO-8')});
  result=await poll();assert.equal(result.held,true);assert.match(result.reason,/Ask me first/);
  assert.equal((await order('PO-8')).status,'DRAFT');assert.equal(net.sent.length,5);
  assert.ok((await needs.needs(db,ws,ctx.actorId)).some(n=>n.sourceId==='retail-edi'&&/Ask me first/.test(n.happened)));
  await modes.save(db,ctx,185,{mode:'inherit',revision:1});
  await poll();assert.equal((await order('PO-8')).status,'CONFIRMED');assert.deepEqual(types().slice(5),['855:PO-8']);

  // Paused: StockChief reads nothing in; afterwards it catches up without sending anything twice.
  await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ws]);
  net.deliver({sender:A,receiver:SELLER,message:po('PO-9')});
  result=await poll();assert.equal(result.held,true);assert.equal(await order('PO-9'),undefined);
  await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ws]);
  // A lost answer from the network: the document is recorded before it leaves and never sent twice.
  net.lose();await poll();
  assert.equal((await order('PO-9')).status,'CONFIRMED');assert.equal(net.sent.length,7);
  await poll();assert.equal(net.sent.length,7,'An uncertain document waits to be checked; it is not sent again.');
  assert.equal((await db.query("SELECT status FROM stockchief_runtime.orderful_outbound WHERE workspace_id=$1 AND kind='ack' AND source_id=$2",[ws,(await order('PO-9')).source_id])).rows[0].status,'SUBMITTING');

  // The rule allowance counts each retailer StockChief handles; the activity log shows what it did on its own.
  assert.equal(await require('../../src/commercial/agent-rule-quota').count(db,f.owner.accountId)>=1,true);
  const log=await require('../../src/autopilot/agent-activity').report(db,ctx);
  const jobTitle=require('../../src/commercial/agent-plan-v3.json').find(r=>r.id===185).job;
  assert.ok(log.rows.filter(r=>r.Job===jobTitle).length>=3,'The activity log shows the EDI work.');

  // Custom includes EDI; Growth refuses even the scheduled check.
  await subscribe('enterprise');const before=net.sent.length;
  net.deliver({sender:A,receiver:SELLER,message:po('PO-10')});await poll();
  assert.equal((await order('PO-10')).status,'CONFIRMED');assert.equal(net.sent.length,before+1);
  await subscribe('growth');await assert.rejects(poll(),e=>e.code==='entitlement_required');
  assert.deepEqual(await waiting(),[]);
  await subscribe('enterprise');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+'/autopilot/orderful');
    assert.equal(await tab.locator('main h1').first().innerText(),'Retail EDI');
    assert(await tab.getByRole('heading',{name:'Retailers',exact:true}).isVisible());
    assert.match(await tab.locator('main').innerText(),/StockChief confirms orders up to 50\.00 USD/);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'retail-edi-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
