'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/supplier-invoice-intake-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const prices=require('../../src/pricing/postgres-service');
const notices=require('../../src/autopilot/operational-notices');
const reviews=require('../../src/autopilot/job-reviews');
const assistant=require('../../src/assistant/postgres-service');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const runtime=require('../../src/operations/postgres-runtime-handlers');
const sync=require('../../src/connections/postgres-commerce-sync');

test('a native cost increase suggests and prepares an exact owner-approved local price',{timeout:240000},async t=>{
  const f=await fixture(t),{db,ctx,subscribe,browser}=f;
  const sku=f.item.skuIds[0];
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const packLine=(skuId,unitCost)=>({skuId,quantityUnits:12,unitsPerPurchaseUnit:6,unitCost});
  const review=(filter=code)=>reviews.run(db,ctx,'margin-prices',{filter});
  const prepare=(actor=ctx,selected=code)=>assistant.prepareAction(db,actor,'Review margin price',
    {action:'catalog.restore_margin',sku:selected});
  const current=()=>prices.currentPrice(db,ctx.workspaceId,sku);
  const refresh=()=>db.transaction(c=>notices.refresh(c,ctx.workspaceId));
  const notice=async()=>(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).find(n=>n.sourceId==='agent-notice-77');
  await f.po([packLine(sku,4)]);
  await prices.setPrice(db,ctx,{skuId:sku,currency:'USD',amountMinor:1000});
  await f.po([packLine(sku,7)],false);
  assert.deepEqual((await review()).rows,[],'a placed but unreceived order has no posted cost');
  const raised=await f.po([packLine(sku,5)]);
  const proposed=await review();
  assert.equal(proposed.rows[0]['Current cost'],'$5.00 per unit');
  assert.match(proposed.rows[0]['Current cost evidence'],new RegExp(raised.poNumber));
  assert.equal(proposed.rows[0]['Suggested selling price'],'$12.50');
  await f.po([packLine(sku,5)]);
  assert.match((await review()).rows[0]['Current cost evidence'],new RegExp(raised.poNumber),'a repeated cost preserves the original rise');

  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const report=await review();
    if(['starter','growth'].includes(tier)){
      assert.equal(report.rows.length,1);
      assert.match(report.rows[0].Suggestion,/\$12\.50 USD per unit.*\$4\.00.*\$5\.00/);
      await assert.rejects(prepare(),e=>e.code==='entitlement_required');
    }else{
      assert.equal(report.rows[0]['Suggested selling price'],'$12.50');
      assert.equal((await prepare()).status,'PREPARED');
    }
    await refresh();
    assert.equal((await notice()).href,'/autopilot/reviews/margin-prices');
    assert.equal((await current()).amount_minor,1000);
  }
  await subscribe('pro');
  const at=Date.now()+3*60_000;
  const sweep=await db.transaction(c=>runtime.runtimeSweep({payload:{now:at}},c));
  assert.equal(sweep.scheduledAutopilotChecks,1);
  const worker=await f.queue.processOne(db,{'autopilot.evaluate':runtime.autopilotEvaluate},{owner:'margin-review',now:at});
  assert.equal(worker.status,'COMPLETED',JSON.stringify(worker.lastError));
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=77',[ctx.workspaceId])).rows[0].n,1);
  assert.match((await browser.get('/needs-you').expect(200)).text,/Review selling prices/);

  const plan=(await prepare()).proposal;
  await subscribe('growth');
  await assert.rejects(assistant.executeProposal(db,ctx,plan.id),e=>e.code==='entitlement_required');
  await subscribe('pro');
  await modes.save(db,ctx,77,{mode:'watch',revision:0});
  assert.equal(await notice(),undefined);
  const watchPage=await browser.get('/autopilot/reviews/margin-prices').expect(200);
  assert.match(watchPage.text,/Watch only/);
  assert.doesNotMatch(watchPage.text,/Prepare price change/);
  await assert.rejects(prepare(),/Watch only/);
  await assert.rejects(assistant.executeProposal(db,ctx,plan.id),/Watch only/);
  await modes.save(db,ctx,77,{mode:'ask',revision:1});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await assert.rejects(assistant.executeProposal(db,ctx,plan.id),/watch-only/);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE accounts SET created_at=(now()-interval '7 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal(await notice(),undefined);
  await assert.rejects(assistant.executeProposal(db,ctx,plan.id),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  const connectorId=randomUUID(),priceMoney={amount:1000,currency:'USD'};
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provider_account_id,status,
    capabilities,provides,config,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES($1,$2,$1,'Price fixture','fixture_sync','price-fixture','connected','[]','[]','{}','CONNECTED',$3,now(),now())`,
  [connectorId,ctx.workspaceId,ctx.actorId]);
  const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connectorId])).rows[0];
  const records=require('../../src/connections/postgres-provider-sync');
  await db.transaction(async tx=>{
    await require('../../src/connections/postgres-credential-store').put(tx,ctx.workspaceId,connectorId,'provider',{accessToken:'fixture'});
    await records.cacheRecord(tx,connection,{entityType:'sku',externalId:'product',code,displayName:code,providerData:{priceMoney}});
    await records.cacheRecord(tx,connection,{entityType:'location',externalId:'warehouse',displayName:'Test warehouse'});
    await records.setMappingInTransaction(tx,ctx,{connectorId,entityType:'sku',externalId:'product',foundryRecordId:sku});
    await records.setMappingInTransaction(tx,ctx,{connectorId,entityType:'location',externalId:'warehouse',foundryRecordId:f.location.id});
  });
  const syncProposal=await sync.prepare(db,ctx,connection,{sku:code,location:f.location.id,priceSyncMode:'two_way'},
    {providers:{get:()=>({readSyncPosition:async()=>({value:priceMoney,version:'fixture'}),
      writeSyncPosition:async()=>assert.fail('The margin approval must stay inside StockChief.')})}});
  await db.transaction(c=>sync.configureInTransaction(c,ctx,syncProposal.payload));
  await f.po([packLine(sku,6)]);
  await assert.rejects(assistant.executeProposal(db,ctx,plan.id),/recorded costs or selling price changed/);
  assert.equal((await current()).amount_minor,1000);
  const final=(await prepare()).proposal;
  await db.query("UPDATE users SET role='staff' WHERE id=$1",[ctx.actorId]);
  await assert.rejects(assistant.executeProposal(db,ctx,final.id),e=>e.code==='forbidden');
  await db.query("UPDATE users SET role='owner' WHERE id=$1",[ctx.actorId]);
  await assistant.executeProposal(db,ctx,final.id);
  const approved=await current();
  assert.equal(approved.amount_minor,1500);
  assert.equal(approved.source,'agent_margin_approval');
  assert.equal((await assistant.executeProposal(db,ctx,final.id)).replayed,true);
  assert.equal((await current()).id,approved.id);
  assert.equal((await db.transaction(c=>sync.reconcile(c,connection))).queued,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM stockchief_runtime.provider_effects
    WHERE workspace_id=$1 AND kind='commerce.position.publish'`,[ctx.workspaceId])).rows[0].n,0);
  await refresh();
  assert.equal(await notice(),undefined);
  assert.deepEqual((await review()).rows,[]);
});

