'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const workflow=require('../../src/purchasing/agent-open-to-buy');
const budgets=require('../../src/purchasing/agent-budgets');
const orders=require('../../src/operations/postgres-business-workflows');
const commerce=require('../../src/operations/postgres-commerce');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers').create();
const autopilot=require('../../src/autopilot/postgres-service');
const modes=require('../../src/autopilot/job-modes');
const time=require('../../src/lib/business-time');
const {addDays}=require('../../src/accounting/customer-money');
const exact=require('../../src/domain/exact-quantity');

test('Custom monthly buying plans allocate exact category and currency packs and recheck native spend',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:2}),{db,ctx,subscribe,browser,location}=f;
  const {workspaceId}=ctx,today=await time.today(db,workspaceId);
  const nextStart=addDays(today.slice(0,7)+'-01',32).slice(0,7)+'-01',month=nextStart.slice(0,7);
  const lead=Math.round((Date.parse(nextStart)-Date.parse(today))/86400000)+2,arrival=addDays(today,lead);
  const annex=await locations.createLocation(db,ctx,{name:'Budget annex',kind:'warehouse'});
  await subscribe('enterprise');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const packSupplier=await commerce.createSupplier(db,ctx,{name:'Packed supply',currency:'USD'});
  await db.query('UPDATE suppliers SET minimum_order_amount=30 WHERE workspace_id=$1 AND id=$2',[workspaceId,packSupplier.id]);
  const euro=await commerce.createSupplier(db,ctx,{name:'Euro supply',currency:'EUR'});
  async function item(code,category,extra={}){
    const result=await catalog.createItem(db,ctx,{name:code,baseCode:code,trackingMode:'quantity',...extra});
    await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,$3,'{}',now(),now())`,
      [workspaceId,result.itemId,category]);
    return result.skuIds[0];
  }
  async function reorder(sku,site,target,supplier,cost,terms={}){
    await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:sku,lastUnitCost:cost,purchaseUnit:'unit',
      unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1,isPreferred:true,leadTimeDays:lead,...terms});
    await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$5,0,'manual',now()::text,now()::text)`,[randomUUID(),workspaceId,sku,site.id,target]);
  }
  const bolts=await item('A-BOLTS','Hardware');
  const cable=await item('B-CABLE','Hardware',{unitLabel:'metre',quantityPrecision:2,quantityIncrement:'0.25'});
  const weightedSpend=await item('COMMITTED-WEIGHT','Hardware',{secondaryUnitLabel:'kg',secondaryPrecision:3});
  const labels=await item('EUR-LABELS','Labels');
  const late=await item('LATE-ORDER','Hardware');
  const unknown=await item('UNPRICED-ORDER','Hardware');
  const measured=await item('MEASURED-REQUEST','Cold',{secondaryUnitLabel:'kg',secondaryPrecision:3});
  await reorder(bolts,location,12,packSupplier,3,{purchaseUnit:'box',unitsPerPurchaseUnit:4});
  await reorder(cable,annex,'2.75',packSupplier,4,{purchaseUnit:'quarter metre',unitsPerPurchaseUnit:'0.25'});
  await reorder(labels,annex,3,euro,4);
  await reorder(late,location,2,packSupplier,2,{leadTimeDays:lead+35});
  await reorder(unknown,location,2,packSupplier,2);
  await db.query('UPDATE supplier_items SET last_unit_cost=NULL WHERE workspace_id=$1 AND sku_id=$2',[workspaceId,unknown]);
  await reorder(measured,annex,2,{id:'fixture-supplier'},2);
  for(const [category,currency,amount] of [['hardware','USD','50.00'],['labels','EUR','18.00'],['cold','USD','15.00']])
    await budgets.save(db,ctx,{month,category,currency,amount,revision:0});
  const commitment=await orders.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,expectedDate:arrival,
    lines:[{skuId:weightedSpend,quantityUnits:4,secondaryQuantity:'10',unitCost:2}],idempotencyKey:randomUUID()});
  const approve=(id)=>orders.approvePurchaseOrder(db,ctx,id,{idempotencyKey:randomUUID()});
  await approve(commitment.purchaseOrderId);
  await orders.placePurchaseOrder(db,ctx,commitment.purchaseOrderId,{idempotencyKey:randomUUID()});
  await orders.receivePurchaseOrder(db,ctx,commitment.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:commitment.lineIds[0],quantity:4,secondaryQuantity:'10',locationId:location.id}]});
  await orders.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:commitment.purchaseOrderId,supplierInvoiceNumber:'WEIGHED-MONTH',
    issueDate:nextStart,dueDate:nextStart,currency:'USD',idempotencyKey:randomUUID(),lines:[{
      purchaseOrderLineId:commitment.lineIds[0],skuId:weightedSpend,quantity:1,secondaryQuantity:'4',unitCostMinor:200,
    }]});
  const capacity=()=>budgets.headroom(db,workspaceId,{month,today});
  const hardware=(await capacity()).find(row=>row.category==='hardware'&&row.currency==='USD');
  assert.deepEqual([hardware.budget,hardware.spent,hardware.committed,hardware.remaining],[5000,800,1200,3000]);
  const count=async table=>Number((await db.query(`SELECT count(*) n FROM ${table} WHERE workspace_id=$1`,[workspaceId])).rows[0].n);
  const effects=async()=>Promise.all(['purchase_orders','movements','accounting_journal_entries','accounting_payments','stockchief_runtime.provider_effects'].map(count));
  const before=await effects(),path=workflow.path,request={month,secondaryQuantities:'MEASURED-REQUEST | '+annex.name+' | 2 | 5.125'};
  for(const tier of ['starter','growth','pro']){
    await subscribe(tier);
    const locked=await browser.get(path+'?month='+month).expect(200);
    assert.match(locked.text,/data-agent-plan-locked/);
    assert.match(locked.text,/Custom/);
    await browser.get(path+'?month='+month).set('Accept','application/json').expect(402);
    await assert.rejects(workflow.prepare(db,ctx,request),e=>e.code==='entitlement_required');
    await assert.rejects(workflow.configure(db,ctx,{confirmed:'yes'}),e=>e.code==='entitlement_required');
  }
  await subscribe('enterprise');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const base='http://127.0.0.1:'+server.address().port;
  await phone.goto(base+'/login');await phone.locator('[name=email]').fill(f.email);await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(base+'/autopilot/reviews/open-to-buy?filter='+month);
  await phone.getByRole('link',{name:'Open monthly buying plans'}).click();
  await phone.locator('textarea[name=secondaryQuantities]').fill(request.secondaryQuantities);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Prepare plan for '+month}).click()]);
  const id=new URL(phone.url()).pathname.split('/').at(-1);
  let view=await workflow.page(db,ctx,{id});
  assert.equal((await workflow.prepare(db,ctx,request)).id,id);
  const manual=view.saved.snapshot,planned=manual.groups.find(group=>group.supplierId===packSupplier.id);
  assert.equal(planned.totalMinor,3000);
  assert.equal(planned.expectedDate,arrival);
  assert.deepEqual(planned.lines.map(l=>[l.code,l.locationId,l.quantityUnits,l.quantityPurchaseUnits,l.amountMinor]),
    [['A-BOLTS',location.id,'8','2',2400],['B-CABLE',annex.id,'1.5','6',600]]);
  assert.equal(manual.groups.find(group=>group.currency==='EUR').totalMinor,1200);
  assert.equal(manual.groups.find(group=>group.lines[0].skuId===measured).totalMinor,1025);
  assert.match(manual.held.find(row=>row.skuId===late).reason,/after this budget month/);
  assert.match(manual.held.find(row=>row.skuId===unknown).reason,/current cost/);
  assert.match(await phone.locator('main').innerText(),/Budget funds part of the reorder/);
  assert.equal(await phone.locator('body').evaluate(b=>b.scrollWidth<=innerWidth+2),true);
  assert.deepEqual(await effects(),before);

  const confirmed={evidence:view.saved.evidence_hash,confirmed:'yes'};
  await subscribe('pro');
  await assert.rejects(workflow.prepareDrafts(db,ctx,id,confirmed),e=>e.code==='entitlement_required');
  await subscribe('enterprise');
  await budgets.save(db,ctx,{month,category:'hardware',currency:'USD',amount:'52.00',revision:1});
  await assert.rejects(workflow.prepareDrafts(db,ctx,id,confirmed),/Budget, stock/);
  const current=await workflow.prepare(db,ctx,request),fresh=await workflow.page(db,ctx,{id:current.id});
  await phone.goto(base+path+'/'+current.id);
  await phone.getByLabel('I reviewed the budget, supplier terms, quantities and delivery dates.').check();
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Create unsent purchase drafts'}).click()]);
  view=await workflow.page(db,ctx,{id:current.id});
  assert.equal(view.orders.length,3);
  assert(view.orders.every(po=>po.status==='DRAFT'));
  assert((await workflow.prepareDrafts(db,ctx,current.id,{evidence:fresh.saved.evidence_hash,confirmed:'yes'})).replayed);
  assert.deepEqual(await effects(),[before[0]+3,...before.slice(1)]);
  const linked=(await db.query(`SELECT p.id,p.status FROM purchase_orders p JOIN stockchief_runtime.agent_open_to_buy_drafts d
    ON d.workspace_id=p.workspace_id AND d.purchase_order_id=p.id WHERE p.workspace_id=$1 AND d.plan_id=$2 AND p.supplier_id=$3`,
    [workspaceId,current.id,packSupplier.id])).rows[0];
  const currentCapacity=(await capacity()).find(row=>row.category==='hardware'&&row.currency==='USD');
  assert.deepEqual([currentCapacity.reserved,currentCapacity.remaining],[3200,0]);
  const packedLines=(await db.query('SELECT quantity_units,quantity_purchase_units,destination_location_id FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number',
    [workspaceId,linked.id])).rows;
  assert.deepEqual(packedLines.map(l=>[exact.canonical(l.quantity_units),exact.canonical(l.quantity_purchase_units),l.destination_location_id]),
    [['8','2',location.id],['2','8',annex.id]]);

  await subscribe('pro');
  await assert.rejects(approve(linked.id),e=>e.code==='entitlement_required');
  await subscribe('enterprise');
  await db.query('UPDATE supplier_items SET last_unit_cost=3.25 WHERE workspace_id=$1 AND sku_id=$2',[workspaceId,bolts]);
  await assert.rejects(approve(linked.id),/current supplier terms/);
  await db.query('UPDATE supplier_items SET last_unit_cost=3 WHERE workspace_id=$1 AND sku_id=$2',[workspaceId,bolts]);
  const competing=await orders.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,expectedDate:arrival,
    lines:[{skuId:bolts,quantityUnits:1,unitCost:4}],idempotencyKey:randomUUID()});
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const ordinary=db.transaction(async c=>{
    await require('../../src/purchasing/postgres-purchase-exposure').lock(c,workspaceId);started();
    await gate;
    return orders.approvePurchaseOrder({transaction:work=>work(c),query:(...args)=>c.query(...args)},ctx,competing.purchaseOrderId,{idempotencyKey:randomUUID()});
  },{isolation:'SERIALIZABLE',retrySafe:true});
  await entered;
  const blocked=assert.rejects(approve(linked.id),/current category budget/);
  let waiting=false;
  for(let i=0;i<50&&!waiting;i++){
    waiting=(await db.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) LIMIT 1`)).rowCount>0;
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,20));
  }
  release();
  assert(waiting,'The budgeted approval waits on the concurrent ordinary purchase transaction');
  assert.equal((await ordinary).status,'APPROVED');
  await blocked;
  await orders.cancelPurchaseOrder(db,ctx,competing.purchaseOrderId,{reason:'Competing ordinary draft closed',idempotencyKey:randomUUID()});
  assert.equal((await approve(linked.id)).status,'APPROVED');
  const approved=(await capacity()).find(row=>row.category==='hardware'&&row.currency==='USD');
  assert.deepEqual([approved.committed,approved.reserved,approved.remaining],[4400,0,0]);
  assert.equal(await count('stockchief_runtime.provider_effects'),before[4]);
  const beforeRoutine=await effects();

  await workflow.configure(db,ctx,{confirmed:'yes'});
  const run=(kind)=>queue.processOne(db,handlers,{owner:'open-to-buy-test',kinds:[kind],leaseMs:120000});
  const evaluate=async()=>{
    await queue.enqueue(db,{workspaceId,kind:'autopilot.evaluate',idempotencyKey:randomUUID(),payload:{actorId:ctx.actorId,requestedByUser:true}});
    const result=await run('autopilot.evaluate');
    assert.equal(result?.status,'COMPLETED',JSON.stringify(result?.lastError));
  };
  await evaluate();
  await subscribe('pro');
  assert.match((await run(workflow.kind)).result.held,/Custom/);
  await subscribe('enterprise');
  await evaluate();
  await modes.save(db,ctx,26,{mode:'watch',revision:0});
  assert.match((await run(workflow.kind)).result.held,/Watch only/);
  await modes.save(db,ctx,26,{mode:'routine',revision:1});
  await evaluate();
  const routine=await run(workflow.kind);
  assert.equal(routine?.status,'COMPLETED',JSON.stringify(routine?.lastError));
  assert.equal((await workflow.page(db,ctx,{id:routine.result.id})).saved.automatic,true);
  await evaluate();
  assert.deepEqual((await run(workflow.kind)).result,{id:routine.result.id,replayed:true});
  await evaluate();
  const rule=(await workflow.page(db,ctx,{month})).rule;
  await subscribe('pro');
  assert((await workflow.configure(db,ctx,{revision:rule.revision,stop:'yes'})).stopped);
  await subscribe('enterprise');
  assert.match((await run(workflow.kind)).result.held,/scope changed/);
  assert.deepEqual(await effects(),beforeRoutine);

  const undated=await orders.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,
    lines:[{skuId:weightedSpend,quantityUnits:2,secondaryQuantity:'3.125',unitCost:2}],idempotencyKey:randomUUID()});
  await approve(undated.purchaseOrderId);
  const uncertain=(await capacity()).find(row=>row.category==='hardware'&&row.currency==='USD');
  assert.equal(uncertain.undated,1);
  assert.equal(uncertain.remaining,null);
});
