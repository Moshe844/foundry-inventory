'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const inv=require('../../src/domain/postgres-inventory-engine'),catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');

// Job 145: a recorded promotion with products from two suppliers is planned
// once and drafts one purchase order per supplier.
async function promotion(t){
 const f=await require('../helpers/agent-promotion-stock-fixture').fixture(t),{db,ctx}=f;
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('coastal-supplier',$1,'Coastal goods','active','USD',now()::text,now()::text)",[ctx.workspaceId]);
 async function product(code,supplierId){
  const sku=(await catalog.createItem(db,ctx,{name:'Promo '+code,baseCode:code,trackingMode:'quantity'})).skuIds[0];
  await inv.receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:4,idempotencyKey:randomUUID()});
  for(let i=0;i<2;i++)await inv.issue(db,ctx,{skuId:sku,locationId:f.location.id,quantity:2,reasonCode:'sold',idempotencyKey:randomUUID()});
  if(supplierId)await commerce.linkSupplierItem(db,ctx,{supplierId,skuId:sku,purchaseUnit:'pack',unitsPerPurchaseUnit:6,lastUnitCost:2,minimumOrderQuantity:1,orderMultiple:1,isPreferred:true});
  return sku;
 }
 const towel=await product('TOWEL-'+randomUUID().slice(0,6),'coastal-supplier'),loose=await product('LOOSE-'+randomUUID().slice(0,6),null);
 const time=require('../../src/lib/business-time'),{addDays}=require('../../src/accounting/customer-money'),{timeZone}=await time.forWorkspace(db,ctx.workspaceId);
 async function record(name,scope){
  const id=randomUUID();await db.query('INSERT INTO stockchief_runtime.pricing_rules(id,workspace_id,revision) VALUES($1,$2,1)',[id,ctx.workspaceId]);
  await db.query('INSERT INTO stockchief_runtime.pricing_rule_versions(id,workspace_id,rule_id,revision,definition,created_by) VALUES($1,$2,$3,1,$4,$5)',[randomUUID(),ctx.workspaceId,id,
   {kind:'promotion',name,currency:'USD',enabled:true,priority:1,scope,discount:{type:'percent',value:2000},startsAt:time.dayBoundary(addDays(f.today,7),timeZone),endsAt:time.dayBoundary(addDays(f.today,90),timeZone)},ctx.actorId]);
  return id;
 }
 const sale=await record('Summer sale',{skuIds:[f.skuId,towel]}),category=await record('Category sale',{categoryIds:['Towels']});
 const code=async id=>(await db.query('SELECT code FROM skus WHERE id=$1',[id])).rows[0].code;
 const form={pricingRuleId:sale,locationName:f.location.name,orderByDate:f.input.orderByDate,arrivalDate:f.input.arrivalDate,upliftPercent:'100'};
 const queue=require('../../src/operations/postgres-job-queue'),handler=require('../../src/operations/postgres-runtime-handlers').create()[f.service.jobKind];
 const work=owner=>queue.processOne(db,{[f.service.jobKind]:handler},{owner});
 const purchases=async()=>(await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 return {...f,towel,loose,sale,category,code,form,work,purchases};
}
const plansOf=preview=>JSON.stringify(preview.drafts.map(d=>({supplierId:d.scope.supplierId,skuIds:d.scope.skuIds,sourceFingerprint:d.sourceFingerprint})));
const common=preview=>{const s=preview.drafts[0].scope;return {locationId:s.locationId,reference:s.reference,orderByDate:s.orderByDate,arrivalDate:s.arrivalDate,startsOn:s.startsOn,endsOn:s.endsOn,upliftPercent:String(s.upliftPercent),confirmed:'yes',plans:plansOf(preview)};};

