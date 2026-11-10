'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const claims=require('../../src/shipping/agent-carrier-claims');
const effects=require('../../src/operations/postgres-provider-effects');
const jobs=require('../../src/operations/postgres-job-queue');
const jobKind='agent.shipping.carrier-claim.v1';
const original=Buffer.from('%PDF-1.7\nOriginal synthetic claim evidence');
const files=['invoice','correspondence','supporting'].map(field=>({field,buffer:original}));

test('claims keep exact physical and provider evidence, enforce four plans, and never repeat an uncertain filing',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,shipping,browser,csrf}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await f.subscribe('pro');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'connected_operations',1000,'Synthetic claim provider operations')`,[randomUUID(),f.owner.accountId]);
  const account=(await db.query("UPDATE workspace_connectors SET provider_type='easypost' WHERE workspace_id=$1 AND provider_type='shippo' RETURNING id",[ctx.workspaceId])).rows[0];
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,account.id,'provider',{apiKey:'EZTK_synthetic'}));
  const remote=new Map(),coverages=new Map();
  let writes=0,reads=0,loseReceipt=false;
  t.mock.method(require('../../src/shipping/providers/easypost'),'call',async(context,path,options)=>{
    assert.equal(context.easypostApiKey,'EZTK_synthetic');
    if(path.startsWith('/insurances/')){
      reads++;
      return coverages.get(path.split('/').at(-1));
    }
    if(path.startsWith('/claims/'))return remote.get(path.split('/').at(-1));
    assert.equal(path,'/claims');
    assert.equal(options.method,'POST');
    writes++;
    const request=options.body,insured=[...coverages.values()].find(x=>x.tracking_code===request.tracking_code);
    assert(insured);
    assert.deepEqual(request.invoice_attachments,[original.toString('base64')]);
    assert.deepEqual(request.email_evidence_attachments,[original.toString('base64')]);
    if(request.type==='damage')assert.deepEqual(request.supporting_documentation_attachments,[original.toString('base64')]);
    const receipt={id:'clm_claim'+writes,object:'Claim',mode:'test',reference:request.reference,insurance_id:insured.id,
      shipment_id:insured.shipment_id,tracking_code:request.tracking_code,type:request.type,status:'submitted',requested_amount:request.amount};
    remote.set(request.reference,receipt);
    if(loseReceipt)throw Object.assign(new Error('The provider response was lost.'),{providerOutcomeUncertain:true});
    return receipt;
  });

  async function sentParcel(number,type='damage'){
    const s=await f.parcel();
    const trackingNumber='SYNTHETIC'+number,externalId='shp_parcel'+number,insuranceId='ins_parcel'+number;
    const label={async quote(){return {rates:[{rateId:'rate'+number,carrier:'usps',service:'Ground',amountMinor:250,currency:'USD'}]};},
      async buy(){return {providerShipmentIds:[externalId],trackingNumber,carrier:'usps',service:'Ground',
        labelUrl:'https://example.test/label.pdf',amountMinor:250,currency:'USD'};}};
    const quote=await shipping.quote(db,ctx,s.shipmentId,{provider:label});
    assert(quote.rates.length);
    await shipping.buyLabel(db,ctx,s.shipmentId,quote.rates[0].id,{idempotencyKey:'label'+number},{provider:label});
    await shipping.handoff(db,ctx,s.shipmentId,{idempotencyKey:'hand-off'+number});
    coverages.set(insuranceId,{id:insuranceId,object:'Insurance',mode:'test',tracking_code:trackingNumber,
      shipment_id:externalId,status:'purchased',amount:'100.00000'});
    return {shipmentId:s.shipmentId,trackingNumber,insuranceId,type,description:'Owner confirmed exact parcel damage.',
      recipient:'Synthetic Retailer',contactEmail:'retailer@example.test',amount:'25.05',confirmed:'yes',useRoutine:'yes'};
  }
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const process=()=>jobs.processOne(db,{[jobKind]:handlers[jobKind]},{owner:'synthetic-carrier-claims'});
  async function saved(id){return (await db.query('SELECT * FROM stockchief_runtime.agent_carrier_claims WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];}
  async function effect(id){return effects.get(db,ctx.workspaceId,(await saved(id)).effect_id);}
  const first=await sentParcel(1);
  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    const locked=await browser.get(claims.path).expect(200);
    assert.match(locked.text,/filing requires Pro or Custom/);
    assert.doesNotMatch(locked.text,/name="insuranceId"/);
    await assert.rejects(claims.prepare(db,ctx,first,files),e=>e.code==='entitlement_required'&&/Pro/.test(e.message));
    await assert.rejects(claims.approve(db,ctx,'unknown',{confirmed:'yes'}),e=>e.code==='entitlement_required');
  }
  assert.equal(reads,0);
  await f.subscribe('pro');
  await assert.rejects(claims.prepare(db,ctx,{...first,insuranceId:'ins_wrong'},files),/exact parcel/);
  await assert.rejects(claims.prepare(db,ctx,{...first,amount:'100.01'},files),/exceeds the verified/);
  await assert.rejects(claims.prepare(db,ctx,first,files.slice(0,2)),/Damage claims/);
  const form=await browser.get(claims.path+'?parcel='+first.trackingNumber).expect(200);
  assert.match(form.text,/SYNTHETIC1/);
  const draft=await browser.post(claims.path).field('_csrf',csrf(form.text))
    .field('parcelKey',JSON.stringify([first.shipmentId,first.trackingNumber]))
    .field('insuranceId',first.insuranceId).field('type',first.type).field('amount',first.amount)
    .field('recipient',first.recipient).field('contactEmail',first.contactEmail).field('description',first.description)
    .field('confirmed','yes').field('useRoutine','yes').attach('invoice',original,'invoice.pdf')
    .attach('correspondence',original,'email.pdf').attach('supporting',original,'proof.pdf').expect(303);
  const id=draft.headers.location.split('/').at(-1);
  const reviewed=await browser.get(draft.headers.location).expect(200);
  assert.match(reviewed.text,/\$25\.05/);
  assert.match(reviewed.text,/File claim/);
  assert.doesNotMatch(reviewed.text,/Save rule/);
  const attachment=await browser.get(draft.headers.location+'/evidence/invoice').expect(200);
  assert.match(attachment.headers['content-disposition'],/attachment/);
  assert.equal(attachment.headers['cache-control'],'private, no-store');
  assert.deepEqual(attachment.body,original);
  await browser.get(draft.headers.location+'/evidence/facts').expect(404);
  assert.equal((await saved(id)).effect_id,null);
  assert.equal((await claims.prepare(db,ctx,first,files)).id,id);
  await assert.rejects(claims.saveRule(db,ctx,id,{revision:0,maximum:'25.05',confirmed:'yes'}),/individually/);
  const stockBefore=await f.balance();
  await browser.post(draft.headers.location+'/file').type('form').send({_csrf:csrf(reviewed.text),confirmed:'yes'}).expect(303);
  await process();
  assert.equal((await effect(id)).status,'SUCCEEDED');
  assert.equal((await saved(id)).receipt.id,'clm_claim1');
  assert.equal(await f.balance(),stockBefore);
  await claims.saveRule(db,ctx,id,{revision:0,maximum:'25.05',confirmed:'yes'});

  const second=await sentParcel(2);
  const routine=await claims.prepare(db,ctx,second,files);
  assert.equal(routine.automatic,true);
  loseReceipt=true;
  await process();
  assert.equal((await effect(routine.id)).status,'AMBIGUOUS');
  assert.equal(writes,2);
  await claims.verify(db,ctx,routine.id);
  assert.equal((await effect(routine.id)).status,'SUCCEEDED');
  assert.equal((await saved(routine.id)).receipt.id,'clm_claim2');
  assert.equal((await claims.approve(db,ctx,routine.id,{confirmed:'yes'})).replayed,true);
  await claims.verify(db,ctx,routine.id);
  assert.equal(writes,2);
  loseReceipt=false;

  const third=await claims.prepare(db,ctx,await sentParcel(3),files);
  assert.equal(third.automatic,true);
  await f.subscribe('growth');
  await process();
  assert.equal((await effect(third.id)).status,'FAILED');
  assert.equal(writes,2);
  await f.subscribe('enterprise');
  assert.equal((await claims.approve(db,ctx,third.id,{confirmed:'yes'})).automatic,false);
  await process();
  assert.equal((await effect(third.id)).status,'SUCCEEDED');
  assert.equal(writes,3);
  const loss=await sentParcel(4,'loss');
  const customDraft=await claims.prepare(db,ctx,loss,files.slice(0,2));
  assert.equal((await saved(customDraft.id)).effect_id,null);
  await claims.saveRule(db,ctx,customDraft.id,{revision:0,maximum:'25.05',confirmed:'yes'});
  const custom=await claims.prepare(db,ctx,await sentParcel(5,'loss'),files.slice(0,2));
  assert.equal(custom.automatic,true);
  await process();
  assert.equal((await effect(custom.id)).status,'SUCCEEDED');
  assert.equal(writes,4);
});
