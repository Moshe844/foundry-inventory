'use strict';
process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://fixture.example.test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const autonomy=require('../../src/autopilot/postgres-service');
const reviews=require('../../src/autopilot/job-reviews');
const kitReorders=require('../../src/purchasing/agent-kit-reorders');

test('kits show build counts on every plan and reorder their parts per plan mode through the usual purchasing path',{timeout:600000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,workflows}=f,ws=ctx.workspaceId,owner={role:'owner'};
  const catalog=require('../../src/domain/postgres-catalog-service'),kits=require('../../src/domain/postgres-kit-service');
  const receipt=require('../../src/accounting/postgres-stock-receipt'),commerce=require('../../src/operations/postgres-commerce');
  const modes=require('../../src/autopilot/job-modes'),supplierId='fixture-supplier';
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("UPDATE suppliers SET email='orders@parts.example.test' WHERE workspace_id=$1 AND id=$2",[ws,supplierId]);
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES($1,$2,$1,'Supplier purchase mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)`,[randomUUID(),ws]);

  // Two warehouses, four parts, two bundles sharing a strap, a bundle that
  // contains another bundle, and a ready-made display assembled from a recipe.
  const D=f.location.id,A=(await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Annex',kind:'warehouse'})).id;
  const item=async code=>(await catalog.createItem(db,ctx,{name:code.toLowerCase(),baseCode:code,trackingMode:'quantity'}));
  const BOLT=f.item.skuIds[0],STRAP=(await item('STRAP')).skuIds[0],CASE=(await item('CASE')).skuIds[0],LABEL=(await item('LABEL')).skuIds[0];
  const toolKit=await item('TOOL-KIT'),bagKit=await item('BAG-KIT'),giftSet=await item('GIFT-SET'),display=await item('DISPLAY-PACK');
  const TOOL=toolKit.skuIds[0],BAG=bagKit.skuIds[0],GIFT=giftSet.skuIds[0],DISPLAY=display.skuIds[0];
  await kits.define(db,ctx,{kitSkuId:TOOL,components:[{skuId:BOLT,quantity:2},{skuId:STRAP,quantity:1}]});
  await kits.define(db,ctx,{kitSkuId:BAG,components:[{skuId:STRAP,quantity:1},{skuId:CASE,quantity:1}]});
  await kits.define(db,ctx,{kitSkuId:GIFT,components:[{skuId:TOOL,quantity:1},{skuId:LABEL,quantity:1}]});
  await kits.define(db,ctx,{kitSkuId:DISPLAY,stockBasis:'preassembled',components:[{skuId:LABEL,quantity:3},{skuId:CASE,quantity:1}]});
  for(const [sku,unit,pack,cost] of [[BOLT,'unit',1,1],[STRAP,'unit',1,2],[CASE,'case',5,3],[LABEL,'unit',1,'0.5']])
    await commerce.linkSupplierItem(db,ctx,{supplierId,skuId:sku,purchaseUnit:unit,unitsPerPurchaseUnit:pack,lastUnitCost:cost,orderMultiple:1,minimumOrderQuantity:1,isPreferred:true});
  for(const [sku,location,quantity,cost] of [[STRAP,D,10,2],[CASE,D,6,3],[LABEL,D,12,'0.5'],[BOLT,A,6,1],[STRAP,A,1,2]])
    await receipt.receive(db,ctx,{skuId:sku,locationId:location,quantity,unitCost:cost,idempotencyKey:randomUUID()});

  // Real kit sales: three tool kits and two bags shipped from Dispatch.
  async function sell(sku,quantity){
    const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:D,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor:2000}]});
    await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),requireFullAllocation:true});
    await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),shipment:{handover:'COLLECTED'},lines:[{lineId:order.lineIds[0],quantity,kit:true}]});
  }
  await sell(TOOL,3);await sell(BAG,2);await sell(TOOL,1);
  // Real assembly: two displays built at Dispatch from labels and cases.
  const manufacturing=require('../../src/manufacturing/postgres-service'),ledger=require('../../src/accounting/postgres-ledger');
  await manufacturing.configure(db,ctx,{wipAccountId:(await ledger.createAccount(db,ctx,{code:'1221',name:'Assembly in progress',type:'ASSET'})).id});
  const bom=await manufacturing.createBom(db,ctx,{outputSkuId:DISPLAY,outputQuantity:1,components:[{skuId:LABEL,quantity:3},{skuId:CASE,quantity:1}]});
  await manufacturing.activateBom(db,ctx,bom.id,{expectedHash:bom.integrity_hash});
  const build=await manufacturing.createWorkOrder(db,ctx,{bomId:bom.id,quantity:2,neededBy:new Date().toISOString().slice(0,10),requestKey:'display-build'});
  await manufacturing.start(db,ctx,build.id,{idempotencyKey:'display-start',confirmed:'yes',materials:[{component:0,skuId:LABEL,locationId:D,quantity:6},{component:1,skuId:CASE,locationId:D,quantity:2}]});
  await manufacturing.complete(db,ctx,build.id,{good:2,scrap:0,locationId:D,confirmed:'yes',idempotencyKey:'display-complete'});
  // Two straps promised to a customer and five new cases held for QC are not available.
  const promised=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:D,idempotencyKey:randomUUID(),lines:[{skuId:STRAP,quantity:2,unitPriceMinor:500}]});
  await workflows.confirmSalesOrder(db,ctx,promised.salesOrderId,{idempotencyKey:randomUUID(),requireFullAllocation:true});
  const quality=require('../../src/operations/agent-quality-holds');
  await quality.save(db,ctx,{supplierId,skuId:CASE,locationId:D,checklist:['Check the cases are intact'],maxUnits:10,confirmed:'yes'});
  const qc=await workflows.createPurchaseOrder(db,ctx,{supplierId,destinationLocationId:D,idempotencyKey:randomUUID(),lines:[{skuId:CASE,purchaseUnit:'case',unitsPerPurchaseUnit:5,quantityUnits:5,unitCost:3}]});
  await workflows.approvePurchaseOrder(db,ctx,qc.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,qc.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,qc.purchaseOrderId,{idempotencyKey:randomUUID(),qcConfirmed:'yes',lines:[{lineId:qc.lineIds[0],quantity:5,locationId:D}]});
  // Saved kit targets: keep tool kits ready at Dispatch, bags and gift sets at the Annex.
  for(const [sku,location,point,target] of [[TOOL,D,6,10],[BAG,A,2,4],[GIFT,A,1,2]])
    await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'manual',now()::text,now()::text)`,[randomUUID(),ws,sku,location,point,target]);

  const kitWork=async()=>(await db.query(`SELECT id,recommended_action::jsonb a,approval_requirement,execution_status,purchase_order_id,policy_evaluation::jsonb e,error_message
    FROM work_items WHERE workspace_id=$1 AND recommended_action::jsonb ? 'kitDemand' ORDER BY created_at,id`,[ws])).rows;
  const open=async()=>(await kitWork()).filter(w=>['WAITING_FOR_APPROVAL','AUTHORIZED'].includes(w.execution_status));
  const waitingWork=async()=>(await db.query("SELECT id FROM work_items WHERE workspace_id=$1 AND source='postgres_autopilot' AND execution_status IN('WAITING_FOR_APPROVAL','AUTHORIZED')",[ws])).rows;
  const find=(rows,sku,location)=>rows.find(w=>w.a.skuId===sku&&w.a.destinationLocationId===location);
  const orders=async()=>Number((await db.query("SELECT count(*) n FROM purchase_orders WHERE workspace_id=$1 AND source='foundry_recommendation'",[ws])).rows[0].n);
  const fact=(work,name)=>work.a.evidence.find(e=>e.fact===name)?.value;

  // Starter only answers: every kit at every warehouse, and what limits it.
  await subscribe('starter');
  const starter=await reviews.run(db,ctx,'kit-capacity');
  assert.equal(starter.mode,'suggest');assert.equal(starter.rows.length,8);
  const said=starter.rows.map(r=>r.Suggestion);
  assert(said.includes('Build 2 TOOL-KIT at Dispatch now. Limited by STRAP: 2 available, 1 per kit (also used by BAG-KIT, GIFT-SET).'),said.join('\n'));
  assert(said.includes('Build 2 BAG-KIT at Dispatch now. Limited by CASE: 2 available, 1 per kit (also used by DISPLAY-PACK); STRAP: 2 available, 1 per kit (also used by GIFT-SET, TOOL-KIT).'),said.join('\n'));
  assert(said.includes('Build 1 TOOL-KIT at Annex now. Limited by STRAP: 1 available, 1 per kit (also used by BAG-KIT, GIFT-SET).'),said.join('\n'));
  assert(said.includes('GIFT-SET can’t be built at Annex now. Short: LABEL: 0 available, 1 per kit (also used by DISPLAY-PACK).'),said.join('\n'));
  assert(said.includes('Build 2 GIFT-SET at Dispatch now. Limited by STRAP: 2 available, 1 per kit (also used by BAG-KIT, TOOL-KIT).'),said.join('\n'));
  assert(said.includes('Build 2 DISPLAY-PACK at Dispatch now. Limited by CASE: 2 available, 1 per kit (also used by BAG-KIT); LABEL: 6 available, 3 per kit (also used by GIFT-SET).'),said.join('\n'));
  assert.deepEqual(await kitReorders.run(db,ctx),{skipped:'plan'});
  await assert.rejects(require('../../src/assistant/postgres-service').prepareAction(db,ctx,'Replenish parts',{action:'kit.replenish_parts',sku:'TOOL-KIT',quantity:2,location:'Dispatch'}),e=>e.code==='entitlement_required');
  assert.match((await f.browser.get('/autopilot/reviews/kit-capacity').expect(200)).text,/Build 2 TOOL-KIT at Dispatch now/);

  // Growth drafts every part order for approval, even for its Autopilot supplier.
  await subscribe('growth');
  const trusted=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY code',[ws,[BOLT,STRAP,CASE,LABEL]])).rows.map(r=>r.code).join('\n');
  await autonomy.configureRoutine(db,ctx,owner,{purchaseEnabled:true,supplierIds:[supplierId],trustedItemCodes:trusted,maximumValue:100,weeklyValue:400});
  await autonomy.setCapability(db,ctx,owner,'supplier_emails',true);
  const growthRun=await kitReorders.run(db,ctx);
  assert.equal(growthRun.planned,6,JSON.stringify(growthRun));assert.equal(growthRun.executed,0);
  let work=await kitWork();
  assert(work.every(w=>w.approval_requirement==='REQUIRED'&&w.execution_status==='WAITING_FOR_APPROVAL'&&/approve/.test(w.e.reason)),JSON.stringify(work.map(w=>w.e)));
  const expected=[[BOLT,D,8],[STRAP,D,8],[CASE,D,5],[STRAP,A,5],[CASE,A,5],[LABEL,A,2]];
  for(const [sku,location,quantity] of expected)assert.equal(Number(find(work,sku,location)?.a.quantity),quantity,sku+' at '+location);
  // One order per part and warehouse: the shared strap is not counted per kit.
  assert.equal(work.filter(w=>w.a.skuId===STRAP).length,2);
  const strapD=find(work,STRAP,D),caseD=find(work,CASE,D),labelA=find(work,LABEL,A),boltD=find(work,BOLT,D);
  assert.equal(fact(strapD,'available'),2,'promised straps are not available');assert.equal(fact(caseD,'available'),2,'cases on QC hold are not available');
  assert.equal(fact(caseD,'kit_sales_90_days'),2);assert.equal(fact(caseD,'kit_assembly_90_days'),2);assert.equal(fact(caseD,'reorder_point'),2);
  assert.equal(fact(boltD,'reorder_point'),12,'the saved tool-kit target replaces its sales history');assert.equal(fact(boltD,'target_stock'),20);
  assert.equal(fact(labelA,'used_in_kits'),'DISPLAY-PACK (3 each), GIFT-SET (1 each)');assert.match(fact(labelA,'saved_kit_targets'),/GIFT-SET: keep 1 to 2 ready/);
  assert.equal(Number(find(work,STRAP,A).a.reorderPoint),3,'bag and gift set needs add up once');
  // A replay adds nothing.
  assert.equal((await kitReorders.run(db,ctx)).planned,0);assert.equal((await kitWork()).length,6);
  // The owner approves one: it becomes a normal approved order sent to the supplier.
  const approved=await autonomy.approve(db,ctx,owner,labelA.id);
  assert(approved.purchase_order_id);assert.equal(approved.outcome.phase,'SUPPLIER_DELIVERY_PENDING');
  const line=(await db.query('SELECT l.sku_id,l.quantity_units,l.destination_location_id,o.status FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id WHERE o.workspace_id=$1 AND o.id=$2',[ws,approved.purchase_order_id])).rows[0];
  assert.deepEqual([line.sku_id,Number(line.quantity_units),line.destination_location_id,line.status],[LABEL,2,A,'APPROVED']);
  await assert.rejects(autonomy.approve(db,ctx,owner,labelA.id),/not ready/);
  assert.equal((await db.query('SELECT count(*)::int n FROM purchase_order_lines WHERE workspace_id=$1 AND sku_id=$2 AND destination_location_id=$3',[ws,LABEL,A])).rows[0].n,1,'approving twice orders once');
  // In the scheduled cycle, ordinary reorders leave kit parts to this job and
  // never buy a kit; transfers suggested for a kit count as stock on the way.
  const cycle=await autonomy.run(db,ctx);
  assert.equal(cycle.kitParts.planned,0,JSON.stringify(cycle.kitParts));
  // Parts each warehouse needs for its own kits are not moved away for another warehouse's kits.
  assert.equal((await db.query(`SELECT count(*)::int n FROM work_items WHERE workspace_id=$1 AND category='stock_transfer' AND execution_status<>'CANCELLED'`,[ws])).rows[0].n,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM work_items WHERE workspace_id=$1 AND category='replenishment_plan' AND NOT recommended_action::jsonb ? 'kitDemand'`,[ws])).rows[0].n,0);
  const ordinary=await autonomy.plan(db,ws,{onlySkuIds:[STRAP,CASE]});
  assert.equal(ordinary.created.length,0);assert(ordinary.considered.some(c=>c.reason==='kit_parts_reorder'&&c.skuId===STRAP&&c.locationId===D));

  // Pages render: the kit review and a waiting part order.
  const page=(await f.browser.get('/autopilot/reviews/kit-capacity').expect(200)).text;
  assert.match(page,/Kits you can build now/);assert.match(page,/STRAP: 8 waiting for approval/);assert.match(page,/Parts to order/);
  const workPage=(await f.browser.get('/autopilot/work/'+strapD.id).expect(200)).text;
  assert.match(workPage,/Part for BAG-KIT, GIFT-SET, TOOL-KIT/);assert.match(workPage,/Used in kits sold \(90 days\)/);
  await renders(f,[`/autopilot/reviews/kit-capacity`,'/autopilot/work/'+strapD.id]);

  // A stale approval stops: three straps arrived at the Annex after it was prepared.
  await receipt.receive(db,ctx,{skuId:STRAP,locationId:A,quantity:3,unitCost:2,idempotencyKey:randomUUID()});
  const stale=find(work,STRAP,A).id;
  await assert.rejects(autonomy.approve(db,ctx,owner,stale),/not ready|changed|no longer/);
  assert.match((await db.query('SELECT execution_status,error_message FROM work_items WHERE id=$1',[stale])).rows.map(r=>r.execution_status+': '+r.error_message)[0],/CANCELLED: Stock, incoming quantities/);
  // Watch only on this job, and a downgrade, stop approval.
  await modes.save(db,ctx,13,{mode:'watch',revision:0});
  await assert.rejects(autonomy.approve(db,ctx,owner,boltD.id),/Watch only/);
  await modes.save(db,ctx,13,{mode:'inherit',revision:1});
  await subscribe('starter');
  await assert.rejects(autonomy.approve(db,ctx,owner,boltD.id),e=>e.code==='entitlement_required');
  for(const w of await waitingWork())await autonomy.cancel(db,ctx,owner,w.id);

  // Pro orders alone inside the owner's per-order and weekly limits.
  await subscribe('pro');
  // This week already holds $36 of earlier orders, so $30 more is left.
  await autonomy.configureRoutine(db,ctx,owner,{purchaseEnabled:true,supplierIds:[supplierId],maximumValue:15,weeklyValue:66});
  await autonomy.setCapability(db,ctx,owner,'supplier_emails',true);
  const earlier=new Set((await kitWork()).map(w=>w.id)),before=await orders(),proRun=await kitReorders.run(db,ctx);
  // The straps that arrived at the Annex now cover it; four parts still need orders.
  assert.equal(proRun.planned,4,JSON.stringify(proRun));assert.equal(proRun.executed,2,JSON.stringify(await open()));
  assert.equal(await orders(),before+2);
  const proWork=(await kitWork()).filter(w=>!earlier.has(w.id)),unplaced=proWork.filter(w=>!w.purchase_order_id);
  assert.equal(unplaced.length,2);
  assert.match(find(unplaced,STRAP,D).e.reason,/approved limit is \$15\.00/);
  // The order over the weekly limit waits. If an order for the same part at
  // the other warehouse changed its stock facts first, it was replaced instead.
  const overWeek=unplaced.find(w=>w.a.skuId!==STRAP);
  assert(overWeek.execution_status==='WAITING_FOR_APPROVAL'&&/seven-day purchasing limit/.test(overWeek.e.reason)||
    overWeek.execution_status==='CANCELLED'&&/Stock, incoming quantities/.test(overWeek.error_message),JSON.stringify(overWeek));
  let waiting=await open();
  const placed=(await kitWork()).filter(w=>w.purchase_order_id&&w.id!==labelA.id);
  assert.equal(placed.length,2);
  const spent=(await db.query("SELECT coalesce(sum(l.line_total),0)::numeric total FROM purchase_order_lines l WHERE l.workspace_id=$1 AND l.purchase_order_id=ANY($2::text[])",[ws,placed.map(w=>w.purchase_order_id)])).rows[0].total;
  assert(Number(spent)<=30,'stays inside the weekly limit with the earlier orders');
  assert.equal((await db.query("SELECT count(*)::int n FROM supplier_communications WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[])",[ws,placed.map(w=>w.purchase_order_id)])).rows[0].n,2,'each order is queued to the supplier');
  // Replay is idempotent: a replaced order is prepared again once, still over
  // the weekly limit, and nothing is ordered twice.
  assert.equal((await kitReorders.run(db,ctx)).executed,0);
  assert.equal((await kitReorders.run(db,ctx)).planned,0);assert.equal(await orders(),before+2);
  waiting=await open();assert.equal(waiting.length,2);

  // Ask me first, Watch only for the inventory, pause and shadow all hold automatic orders.
  const sample=find(waiting,STRAP,D).a,decide=async()=>autonomy.evaluate(db,ws,sample,await autonomy.getState(db,ws));
  await modes.save(db,ctx,13,{mode:'ask',revision:2});
  assert.match((await decide()).reason,/Ask me first/);
  await modes.save(db,ctx,13,{mode:'inherit',revision:3});
  await autonomy.setMode(db,ctx,owner,'OBSERVE');assert.match((await decide()).reason,/watch only/);
  await assert.rejects(autonomy.approve(db,ctx,owner,find(waiting,STRAP,D).id),/watch-only/);
  await autonomy.setMode(db,ctx,owner,'POLICY_AUTOMATED');
  await autonomy.pause(db,ctx,owner,'Checking stock');assert.equal((await decide()).decision,'refused');
  assert.deepEqual(await kitReorders.run(db,ctx),{skipped:'paused'});
  await autonomy.resume(db,ctx,owner);
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  assert.match((await decide()).reason,/watch only/);
  await assert.rejects(autonomy.approve(db,ctx,owner,find(waiting,STRAP,D).id),/14 days|watching/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  // Custom orders alone inside its agreed limits.
  for(const w of await waitingWork())await autonomy.cancel(db,ctx,owner,w.id);
  await subscribe('enterprise');
  await db.query(`UPDATE commercial_plan_versions SET configuration=jsonb_set(configuration,'{agentPurchaseLimits}','{"currency":"USD","perOrder":20,"perWeek":100}'::jsonb)
    WHERE id=(SELECT plan_version_id FROM account_subscriptions WHERE account_id=$1)`,[f.owner.accountId]);
  await autonomy.configureRoutine(db,ctx,owner,{purchaseEnabled:true,supplierIds:[supplierId],maximumValue:20,weeklyValue:100});
  await autonomy.setCapability(db,ctx,owner,'supplier_emails',true);
  const customRun=await kitReorders.run(db,ctx);
  assert.equal(customRun.executed,2,JSON.stringify(customRun));assert.equal((await open()).length,0);
  assert.equal(await orders(),before+4);
  assert.equal((await kitReorders.run(db,ctx)).planned,0);

  // Bad data stops and asks: a kit target for all warehouses and a part with no supplier.
  const washer=(await item('WASHER')).skuIds[0],spare=(await item('SPARE-KIT')).skuIds[0];
  await kits.define(db,ctx,{kitSkuId:spare,components:[{skuId:washer,quantity:2}]});
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,1,2,'manual',now()::text,now()::text),($5,$2,$6,NULL,1,1,'manual',now()::text,now()::text)`,[randomUUID(),ws,spare,D,randomUUID(),BAG]);
  const held=await kitReorders.run(db,ctx);
  assert.equal(held.planned,0);assert.match(held.held.find(h=>h.skuId===washer).reason,/Save a supplier and its current price for WASHER/);
  const review=await reviews.run(db,ctx,'kit-capacity');
  assert.match(review.rows.find(r=>r.Kit==='SPARE-KIT'&&r.Warehouse==='Dispatch')['Parts to order'],/Save a supplier/);
  assert.match(review.rows.find(r=>r.Kit==='BAG-KIT')['Review'],/each warehouse/);

  // Every order is in the security audit.
  const audit=Object.fromEntries((await db.query("SELECT action,count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Kit part%' GROUP BY action",[ws])).rows.map(r=>[r.action,r.n]));
  assert.deepEqual(audit,{'Kit part order approved':1,'Kit parts ordered on their own':4});
});

async function renders(f,paths){
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  try{
    const origin='http://127.0.0.1:'+server.address().port,shots=process.env.KIT_SHOTS;
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
      const page=await chrome.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500}),errors=[];
      page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
      for(const path of paths){
        await page.goto(origin+path);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scrolling at '+viewport.width+' on '+path);
        if(shots)await page.screenshot({path:require('node:path').join(shots,path.split('/').filter(Boolean).slice(-1)[0].slice(0,20)+'-'+viewport.width+'.png'),fullPage:true});
      }
      assert.deepEqual(errors,[]);
      await page.close();
    }
  }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
}