test('a recorded promotion drafts one purchase order per supplier: Pro reviews each, Custom prepares them alone within its limit, and undo works',{timeout:600000},async t=>{
 const f=await promotion(t),{db,ctx,service}=f;
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(service.preview(db,ctx,f.form),e=>e.code==='entitlement_required');}
 await f.subscribe('pro');
 assert.deepEqual((await service.list(db,ctx)).promotions.map(p=>[p.name,p.startsOn,p.endsOn]).sort(),[['Category sale',f.input.startsOn,f.input.endsOn],['Summer sale',f.input.startsOn,f.input.endsOn]]);
 const preview=await service.preview(db,ctx,f.form);
 assert.deepEqual(preview.drafts.map(d=>[d.supplier.name,d.scope.reference,d.scope.startsOn,d.scope.endsOn,d.scope.skuIds,d.calculated.rows[0].expectedUnits,d.calculated.totalMinor]),
  [['Fixture parts','Summer sale',f.input.startsOn,f.input.endsOn,[f.skuId],8,2400],['Coastal goods','Summer sale',f.input.startsOn,f.input.endsOn,[f.towel],8,2400]]);
 // Missing facts stop and ask.
 await assert.rejects(service.preview(db,ctx,{...f.form,pricingRuleId:f.category}),/covers whole categories/);
 await assert.rejects(service.preview(db,ctx,{...f.form,pricingRuleId:'',skuCodes:await f.code(f.loose),reference:'Loose',startsOn:f.input.startsOn,endsOn:f.input.endsOn}),/Record the supplier you buy/);
 await assert.rejects(service.preview(db,ctx,{...f.form,pricingRuleId:''}),/Enter the products on promotion/);
 // Pro: save both, then prepare each draft after review. Nothing is automatic.
 const saved=await service.saveAll(db,ctx,common(preview));assert.equal(saved.length,2);
 assert.deepEqual((await service.saveAll(db,ctx,common(preview))).map(s=>s.replayed),[true,true]);
 await assert.rejects(service.configure(db,ctx,saved[0].promotionId,{revision:1,refreshDays:'1',maximumAmount:'24.00',confirmed:'yes',sourceFingerprint:preview.drafts[0].sourceFingerprint}),e=>e.code==='entitlement_required');
 const before=await f.purchases();
 const first=await service.purchase(db,ctx,saved[0].id,{confirmed:'yes',sourceFingerprint:preview.drafts[0].sourceFingerprint});
 assert.equal(await f.purchases(),before+1);
 // Undo cancels the unchanged draft; a reviewed draft can then be prepared again.
 assert.equal((await service.undo(db,ctx,saved[0].id)).replayed,false);
 assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[first.purchaseOrderId])).rows[0].status,'CANCELLED');
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Promotion purchase draft undone'",[ctx.workspaceId])).rows[0].n,1);
 const again=await service.purchase(db,ctx,saved[0].id,{confirmed:'yes',sourceFingerprint:preview.drafts[0].sourceFingerprint});
 assert.notEqual(again.purchaseOrderId,first.purchaseOrderId);assert.equal((await db.query('SELECT status FROM purchase_orders WHERE id=$1',[again.purchaseOrderId])).rows[0].status,'DRAFT');
 assert.equal((await service.purchase(db,ctx,saved[0].id,{confirmed:'yes',sourceFingerprint:preview.drafts[0].sourceFingerprint})).purchaseOrderId,again.purchaseOrderId,'One live draft per promotion plan');
 // Custom: the second supplier's draft is prepared alone, inside the owner's limit.
 await f.subscribe('enterprise');
 await service.configure(db,ctx,saved[1].promotionId,{revision:1,refreshDays:'1',maximumAmount:'24.00',confirmed:'yes',sourceFingerprint:preview.drafts[1].sourceFingerprint});
 const done=await f.work('promotion-coastal');assert.equal(done.status,'COMPLETED',JSON.stringify(done));assert(done.result.purchaseOrderId);
 const order=(await db.query('SELECT status,supplier_id FROM purchase_orders WHERE id=$1',[done.result.purchaseOrderId])).rows[0];
 assert.deepEqual([order.status,order.supplier_id],['DRAFT','coastal-supplier']);
 const page=await service.page(db,ctx,saved[1].promotionId);assert.equal(page.draft.automatic,true);assert.equal(page.project.enabled,false);
 assert.equal(await f.purchases(),before+3);assert.equal(await f.balance(),0);
});

test('phone and desktop: a recorded promotion is chosen, reviewed for both suppliers and saved together',{timeout:600000},async t=>{
 const f=await promotion(t),{db,ctx}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port,flat=tab=>tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
 for(const [i,viewport] of [{width:390,height:844},{width:1440,height:900}].entries()){
  const tab=await browser.newPage({viewport,...(viewport.width<500?{isMobile:true,hasTouch:true}:{})});tab.setDefaultTimeout(12000);
  await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await tab.goto(origin+'/autopilot/promotion-stock');
  await tab.locator('[name=pricingRuleId]').selectOption(f.sale);
  await tab.locator('[name=locationName]').fill(f.location.name);await tab.locator('[name=reference]').fill('Summer sale '+i);
  for(const key of ['orderByDate','arrivalDate','upliftPercent'])await tab.locator('[name='+key+']').fill(f.form[key]);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Review promotion stock plan',exact:true}).click()]);
  const text=await tab.locator('main').innerText();assert.match(text,/come from 2 suppliers/);assert.match(text,/Coastal goods/);assert.match(text,/Fixture parts/);
  assert.ok(await flat(tab),'No sideways scrolling at '+viewport.width+' px');
  await tab.locator('form[action="/autopilot/promotion-stock"] [name=confirmed]').check();
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Save reviewed promotion plans',exact:true}).click()]);
  assert.equal(new URL(tab.url()).pathname,'/autopilot/promotion-stock');
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_promotion_stock WHERE workspace_id=$1 AND reference=$2',[ctx.workspaceId,'Summer sale '+i])).rows[0].n,2);
  assert.ok(await flat(tab),'No sideways scrolling at '+viewport.width+' px');
  await tab.close();
 }
});
