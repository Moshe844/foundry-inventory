'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const freight=require('../../src/shipping/agent-freight-pickups');
const jobs=require('../../src/operations/postgres-job-queue');
const effects=require('../../src/operations/postgres-provider-effects');

test('only Custom can book quoted pallets, and a carrier booking never hands stock over',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{provider:'shipengine',units:15});
  const {db,ctx,browser,csrf,shipping}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await f.subscribe('enterprise');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'connected_operations',1000,'Synthetic freight operation allowance')`,[randomUUID(),f.owner.accountId]);
  const connector=(await db.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='shipengine'",[ctx.workspaceId])).rows[0];
  const savedBookings=new Map();
  const future=new Date(Date.now()+86400000*2).toISOString().slice(0,10);
  let writes=0,reads=0,holdReceipt=false;
  t.mock.method(require('../../src/shipping/providers/shipengine'),'call',async(account,path,options)=>{
    assert.equal(account.shipengineApiKey,'TEST_fixture');
    if(path==='/freight/provider_accounts'){
      reads++;
      return {freight_provider_accounts:[{freight_provider_account_id:'se-101',freight_provider_code:'SYNTHETIC',nickname:'Synthetic freight'}]};
    }
    if(path==='/freight/quotes'){
      reads++;
      assert.equal(options.body.freight_provider_account_id,'se-101');
      assert.equal(options.body.handling_units[0].length,48.5);
      assert.equal(options.body.handling_units[0].commodities[0].weight,200.25);
      return {quotes:[{freight_provider_account_id:'se-101',offer_id:'example-offer-'+reads,carrier_scac:'TEST',
        carrier_name:'Synthetic LTL',service_name:'Ground',total_charges:124.90,quote_expiration_date:new Date(Date.now()+3600000).toISOString()}]};
    }
    if(path.startsWith('/freight/shipments/'))return savedBookings.get(path.split('/').at(-1));
    assert.equal(path,'/freight/shipments');
    assert.equal(options.method,'POST');
    assert.equal(options.body.pickup_details.is_self_scheduled,false);
    assert.equal(options.body.pickup_details.pickup_date,future);
    assert.match(options.body.offer_id,/^example-offer-/);
    assert.equal(options.retries,0);
    writes++;
    const id='se-'+(900+writes),receipt={freight_shipment_id:id,freight_provider_account_id:'se-101',
      status:'booked',bol_number:'BOL-'+writes,confirmation_number:'PICKUP-'+writes,
      documents:[{type:'BILL_OF_LADING',url:'https://api.shipengine.com/v2/downloads/p1/fixture/bol.pdf'}]};
    savedBookings.set(id,receipt);
    return holdReceipt?{...receipt,confirmation_number:null}:receipt;
  });
  async function packed(){
    const box=await f.parcel();
    await db.query("UPDATE sales_orders SET contact_phone='5185550100' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,box.order.salesOrderId]);
    return box;
  }
  const first=await packed();
  for(const tier of ['starter','growth','pro']){
    await f.subscribe(tier);
    const locked=await browser.get(freight.path).expect(200);
    assert.match(locked.text,/Pallet pickup booking requires Custom/);
    assert.doesNotMatch(locked.text,/Load freight accounts/);
    await assert.rejects(freight.prepare(db,ctx,{shipmentId:first.shipmentId}),e=>e.code==='entitlement_required'&&/Custom/.test(e.message));
    await assert.rejects(freight.book(db,ctx,'unknown',{}),e=>e.code==='entitlement_required');
  }
  assert.equal(reads,0);
  await f.subscribe('enterprise');
  const formFields={accountId:'se-101',fromType:'commercial',toType:'commercial',pickupDate:future,readyTime:'08:00',closeTime:'17:00',
    confirmed:'yes',nonHazardous:'yes',palletGroup:'1',palletCount:'1',palletLength:'48.5',palletWidth:'40',palletHeight:'50',
    palletStackable:'no',commodityName:'Synthetic freight',commodityCount:'10',commodityWeight:'200.25',commodityClass:'125',commodityNmfc:''};
  async function quote(shipment,viaBrowser=false,useRoutine=''){
    const parameters={shipmentId:shipment.shipmentId,connectorId:connector.id};
    const snapshot=await freight.page(db,ctx,parameters);
    assert.equal(snapshot.freightAccounts[0].id,'se-101');
    const input={...formFields,...parameters,useRoutine,sourceFingerprint:snapshot.exact.fingerprint};
    if(!viaBrowser)return freight.prepare(db,ctx,input);
    const form=await browser.get(freight.path+'?'+new URLSearchParams({shipment:shipment.shipmentId,connection:connector.id})).expect(200);
    assert.match(form.text,/Synthetic freight/);
    const saved=await browser.post(freight.path).type('form').send({...input,_csrf:csrf(form.text)}).expect(303);
    return {id:saved.headers.location.split('/').at(-1)};
  }
  async function stored(id){return (await freight.page(db,ctx,{id})).selected;}
  async function savedEffect(id){return effects.get(db,ctx.workspaceId,(await stored(id)).effect_id);}
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const run=()=>jobs.processOne(db,{[freight.kind]:handlers[freight.kind]},{owner:'synthetic-freight-worker'});
  const primary=await quote(first,true);
  const viewed=await browser.get(freight.path+'/'+primary.id).expect(200);
  assert.match(viewed.text,/\$124\.90/);
  const draft=await stored(primary.id),approval={revision:draft.revision,offerId:draft.offers[0].id,confirmed:'yes'};
  const balance=await f.balance();
  await freight.saveRule(db,ctx,primary.id,{...approval,maximum:'124.90',ruleRevision:0});
  await browser.post(freight.path+'/'+primary.id+'/book').type('form').send({...approval,_csrf:csrf(viewed.text)}).expect(303);
  await assert.rejects(shipping.cancel(db,ctx,first.shipmentId),/freight pickup/);
  await assert.rejects(shipping.handoff(db,ctx,first.shipmentId,{idempotencyKey:'premature'}),/Verify this freight booking/);
  await run();
  assert.equal((await savedEffect(primary.id)).status,'SUCCEEDED');
  assert.equal((await stored(primary.id)).receipt.number,'PICKUP-1');
  assert.equal(await f.balance(),balance);
  assert.match((await browser.get(freight.path+'/'+primary.id).expect(200)).text,/Download bill of lading/);
  assert.equal((await freight.book(db,ctx,primary.id,approval)).replayed,true);
  await shipping.handoff(db,ctx,first.shipmentId,{idempotencyKey:'actual-freight-handoff'});
  assert.equal(await f.balance(),balance-1);
  assert.equal((await shipping.requireShipment(db,ctx.workspaceId,first.shipmentId)).tracking_number,'BOL-1');

  const next=await quote(await packed(),false,'yes');
  assert.equal(next.queued,true);
  assert.equal((await stored(next.id)).rule_revision,1);
  holdReceipt=true;
  await run();
  assert.equal((await savedEffect(next.id)).status,'AMBIGUOUS');
  await freight.verify(db,ctx,next.id);
  assert.equal((await savedEffect(next.id)).status,'SUCCEEDED');
  assert.equal((await stored(next.id)).receipt.number,'PICKUP-2');
  assert.equal(writes,2);

  const downgrade=await quote(await packed());
  const queued=await stored(downgrade.id);
  await freight.book(db,ctx,downgrade.id,{revision:queued.revision,offerId:queued.offers[0].id,confirmed:'yes'});
  await f.subscribe('pro');
  await run();
  assert.equal((await savedEffect(downgrade.id)).status,'FAILED');
  assert.equal(writes,2);
});
