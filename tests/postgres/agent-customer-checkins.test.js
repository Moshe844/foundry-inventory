
'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-workflow-fixture');
const checkins=require('../../src/sales/agent-customer-checkins');
const assistant=require('../../src/assistant/postgres-service');
const autopilot=require('../../src/autopilot/postgres-service');
const reviews=require('../../src/autopilot/job-reviews');
const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers').create();
const field=(html,name)=>new RegExp('name="'+name+'" value="([^"]+)"').exec(html)?.[1];

test('inactive customer check-ins use native purchases, completed examples and private communications',{timeout:300000},async t=>{
  const f=await fixture(t,{units:32,timeZone:'America/New_York'}),{db,ctx,browser,workflows,location}=f;
  const ws=ctx.workspaceId,skuId=f.item.skuIds[0],route=checkins.path;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const add=async(name,email=name.toLowerCase()+'@example.test')=>{
    const id='cust-'+randomUUID(),at=new Date().toISOString();
    await db.query(`INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$6)`,[id,ws,name,email,ctx.actorId,at]);
    return id;
  };
  const purchase=async(id,{age=100,confirmOnly=false}={})=>{
    const order=await workflows.createSalesOrder(db,ctx,{customerId:id,deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,
      idempotencyKey:randomUUID(),lines:[{skuId,quantity:1,unitPriceMinor:1200}]});
    await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
    if(confirmOnly)return order;
    const fulfilled=await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),
      shipment:{handover:'COLLECTED'},lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:1}]});
    const shipment=(await db.query('SELECT id,shipment_number FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2',
      [ws,order.salesOrderId])).rows[0];
    assert(fulfilled.invoiceId);
    await db.query("UPDATE sales_shipments SET shipped_at=(now()-$3::interval)::text WHERE workspace_id=$1 AND id=$2",
      [ws,shipment.id,age+' days']);
    return {order,shipment};
  };
  const history=async(name,email)=>{
    const id=await add(name,email);
    await purchase(id,{age:160});await purchase(id,{age:100});
    return id;
  };
  const review=filter=>reviews.run(db,ctx,'customer-check-in',{filter});
  const prepare=id=>assistant.prepareAction(db,ctx,'Prepare a private check-in.',{action:checkins.ACTION,recordReference:id});
  const drafts=async id=>(await db.query(`SELECT d.*,m.status,m.recipient,m.subject,m.body,m.external_message_id,m.sent_at,m.connector_id
    FROM stockchief_runtime.agent_customer_checkin_drafts d JOIN customer_communications m ON m.id=d.id
    WHERE d.workspace_id=$1 AND ($2::text IS NULL OR d.customer_id=$2) ORDER BY d.created_at,d.id`,[ws,id||null])).rows;
  const effects=async()=>Number((await db.query("SELECT count(*) n FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send'",[ws])).rows[0].n);
  const worker=()=>queue.processOne(db,handlers,{owner:'native-check-in-fixture',kinds:[checkins.KIND]});
  const train=(exampleId,revision=0)=>checkins.configure(db,ctx,{exampleId,revision,confirmed:'yes'});
  const pro=await history('ProExample');

  await t.test('Starter and Growth cannot read, prepare, configure or schedule the duty',async()=>{
    for(const tier of ['starter','growth']){
      await f.subscribe(tier);
      await browser.get('/autopilot/reviews/customer-check-in').expect(402);
      await browser.get(route).expect(402);
      await assert.rejects(review('ProExample'),e=>e.code==='entitlement_required');
      await assert.rejects(prepare(pro),e=>e.code==='entitlement_required');
      await assert.rejects(train('fabricated'),e=>e.code==='entitlement_required');
      assert.equal((await checkins.schedule(db,ws)).queued,false);
    }
    assert.equal((await drafts()).length,0);
  });

  let example;
  await t.test('Pro can discover and approve one genuine draft, then teach its exact routine',async()=>{
    await f.subscribe('pro');
    await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
    const list=await browser.get('/autopilot/reviews/customer-check-in').query({filter:'ProExample'}).expect(200);
    assert.match(list.text,/Hello ProExample/);
    assert.match(list.text,/Open saved check-ins/);
    await assert.rejects(train('fabricated'),/Complete an individually approved/);
    assert.equal((await checkins.schedule(db,ws)).queued,false);
    const page=await browser.get(route).query({customer:pro}).expect(200);
    const p=await browser.post(route+'/prepare').type('form').send({_csrf:f.csrf(page.text),customerId:pro,
      idempotencyKey:field(page.text,'idempotencyKey')}).expect(303);
    const proposalId=p.headers.location.split('/').at(-1);
    const action=await browser.get(p.headers.location).expect(200);
    assert.match(action.text,/Save[s]? one private check-in draft/i);
    assert.match(action.text,/proexample@example.test/);
    assert.equal((await drafts(pro)).length,0);
    await Promise.all([assistant.executeProposal(db,ctx,proposalId),assistant.executeProposal(db,ctx,proposalId)]);
    [example]=await drafts(pro);
    assert.equal(example.authority_kind,'INDIVIDUAL');
    assert.equal(example.status,'PREPARED');
    assert.equal(example.sent_at,null);
    assert.equal(example.connector_id,null);
    assert.equal(example.evidence.purchases.length,2);
    assert.notEqual(example.evidence.purchases[0].orderId,example.evidence.purchases[1].orderId);
    assert.match(example.body,/Hello ProExample/);
    assert.equal((await drafts(pro)).length,1);
    assert.equal(await effects(),0);
    await browser.get(route).query({draft:example.id}).expect(200).expect(/Purchase evidence/);
    assert.doesNotMatch((await browser.get('/fulfilment').expect(200)).text,/ProExample/);
  });

  await t.test('recent purchases, open orders, physically returned goods and changed contacts prevent stale drafting',async()=>{
    const recent=await history('RecentBuyer'),pending=await history('OpenOrder'),once=await add('OnePurchase');
    await purchase(recent,{age:4});await purchase(pending,{confirmOnly:true});await purchase(once,{age:160});
    for(const name of ['RecentBuyer','OpenOrder','OnePurchase'])assert.equal((await review(name)).rows.length,0,name);
    const returned=await add('ReturnedPurchase');
    await purchase(returned,{age:160});
    const {order}=await purchase(returned,{age:100});
    assert.equal((await review('ReturnedPurchase')).rows.length,1);
    const returns=require('../../src/operations/postgres-returns');
    const {customerReturnId}=await returns.requestCustomerReturn(db,ctx,{salesOrderId:order.salesOrderId,quarantineLocationId:location.id,
      resolution:'NO_REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:order.lineIds[0],quantity:1}]});
    await returns.authorizeCustomerReturn(db,ctx,customerReturnId,{idempotencyKey:randomUUID()});
    assert.equal((await review('ReturnedPurchase')).rows.length,1);
    const {rows:[{id:lineId}]}=await db.query('SELECT id FROM customer_return_lines WHERE workspace_id=$1 AND customer_return_id=$2',[ws,customerReturnId]);
    await returns.receiveCustomerReturn(db,ctx,customerReturnId,{idempotencyKey:randomUUID(),lines:[{lineId,quantity:1}]});
    assert.equal((await review('ReturnedPurchase')).rows.length,0);
    const quoted=await history('ReturningBuyer'),quotes=require('../../src/sales/postgres-quotes');
    const buyerQuotes=require('../../src/sales/agent-quote-buyers'),today=await require('../../src/lib/business-time').today(db,ws);
    const q=await quotes.create(db,ctx,{customerId:quoted,deliveryMethod:'PICKUP',orderDate:today,validUntil:today,
      fulfillmentLocationId:location.id,currency:'USD',requestKey:randomUUID(),lines:[{skuId,quantity:1,unitPriceMinor:1200}]});
    const model=await buyerQuotes.page(db,ctx,q.id);
    await buyerQuotes.publish(db,ctx,q.id,{confirmed:'yes',expectedQuote:q.pricing_hash,expectedOffer:model.publication.hash});
    const token=(await buyerQuotes.page(db,ctx,q.id)).url.split('/').at(-1),offer=await buyerQuotes.buyerPage(db,token);
    await buyerQuotes.receive(db,token,{buyerName:'Returning Buyer',buyerEmail:'returningbuyer@example.test',confirmed:'yes',expectedOffer:offer.offerHash});
    assert.equal((await review('ReturningBuyer')).rows.length,0,'An accepted quotation is renewed activity');
    const accepted=await assistant.prepareAction(db,ctx,'Draft the accepted quote.',{action:'sales_quote.accept',recordReference:q.id});
    await assistant.executeProposal(db,ctx,accepted.proposal.id);
    assert.equal((await review('ReturningBuyer')).rows.length,0,'A draft with an actual buyer acceptance is renewed activity');
    const stale=await history('StaleContact'),p=await prepare(stale);
    await db.query("UPDATE customers SET email='changed@example.test' WHERE workspace_id=$1 AND id=$2",[ws,stale]);
    await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),/contact or purchase evidence changed/);
    assert.equal((await drafts(stale)).length,0);
    await purchase(stale,{age:2});
  });

  let proCandidate;
  await t.test('a taught Pro worker runs once from native evaluation and stops on Watch',async()=>{
    proCandidate=await history('TaughtCustomer');
    const settings=await browser.get(route).expect(200);
    assert.match(settings.text,/Teach private drafting/);
    assert.match(settings.text,new RegExp(example.id));
    await browser.post(route+'/routine').type('form').send({_csrf:f.csrf(settings.text),revision:0,
      exampleId:example.id,confirmed:'yes',idempotencyKey:field(settings.text,'idempotencyKey')}).expect(303);
    const work=await worker();
    assert.equal(work.status,'COMPLETED',JSON.stringify(work));
    assert.equal(work.result.drafted,1);
    const [saved]=await drafts(proCandidate);
    assert.equal(saved.authority_kind,'TRAINED');
    assert.equal(saved.rule_revision,1);
    assert.equal((await checkins.schedule(db,ws)).queued,false);
    assert.equal(await worker(),null);
    const evaluated=await history('EvaluationCustomer');
    const cycle=await autopilot.run(db,ctx);
    assert.equal(cycle.customerCheckins.queued,true);
    assert.equal((await worker()).result.drafted,1);
    assert.equal((await drafts(evaluated))[0].authority_kind,'TRAINED');
    const paused=await history('WatchCustomer');
    const waiting=await queue.enqueue(db,{workspaceId:ws,kind:checkins.KIND,idempotencyKey:randomUUID(),
      payload:{revision:1,slot:0,after:''}});
    assert(waiting.job.id);
    await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
    const held=await worker();
    assert.equal(held.result.state,'HELD');
    assert.match(held.result.reason,/watch-only/);
    assert.equal((await drafts(paused)).length,0);
    await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  });

  await t.test('Custom needs no example and queued work holds after downgrade',async()=>{
    const custom=await history('CustomCandidate');
    await f.subscribe('enterprise');
    await train(null,1);
    await f.subscribe('pro');
    const downgraded=await worker();
    assert.equal(downgraded.result.state,'HELD');
    assert.match(downgraded.result.reason,/taught rule|teach/i);
    assert.equal((await drafts(custom)).length,0);
    await f.subscribe('enterprise');
    await train(null,2);
    const accepted=await worker();
    assert.equal(accepted.status,'COMPLETED',JSON.stringify(accepted));
    assert((await drafts(custom)).some(d=>d.authority_kind==='CUSTOM'&&d.rule_revision===3));
    const initial=(await drafts(proCandidate))[0];
    await purchase(proCandidate,{age:0});
    await browser.get(route).query({draft:initial.id}).expect(200).expect(/activity or contact details changed/);
    assert.equal((await drafts(proCandidate))[0].evidence_hash,initial.evidence_hash);
    assert.equal(await effects(),0);
    await f.subscribe('growth');
    const stopped=await browser.get(route).expect(200);
    assert.match(stopped.text,/Stop routine drafting/);
    assert.doesNotMatch(stopped.text,/Authorize private drafting|Teach private drafting/);
    await checkins.configure(db,ctx,{revision:3,stop:'yes'});
    await browser.get(route).expect(402);
  });
});
