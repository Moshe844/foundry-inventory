'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const assistant=require('../../src/assistant/postgres-service');
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
