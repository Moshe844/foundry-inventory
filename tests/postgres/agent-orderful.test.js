'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const {randomUUID}=require('node:crypto');
const edi=require('../../src/connections/postgres-orderful-test');
test('retailer test PO to acknowledgment, actual ship notice and posted invoice with stream and plan isolation',{timeout:240000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,workflows}=f;
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
  const source=randomUUID(),change=randomUUID(),wrong=randomUUID(),ext=randomUUID(),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  async function plan(id){await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,$3,
    (SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'),'ACTIVE')
    ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),f.owner.accountId,id]);}
  const config={buyer:'TESTBUYER',seller:'TESTSELLER',apiKey:'fixture-orderful',locationId:f.location.id,customerId:'fixture-customer',currency:'USD',transactionId:source};
  const msg={purchaseOrderNumber:'BUY-5',purchaseOrderDate:today,purpose:'original',purchaseOrderType:'standalone',
    parties:{shipTo:{name:'Receiving',addressLine1:'25 Main Street',city:'Albany',stateOrProvinceCode:'NY',postalCode:'12201',countryCode:'US'}},
    lineItems:[{purchaseOrderLineId:'1',productIds:{vendorItemNumber:code},quantity:{value:'2',unitOfMeasure:'each'},unitCostPrice:'3.25'}]};
  let calls=0,lose=false,verifyMismatch=false;
  const outgoing=[];
  const transport=async(url,opts)=>{
    calls++;const u=new URL(url),json=v=>new Response(JSON.stringify(v),{status:200});
    if(u.hostname==='storage.googleapis.com'){
      assert.equal(opts.headers['orderful-api-key'],undefined);
      return json(u.pathname==='/out'?(verifyMismatch?{broken:true}:outgoing[0].message):msg);
    }
    assert.equal(u.hostname,'api.orderful.com');assert.equal(opts.headers['orderful-api-key'],config.apiKey);assert.equal(opts.headers['orderful-api-version'],'v4');
    if(u.searchParams.has('createdAtStart')){
      assert.equal(u.searchParams.get('stream'),'test');assert.equal(u.searchParams.get('receiverId'),config.seller);assert.equal(u.searchParams.get('senderId'),null,'Every retailer of this seller is read.');
      return json({data:[],metadata:{pagination:{links:{next:null,prev:null}}}});
    }
    if(opts.method==='POST'){
      const body=JSON.parse(opts.body);assert.equal(body.stream,'test');assert.equal(body.senderId,config.seller);assert.equal(body.receiverId,config.buyer);outgoing.push(body);
      if(lose){lose=false;throw new Error('simulated lost response');}
      return new Response(JSON.stringify({id:String(850000+outgoing.length),status:'ACCEPTED',detail:''}),{status:202});
    }
    const isOut=u.pathname.includes(ext),id=u.pathname.split('/')[2],amended=id===change;
    if(u.pathname.endsWith('/message'))return new Response(null,{status:302,headers:{Location:'https://storage.googleapis.com/'+(isOut?'out':'in')}});
    return json({id,stream:id===wrong?'live':'test',direction:isOut?'out':'in',senderId:isOut?config.seller:config.buyer,receiverId:isOut?config.buyer:config.seller,
      ediTransactionType:isOut?'855_PURCHASE_ORDER_ACKNOWLEDGMENT':amended?'860_PURCHASE_ORDER_CHANGE':'850_PURCHASE_ORDER',businessNumber:'BUY-5',validationStatus:'VALID',deliveryStatus:'DELIVERED',acknowledgmentStatus:'ACCEPTED'});
  };
  for(const tier of ['starter','growth','pro']){
    await plan(tier);await assert.rejects(edi.connect(db,ctx,config,transport),e=>e.code==='entitlement_required');assert.equal(calls,0);
  }
  await plan('enterprise');await assert.rejects(edi.connect(db,ctx,{...config,transactionId:wrong},transport),/test stream/);
  await edi.connect(db,ctx,config,transport);const created=await edi.receive(db,ctx,source,transport);
  assert.equal((await edi.receive(db,ctx,source,transport)).orderId,created.orderId);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  await assert.rejects(edi.send(db,ctx,source,'ack',created.orderId,transport),/Confirm/);
  await workflows.confirmSalesOrder(db,ctx,created.orderId,{idempotencyKey:'edi-confirm'});
  const substitute=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Substitute',baseCode:'SUB-'+randomUUID().slice(0,8),trackingMode:'quantity'});
  await db.query('UPDATE sales_order_lines SET sku_id=$2 WHERE sales_order_id=$1',[created.orderId,substitute.skuIds[0]]);
  await assert.rejects(edi.send(db,ctx,source,'ack',created.orderId,transport),/items, quantities or prices changed/);
  assert.equal(outgoing.length,0);
  await db.query('UPDATE sales_order_lines SET sku_id=$2 WHERE sales_order_id=$1',[created.orderId,f.item.skuIds[0]]);
  lose=true;await assert.rejects(edi.send(db,ctx,source,'ack',created.orderId,transport),/unknown/);
  assert.equal(outgoing.length,1);assert.equal(outgoing[0].message.lineItems[0].actions[0].quantity.value,'2');
  assert.equal((await edi.send(db,ctx,source,'ack',created.orderId,transport)).alreadySubmitted,true);
  verifyMismatch=true;await assert.rejects(edi.reconcile(db,ctx,source,'ack',created.orderId,ext,transport),/differs/);
  verifyMismatch=false;assert.equal((await edi.reconcile(db,ctx,source,'ack',created.orderId,ext,transport)).status,'ACKNOWLEDGED');
  const line=(await db.query('SELECT id FROM sales_order_lines WHERE sales_order_id=$1',[created.orderId])).rows[0];
  const parcel=await f.shipping.prepare(db,ctx,created.orderId,{idempotencyKey:'edi-pack',lines:[{lineId:line.id,locationId:f.location.id,quantity:2}]});
  await assert.rejects(edi.send(db,ctx,source,'ship',parcel.shipmentId,transport),/handoff/);
  await f.shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:100,lengthMm:130,widthMm:90,heightMm:80}]);
  await f.shipping.markPacked(db,ctx,parcel.shipmentId);
  await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'TEST-EDI-123'});
  const bill=(await db.query('SELECT id FROM accounting_customer_invoices WHERE sales_order_id=$1',[created.orderId])).rows[0];
  await assert.rejects(edi.send(db,ctx,source,'invoice',bill.id,transport),/ship notices/);
  await plan('pro');await assert.rejects(edi.send(db,ctx,source,'ship',parcel.shipmentId,transport),e=>e.code==='entitlement_required');
  const customer='cus_edi_test',scope={accountId:f.owner.accountId,workspaceId:ctx.workspaceId},addons=require('../../src/commercial/capacity-addons');
  await db.query('UPDATE account_subscriptions SET stripe_customer_id=$2 WHERE account_id=$1',[scope.accountId,customer]);
  await db.query("UPDATE commercial_capacity_products SET stripe_price_id=id WHERE id='agent-pro-edi'");
  const {order:purchase}=await addons.begin(db,scope,{productId:'agent-pro-edi',quantity:1,idempotencyKey:randomUUID(),origin:'https://example.test'},
    {testMode:true,provider:{retrievePrice:async id=>({id,active:true,type:'recurring',currency:'usd',unit_amount:29900,recurring:{interval:'month'}}),
    createCapacityCheckout:async x=>({id:'cs_'+x.orderId,url:'https://example.test/checkout'})}});
  const time=Math.floor(Date.now()/1000),subscription='sub_'+purchase.id;
  const event=(type,obj)=>db.transaction(c=>addons.receive(c,{id:'evt_'+randomUUID(),created:time,type,data:{object:obj}}));
  await event('checkout.session.completed',{id:'cs_'+purchase.id,mode:'subscription',customer,subscription,metadata:{stockchief_capacity_order_id:purchase.id,stockchief_account_id:scope.accountId}});
  await event('invoice.paid',{id:'in_'+purchase.id,status:'paid',currency:'usd',total:29900,customer,subscription,lines:{has_more:false,data:[{quantity:1,price:{id:'agent-pro-edi'},period:{start:time-1,end:time+86400}}]}});
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[scope.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // The owner lets StockChief send this retailer's documents on its own (job 185).
  await edi.saveRetailer(db,ctx,{partnerId:config.buyer,revision:1,name:'Test buyer',customerId:config.customerId,locationId:config.locationId,currency:'USD',maxOrder:'100',automatic:'yes'});
  await edi.configure(db,ctx,'enable');await db.transaction(edi.schedule);
  const job={workspaceId:ctx.workspaceId,payload:(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE kind='orderful.test-inbox' AND workspace_id=$1",[ctx.workspaceId])).rows[0].payload};
  await plan('growth');await assert.rejects(edi.poll(db,job,transport),e=>e.code==='entitlement_required');assert.equal(outgoing.length,1);
  await plan('pro');await edi.poll(db,job,transport);await edi.poll(db,job,transport);
  assert.equal(outgoing.length,3);
  await edi.configure(db,ctx,'disable');await assert.rejects(edi.poll(db,job,transport),/disabled/);
  assert.equal(outgoing[1].message.orders[0].items[0].quantityShipped.value,'2');assert.equal(outgoing[1].message.references.trackingNumber,'TEST-EDI-123');
  assert.equal(outgoing[2].message.invoiceTotal,'6.50');assert.equal(outgoing[2].message.lineItems[0].purchaseOrderLineId,'1');
  assert.equal((await edi.dashboard(db,ctx)).records[0].submitted.length,3);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');await browser.post('/login').type('form').send({_csrf:/name="_csrf" value="([^"]+)"/.exec(login.text)[1],email:f.email,password:f.password});
  assert.match((await browser.get('/autopilot/orderful').expect(200)).text,/Retailer acknowledged/);
  await db.query("INSERT INTO stockchief_runtime.orderful_inbox(workspace_id,transaction_id,business_number,kind,opened_at,issue) VALUES($1,$2,'BUY-5','860_PURCHASE_ORDER_CHANGE',now(),'Needs review')",[ctx.workspaceId,change]);
  assert.equal((await edi.receive(db,ctx,change,transport)).held,true);
  assert.equal((await edi.receive(db,ctx,change,transport)).replayed,true);
  const reviewed=(await db.query('SELECT completed_at,issue FROM stockchief_runtime.orderful_inbox WHERE workspace_id=$1 AND transaction_id=$2',[ctx.workspaceId,change])).rows[0];
  assert.ok(reviewed.completed_at);assert.equal(reviewed.issue,null);
  assert.equal((await edi.dashboard(db,ctx)).records[0].changes.length,1);
  await assert.rejects(edi.outbound(db,ctx,source,'ack',created.orderId),/changed this order/);
  await plan('starter');assert.equal((await edi.dashboard(db,ctx)).records,undefined);await edi.disconnect(db,ctx);
});
