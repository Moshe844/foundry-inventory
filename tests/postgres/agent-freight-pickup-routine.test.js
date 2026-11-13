'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const freight=require('../../src/shipping/agent-freight-pickups');
const routine=require('../../src/shipping/agent-freight-routine');
const jobs=require('../../src/operations/postgres-job-queue');
const effects=require('../../src/operations/postgres-provider-effects');

// Job 66: Custom books repeat pallet pickups on its own within the owner's
// saved rule; every other plan is locked; anything that does not match stops
// and asks; pause, Watch only, Ask me first and the first 14 days hold it.
test('Custom books a repeat pallet pickup alone within its rule; other plans, held modes and mismatched facts never book',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{provider:'shipengine',units:40});
  const {db,ctx,browser,csrf}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await f.subscribe('enterprise');
  const autopilot=require('../../src/autopilot/postgres-service');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'connected_operations',1000,'Synthetic freight operation allowance')`,[randomUUID(),f.owner.accountId]);
  const connector=(await db.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='shipengine'",[ctx.workspaceId])).rows[0];
  const quote={price:124.90,currency:undefined};let writes=0,quotes=0,lastPickup=null;
  t.mock.method(require('../../src/shipping/providers/shipengine'),'call',async(account,path,options)=>{
    assert.equal(account.shipengineApiKey,'TEST_fixture');
    if(path==='/freight/provider_accounts')return {freight_provider_accounts:[{freight_provider_account_id:'se-101',freight_provider_code:'SYNTHETIC',nickname:'Synthetic freight'}]};
    if(path==='/freight/quotes'){
      quotes++;
      return {quotes:[{freight_provider_account_id:'se-101',offer_id:'offer-'+quotes,carrier_scac:'TEST',carrier_name:'Synthetic LTL',service_name:'Ground',
        total_charges:quote.price,...(quote.currency?{currency:quote.currency}:{}),quote_expiration_date:new Date(Date.now()+3600000).toISOString()}]};
    }
    assert.equal(path,'/freight/shipments');
    writes++;lastPickup=options.body.pickup_details;
    return {freight_shipment_id:'se-'+(900+writes),freight_provider_account_id:'se-101',status:'booked',bol_number:'BOL-'+writes,
      confirmation_number:'PICKUP-'+writes,documents:[]};
  });
  // Pallets measured at packing: 48 × 40 × 50 inches, 200 pounds.
  const pallets=[{weightGrams:90718,lengthMm:1219.2,widthMm:1016,heightMm:1270}];
  async function packed(boxes=pallets){
    const box=await f.parcel({boxes});
    await db.query("UPDATE sales_orders SET contact_phone='5185550100' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,box.order.salesOrderId]);
    return box;
  }
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const work=kind=>jobs.processOne(db,{[kind]:handlers[kind]},{owner:'synthetic-freight-worker'});
  const book=()=>work(freight.kind);
  let cycle=0;
  async function cycleRun(){
    const scheduled=await routine.schedule(db,ctx.workspaceId,'cycle-'+(++cycle));
    if(!scheduled.queued)return null;
    const job=await work(routine.KIND);
    assert.equal(job.status,'COMPLETED',JSON.stringify(job));
    return job.result;
  }
  const stored=async shipmentId=>(await db.query('SELECT * FROM stockchief_runtime.agent_freight_pickups WHERE workspace_id=$1 AND shipment_id=$2',[ctx.workspaceId,shipmentId])).rows[0]||null;
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(r=>/^freight-/.test(r.sourceId||''));

  // The first pickup on a lane is reviewed by a person, who saves the rule.
  const first=await packed();
  const form=await browser.get(freight.path+'?'+new URLSearchParams({shipment:first.shipmentId,connection:connector.id})).expect(200);
  assert.match(form.text,/up to 96 inches a side and 2,500 pounds/);
  const number=(await f.shipping.requireShipment(db,ctx.workspaceId,first.shipmentId)).shipment_number;
  assert.match((await browser.get(freight.path).expect(200)).text,new RegExp('>'+number+'</option>'),'packed shipments with no label are offered');
  assert.match(form.text,/name="palletLength" value="48"/,'the measured packages start the pallet rows');
  assert.match(form.text,/name="commodityWeight" inputmode="decimal" value="200"/);
  const exact=(await freight.page(db,ctx,{shipmentId:first.shipmentId,connectorId:connector.id})).exact;
  const facts={accountId:'se-101',fromType:'commercial',toType:'commercial',pickupDate:new Date(Date.now()+86400000*3).toISOString().slice(0,10),
    readyTime:'08:00',closeTime:'16:00',confirmed:'yes',nonHazardous:'yes',connectorId:connector.id,
    pallets:[{quantity:'1',length:'48',width:'40',height:'50',stackable:false,commodities:[{description:'Packed goods',quantity:'10',weight:'200',freightClass:'125'}]}]};
  const reviewed=await freight.prepare(db,ctx,{...facts,shipmentId:first.shipmentId,sourceFingerprint:exact.fingerprint});
  const template=await stored(first.shipmentId);
  assert.equal((await needs()).filter(r=>r.sourceId==='freight-pickup:'+reviewed.id).length,1,'reviewed quotes wait in Needs you');
  await freight.saveRule(db,ctx,reviewed.id,{revision:template.revision,offerId:template.offers[0].id,confirmed:'yes',maximum:'130.00',ruleRevision:0});
  await freight.book(db,ctx,reviewed.id,{revision:template.revision,offerId:template.offers[0].id,confirmed:'yes'});
  await book();
  assert.equal(writes,1);
  assert.equal((await needs()).length,0);

  // Every plan but Custom is locked out of the routine and its Needs you items.
  for(const tier of ['starter','growth','pro']){
    await f.subscribe(tier);
    assert.equal((await routine.schedule(db,ctx.workspaceId,'locked-'+tier)).queued,false);
    assert.equal((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,'plan');
    assert.deepEqual(await routine.inbox(db,ctx.workspaceId),[]);
  }
  await f.subscribe('enterprise');

  // Custom: the same customer, warehouse and pallets are booked alone, once.
  const repeat=await packed();
  const before=quotes;
  const result=await cycleRun();
  assert.equal(result.queued,1,JSON.stringify([result,(await db.query('SELECT reason FROM stockchief_runtime.agent_freight_holds WHERE workspace_id=$1',[ctx.workspaceId])).rows]));
  const saved=await stored(repeat.shipmentId);
  assert.equal(saved.rule_revision,1);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const next=new Date(today+'T12:00:00Z');do next.setUTCDate(next.getUTCDate()+1);while([0,6].includes(next.getUTCDay()));
  assert.equal(saved.facts.pickup.pickup_date,next.toISOString().slice(0,10),'pickup is the next business day');
  assert.equal(saved.facts.pickup.ready_time,'08:00');
  assert.deepEqual(saved.facts.handling,template.facts.handling);
  await book();
  assert.equal(writes,2);
  assert.equal(lastPickup.pickup_date,next.toISOString().slice(0,10));
  assert.equal((await effects.get(db,ctx.workspaceId,saved.effect_id)).status,'SUCCEEDED');
  assert.equal(await cycleRun(),null,'a replayed cycle finds nothing left to book');
  assert.equal(quotes,before+1);
  const audits=(await db.query("SELECT action FROM security_event_history WHERE workspace_id=$1 AND reference=$2 ",[ctx.workspaceId,saved.id])).rows.map(r=>r.action).sort();
  assert.deepEqual(audits,['Freight pickup queued under saved authority','Freight quotes requested on its own']);
  const log=JSON.stringify((await require('../../src/autopilot/agent-activity').report(db,ctx)).rows);
  assert.match(log,/Booked a freight pickup under your rule/);

  // Over the rule's maximum: the quote waits for the owner in Needs you.
  quote.price=180;
  const dearer=await packed();
  assert.equal((await cycleRun()).quoted,1);
  const waiting=await stored(dearer.shipmentId);
  assert.equal(waiting.effect_id,null);
  assert.match((await needs()).find(r=>r.sourceId==='freight-pickup:'+waiting.id).happened,/\$180\.00/);
  quote.price=124.90;

  // A quote in another currency stops and asks; it is never converted.
  quote.currency='CAD';
  const foreign=await packed();
  assert.equal((await cycleRun()).held,1);
  assert.equal(await stored(foreign.shipmentId),null);
  const held=(await needs()).find(r=>r.sourceId==='freight-hold:'+foreign.shipmentId);
  assert.match(held.happened,/quoted in CAD/);
  assert.equal(await cycleRun(),null,'a held shipment is not asked again until it changes or a day passes');
  quote.currency=undefined;

  // Different pallets are not the authorized profile: nothing happens.
  const other=await packed([{weightGrams:181437,lengthMm:1219.2,widthMm:1016,heightMm:1270}]);
  const quiet=await cycleRun();
  assert.equal(quiet?.checked||0,0);
  assert.equal(await stored(other.shipmentId),null);

  // Ask me first gets the quotes for the owner; Watch only, pause and the
  // first 14 days do nothing at all.
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,66,{mode:'ask',revision:0});
  const asked=await packed();
  const askedRun=await cycleRun();
  assert.equal(askedRun.quoted,1,JSON.stringify(askedRun));
  assert.equal((await stored(asked.shipmentId)).effect_id,null);
  await modes.save(db,ctx,66,{mode:'watch',revision:1});
  const watched=await packed(),quoted=quotes;
  assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/Watch only/);
  await modes.save(db,ctx,66,{mode:'inherit',revision:2});
  await autopilot.pause(db,ctx,{role:'owner'},'Freight check');
  assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal(quotes,quoted);
  assert.equal(await stored(watched.shipmentId),null);
  assert.equal(writes,2);

  // Oversized freight: a person must confirm the carrier takes it, and it is
  // never authorized for routine booking. Hazardous freight is refused.
  const big=await packed();
  const bigExact=(await freight.page(db,ctx,{shipmentId:big.shipmentId,connectorId:connector.id})).exact;
  const oversized={...facts,shipmentId:big.shipmentId,sourceFingerprint:bigExact.fingerprint,pallets:[{...facts.pallets[0],length:'100'}]};
  await assert.rejects(freight.prepare(db,ctx,oversized),/over the standard LTL limit of 96 inches/);
  await assert.rejects(freight.prepare(db,ctx,{...oversized,nonHazardous:''}),/Hazardous freight always needs a person/);
  const confirmed=await freight.prepare(db,ctx,{...oversized,oversizeConfirmed:'yes',useRoutine:'yes'});
  assert.equal(confirmed.queued,undefined,'oversized freight is never booked under a rule');
  const bigRow=await stored(big.shipmentId);
  assert.equal(bigRow.facts.oversize,true);
  await assert.rejects(freight.saveRule(db,ctx,confirmed.id,{revision:bigRow.revision,offerId:bigRow.offers[0].id,confirmed:'yes',maximum:'500',ruleRevision:0}),/Oversized freight/);
  await assert.rejects(freight.book(db,ctx,confirmed.id,{revision:bigRow.revision,offerId:bigRow.offers[0].id,useRoutine:'yes'}),/Approve this exact quote/);
  const page=await browser.get(freight.path+'/'+confirmed.id).expect(200);
  assert.match(page.text,/Oversized freight is booked one pickup at a time/);
  assert.equal(writes,2);

  // The quote form and a saved oversized pickup at phone and desktop width.
  await require('../helpers/page-widths').widths(f,[[freight.path+'?'+new URLSearchParams({shipment:watched.shipmentId,connection:connector.id}),'freight-pickup-form'],
    [freight.path+'/'+confirmed.id,'freight-pickup-oversized']],async(view,path)=>{
    assert.match(await view.locator('main').innerText(),path.includes('?')?/Standard LTL pallets are up to 96 inches/:/Oversized freight is booked one pickup at a time/);});
});
