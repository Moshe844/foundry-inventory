'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {hash}=require('../../src/pricing/postgres-promotions');
const checks=require('../../src/purchasing/agent-delivery-comparisons');

async function recorded(f,order,{actual,weight,code,reference=randomUUID()}){
  const snapshot=await checks.source(f.db,f.ctx,order.purchaseOrderId);
  const row={code:code||snapshot.lines[0].code,lineId:order.lineIds[0],basis:'stock',quantity:actual};
  if(weight!=null)row.secondaryQuantity=weight;
  const comparison=await checks.save(f.db,f.ctx,{orderId:order.purchaseOrderId,observations:[row],
    sourceReference:reference,requestKey:randomUUID(),sourceHash:hash(snapshot),physicallyChecked:'yes'});
  const input={comparisonId:comparison.id,lineId:order.lineIds[0],connectorId:f.connectorId,shortageConfirmed:'yes',remedy:'credit'};
  return {comparison,reference,input};
}

test('native supplier shortage claims use checked receipts and the exact current plan, teaching and delivery authority',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-claim-fixture').fixture(t),{db,ctx,service}=f;
  const order=await f.order(6);
  const first=await recorded(f,order,{actual:'4',reference:'CHECKED-PARTIAL-DELIVERY'});
  await assert.rejects(service.preview(db,ctx,first.input),/purchase line or received quantity changed/);
  await f.receive(order,{reference:first.reference,qcConfirmed:'yes',lines:[{lineId:order.lineIds[0],quantity:4,locationId:f.location.id}]});
  const path='/autopilot/delivery-checks/'+first.comparison.id;
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    const locked=await f.browser.get(path).expect(200);
    assert.match(locked.text,/Supplier shortage claims require Pro or Custom/);
    assert.doesNotMatch(locked.text,/name="shortageConfirmed"/);
    await f.browser.post('/autopilot/supplier-claims/preview').set('Accept','application/json')
      .type('form').send({_csrf:f.csrf(locked.text),...first.input}).expect(402);
  }
  await f.subscribe('pro');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const origin='http://127.0.0.1:'+server.address().port;
  const browserErrors=[];
  page.on('pageerror',error=>browserErrors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(origin+'/login');
  await page.getByLabel('Work email').fill(f.email);
  await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+path);
  await page.getByText('Prepare supplier shortage claim',{exact:true}).click();
  await page.getByLabel('Connected sending mailbox').selectOption(f.connectorId);
  await page.locator('[name=shortageConfirmed]').check();
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save confirmed shortage',exact:true}).click()]);
  assert.match(page.url(),/\/autopilot\/supplier-claims\//);
  const id=new URL(page.url()).pathname.split('/').at(-1);
  const claim=await service.claim(db,ctx,id);
  assert.equal(claim.snapshot.missingUnits,'2');
  assert.equal(claim.snapshot.totalMinor,200);
  assert.equal((await service.preview(db,ctx,first.input)).id,id);
  const visible=await page.locator('main').innerText();
  assert.match(visible,/2 missing/);
  assert.match(visible,/Original delivery comparison/);
  assert.match(visible,/\$2.00/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const limits=f.limits({includePhotos:'no'});
  await assert.rejects(service.configure(db,ctx,id,limits),/completed|individually approve/);
  await page.locator('form[action$="/send"] [name=confirmed]').check();
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send this claim once',exact:true}).click()]);
  await f.deliver();
  await page.reload();
  assert.match(await page.locator('main').innerText(),/Mailbox delivery: SENT/);
  assert.deepEqual(browserErrors,[]);
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].body,/6 unit due, 4 checked and received, 2 missing/);
  await assert.rejects(service.preview(db,ctx,first.input),/already has a queued or sent claim/);
  const rule=await service.configure(db,ctx,id,limits);
  assert(rule.id);

  const secondOrder=await f.order(5);
  const second=await recorded(f,secondOrder,{actual:'3'});
  await f.receive(secondOrder,{reference:second.reference,qcConfirmed:'yes',lines:[{lineId:secondOrder.lineIds[0],quantity:3,locationId:f.location.id}]});
  const next=await service.preview(db,ctx,second.input);
  const run=await service.run(db,ctx.workspaceId);
  assert.equal(run.results.find(row=>row.claimId===next.id)?.needsReview,undefined);
  assert.equal((await service.claim(db,ctx,next.id)).automatic,true);
  await f.deliver();
  assert.equal(f.sent.length,2);
  assert.equal((await service.run(db,ctx.workspaceId)).results.length,0);

  const staleOrder=await f.order(5);
  const stale=await recorded(f,staleOrder,{actual:'3'});
  await f.receive(staleOrder,{reference:stale.reference,qcConfirmed:'yes',lines:[{lineId:staleOrder.lineIds[0],quantity:3,locationId:f.location.id}]});
  const older=await service.preview(db,ctx,stale.input);
  await f.workflows.receivePurchaseOrder(db,ctx,staleOrder.purchaseOrderId,{idempotencyKey:randomUUID(),qcConfirmed:'yes',
    lines:[{lineId:staleOrder.lineIds[0],quantity:1,locationId:f.location.id}]});
  await assert.rejects(f.send(older),/purchase line or received quantity changed/);
  assert.equal(f.sent.length,2);
});

