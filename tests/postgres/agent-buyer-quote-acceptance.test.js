
'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
const {fixture}=require('../helpers/agent-workflow-fixture');
const buyers=require('../../src/sales/agent-quote-buyers');
const quotes=require('../../src/sales/postgres-quotes');
const assistant=require('../../src/assistant/postgres-service');
const pricing=require('../../src/pricing/postgres-service');
const autopilot=require('../../src/autopilot/postgres-service');
const paymentTerms=require('../../src/sales/postgres-payment-terms');
const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers').create();
const {addDays}=require('../../src/accounting/customer-money');
const field=(html,name)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(html)?.[1];

test('a real buyer accepts one exact quote revision through its private link',{timeout:300000},async t=>{
  const f=await fixture(t,{units:12}),{db,ctx,browser,workflows,location}=f;
  const workspaceId=ctx.workspaceId,customerId='fixture-customer',skuId=f.item.skuIds[0];
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>app.locals.sessionStore.close());
  const buyer=request.agent(app);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("UPDATE customers SET email='buyer@example.test' WHERE workspace_id=$1 AND id=$2",[workspaceId,customerId]);
  await pricing.setPrice(db,ctx,{skuId,amountMinor:1200,currency:'USD'});
  const today=await require('../../src/lib/business-time').today(db,workspaceId),taxRateId='buyer-acceptance-tax';
  await db.query(`INSERT INTO accounting_tax_rates(id,workspace_id,name,jurisdiction,rate_millionths,applies_to,effective_from,active,created_by_user_id,created_at,updated_at)
    VALUES($1,$2,'Quote tax','Fixture',100000,'SALES','2020-01-01',1,$3,$4,$4)`,[taxRateId,workspaceId,ctx.actorId,new Date().toISOString()]);
  const create=(overrides={})=>quotes.create(db,ctx,{customerId,currency:'USD',taxRateId,discountMinor:200,orderDate:today,validUntil:addDays(today,7),
    deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,requestKey:randomUUID(),notes:'Private staff context',
    lines:[{skuId,quantity:2}],...overrides});
  const issue=async(q,overrides={})=>{
    const review=await buyers.page(db,ctx,q.id);
    return buyers.publish(db,ctx,q.id,{expectedQuote:q.pricing_hash,expectedOffer:review.publication?.hash,
      confirmed:'yes',linkRevision:review.link?.revision||0,...overrides});
  };
  const newTerms=netDays=>db.transaction(c=>paymentTerms.saveInTransaction(c,ctx,
    {customerId,kind:'ON_ACCOUNT',netDays,creditApproved:true}));
  const privateUrl=async q=>(await buyers.page(db,ctx,q.id)).url;
  const accepted=q=>buyers.accepted(db,workspaceId,q.id);
  const jobs=async()=>Number((await db.query('SELECT count(*) n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2',[workspaceId,buyers.KIND])).rows[0].n);
  const orders=async()=>Number((await db.query('SELECT count(*) n FROM sales_orders WHERE workspace_id=$1',[workspaceId])).rows[0].n);
  const worker=()=>queue.processOne(db,handlers,{owner:'buyer-quote-fixture',kinds:[buyers.KIND]});
  const directAccept=async q=>{
    const path=await privateUrl(q),page=await buyer.get(path).expect(200);
    await buyer.post(path+'/accept').type('form').send({_csrf:f.csrf(page.text),expectedOffer:field(page.text,'expectedOffer'),
      buyerName:'Jordan Buyer',buyerEmail:'buyer@example.test',confirmed:'yes',idempotencyKey:field(page.text,'idempotencyKey')}).expect(303);
    return accepted(q);
  };
  const verifyOrder=async(q,mode,expectedBalance=12)=>{
    const receipt=await accepted(q),id=receipt.order_id;
    assert.equal(receipt.state,'DRAFTED');
    assert.equal(receipt.approved_mode,mode);
    assert.equal(receipt.authorized_by,ctx.actorId);
    assert.equal((await quotes.get(db,workspaceId,q.id)).sales_order_id,id);
    const order=(await db.query(`SELECT o.*,s.quote FROM sales_orders o
      JOIN stockchief_runtime.pricing_order_snapshots s ON s.workspace_id=o.workspace_id AND s.id=o.pricing_quote_id
      WHERE o.workspace_id=$1 AND o.id=$2`,[workspaceId,id])).rows[0];
    assert.equal(order.status,'DRAFT');
    assert.equal(order.customer_id,q.customer_id);
    assert.equal(order.fulfillment_location_id,location.id);
    assert.equal(order.contact_email,'buyer@example.test');
    for(const key of ['subtotalMinor','discountMinor','taxMinor','totalMinor','currency','lines'])assert.deepEqual(order.quote[key],q.pricing[key]);
    assert.equal(Number(order.discount_minor),q.pricing.discountMinor);
    assert.equal(Number(order.tax_minor),q.pricing.taxMinor);
    assert.equal(await f.balance(),expectedBalance);
    for(const table of ['accounting_customer_invoices','accounting_payments','payment_requests','sales_shipments']){
      assert.equal((await db.query('SELECT id FROM '+table+' WHERE workspace_id=$1 AND sales_order_id=$2',[workspaceId,id])).rowCount,0,table);
    }
    return id;
  };

  await t.test('Starter excludes Agent acceptance while preserving native quote management',async()=>{
    await f.subscribe('starter');
    const q=await create(),page=await browser.get('/quotes/'+q.id).expect(200);
    assert.doesNotMatch(page.text,/Private buyer acceptance/);
    assert.match(page.text,/Accept and create draft order/);
    await assert.rejects(issue(q),e=>e.code==='entitlement_required');
    assert.equal(await orders(),0);
  });

  let individuallyApproved;
  await t.test('Growth receives a CSRF-protected buyer receipt and approves its native order once',async()=>{
    await f.subscribe('growth');
    await newTerms(21);
    const q=await create(),ownerUrl='/quotes/'+q.id+'/buyer';
    const preview=await browser.get(ownerUrl).expect(200);
    assert.match(preview.text,/Net 21 days/);
    assert.match(preview.text,/buyer@example.test/);
    assert.doesNotMatch(preview.text,/Maximum authorized total/);
    await assert.rejects(issue(q,{routine:'yes',maximum:'50'}),e=>e.code==='entitlement_required');
    await browser.post(ownerUrl+'/publish').type('form').send({_csrf:f.csrf(preview.text),
      expectedQuote:q.pricing_hash,expectedOffer:field(preview.text,'expectedOffer'),linkRevision:0,
      confirmed:'yes',idempotencyKey:field(preview.text,'idempotencyKey')}).expect(303);
    const path=await privateUrl(q),html=await buyer.get(path).expect(200);
    assert.equal(html.headers['cache-control'],'no-store');
    assert.equal(html.headers['referrer-policy'],'no-referrer');
    assert.equal(html.headers['x-robots-tag'],'noindex, nofollow');
    assert.match(html.text,/Net 21 days/);
    assert.match(html.text,/\$24\.20/);
    assert.doesNotMatch(html.text,/buyer@example.test|Private staff context|costUnitMinor|source_snapshot/);
    assert(field(html.text,'idempotencyKey'));
    const form={_csrf:f.csrf(html.text),expectedOffer:field(html.text,'expectedOffer'),buyerName:'Jordan Buyer',
      buyerEmail:'BUYER@example.test',confirmed:'yes',idempotencyKey:field(html.text,'idempotencyKey')};
    await buyer.post(path+'/accept').type('form').send({...form,_csrf:''}).expect(403);
    await buyer.post(path+'/accept').type('form').send({...form,buyerEmail:'elsewhere@example.test'}).expect(400);
    await buyer.post(path+'/accept').type('form').send({...form,expectedOffer:'different'}).expect(400);
    assert.equal(await accepted(q),undefined);
    await assert.rejects(quotes.decide(db,ctx,q.id,{accept:true,expectedHash:q.pricing_hash}),/private buyer acceptance/);
    await newTerms(60);
    await Promise.all([buyer.post(path+'/accept').type('form').send(form).expect(303),
      buyer.post(path+'/accept').type('form').send(form).expect(303)]);
    const received=await accepted(q);
    assert.equal(received.state,'RECEIVED');
    assert.equal(received.payment_terms.net_days,21);
    assert.equal(received.buyer_email,'buyer@example.test');
    assert.equal(await orders(),0);
    assert.equal(await jobs(),0);
    await assert.rejects(create({supersedesId:q.id}),/buyer’s acceptance/);
    await buyer.get(path).expect(200).expect(/Acceptance received/);
    await buyer.post(path+'/accept').type('form').send({...form,buyerName:'Different signature'}).expect(404);
    const owner=await browser.get(ownerUrl).expect(200);
    const review=await browser.post(ownerUrl+'/review').type('form').send({_csrf:f.csrf(owner.text),
      idempotencyKey:field(owner.text,'idempotencyKey')}).expect(303);
    const proposalId=review.headers.location.split('/').at(-1);
    const action=await browser.get(review.headers.location).expect(200);
    assert.match(action.text,/Jordan Buyer/);
    assert.match(action.text,/Net 21 days/);
    await Promise.all([assistant.executeProposal(db,ctx,proposalId),assistant.executeProposal(db,ctx,proposalId)]);
    const id=await verifyOrder(q,'INDIVIDUAL');
    individuallyApproved=id;
    assert.equal(await orders(),1);
    assert.equal((await paymentTerms.forOrder(db,workspaceId,id,customerId)).net_days,21);
    assert.equal(await require('../../src/accounting/customer-terms').dueDate(db,workspaceId,customerId,today,{orderId:id}),addDays(today,21));
    await assert.rejects(workflows.editDraftSalesOrder(db,ctx,id,{...q.input,expectedVersion:1}),/accepted the exact terms/);
  });

  for(const tier of ['pro','enterprise']){
    await t.test(tier+' drafts only after buyer acceptance and exact owner authority',async()=>{
      await f.subscribe(tier);
      await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
      const q=await create(),before=await orders();
      await issue(q,{routine:'yes',maximum:'30'});
      assert.equal(await orders(),before);
      const receipt=await directAccept(q);
      assert.equal(receipt.state,'RECEIVED');
      const ran=await worker();
      assert.equal(ran.status,'COMPLETED',JSON.stringify(ran));
      await verifyOrder(q,'ROUTINE');
      assert.equal((await buyers.run(db,workspaceId,{quoteId:q.id,acceptanceId:receipt.id})).replayed,true);
      assert.equal(await orders(),before+1);
    });
  }

  await t.test('downgrade, Watch and stale pricing hold queued work with buyer evidence intact',async()=>{
    await f.subscribe('pro');
    const before=await orders();
    let q=await create();
    await issue(q,{routine:'yes',maximum:'30'});
    await directAccept(q);
    await f.subscribe('starter');
    await worker();
    assert.equal((await accepted(q)).state,'HELD');
    assert.equal(await orders(),before);
    await f.subscribe('pro');
    q=await create();
    await issue(q,{routine:'yes',maximum:'30'});
    await directAccept(q);
    await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
    await worker();
    assert.equal((await accepted(q)).state,'HELD');
    assert.match((await accepted(q)).problem,/watch-only/);
    await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
    q=await create();
    await issue(q,{routine:'yes',maximum:'30'});
    await directAccept(q);
    await pricing.setPrice(db,ctx,{skuId,amountMinor:1400,currency:'USD'});
    await worker();
    assert.equal((await accepted(q)).state,'HELD');
    assert.match((await accepted(q)).problem,/prices|discounts/);
    assert.equal(await orders(),before);
  });

  await t.test('withdrawal, expiry, superseded revisions and rotated links stop conversion',async()=>{
    await f.subscribe('pro');
    const before=await orders();
    let q=await create();
    await issue(q);
    const old=await privateUrl(q);
    await issue(q);
    await buyer.get(old).expect(404);
    const next=await privateUrl(q);
    assert.notEqual(old,next);
    await create({supersedesId:q.id});
    await buyer.get(next).expect(404);
    assert.equal(await accepted(q),undefined);
    q=await create({orderDate:addDays(today,-2),validUntil:addDays(today,-1)});
    await assert.rejects(issue(q),/unexpired/);
    q=await create();
    await issue(q,{routine:'yes',maximum:'40'});
    const path=await privateUrl(q);
    await directAccept(q);
    await assert.rejects(buyers.revoke(db,ctx,q.id,{linkRevision:0}),/changed/);
    await buyers.revoke(db,ctx,q.id,{linkRevision:1});
    await buyer.get(path).expect(404);
    await worker();
    assert.equal((await accepted(q)).state,'WITHDRAWN');
    assert.equal(await orders(),before);
    await create({supersedesId:q.id});
  });

  await t.test('a shipped mixed-unit quote keeps exact weight, destination and accepted price',async()=>{
    const catalog=require('../../src/domain/postgres-catalog-service'),stock=require('../../src/accounting/postgres-stock-receipt');
    const measured=(await catalog.createItem(db,ctx,{name:'Quoted actual-weight pieces',baseCode:'QUOTE-WEIGHT',
      trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'})).skuIds[0];
    await stock.receive(db,ctx,{skuId:measured,locationId:location.id,quantity:4,secondaryQuantity:'5.875',unitCost:'1',idempotencyKey:randomUUID()});
    await pricing.setPrice(db,ctx,{skuId:measured,amountMinor:1600,currency:'USD'});
    const q=await create({deliveryMethod:'SHIP',shipToAddress:'10 Jobsite Rd, Albany, NY 12207',discountMinor:0,
      lines:[{skuId:measured,quantity:2,secondaryQuantity:'2.375'},{skuId,quantity:1}]});
    await issue(q,{routine:'yes',maximum:'100'});
    await buyer.get(await privateUrl(q)).expect(200).expect(/2 piece · 2\.375 kg/).expect(/10 Jobsite Rd/);
    await directAccept(q);
    await worker();
    const id=await verifyOrder(q,'ROUTINE',16);
    const line=(await db.query('SELECT quantity_ordered,secondary_quantity_ordered FROM sales_order_lines WHERE sales_order_id=$1 AND sku_id=$2',[id,measured])).rows[0];
    assert.equal(Number(line.quantity_ordered),2);
    assert.equal(Number(line.secondary_quantity_ordered),2.375);
    assert.equal((await db.query('SELECT ship_to_address FROM sales_orders WHERE id=$1',[id])).rows[0].ship_to_address,q.input.shipToAddress);
  });

  await t.test('later manual fulfillment invoices the exact accepted terms',async()=>{
    assert(individuallyApproved);
    await workflows.confirmSalesOrder(db,ctx,individuallyApproved,{idempotencyKey:randomUUID()});
    const [{id:lineId}]=(await db.query('SELECT id FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2',[workspaceId,individuallyApproved])).rows;
    await workflows.fulfillSalesOrder(db,ctx,individuallyApproved,{idempotencyKey:randomUUID(),shipment:{handover:'COLLECTED'},
      lines:[{lineId,locationId:location.id,quantity:2}]});
    const [invoice]=(await db.query("SELECT id,total_minor,due_date due FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2",[workspaceId,individuallyApproved])).rows;
    assert.equal(Number(invoice.total_minor),2420);
    assert.equal(invoice.due,addDays(today,21));
    assert.equal((await require('../../src/accounting/postgres-invoice-document').load(db,workspaceId,invoice.id)).terms,'Net 21 days');
  });
});
