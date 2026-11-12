'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('channel price reviews compare recorded catalogue and verified provider prices with owner MAP terms without changing prices',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
 await subscribe('pro');
 const prices=require('../../src/pricing/postgres-service'),sync=require('../../src/connections/postgres-commerce-sync'),reviews=require('../../src/autopilot/job-reviews');
 const map=require('../../src/pricing/channel-price-review'),sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
 await prices.setPrice(db,ctx,{skuId:sku,amountMinor:1200,currency:'USD'});
 let writes=0;
 const registry={get:()=>({readSyncPosition:async()=>({value:{amount:800,currency:'USD'},version:'verified-fixture'}),writeSyncPosition:async()=>{writes++;throw Error('NO_PROVIDER_WRITES');}})};
 const id='channel-'+randomUUID(),at=new Date().toISOString();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provider_account_id,status,capabilities,provides,config,setup_status,authorized_by_user_id,created_at,updated_at)
  VALUES($1,$2,$1,'Test channel','fixture_sync','fixture-account','connected','[]','[]','{}','CONNECTED',$3,$4,$4)`,[id,ctx.workspaceId,ctx.actorId,at]);
 await db.transaction(tx=>require('../../src/connections/postgres-credential-store').put(tx,ctx.workspaceId,id,'provider',{accessToken:'fixture'}));
 const connector=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0],records=require('../../src/connections/postgres-provider-sync');
 await db.transaction(async tx=>{
  await records.cacheRecord(tx,connector,{entityType:'sku',externalId:'part',code,displayName:'Test part',providerData:{priceMoney:{amount:800,currency:'USD'}}});
  await records.cacheRecord(tx,connector,{entityType:'location',externalId:'bay',displayName:'Test bay'});
  await records.setMappingInTransaction(tx,ctx,{connectorId:id,entityType:'sku',externalId:'part',foundryRecordId:sku});
  await records.setMappingInTransaction(tx,ctx,{connectorId:id,entityType:'location',externalId:'bay',foundryRecordId:f.location.id});
 });
 const proposal=await sync.prepare(db,ctx,connector,{sku:code,location:f.location.id,priceSyncMode:'inbound',initialSyncSource:'provider'},{providers:registry});
 await db.transaction(tx=>sync.configureInTransaction(tx,ctx,proposal.payload));
 // The canonical connector verifies this observation on its next reconciliation.
 await db.transaction(tx=>sync.reconcile(tx,connector));
 await prices.setPrice(db,ctx,{skuId:sku,amountMinor:1200,currency:'USD'});
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  if(tier==='starter'){
   await assert.rejects(reviews.run(db,ctx,'channel-prices'),e=>e.code==='entitlement_required');
   const locked=await browser.get('/autopilot/reviews/channel-prices').expect(402);assert(!locked.text.includes('Save supplier terms'));
   await assert.rejects(map.save(db,ctx,{sku:code,minimum:'10',currency:'USD',revision:0}),e=>e.code==='entitlement_required');continue;
  }
  const result=await reviews.run(db,ctx,'channel-prices');assert.equal(result.rows.length,2,'The catalogue check and the verified price sync are both recorded channel prices');
  assert.deepEqual(result.rows.map(r=>[r.Where,r['Recorded provider price']]).sort(),[['All locations','$8.00'],[f.location.name,'$8.00']]);
  const page=await browser.get('/autopilot/reviews/channel-prices').expect(200);assert.match(page.text,/Save supplier terms/);
 }
 await subscribe('growth');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const bay=async()=>(await reviews.run(db,ctx,'channel-prices')).rows.find(r=>r.Where===f.location.name);
 const page=await browser.get('/autopilot/reviews/channel-prices').expect(200),input={sku:code,minimum:'10.00',currency:'USD',revision:0};
 await browser.post('/autopilot/map-terms').type('form').send({...input,_csrf:f.csrf(page.text)}).expect(303);
 await assert.rejects(map.save(db,ctx,input),/changed/);
 assert.equal((await bay()).Finding,'Recorded price below MAP');
 assert.equal((await prices.currentPrice(db,ctx.workspaceId,sku)).amount_minor,1200);
 const checks=require('../../src/pricing/agent-channel-price-checks'),needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('channel-price'));
 assert.equal((await checks.run(db,ctx.workspaceId)).opened.length,2);
 assert((await needs()).some(n=>n.sourceId==='channel-price-map'&&/2 channel prices are below/.test(n.title)));
 await db.query("UPDATE connection_commerce_positions SET last_verified_at=now()-interval '25 hours' WHERE workspace_id=$1",[ctx.workspaceId]);
 assert.equal((await bay()).Finding,'Refresh provider check');
 await db.query("UPDATE connection_commerce_positions SET baseline_provider='{\"amount\":1200,\"currency\":\"EUR\"}',last_verified_at=now() WHERE workspace_id=$1",[ctx.workspaceId]);
 assert.equal((await bay()).Finding,'MAP currency needs review');
 await db.query("UPDATE connection_commerce_positions SET baseline_provider='{\"amount\":1200,\"currency\":\"ZZZ\"}' WHERE workspace_id=$1",[ctx.workspaceId]);
 assert.equal((await bay())['Recorded provider price'],'Provider currency needs review');
 await db.query("UPDATE connection_commerce_positions SET baseline_provider='{\"amount\":1200,\"currency\":\"USD\"}' WHERE workspace_id=$1",[ctx.workspaceId]);
 assert.equal((await bay()).Finding,'Matches recorded catalogue price');
 await db.query("UPDATE workspace_connectors SET provider_account_id='different-account' WHERE id=$1",[id]);
 assert.equal(await bay(),undefined,'Old account observations cannot describe a newly connected provider account');
 await db.query("UPDATE workspace_connectors SET provider_account_id='fixture-account' WHERE id=$1",[id]);
 // The channel's next catalogue check records the matching price; both flags clear.
 await db.transaction(tx=>records.cacheRecord(tx,connector,{entityType:'sku',externalId:'part',code,displayName:'Test part',providerData:{priceMoney:{amount:1200,currency:'USD'}}}));
 assert.equal((await checks.run(db,ctx.workspaceId)).cleared.length,2);assert.deepEqual(await needs(),[]);
 await db.query("UPDATE users SET role='staff' WHERE id=$1",[ctx.actorId]);
 await assert.rejects(map.save(db,ctx,{...input,revision:1}),e=>e.code==='forbidden');
 await db.query("UPDATE users SET role='owner' WHERE id=$1",[ctx.actorId]);
 await db.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by)
  SELECT $1,'sales_order.repeat','quota-'||n,'Quota fixture '||n,'USD',1000,$2 FROM generate_series(1,49) n`,[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(require('../../src/manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],1),/50 active rules/);
 await map.save(db,ctx,{...input,minimum:'11',revision:1});
 await subscribe('starter');await assert.rejects(map.save(db,ctx,{...input,revision:2}),e=>e.code==='entitlement_required');
 await map.save(db,ctx,{sku:code,revision:2,remove:'1'});
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.channel_map_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 assert.equal(writes,0);assert.equal(await f.balance(),4);
});
