'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 132: Starter and Growth do not include it. Pro drafts dead-stock
// retirements until the owner has completed one and saved the rule with it;
// Custom retires within the rule's limit. A person marking or approving acts
// at once. Retiring stops reordering, sells down the stock left (clearance
// prices wait for a person), archives the product when none is left, sets its
// channel stock to zero and points staff to the replacement. A person decides
// any write-off.
test('discontinued products stop reordering, sell down, retire to zero on channels and point staff to the replacement',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location,workflows}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt'),prices=require('../../src/pricing/postgres-service');
  const work=require('../../src/catalog/agent-retirement-work'),reviews=require('../../src/autopilot/job-reviews'),modes=require('../../src/autopilot/job-modes');
  const autopilot=require('../../src/autopilot/postgres-service'),planning=require('../../src/forecasting/postgres-planning-service'),commerce=require('../../src/operations/postgres-commerce');
  const age=interval=>db.query(`UPDATE accounts SET created_at=(now()-interval '${interval}')::text WHERE id=$1`,[f.owner.accountId]);
  await age('30 days');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const today=await require('../../src/lib/business-time').today(db,ws),old=require('../../src/accounting/customer-money').addDays(today,-210)+'T12:00:00Z';
  const product=async(code,{units=0,unitLabel=null}={})=>{
    const made=await catalog.createItem(db,ctx,{name:'Product '+code,baseCode:code,trackingMode:'quantity',purchaseCost:'2',...(unitLabel?{unitLabel}:{})});
    const sku=made.skuIds[0];
    if(units)await receipt.receive(db,ctx,{skuId:sku,locationId:location.id,quantity:units,occurredAt:old,idempotencyKey:randomUUID()});
    await prices.setPrice(db,ctx,{skuId:sku,amountMinor:1000,currency:'USD'});
    return {sku,item:made.itemId,code};
  };
  const row=async sku=>(await db.query(`SELECT * FROM stockchief_runtime.agent_product_retirements WHERE workspace_id=$1 AND sku_id=$2
    ORDER BY created_at DESC,id DESC LIMIT 1`,[ws,sku])).rows[0];
  const active=async sku=>(await db.query('SELECT s.is_active::int+i.is_active::int AS n FROM skus s JOIN items i ON i.id=s.item_id WHERE s.id=$1',[sku])).rows[0].n===2;
  const audits=action=>db.query('SELECT count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action]).then(r=>r.rows[0].n);
  const plan=async id=>(await db.query('SELECT status FROM stockchief_runtime.agent_clearance_plans WHERE id=$1',[id])).rows[0]?.status;
  const sweep=()=>work.run({workspaceId:ws,payload:{}},db);
  const position=async sku=>(await planning.position(db,ws,{onlySkuIds:[sku]})).find(p=>p.location_id===location.id);
  const sell=async(sku,quantity)=>{
    const o=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:location.id,deliveryMethod:'SHIP',idempotencyKey:randomUUID(),
      lines:[{skuId:sku,quantity,unitPriceMinor:1000}]});
    await workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    return o;
  };
  const ship=(o,quantity)=>workflows.fulfillSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:o.lineIds[0],locationId:location.id,quantity}]});

  const lamp=await product('LAMP-OLD',{units:3}),lampNew=await product('LAMP-NEW');
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,5,10,'manual',now()::text,now()::text)`,[randomUUID(),ws,lamp.sku,location.id]);

  // Starter and Growth: refused, with the plan lock.
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    await assert.rejects(work.mark(db,ctx,{sku:'LAMP-OLD',confirmed:'yes'}),e=>e.code==='entitlement_required');
    const locked=await browser.get(work.path).expect(200);
    assert.match(locked.text,/Upgrade/);assert.ok(!locked.text.includes('data-retire-mark'));
    assert.equal((await sweep()).skipped,true);
    assert.deepEqual(await work.inbox(db,ws),[]);
  }

  // Pro. A shop channel takes LAMP-OLD's stock from StockChief.
  await subscribe('pro');
  assert.equal((await position(lamp.sku)).shortage,true,'it is reordered before it is discontinued');
  const connectorId=randomUUID(),at=new Date().toISOString();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Web shop','shopify','connected','[]','[]','{}','CONNECTED',$3,'synthetic-retirement-shop',$4,$4)`,[connectorId,ws,ctx.actorId,at]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connectorId,'provider',{accessToken:'synthetic-retirement-token'}));
  const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connectorId])).rows[0];
  const sync=require('../../src/connections/postgres-commerce-sync'),cacheRecord=require('../../src/connections/postgres-provider-sync').cacheRecord;
  const remote={value:3},writes=[];
  const provider={readSyncPosition:async()=>({value:remote.value,version:null}),writeSyncPosition:async input=>{
    if(input.beforeWrite)await input.beforeWrite();
    if(input.expected!==remote.value)throw Object.assign(new Error('Synthetic shop stock changed'),{code:'commerce_sync_conflict',status:409,providerWriteAttempted:false});
    writes.push(input.value);remote.value=input.value;return {externalId:input.externalId,value:input.value,verified:true};}};
  const providers={get:()=>provider};
  const cache=()=>db.transaction(async c=>{
    await cacheRecord(c,connection,{entityType:'sku',externalId:'lamp-variant',code:'LAMP-OLD',displayName:'Old lamp',providerData:{itemName:'Old lamp',inventoryCounts:[{externalLocationId:'shop-room',quantity:remote.value}]}});
    await cacheRecord(c,connection,{entityType:'location',externalId:'shop-room',displayName:location.name});});
  await cache();
  const prepared=await sync.prepare(db,ctx,connection,{sku:'LAMP-OLD',location:location.id,quantitySyncMode:'outbound',priceSyncMode:'off',source:'stockchief'},{providers});
  await db.transaction(c=>sync.configureInTransaction(c,ctx,{...prepared.payload,idempotencyKey:randomUUID()}));
  const deliver=async()=>{const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create(providers),
    kinds=['provider.effect',require('../../src/operations/agent-commerce-protocol').kind],out=[];
    for(let i=0;i<10;i++){const r=await jobs.processOne(db,Object.fromEntries(kinds.map(k=>[k,handlers[k]])),{owner:'retirement-channel-worker',kinds});if(!r)break;out.push(r);if(r.status!=='COMPLETED')throw Error(JSON.stringify(r.lastError));}
    return out;};

  // Facts that do not match stop and ask.
  await product('ROPE-M',{unitLabel:'m'});
  await assert.rejects(work.mark(db,ctx,{sku:'LAMP-OLD',replacement:'ROPE-M',confirmed:'yes'}),/different stock units/);
  await assert.rejects(work.mark(db,ctx,{sku:'LAMP-OLD',replacement:'LAMP-OLD',confirmed:'yes'}),/cannot replace itself/);
  await assert.rejects(work.mark(db,ctx,{sku:'NO-SUCH-SKU',confirmed:'yes'}),/No single active product/);
  await assert.rejects(work.mark(db,ctx,{sku:'LAMP-OLD',confirmed:'no'}),/Confirm/);
  await assert.rejects(work.mark(db,ctx,{sku:'LAMP-OLD',markdown:'20',confirmed:'yes'}),/both a clearance markdown/);
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:lamp.sku,quantityUnits:4,unitCost:2}]});
  await assert.rejects(work.mark(db,ctx,{sku:'LAMP-OLD',confirmed:'yes'}),/unfinished order to buy more/);
  await db.query("UPDATE purchase_orders SET status='CANCELLED' WHERE id=$1",[po.purchaseOrderId]);
  const book=await product('BOOK-X');
  await db.query('INSERT INTO accounting_inventory_cost_balances(workspace_id,sku_id,location_id,quantity_units,total_cost_minor,updated_at) VALUES($1,$2,$3,1,100,now()::text)',[ws,book.sku,location.id]);
  await assert.rejects(work.mark(db,ctx,{sku:'BOOK-X',confirmed:'yes'}),/stock value in the books but none on the shelf/);
  assert.equal(await row(lamp.sku),undefined);

  // The owner marks it: no more reordering, stock sold down, a clearance plan
  // whose prices wait for a person.
  const marked=await work.mark(db,ctx,{sku:'LAMP-OLD',replacement:'LAMP-NEW',markdown:'20',stepDays:'30',confirmed:'yes'});
  assert.deepEqual([marked.status,marked.left,marked.replacementCode],['SELLING_DOWN','3','LAMP-NEW']);
  const lampWork=await row(lamp.sku);
  assert.equal(await plan(lampWork.applied.clearancePlanId),'DRAFT');
  assert.equal((await prices.currentPrice(db,ws,lamp.sku)).amount_minor,1000,'prices change only after a person approves');
  const stopped=await position(lamp.sku);
  assert.deepEqual([stopped.shortage,stopped.reorderPoint,stopped.effectiveReorder],[false,null,null]);
  assert.equal(await audits('Discontinued products retired'),1);
  assert.equal((await work.mark(db,ctx,{sku:'LAMP-OLD',confirmed:'yes'})).replayed,true);
  // Staff see the replacement on the product page, in order entry and in Ask.
  const lampPage=await browser.get('/inventory/'+lamp.item).expect(200);
  assert.match(lampPage.text,/LAMP-OLD is discontinued[\s\S]*LAMP-NEW[\s\S]*3 left to sell[\s\S]*Open its clearance plan/);
  assert.ok((await browser.get('/inventory/'+lampNew.item).expect(200)).text.includes('data-retire-link'));
  const picked=(await commerce.catalogue(db,ws,{search:'LAMP-OLD',limit:10})).find(r=>r.id===lamp.sku);
  assert.deepEqual([picked.discontinued,picked.replacement_code],[true,'LAMP-NEW']);
  const searched=await browser.get('/sales/catalogue/search?q=LAMP-OLD').set('Accept','application/json').expect(200);
  assert.equal(searched.body.products.find(p=>p.id===lamp.sku).replacement_code,'LAMP-NEW');
  const ask=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
  const asked=await ask.prepare(null,db,ctx,'',{agentJob:'discontinued-products',search:'LAMP-OLD'});
  assert.deepEqual([asked.rows[0].Status,asked.rows[0].Replacement,asked.rows[0]['Stock left']],['Selling down','LAMP-NEW','3']);

  // The order page and the pick list point staff to the replacement.
  const vase=await product('VASE-OLD',{units:2});
  await work.mark(db,ctx,{sku:'VASE-OLD',replacement:'LAMP-NEW',confirmed:'yes'});
  const vaseOrder=await sell(vase.sku,1);
  assert.match((await browser.get('/orders/'+vaseOrder.salesOrderId).expect(200)).text,/data-discontinued[^>]*><p><strong>VASE-OLD is discontinued\.<\/strong> When none are left, use <a[^>]*>LAMP-NEW/);
  const wave=await require('../../src/operations/postgres-fulfillment-waves').create(db,ctx,{orderIds:[vaseOrder.salesOrderId],idempotencyKey:randomUUID()});
  assert.match((await browser.get('/warehouse/waves/'+wave.waveId).expect(200)).text,/data-discontinued>Discontinued\. If none are left, the replacement is LAMP-NEW/);

  // Sold out: archived, set to zero on the channel through normal delivery,
  // and a search for the old code offers the replacement.
  const lampOrder=await sell(lamp.sku,3);await ship(lampOrder,3);
  const finished=await sweep();assert.equal(finished.finished,1,JSON.stringify({finished,work:await row(lamp.sku)}));
  const retired=await row(lamp.sku);
  assert.deepEqual([retired.status,retired.applied.archived,retired.applied.channels.queued,await active(lamp.sku)],['RETIRED','item',1,false]);
  assert.equal(await plan(lampWork.applied.clearancePlanId),'CANCELLED','an unapproved clearance plan is no longer needed');
  assert.equal((await deliver()).length,1);
  assert.deepEqual([writes,remote.value],[[0],0]);
  await cache();
  assert.equal((await db.transaction(c=>sync.reconcile(c,connection))).conflicts,0,'a retired product keeps reading zero');
  const offered=(await commerce.catalogue(db,ws,{search:'LAMP-OLD',limit:10})).find(r=>r.id===lampNew.sku);
  assert.equal(offered.replaces,'LAMP-OLD');
  assert.equal((await sweep()).finished,0,'a replay changes nothing');
  assert.match((await browser.get('/inventory/'+lamp.item).expect(200)).text,/LAMP-OLD is discontinued/);

  // Undo: active again, reordered again, no replacement guidance.
  await work.undo(db,ctx,retired.id,{confirmed:'yes'});
  assert.equal(await active(lamp.sku),true);
  assert.equal((await position(lamp.sku)).shortage,true);
  assert.doesNotMatch((await browser.get('/inventory/'+lamp.item).expect(200)).text,/is discontinued/);
  assert.deepEqual(await work.undo(db,ctx,retired.id,{confirmed:'yes'}),{replayed:true});
  assert.equal(await audits('Discontinued product brought back'),1);

  // Dead stock on Pro: drafts until the owner retires one and saves the rule with it.
  const deadA=await product('DEAD-A',{units:2}),deadB=await product('DEAD-B',{units:4}),deadP=await product('DEAD-P',{units:1});
  await assert.rejects(work.configure(db,ctx,{revision:0,confirmed:'yes',deadDays:'10',dailyLimit:'5'}),/from 30 to 1,095/);
  await work.configure(db,ctx,{revision:0,confirmed:'yes',deadDays:'90',dailyLimit:'5',markdown:'25',stepDays:'30'});
  await sweep();
  const draftA=await row(deadA.sku),draftP=await row(deadP.sku);
  assert.deepEqual([draftA.status,(await row(deadB.sku)).status,draftP.status],['DRAFT','DRAFT','DRAFT']);
  assert.match(draftA.reason,/Retire one product yourself/);
  assert.match((await work.inbox(db,ws)).find(r=>r.sourceId==='product-retirement-drafts').happened,/3 products have not sold/);
  await work.dismiss(db,ctx,draftP.id,{confirmed:'yes'});
  await assert.rejects(work.approve(db,ctx,draftA.id,{confirmed:'yes',fingerprint:'stale'}),/Review the current product/);
  const approved=await work.approve(db,ctx,draftA.id,{confirmed:'yes',fingerprint:draftA.fingerprint});
  assert.equal(approved.status,'SELLING_DOWN');
  const deadAPlan=(await row(deadA.sku)).applied.clearancePlanId;
  assert.equal(await plan(deadAPlan),'DRAFT');
  await assert.rejects(work.configure(db,ctx,{revision:1,confirmed:'yes',deadDays:'90',dailyLimit:'5',exampleId:'retirement-missing'}),/Teach the rule from a retirement you completed/);
  await work.configure(db,ctx,{revision:1,confirmed:'yes',deadDays:'90',dailyLimit:'5',markdown:'25',stepDays:'30',exampleId:draftA.id});
  await sweep();
  const autoB=await row(deadB.sku);
  assert.deepEqual([autoB.status,autoB.automatic],['SELLING_DOWN',true]);
  assert.equal((await row(deadP.sku)).status,'DISMISSED','a product the owner kept is not retired on its own');
  assert.equal(await audits('Discontinued products retired on their own'),1);

  // Custom: on its own inside the daily limit, without training.
  await subscribe('enterprise');
  await db.query("UPDATE stockchief_runtime.agent_product_retirements SET decided_at=decided_at-interval '2 days' WHERE workspace_id=$1",[ws]);
  await work.configure(db,ctx,{revision:2,confirmed:'yes',deadDays:'90',dailyLimit:'1'});
  const deadC=await product('DEAD-C',{units:1}),deadD=await product('DEAD-D',{units:1});
  await sweep();
  const custom=[await row(deadC.sku),await row(deadD.sku)];
  assert.deepEqual(custom.map(r=>r.status).sort(),['DRAFT','SELLING_DOWN']);
  const held=custom.find(r=>r.status==='DRAFT');
  assert.match(held.reason,/over your limit of 1 products retired a day/);
  await work.configure(db,ctx,{revision:3,confirmed:'yes',deadDays:'90',dailyLimit:'10'});
  // Pause, shadow, Ask me first and Watch only keep it a draft.
  await autopilot.pause(db,ctx,{role:'owner'},'checking');
  await sweep();assert.match((await row(held.sku_id)).reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await age('1 day');
  await sweep();assert.match((await row(held.sku_id)).reason,/watching during the first 14 days/);
  await assert.rejects(work.mark(db,ctx,{sku:'DEAD-C',confirmed:'yes'}),/watching during the first 14 days/);
  await age('30 days');
  await modes.save(db,ctx,132,{mode:'ask',revision:0});
  await sweep();assert.match((await row(held.sku_id)).reason,/Ask me first/);
  await modes.save(db,ctx,132,{mode:'watch',revision:1});
  await sweep();assert.match((await row(held.sku_id)).reason,/Watch only/);
  await modes.save(db,ctx,132,{mode:'inherit',revision:2});
  await sweep();
  assert.deepEqual([(await row(held.sku_id)).status,(await row(held.sku_id)).automatic],['SELLING_DOWN',true]);
  // An undone automatic retirement is not made again on its own.
  await work.undo(db,ctx,autoB.id,{confirmed:'yes'});
  await sweep();
  assert.equal((await row(deadB.sku)).status,'UNDONE');

  // Stock that stops selling waits for a person, who writes it off through the
  // normal product deletion; StockChief then finishes the retirement.
  await require('../../src/pricing/agent-clearance-plans').end(db,ctx,deadAPlan,{confirmed:'yes'});
  await db.query("UPDATE stockchief_runtime.agent_product_retirements SET decided_at=now()-interval '40 days',created_at=now()-interval '40 days' WHERE id=$1",[draftA.id]);
  const stuck=(await work.inbox(db,ws)).find(r=>r.sourceId==='product-retirement-stock');
  assert.match(stuck.why,/never writes off stock/);
  assert.ok((await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).some(r=>r.sourceId==='product-retirement-stock'));
  const screen=await browser.get(work.path).expect(200);
  for(const marker of ['data-retire-mark','data-retire-work','data-retire-rule'])assert.ok(screen.text.includes(marker),marker);
  assert.ok(screen.text.includes('href="/delete/product/'+deadA.item+'"'));
  const removal=await browser.get('/delete/product/'+deadA.item).expect(200);
  const reviewHash=/name="reviewHash" value="([^"]+)"/.exec(removal.text)[1];
  await browser.post('/delete/product/'+deadA.item).type('form').send({_csrf:f.csrf(removal.text),reviewHash}).expect(303);
  await sweep();
  const writtenOff=await row(deadA.sku);
  assert.deepEqual([writtenOff.status,writtenOff.applied.archived],['RETIRED','person']);
  await assert.rejects(work.undo(db,ctx,writtenOff.id,{confirmed:'yes'}),/archived outside this retirement/);
  const listed=await reviews.run(db,ctx,'discontinued-products',{});
  assert.ok(listed.rows.some(r=>r.SKU==='DEAD-A'&&r.Status==='Retired'));
  assert.equal((await work.schedule(db,ws,'cycle-1')).queued,true);
  assert.equal((await work.schedule(db,ws,'cycle-2')).queued,false);

  // The pages read well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+work.path);
    assert(await view.getByRole('heading',{name:'Mark a product discontinued'}).isVisible());
    assert(await view.getByRole('heading',{name:'Retire dead stock'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.screenshot({path:require('node:path').join(folder,'discontinued-products-'+name+'.png'),fullPage:true});
    await view.goto(base+'/inventory/'+vase.item);
    assert.match(await view.locator('main').innerText(),/VASE-OLD is discontinued/);
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' product page must not scroll sideways');
    await view.close();
  }
});
