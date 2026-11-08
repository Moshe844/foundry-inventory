'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const assistant=require('../../src/assistant/postgres-service');
test('unusual automatic spending or volume pauses the inventory until an owner reviews it',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,workflows,browser,subscribe}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '60 days')::text WHERE id=$1",[f.owner.accountId]);
  const auto=require('../../src/autopilot/postgres-service'),guard=require('../../src/autopilot/circuit-breaker');
  const time=require('../../src/lib/business-time'),today=await time.today(db,ctx.workspaceId);
  const stamp=days=>days?require('../../src/accounting/customer-money').addDays(today,-days)+'T13:00:00Z':new Date().toISOString();
  const path='/autopilot/reviews/unusual-automatic-activity';
  await subscribe('growth');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  async function commitment(days,unitCost,approval='NONE',currency='USD'){
    const id=randomUUID(),at=stamp(days);
    const {purchaseOrderId}=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,currency,
      idempotencyKey:id,lines:[{skuId:f.item.skuIds[0],quantityUnits:1,unitCost}]});
    await workflows.approvePurchaseOrder(db,ctx,purchaseOrderId,{idempotencyKey:randomUUID()});
    await db.query(`INSERT INTO work_items(id,workspace_id,category,source,idempotency_key,approval_requirement,
      execution_status,purchase_order_id,approved_at,created_at) VALUES($1,$2,'replenishment_plan','postgres_autopilot',$1,$3,'COMPLETED',$4,$5,$5)`,
      [id,ctx.workspaceId,approval,purchaseOrderId,at]);
  }
  for(const d of [4,3,2,1])await commitment(d,10);
  await commitment(0,500,'REQUIRED');await commitment(0,250,'NONE','EUR');
  assert.deepEqual(await guard.observations(db,ctx.workspaceId),[]);
  await commitment(0,25);
  const refresh=()=>db.transaction(c=>guard.refresh(c,ctx.workspaceId));
  await subscribe('starter');await browser.get(path).expect(402);await refresh();assert.equal((await auto.getState(db,ctx.workspaceId)).paused,false);
  await subscribe('growth');await browser.get(path).expect(200);
  const run=()=>db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate({workspaceId:ctx.workspaceId,id:randomUUID(),payload:{actorId:ctx.actorId}},c));
  await run();assert.match((await auto.getState(db,ctx.workspaceId)).pausedReason,/\$25\.00/);
  await refresh();assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Paused unusual automatic activity'",[ctx.workspaceId])).rows[0].n,1);
  await assert.rejects(require('../../src/shipping/agent-postage').assertPurchase(db,ctx.workspaceId,'automatic',{amount_minor:100,currency:'USD'}),/paused/);
  const account=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Team member',businessName:'Separate inventory',email:randomUUID()+'@example.test',password:f.password});
  const staff={workspaceId:ctx.workspaceId,actorId:randomUUID()};await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Team member','staff',now()::text)",[staff.actorId,ctx.workspaceId,account.accountId]);
  await assert.rejects(auto.resume(db,staff,{role:'owner'}),/owner/);
  await auto.resume(db,ctx,{role:'owner'});await refresh();assert.equal((await auto.getState(db,ctx.workspaceId)).paused,false);
  await subscribe('pro');for(let i=0;i<3;i++)await commitment(0,1);
  await refresh();assert.match((await auto.getState(db,ctx.workspaceId)).pausedReason,/3 automatic actions/);
  await subscribe('enterprise');assert.match((await browser.get(path).expect(200)).text,/Actions/);
});
test('the carrier sees only eligible purchases after current-plan, per-label and delivery address checks',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:30}),{db,ctx,shipping,subscribe}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
  const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
  let buys=0;
  async function proposal(tier,amount,currency='USD'){
    await subscribe(tier);
    const p=await f.parcel();
    const provider={quote:async()=>({providerShipmentIds:['carrier'],rates:[{rateId:'rate',carrier:'usps',service:'Ground',amountMinor:amount,currency}]}),
      buy:async()=>{buys++;return {providerLabelIds:['label-'+buys],providerShipmentId:'label',trackingNumber:'P'+buys,labelUrl:'https://labels.example.test/label.pdf',labelFormat:'PDF',amountMinor:amount,currency};}};
    const rate=(await shipping.quote(db,ctx,p.shipmentId,{provider})).rates[0];
    const action=await assistant.prepareAction(db,ctx,'Buy this quoted shipment label',{action:'shipping.label',recordReference:p.shipmentId,rate:rate.id});
    await plans.save(db,ctx,'Buy the selected label and review deliveries',randomUUID(),
      [{contract:registry.get('shipping.label'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'overdue-work'},dependsOn:[0]}],
      [{result:action},{result:{status:'CLARIFY'}}]);
    return {proposalId:action.proposal.id,provider,shipmentId:p.shipmentId};
  }
  async function spend(p,automatic=true){
    const result=automatic?await assistant.executeMission(db,ctx,p.proposalId):await assistant.executeProposal(db,ctx,p.proposalId);
    return ()=>shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,result.result.effectId,{provider:p.provider});
  }
  const starter=await proposal('starter',500);await assert.rejects(spend(starter),e=>e.code==='entitlement_required');
  await (await spend(starter,false))();assert.equal(buys,1);
  const limit=await proposal('growth',2500);await (await spend(limit))();assert.equal(buys,2);
  const above=await proposal('growth',2501);await assert.rejects(spend(above),/\$25/);assert.equal(buys,2);
  await (await spend(above,false))();assert.equal(buys,3);
  await assert.rejects(require('../../src/shipping/agent-postage').assertPurchase(db,ctx.workspaceId,'automatic',{amount_minor:100,currency:'EUR'}),/USD/);
  for(const tier of ['pro','enterprise']){
    const eligible=await proposal(tier,2501);
    await (await spend(eligible))();
  }
  const later=await proposal('pro',3000),run=await spend(later);
  const before=buys;await subscribe('growth');await assert.rejects(run(),/\$25/);assert.equal(buys,before);
  for(const tier of ['starter','growth','pro','enterprise']){
    const moved=await proposal(tier,300),attempt=await spend(moved,false);
    await db.query("UPDATE sales_shipments SET ship_to_address='Missing postal details' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,moved.shipmentId]);
    await assert.rejects(attempt(),/address/);assert.equal(buys,before);
  }
  const {combine}=require('../../src/shipping/parcel-rates');
  const bundle=costs=>combine(costs.map((amountMinor,i)=>({providerShipmentIds:['p'+i],rates:[{rateId:'r'+i,carrier:'UPS',service:'ground',currency:'USD',amountMinor}]}))).rates[0];
  await subscribe('growth');
  const check=async parts=>{const rate=bundle(parts);return require('../../src/shipping/agent-postage').assertPurchase(db,ctx.workspaceId,'automatic',
    {currency:'USD',amount_minor:rate.amountMinor,provider_rate_id:rate.rateIds.join(','),package_amounts_minor:rate.packageAmountsMinor});};
  await check([2300,2500]);await assert.rejects(check([2000,2600]),/\$25/);
  const settings=require('../../src/autopilot/job-modes');
  const queued=await proposal('growth',1500),worker=await spend(queued),priorBuys=buys;
  const modesPage=await f.browser.get('/autopilot/job-modes').expect(200);
  await f.browser.post('/autopilot/job-modes/59').type('form').send({_csrf:f.csrf(modesPage.text),mode:'ask',revision:0}).expect(303);
  await assert.rejects(worker(),/Ask me first/);assert.equal(buys,priorBuys);
  await assert.rejects(settings.save(db,ctx,59,{mode:'routine',revision:0}),/has changed/);
  await assert.rejects(settings.save(db,{...ctx,actorId:'other-user'},59,{mode:'routine',revision:1}),/Only the business owner/);
  const manual=await proposal('growth',1500);await(await spend(manual,false))();assert.equal(buys,priorBuys+1);
  await settings.save(db,ctx,59,{mode:'watch',revision:1});
  const watched=await proposal('growth',1500);await assert.rejects(spend(watched,false),/Watch only/);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);const offers=await settings.page(db,ctx);
    assert.equal(offers.find(j=>j.id===59).allowed.includes('routine'),tier!=='starter');
    assert.equal(offers.find(j=>j.id===6).allowed.length>0,['pro','enterprise'].includes(tier));
    assert.equal(offers.find(j=>j.id===77).allowed.includes('routine'),false);
  }
  await subscribe('starter');
  await assert.rejects(settings.save(db,ctx,59,{mode:'routine',revision:2}),/cannot run at that level/);
  await settings.save(db,ctx,59,{mode:'inherit',revision:2});
  const timely=await f.parcel(),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const days=n=>require('../../src/accounting/customer-money').addDays(today,n);
  await db.query('UPDATE sales_orders SET needed_by=$2 WHERE id=$1',[timely.order.salesOrderId,days(4)]);
  const rates=[['late',100,5],['timely',200,4],['fast',500,1],['undated',50,null]].map(([service,amountMinor,delay])=>
    ({service,amountMinor,deliveryDate:delay==null?null:days(delay),rateId:service,carrier:'UPS',currency:'USD'}));
  await shipping.quote(db,ctx,timely.shipmentId,{provider:{quote:async()=>({providerShipmentIds:['promise'],rates})}});
  const report=()=>require('../../src/autopilot/job-reviews').run(db,ctx,'timely-shipping-rates',{filter:timely.order.orderNumber});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);const result=await report();
    if(tier==='starter')assert.match(result.rows[0].Suggestion,/UPS timely at \$2.00/);
    else{assert.equal(result.rows[0].Service,'UPS timely');assert.equal(result.rows[0].Price,'$2.00');}
  }
  await db.query("UPDATE shipment_rates SET quoted_at=(now()-interval '31 minutes')::text WHERE shipment_id=$1",[timely.shipmentId]);
  assert.match((await report()).rows[0].Status,/No eligible dated quote/);
});
