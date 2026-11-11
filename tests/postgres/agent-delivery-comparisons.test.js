'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const service=require('../../src/purchasing/agent-delivery-comparisons');

test('actual delivery comparisons preserve exact plan gates, native stock, original wrong-item evidence and retries',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:4,unitCost:1,supplierSku:'DELIVERY-SUPPLIER-CODE'}]});
  await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const facts=await service.source(db,ctx,po.purchaseOrderId);
  const {hash}=require('../../src/pricing/postgres-promotions');
  const input={orderId:po.purchaseOrderId,requestKey:randomUUID(),sourceHash:hash(facts),sourceReference:'Actual delivery note 100',
    physicallyChecked:'yes',observations:[{code:'DELIVERY-SUPPLIER-CODE',quantity:'3'},{code:'WRONG-DELIVERED-CODE',quantity:'2',unit:'carton'}]};
  await f.subscribe('starter');
  const starter=await service.page(db,ctx);
  assert.equal(starter.allowed,false);
  assert(starter.suggestion);
  await assert.rejects(service.save(db,ctx,input),error=>error.code==='entitlement_required'&&/Growth/.test(error.message));
  const locked=await f.browser.get(service.path);
  assert.equal(locked.status,200);
  assert.match(locked.text,/Growth/);
  assert.doesNotMatch(locked.text,/Check quantities, codes and weights<\/button>/);
  let first;
  for(const tier of ['growth','pro','enterprise']){
    await f.subscribe(tier);
    const saved=await service.save(db,ctx,{...input,requestKey:randomUUID()});
    first=first||saved;
    assert.equal(saved.result.agrees,false);
    assert.equal(saved.result.rows[0].short,1);
    assert.equal(saved.result.unexpected[0].code,'WRONG-DELIVERED-CODE');
    const detail=await f.browser.get(service.path+'/'+saved.id);
    assert.equal(detail.status,200,detail.text.slice(-2000));
    assert.match(detail.text,/Short by 1/);
    assert.match(detail.text,/WRONG-DELIVERED-CODE/);
  }
  const before=(await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
  const journalCount=(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
  const concurrent=await Promise.all([service.save(db,ctx,input),service.save(db,ctx,input)]);
  assert.equal(concurrent[0].id,concurrent[1].id);
  assert.equal(concurrent.filter(row=>row.replayed).length,1);
  await assert.rejects(service.save(db,ctx,{...input,observations:[{code:facts.lines[0].code,quantity:4}]}),/different actual goods/);
  assert.equal(await f.balance(),20);
  assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before);
  assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,journalCount);
  await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'Actual accepted unit',
    lines:[{lineId:po.lineIds[0],quantity:1,locationId:f.location.id}]});
  await assert.rejects(service.save(db,ctx,{...input,requestKey:randomUUID()}),/received quantities changed/);
  await f.subscribe('starter');
  assert.equal((await service.page(db,ctx,{id:first.id})).record.result.rows[0].short,1);
  await assert.rejects(service.save(db,ctx,{...input,requestKey:randomUUID()}),error=>error.code==='entitlement_required');
  const timing=(await require('../../src/autopilot/time-saved').report(db,ctx,'week')).rows.find(row=>row.key==='delivery-comparison');
  assert.equal(timing.count,1,'Repeated comparisons of the same original delivery count once');
  assert.equal(timing.minutes,null);
  const beforeUpgrade=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
  assert.deepEqual(await require('../../src/db/migrate-postgres').migratePostgres(db),[]);
  assert.deepEqual((await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows,beforeUpgrade);
});

test('a phone owner records an actual short delivery with a wrong item and sees the saved comparison',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  await f.subscribe('growth');
  const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:4,unitCost:1}]});
  await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const handle=app.listen(0,'127.0.0.1',()=>resolve(handle));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const origin='http://127.0.0.1:'+server.address().port;
  const navigate=async click=>Promise.all([page.waitForNavigation(),click()]);
  await page.goto(origin+'/login');
  await page.locator('[name=email]').fill(f.email);
  await page.locator('[name=password]').fill(f.password);
  await navigate(()=>page.locator('button[type=submit]').click());
  await page.goto(origin+'/purchasing/orders/'+po.purchaseOrderId);
  await navigate(()=>page.getByRole('link',{name:'Compare actual delivery',exact:true}).click());
  await page.getByLabel('Original delivery reference',{exact:true}).fill('PHONE-DELIVERY-1');
  await page.locator('[name="observations[0][quantity]"]').fill('3');
  await page.locator('[name="observations[1][code]"]').fill('ACTUAL-WRONG-CODE');
  await page.locator('[name="observations[1][quantity]"]').fill('1');
  await page.getByRole('button',{name:'Add another delivery row',exact:true}).click();
  await page.locator('[name="observations[4][code]"]').fill('SECOND-WRONG-CODE');
  await page.locator('[name="observations[4][quantity]"]').fill('1');
  await page.locator('[name=physicallyChecked]').check();
  await navigate(()=>page.getByRole('button',{name:'Check quantities, codes and weights',exact:true}).click());
  assert.match(await page.locator('main').innerText(),/Short by 1/);
  assert.match(await page.locator('main').innerText(),/ACTUAL-WRONG-CODE/);
  assert.match(await page.locator('main').innerText(),/SECOND-WRONG-CODE/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  require('node:fs').mkdirSync('output',{recursive:true});
  await page.screenshot({path:'output/delivery-comparison-phone.png',fullPage:true});
  assert.equal(await f.balance(),20);
});

