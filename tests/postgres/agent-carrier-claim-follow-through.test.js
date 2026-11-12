'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 63 on every plan: a claim is prepared from the carrier's own "lost"
// scan (job 62) or a staff or customer report, with the shipment, its value
// and the evidence; EasyPost-insured labels are filed through a test EasyPost
// account, other carriers get a claim pack and steps, and every claim is
// followed to payment or denial. Pro drafts until taught; Custom files alone
// within the owner's limit; Starter and Growth do not include it.
const photo=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000','hex');
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{provider:'easypost',units:40}),{db,ctx,shipping}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'connected_operations',1000,'Synthetic claim provider operations')`,
    [randomUUID(),f.owner.accountId]);
  const insured=new Map(),remote=new Map(),state={writes:0,labels:0};
  t.mock.method(require('../../src/shipping/providers/easypost'),'call',async(_context,path,options={})=>{
    if(path==='/insurances?page_size=100')return {insurances:[...insured.values()]};
    if(path.startsWith('/insurances/'))return [...insured.values()].find(i=>i.id===path.split('/').at(-1));
    if(path.startsWith('/claims/'))return remote.get(path.split('/').at(-1));
    assert.equal(path,'/claims');assert.equal(options.method,'POST');state.writes++;
    const body=options.body,cover=[...insured.values()].find(i=>i.tracking_code===body.tracking_code);
    assert.ok(body.invoice_attachments?.[0]&&body.email_evidence_attachments?.[0],'the claim carries its evidence');
    const saved={id:'clm_claim'+state.writes,object:'Claim',mode:'test',reference:body.reference,insurance_id:cover.id,shipment_id:cover.shipment_id,
      tracking_code:body.tracking_code,type:body.type,status:'submitted',requested_amount:body.amount};
    remote.set(body.reference,saved);return saved;
  });
  const label={quote:async()=>({rates:[{rateId:'g',carrier:'usps',service:'Ground Advantage',amountMinor:300,currency:'USD'}]}),
    buy:async()=>{state.labels++;return {providerShipmentIds:['shp_parcel'+state.labels],trackingNumber:'EZ'+state.labels,carrier:'usps',service:'Ground Advantage',
      labelUrl:'https://labels.example.test/'+state.labels+'.pdf',amountMinor:300,currency:'USD'};}};
  // A parcel handed to the carrier: an insured EasyPost label, or a UPS number typed at handoff.
  async function sent({quantity=1,manual=false,cover='100.00000'}={}){
    const p=await f.parcel({quantity});await shipping.markPacked(db,ctx,p.shipmentId);
    if(manual)await shipping.handoff(db,ctx,p.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z999AA1'+String(20000000+state.labels++)});
    else{const rate=(await shipping.quote(db,ctx,p.shipmentId,{provider:label})).rates[0];
      await shipping.buyLabel(db,ctx,p.shipmentId,rate.id,{idempotencyKey:'label-'+p.shipmentId},{provider:label});
      await shipping.handoff(db,ctx,p.shipmentId,{handover:'CARRIER'});}
    const s=await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId);
    if(!manual&&cover){const externalId=s.provider_packages[0].externalId;
      insured.set(externalId,{id:'ins_'+externalId.slice(4),object:'Insurance',mode:'test',tracking_code:s.tracking_number,shipment_id:externalId,status:'purchased',amount:cover});}
    return {...p,id:p.shipmentId,orderId:p.order.salesOrderId,tracking:s.tracking_number};
  }
  const lose=p=>shipping.applyTracking(db,ctx,p.id,{status:'FAILURE',detail:'Package lost in transit',externalEventId:'lost-'+p.id,occurredAt:new Date().toISOString()});
  const watch=require('../../src/shipping/agent-parcel-watch'),claims=require('../../src/shipping/agent-carrier-claims');
  const routine=()=>watch.run(db,{workspaceId:ctx.workspaceId,id:randomUUID()},{providerResolver:()=>({track:async()=>null})});
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const work=()=>jobs.processOne(db,{'agent.shipping.carrier-claim.v1':handlers['agent.shipping.carrier-claim.v1']},{owner:'claim-worker'});
  const claimOf=async p=>(await db.query(`SELECT c.*,e.status effect_status FROM stockchief_runtime.agent_carrier_claims c LEFT JOIN stockchief_runtime.provider_effects e
    ON e.workspace_id=c.workspace_id AND e.id=c.effect_id WHERE c.workspace_id=$1 AND c.shipment_id=$2`,[ctx.workspaceId,p.id])).rows[0];
  const details=(input={})=>claims.saveSettings(db,ctx,{claimant:'Synthetic Retailer',contactEmail:'claims@example.test',...input});
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('carrier-claim:'));
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);
  const auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  return {f,db,ctx,insured,remote,state,sent,lose,watch,claims,routine,work,claimOf,details,needs,audits,auto,modes};
}

test('lost parcels: Pro drafts until taught, Custom files alone within the owner limit, and every claim is followed to payment or denial',{timeout:600000},async t=>{
  const {f,db,ctx,remote,state,sent,lose,claims,routine,work,claimOf,details,needs,audits,auto,modes}=await setup(t);
  // Starter and Growth do not include carrier claims.
  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    await assert.rejects(details(),e=>e.code==='entitlement_required');
    assert.match((await f.browser.get(claims.path).expect(200)).text,/filing requires Pro or Custom/);
  }
  const growthLost=await sent();await lose(growthLost);await routine();
  assert.equal(await claimOf(growthLost),undefined,'Growth flags the loss but prepares no claim');

  await f.subscribe('pro');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // Without claim details StockChief cannot claim; it waits and asks.
  const first=await sent();await lose(first);await routine();assert.equal(await claimOf(first),undefined);
  await details();
  await routine();let claim=await claimOf(first);
  assert.deepEqual([claim.route,claim.source,claim.effect_id,claim.facts.amountMinor],['api','carrier',null,1200]);
  assert.equal(claim.facts.insuranceId,'ins_parcel2');assert.equal(state.writes,0,'Pro drafts until taught');
  assert.equal((await claimOf(growthLost))?.route,'api','the Growth-era loss is claimed once Pro allows it');
  assert.ok((await needs()).some(n=>n.sourceId==='carrier-claim:'+claim.id&&n.actionLabel==='File the claim'));
  await claims.approve(db,ctx,claim.id,{confirmed:'yes'});await work();
  claim=await claimOf(first);assert.equal(claim.effect_status,'SUCCEEDED');assert.equal(claim.receipt.status,'submitted');assert.equal(state.writes,1);
  await assert.rejects(claims.saveRule(db,ctx,claim.id,{revision:0,maximum:'50.00',confirmed:'yes'}),/individually/,'Pro is taught only up to what it was shown');
  await claims.saveRule(db,ctx,claim.id,{revision:0,maximum:'12.00',confirmed:'yes'});
  // Taught: the next loss in the same scope is filed on its own, once.
  const second=await sent();await lose(second);await routine();await routine();
  claim=await claimOf(second);assert.equal(claim.automatic,true);await work();assert.equal(state.writes,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_carrier_claims WHERE shipment_id=$1',[second.id])).rows[0].n,1);
  // Over the taught maximum it waits for a person.
  const big=await sent({quantity:5});await lose(big);await routine();
  claim=await claimOf(big);assert.equal(claim.facts.amountMinor,6000);assert.equal(claim.effect_id,null);await work();assert.equal(state.writes,2);

  // Following up: the carrier pays one and denies another; checking again changes nothing.
  const one=await claimOf(first),two=await claimOf(second);
  remote.set(one.facts.reference,{...remote.get(one.facts.reference),status:'approved',approved_amount:'12.00'});
  remote.set(two.facts.reference,{...remote.get(two.facts.reference),status:'rejected',status_detail:'No proof of value'});
  assert.equal((await claims.followUp(db,{workspaceId:ctx.workspaceId})).decided,2);
  assert.deepEqual([(await claimOf(first)).outcome,Number((await claimOf(first)).paid_minor)],['PAID',1200]);
  assert.deepEqual([(await claimOf(second)).outcome,(await claimOf(second)).outcome_note],['DENIED','No proof of value']);
  assert.equal((await claims.followUp(db,{workspaceId:ctx.workspaceId})).checked,0);
  assert.equal(await audits('Carrier claim paid'),1);assert.equal(await audits('Carrier claim denied'),1);
  assert.match((await f.browser.get(claims.path+'/'+one.id).expect(200)).text,/Paid[\s\S]*\$12\.00/);

  // Custom files alone within the owner's own limit, and asks above it.
  await f.subscribe('enterprise');await details({autoLimit:'90.00'});
  const custom=await sent({quantity:7});await lose(custom);await routine();
  claim=await claimOf(custom);assert.deepEqual([claim.automatic,claim.rule_revision,claim.facts.amountMinor],[true,null,8400]);await work();assert.equal(state.writes,3);
  const over=await sent({quantity:8});await lose(over);await routine();assert.equal((await claimOf(over)).effect_id,null);
  // Ask me first drafts; the first 14 days only flag; pause stops the watch.
  await modes.save(db,ctx,63,{mode:'ask',revision:0});
  const ask=await sent();await lose(ask);await routine();assert.equal((await claimOf(ask)).effect_id,null);
  await modes.save(db,ctx,63,{mode:'inherit',revision:1});
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const shadow=await sent();await lose(shadow);await routine();assert.equal(await claimOf(shadow),undefined);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await auto.pause(db,ctx,{role:'owner'},'Claims review');
  const paused=await sent();await lose(paused);assert.deepEqual(await routine(),{skipped:'paused'});
  const reported=await claims.report(db,ctx,paused.id,{type:'loss',reportedBy:'staff',description:'Never arrived at the depot.',confirmed:'yes'});
  assert.equal((await claimOf(paused)).effect_id,null,'a paused inventory files nothing on its own');assert.equal(reported.automatic,false);
  await auto.resume(db,ctx,{role:'owner'});await work();assert.equal(state.writes,3);
  assert.equal(await f.balance(),40-26,'claims never move stock');
});

test('staff and customer reports: damage needs a photo, other carriers get a claim pack and steps, and a person records the answer',{timeout:600000},async t=>{
  const {f,db,ctx,state,sent,claims,claimOf,details,needs,audits}=await setup(t);
  await f.subscribe('starter');const lockedParcel=await sent({manual:true});
  await assert.rejects(claims.report(db,ctx,lockedParcel.id,{type:'loss',reportedBy:'staff',description:'Lost',confirmed:'yes'}),e=>e.code==='entitlement_required');
  assert.match((await f.browser.get('/fulfilment/'+lockedParcel.id).expect(200)).text,/Carrier claims · Pro/);
  await f.subscribe('pro');
  const ups=await sent({manual:true});
  await assert.rejects(claims.report(db,ctx,ups.id,{type:'damage',reportedBy:'customer',description:'Crushed box',confirmed:'yes'},[{field:'photo',buffer:photo}]),/Add the business/);
  await details();
  await assert.rejects(claims.report(db,ctx,ups.id,{type:'damage',reportedBy:'customer',description:'Crushed box',confirmed:'yes'}),/photo of the damage/);
  const page=await f.browser.get('/fulfilment/'+ups.id).expect(200);assert.match(page.text,/id="claim-report"/);
  await f.browser.post('/fulfilment/'+ups.id+'/claim-report').field('_csrf',f.csrf(page.text)).field('type','damage').field('reportedBy','customer')
    .field('description','The customer sent a photo of a crushed box.').field('confirmed','yes').attach('photo',photo,'box.png').expect(303);
  let claim=await claimOf(ups);
  assert.deepEqual([claim.route,claim.source,claim.facts.carrier,claim.facts.amountMinor],['portal','customer','ups',1200]);
  assert.match(claim.facts.claimPage,/ups\.com/);assert.deepEqual(claim.supporting,photo);
  assert.ok(claim.invoice.subarray(0,5).equals(Buffer.from('%PDF-')),'the pack carries the value of the parcel');
  assert.ok(claim.correspondence.subarray(0,5).equals(Buffer.from('%PDF-')),'and the tracking record with the report');
  assert.equal((await claims.report(db,ctx,ups.id,{type:'damage',reportedBy:'staff',description:'Again',confirmed:'yes'},[{field:'photo',buffer:photo}])).replayed,true);
  assert.ok((await needs()).some(n=>n.sourceId==='carrier-claim:'+claim.id&&/File the carrier claim/.test(n.title)&&n.actionLabel==='Open the claim'));
  await assert.rejects(claims.approve(db,ctx,claim.id,{confirmed:'yes'}),/claim page/);
  let view=await f.browser.get(claims.path+'/'+claim.id).expect(200);
  assert.match(view.text,/File it with UPS/);assert.match(view.text,/ups\.com/);assert.match(view.text,/Download the invoice/);
  assert.equal((await f.browser.get(claims.path+'/'+claim.id+'/evidence/supporting').expect(200)).body.length,photo.length);
  await f.browser.post(claims.path+'/'+claim.id+'/filed').type('form').send({_csrf:f.csrf(view.text),reference:'UPS-CLM-1',confirmed:'yes'}).expect(303);
  assert.equal((await claims.recordFiled(db,ctx,claim.id,{reference:'UPS-CLM-1',confirmed:'yes'})).replayed,true);
  view=await f.browser.get(claims.path+'/'+claim.id).expect(200);assert.match(view.text,/UPS-CLM-1/);assert.match(view.text,/The carrier’s answer/);
  await f.browser.post(claims.path+'/'+claim.id+'/outcome').type('form').send({_csrf:f.csrf(view.text),outcome:'paid',amount:'12.00'}).expect(303);
  claim=await claimOf(ups);assert.deepEqual([claim.outcome,Number(claim.paid_minor)],['PAID',1200]);
  assert.equal(await audits('Carrier claim filed on the carrier’s page'),1);assert.equal(await audits('Carrier claim paid'),1);
  assert.equal((await needs()).filter(n=>n.sourceId==='carrier-claim:'+claim.id).length,0);
  // A staff loss report on an insured EasyPost label goes through the claim API.
  const insuredParcel=await sent();
  const opened=await claims.report(db,ctx,insuredParcel.id,{type:'loss',reportedBy:'staff',description:'Scanned out, never arrived.',confirmed:'yes'});
  assert.equal(opened.route,'api');assert.equal((await claimOf(insuredParcel)).source,'staff');assert.equal(state.writes,0);
  // A missing price stops and asks rather than guessing the value.
  const unpriced=await sent({manual:true});
  await db.query('UPDATE sales_order_lines SET unit_price_minor=NULL WHERE sales_order_id=$1',[unpriced.orderId]);
  await assert.rejects(claims.report(db,ctx,unpriced.id,{type:'loss',reportedBy:'staff',description:'Lost',confirmed:'yes'}),/price is missing/);
});

test('the claim and the parcel report read well on a desktop and on a 390 px phone',{timeout:300000},async t=>{
  const {f,db,sent,claims,claimOf,details}=await setup(t);
  await f.subscribe('pro');await details();
  const reportable=await sent({manual:true}),filed=await sent({manual:true});
  await claims.report(db,f.ctx,filed.id,{type:'damage',reportedBy:'staff',description:'Corner crushed.',confirmed:'yes'},[{field:'photo',buffer:photo}]);
  const claim=await claimOf(filed);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const width of [1280,390]){
    const tab=await chrome.newPage({viewport:{width,height:900}});tab.setDefaultTimeout(15000);
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(origin+'/fulfilment/'+reportable.id);
    assert.match(await tab.locator('#claim-report').innerText(),/Report a lost or damaged parcel/);
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll on the shipment at '+width);
    await tab.goto(origin+claims.path+'/'+claim.id);
    assert.match(await tab.locator('#claim').innerText(),/File it with UPS/);
    assert.equal(await tab.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll on the claim at '+width);
    await tab.close();
  }
});