test('matched bills preserve exact pack and recoverable tax evidence and hold mixed currencies',{timeout:240000},async t=>{
  const f=await fixture(t),{db,ctx,service}=f;
  const item=await catalog.createItem(db,ctx,{name:'Packed goods',baseCode:'MARGIN-PACK',trackingMode:'quantity'});
  const skuId=item.skuIds[0],code='MARGIN-PACK';
  const packed=()=>f.po([{skuId,quantityUnits:12,unitsPerPurchaseUnit:6,unitCost:4}]);
  await packed();
  await prices.setPrice(db,ctx,{skuId,currency:'USD',amountMinor:1100});
  const po=await packed();
  const invoice=f.text(po,{tax:1000,headers:'SKU|Purchase packs|Unit price|Line total',
    rows:[{sku:code,quantity:2,price:2501,total:5002}]});
  const source=await f.arrive(invoice);
  await f.runSource();
  let saved=await service.get(db,ctx,await f.intake(source.attachmentId));
  assert.equal(saved.status,'EXCEPTION');
  const review=()=>reviews.run(db,ctx,'margin-prices',{filter:code});
  assert.deepEqual((await review()).rows,[],'a disputed invoice is not posted cost evidence');
  await service.approve(db,ctx,saved.id,{revision:saved.revision,matchFingerprint:saved.comparison.matchFingerprint,
    confirmed:'yes',approvePrices:'yes',approveCharges:'yes',reason:'Confirm the exact printed pack variance and tax.'});
  saved=await service.get(db,ctx,saved.id);
  assert.equal(saved.status,'POSTED');
  const [row]=(await review()).rows;
  assert.equal(row['Current cost'],'$25.01 per 6 units');
  assert.match(row['Current cost evidence'],/Posted bill/);
  assert.equal(row.link,'/money/bills/'+saved.bill_id);
  assert.equal(row['Suggested selling price'],'$11.47');
  await prices.setPurchaseCost(db,ctx,{skuId,currency:'EUR',amountMinor:900});
  assert.deepEqual((await review()).rows,[],'a current foreign cost cannot be substituted for a same-currency comparison');

  const weighed=await catalog.createItem(db,ctx,{name:'Catch-weight goods',baseCode:'MARGIN-WEIGHT',trackingMode:'quantity',
    unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const weighedSku=weighed.skuIds[0];
  await f.po([{skuId:weighedSku,quantityUnits:2,secondaryQuantity:3.25,unitCost:8}]);
  await prices.setPrice(db,ctx,{skuId:weighedSku,currency:'USD',amountMinor:1234});
  await f.po([{skuId:weighedSku,quantityUnits:2,secondaryQuantity:2.75,unitCost:9}]);
  const [measured]=(await reviews.run(db,ctx,'margin-prices',{filter:weighedSku})).rows;
  assert.equal(measured['Pricing unit'],'kg');
  assert.equal(measured['Current cost'],'$9.00 per kg');
  assert.equal(measured['Suggested selling price'],'$13.89');
});