test('Custom can file a measured serial shortage within its explicitly authorized weight and goods cost without training',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-claim-fixture').fixture(t,'enterprise'),{db,ctx,service,workflows}=f;
  const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{
    name:'Measured serialized goods',baseCode:'SHORT-MEASURED',trackingMode:'serial',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),
    lines:[{skuId:item.skuIds[0],quantityUnits:3,secondaryQuantity:'7.75',unitCost:'4.00'}]});
  await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
  const first=await recorded(f,order,{actual:'2',weight:'5.125'});
  await workflows.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID(),reference:first.reference,
    lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:2,secondaryQuantity:'5.125',lotCode:'EXACT-CLAIM-BATCH',
      serials:['CLAIM-1','CLAIM-2'],serialWeights:{'CLAIM-1':'2.5','CLAIM-2':'2.625'}}]});
  const claim=await service.preview(db,ctx,first.input);
  assert.equal(claim.snapshot.missingUnits,'1');
  assert.equal(claim.snapshot.missingWeight,'2.625');
  assert.equal(claim.snapshot.totalMinor,1050);
  assert(claim.snapshot.receiptLines[0].lot_id);
  const limits=f.limits({includePhotos:'no',maxUnits:1,maxWeight:'2.624',maxValue:'10.50',maxWeekly:'21.00'});
  const rule=await service.configure(db,ctx,claim.id,limits);
  await assert.rejects(service.sendAutomatic(db,ctx,claim.id,rule.id),/exceeds current owner authority/);
  await service.configure(db,ctx,claim.id,{...limits,ruleId:rule.id,revision:1,maxWeight:'2.625'});
  const run=await service.run(db,ctx.workspaceId);
  assert(run.results.find(row=>row.claimId===claim.id)?.communicationId);
  const cost=await db.query('SELECT quantity_units::text,total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',
    [ctx.workspaceId,item.skuIds[0]]);
  await f.deliver();
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].body,/2.625 kg/);
  assert.match(f.sent[0].body,/\$10.50/);
  assert.deepEqual((await db.query('SELECT quantity_units::text,total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',
    [ctx.workspaceId,item.skuIds[0]])).rows,cost.rows);

  const light=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),
    lines:[{skuId:item.skuIds[0],quantityUnits:2,secondaryQuantity:'6.125',unitCost:'4.00'}]});
  await workflows.approvePurchaseOrder(db,ctx,light.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,light.purchaseOrderId,{idempotencyKey:randomUUID()});
  const underweight=await recorded(f,light,{actual:'2',weight:'5.5'});
  await workflows.receivePurchaseOrder(db,ctx,light.purchaseOrderId,{idempotencyKey:randomUUID(),reference:underweight.reference,
    lines:[{lineId:light.lineIds[0],locationId:f.location.id,quantity:2,secondaryQuantity:'5.5',lotCode:'EXACT-LIGHT-BATCH',
      serials:['LIGHT-1','LIGHT-2'],serialWeights:{'LIGHT-1':'2.7','LIGHT-2':'2.8'}}]});
  const review=await f.browser.get('/autopilot/delivery-checks/'+underweight.comparison.id).expect(200);
  assert.match(review.text,/Save confirmed shortage/);
  const shortage=await service.preview(db,ctx,underweight.input);
  assert.equal(shortage.snapshot.missingUnits,'0');
  assert.equal(shortage.snapshot.missingWeight,'0.625');
  assert.equal(shortage.snapshot.totalMinor,250);
  assert((await service.run(db,ctx.workspaceId)).results.find(row=>row.claimId===shortage.id)?.communicationId);
  await f.deliver();
  assert.equal(f.sent.length,2);
  assert.match(f.sent[1].body,/0.625 kg/);
  const day=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const digest=await require('../../src/autopilot/agent-work-digest').report(db,ctx,{filter:day});
  const report=digest.rows.find(row=>row.link==='/autopilot/supplier-claims/'+shortage.id);
  assert.match(report.Action,/Sent supplier shortage claim/);
  const measured=(await require('../../src/autopilot/time-saved').report(db,ctx)).rows.find(row=>row.key==='supplier-claim');
  assert.equal(measured.count,2);
  assert.equal(measured.minutes,null);
});