test('native delivery comparisons preserve variants, tracked goods, fractional units, independent weights and finished kits',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  await f.subscribe('pro');
  const catalog=require('../../src/domain/postgres-catalog-service');
  const examples=[
    {name:'Fabric',trackingMode:'quantity',unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001',quantity:'1.25'},
    {name:'Weighed goods',trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,quantity:2,secondaryQuantity:'3.35'},
    {name:'Batch goods',trackingMode:'lot',quantity:2},
    {name:'Serial goods',trackingMode:'serial',quantity:2},
    {name:'Flavored goods',trackingMode:'quantity',hasVariants:true,options:[{name:'Flavor',values:'Vanilla,Chocolate'}],quantity:2},
    {name:'Finished bundle',trackingMode:'quantity',quantity:2,kit:true}
  ];
  const products=[];
  for(const example of examples){
    const item=await catalog.createItem(db,ctx,{...example,baseCode:'DELIVERY-'+randomUUID().slice(0,7)});
    if(example.kit)await require('../../src/domain/postgres-kit-service').define(db,ctx,{kitSkuId:item.skuIds[0],
      components:[{skuId:f.item.skuIds[0],quantity:2}]});
    products.push({...example,skuId:item.skuIds[0]});
  }
  const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:products.map(product=>({skuId:product.skuId,quantityUnits:product.quantity,
      secondaryQuantity:product.secondaryQuantity,unitCost:1}))});
  await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const snapshot=await service.source(db,ctx,po.purchaseOrderId);
  const observations=snapshot.lines.map(line=>({code:line.code,quantity:line.quantity_units,
    secondaryQuantity:line.secondary_unit_label?'3.30':null}));
  const saved=await service.save(db,ctx,{orderId:po.purchaseOrderId,requestKey:randomUUID(),
    sourceHash:require('../../src/pricing/postgres-promotions').hash(snapshot),sourceReference:'Actual multi-product delivery',
    physicallyChecked:'yes',observations});
  assert.equal(saved.result.unexpected.length,0);
  assert.equal(saved.result.rows.filter(row=>!row.agrees).length,1);
  const measured=saved.result.rows.find(row=>row.weightUnit);
  assert.equal(measured.observedWeight,'3.3');
  assert.match(measured.findings.join(' '),/0.05 kg still due/);
  assert(saved.result.rows.find(row=>row.name.startsWith('Flavored goods')).name.includes(' / '));
  assert.equal(saved.result.rows.find(row=>row.unit==='m').observed,'1.25');
  const formPage=await f.browser.get(service.path+'?orderId='+po.purchaseOrderId);
  const largeForm=new URLSearchParams({_csrf:f.csrf(formPage.text),orderId:po.purchaseOrderId,
    sourceHash:require('../../src/pricing/postgres-promotions').hash(snapshot),requestKey:randomUUID(),
    sourceReference:'Original large delivery note',physicallyChecked:'yes'});
  for(let index=0;index<500;index++){
    largeForm.set('observations['+index+'][code]','未知-'+index+'-'+'測'.repeat(100));
    largeForm.set('observations['+index+'][quantity]','1');
    largeForm.set('observations['+index+'][basis]','stock');
  }
  assert(Buffer.byteLength(largeForm.toString())>256*1024);
  const posted=await f.browser.post(service.path).type('form').send(largeForm.toString());
  assert.equal(posted.status,303,posted.text.slice(-2000));
  const large=await service.page(db,ctx,{id:posted.headers.location.split('/').at(-1)});
  assert.equal(large.record.result.unexpected.length,500);
  assert.equal(await f.balance(),20);
});
