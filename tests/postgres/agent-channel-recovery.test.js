'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const recovery=require('../../src/connections/agent-channel-recovery');
const sync=require('../../src/connections/postgres-commerce-sync');

test('channel recovery rereads exact approved stock or price without a repeat write',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f,skuId=f.item.skuIds[0],warehouse=f.location.id;
  const price=require('../../src/pricing/postgres-service');
  const sku=(await db.query('SELECT code FROM skus WHERE id=$1',[skuId])).rows[0].code;
  const mode=require('../../src/autopilot/job-modes');
  const jobs=require('../../src/operations/postgres-job-queue');
  const effects=require('../../src/operations/postgres-provider-effects');
  const cache=require('../../src/connections/postgres-provider-sync').cacheRecord;
  await f.subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'connected_operations',1000,'Synthetic Custom provider operations')`,[randomUUID(),f.owner.accountId]);
  await price.setPrice(db,ctx,{skuId,amountMinor:1300,currency:'USD'});

  async function connect(provider){
    const id='connector-'+randomUUID(),account=provider+'-synthetic';
    const initial=(await price.currentPrice(db,ctx.workspaceId,skuId)).amount_minor;
    const at=new Date().toISOString();
    await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provider_account_id,status,
      capabilities,provides,config,setup_status,authorized_by_user_id,created_at,updated_at)
      VALUES($1,$2,$1,$3,$3,$4,'connected','[]','[]','{}','CONNECTED',$5,$6,$6)`,
    [id,ctx.workspaceId,provider,account,ctx.actorId,at]);
    await db.transaction(tx=>require('../../src/connections/postgres-credential-store').put(tx,ctx.workspaceId,id,'provider',{accessToken:'fixture'}));
    const connector=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0];
    await db.transaction(async tx=>{
      await cache(tx,connector,{entityType:'sku',externalId:provider+'-variant',code:sku,displayName:'Parcel item',
        providerData:{itemName:'Parcel item',priceMoney:{amount:initial,currency:'USD'}}});
      await cache(tx,connector,{entityType:'location',externalId:provider+'-location',displayName:f.location.name});
    });
    let remote={amount:initial,currency:'USD'},writes=0,reads=0,afterRead=null;
    const adapter={async readSyncPosition(input){
      assert.equal(input.externalId,provider+'-variant');
      reads++;
      if(afterRead)await afterRead();
      return {value:remote,version:null};
    },async writeSyncPosition(input){
      writes++;remote=input.value;
      throw Object.assign(new Error('Provider accepted the update but did not acknowledge it.'),{providerOutcomeUncertain:true,status:502});
    }};
    const registry={get:()=>adapter};
    const authority=await sync.prepare(db,ctx,connector,{sku,location:warehouse,priceSyncMode:'outbound',initialSyncSource:'stockchief'},{providers:registry});
    await db.transaction(tx=>sync.configureInTransaction(tx,ctx,authority.payload));
    return {id,connector,registry,stats:()=>({writes,reads}),onRead:fn=>{afterRead=fn;}};
  }

  const shopify=await connect('shopify');
  const makeUncertain=async(connector,amount)=>{
    await price.setPrice(db,ctx,{skuId,amountMinor:amount,currency:'USD'});
    const position=(await db.query("SELECT id,pending_effect_id FROM connection_commerce_positions WHERE connector_id=$1 AND field='price'",[connector.id])).rows[0];
    assert(position.pending_effect_id);
    await assert.rejects(sync.execute(db,ctx.workspaceId,position.pending_effect_id,{providers:connector.registry}));
    assert.equal((await effects.get(db,ctx.workspaceId,position.pending_effect_id)).status,'AMBIGUOUS');
    await db.query(`UPDATE stockchief_runtime.jobs SET status='DEAD'
      WHERE workspace_id=$1 AND kind='provider.commerce-verify' AND payload->>'effectId'=$2`,[ctx.workspaceId,position.pending_effect_id]);
    await db.query("UPDATE stockchief_runtime.provider_effects SET updated_at=now()-interval '20 minutes' WHERE id=$1",[position.pending_effect_id]);
    return position;
  };
  const growth=await makeUncertain(shopify,1550);
  await f.subscribe('starter');
  await assert.rejects(mode.save(db,ctx,182,{mode:'routine',revision:0}),/cannot run/);
  assert.deepEqual(await recovery.schedule(db,ctx.workspaceId),{queued:0});
  const starter=await recovery.definition.readPage(db,ctx);
  assert.equal(starter.rows[0].Review,'Compare with provider');
  assert.equal(shopify.stats().writes,1);

  await f.subscribe('growth');
  await mode.save(db,ctx,182,{mode:'routine',revision:0});
  assert.deepEqual(await recovery.schedule(db,ctx.workspaceId),{queued:1});
  assert.deepEqual(await recovery.schedule(db,ctx.workspaceId),{queued:0});
  const process=connector=>{
    const handlers=require('../../src/operations/postgres-runtime-handlers').create(connector.registry);
    return jobs.processOne(db,{[recovery.kind]:handlers[recovery.kind]},{owner:'channel-recovery-fixture'});
  };
  const growthDone=await process(shopify);
  assert.equal(growthDone.status,'COMPLETED');
  assert.equal((await effects.get(db,ctx.workspaceId,growth.pending_effect_id)).status,'SUCCEEDED');
  assert.equal(shopify.stats().writes,1);
  assert.equal((await recovery.definition.readPage(db,ctx)).rows[0].Review,'Provider confirmed');
  assert.equal(await f.balance(),20);

  const off=await sync.prepare(db,ctx,shopify.connector,{sku,location:warehouse,priceSyncMode:'off'},{providers:shopify.registry});
  await db.transaction(tx=>sync.configureInTransaction(tx,ctx,off.payload));
  await f.subscribe('pro');
  const woo=await connect('woocommerce');
  const pro=await makeUncertain(woo,1650);
  assert.deepEqual(await recovery.schedule(db,ctx.workspaceId),{queued:1});
  const before=woo.stats().reads;
  await f.subscribe('starter');
  await process(woo);
  assert.equal(woo.stats().reads,before);
  assert.equal((await effects.get(db,ctx.workspaceId,pro.pending_effect_id)).status,'AMBIGUOUS');

  await f.subscribe('pro');
  const again=async id=>{
    await db.query("UPDATE stockchief_runtime.agent_channel_recovery_checks SET queued_at=now()-interval '7 hours' WHERE effect_id=$1",[id]);
    await db.query("UPDATE stockchief_runtime.provider_effects SET updated_at=now()-interval '20 minutes' WHERE id=$1",[id]);
    assert.deepEqual(await recovery.schedule(db,ctx.workspaceId),{queued:1});
    await process(woo);
  };
  await again(pro.pending_effect_id);
  assert.equal((await effects.get(db,ctx.workspaceId,pro.pending_effect_id)).status,'SUCCEEDED');
  assert.equal(woo.stats().writes,1);

  await f.subscribe('enterprise');
  const custom=await makeUncertain(woo,1750);
  assert.deepEqual(await recovery.schedule(db,ctx.workspaceId),{queued:1});
  woo.onRead(()=>db.query("UPDATE workspace_connectors SET provider_account_id='changed-account' WHERE id=$1",[woo.id]));
  await process(woo);
  assert.equal((await effects.get(db,ctx.workspaceId,custom.pending_effect_id)).status,'AMBIGUOUS');
  woo.onRead(null);
  await db.query('UPDATE workspace_connectors SET provider_account_id=$2 WHERE id=$1',[woo.id,woo.connector.provider_account_id]);
  await again(custom.pending_effect_id);
  assert.equal((await effects.get(db,ctx.workspaceId,custom.pending_effect_id)).status,'SUCCEEDED');
  assert.equal(woo.stats().writes,2);
  assert.equal(await f.balance(),20);
});
