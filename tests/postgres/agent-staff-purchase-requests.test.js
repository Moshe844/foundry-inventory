'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const requests=require('../../src/purchasing/agent-purchase-requests');

test('staff purchase requests resolve exact product names and nicknames without training and create one approved draft',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
  const catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');
  const tape=await catalog.createItem(db,ctx,{name:'Packing tape',baseCode:'PACK-TAPE',trackingMode:'quantity',unitLabel:'rolls'});
  const supplier=await commerce.createSupplier(db,ctx,{name:'Packing supplies',currency:'USD'});
  await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:tape.skuIds[0],lastUnitCost:'2.50',unitsPerPurchaseUnit:1});
  const alias=require('../../src/assistant/postgres-record-aliases');
  await alias.save(db,ctx,await alias.prepare(db,ctx,{kind:'item',recordReference:tape.itemId,alias:'tape'}));
  const member={...ctx,actorId:randomUUID()},staffAccount=randomUUID(),email=randomUUID()+'@example.test';
  await db.query(`INSERT INTO accounts(id,email,name,password_hash,plan,email_verified_at,last_workspace_id,created_at)
    SELECT $1,$2,'Dispatch staff',password_hash,'paid',now(),$4,now() FROM accounts WHERE id=$3`,[staffAccount,email,f.owner.accountId,ctx.workspaceId]);
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,warehouse_location_ids,created_at)
    VALUES($1,$2,$3,'Dispatch staff','staff',$4,now())`,[member.actorId,ctx.workspaceId,staffAccount,JSON.stringify([f.location.id])]);
  const input={requestText:'We need more tape.',locationId:f.location.id,requestKey:randomUUID()};
  await f.subscribe('starter');
  const locked=await f.browser.get('/purchasing/requests').expect(200);
  assert.match(locked.text,/Growth plan/);
  assert.doesNotMatch(locked.text,/name="requestText"/);
  await f.browser.post('/purchasing/requests').set('Accept','application/json').type('form').send({_csrf:f.csrf(locked.text),...input}).expect(402);

  await f.subscribe('growth');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),origin='http://127.0.0.1:'+server.address().port;
  const errors=[];
  phone.on('pageerror',error=>errors.push(error.message));
  phone.setDefaultTimeout(15000);
  await phone.goto(origin+'/login');
  await phone.getByLabel('Work email').fill(email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(origin+'/purchasing');
  assert.equal(new URL(phone.url()).pathname,'/warehouse/stock');
  const page=await Promise.all([phone.waitForNavigation(),phone.getByRole('link',{name:'Request a purchase',exact:true}).click()]).then(([response])=>response);
  assert.equal(new URL(phone.url()).pathname,'/purchasing/requests');
  assert.equal(page.status(),200,await phone.locator('body').innerText());
  assert.match(await phone.locator('main').innerText(),/What do you need/);
  assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await phone.getByLabel('What do you need?').fill(input.requestText);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Request purchase',exact:true}).click()]);
  assert.match(await phone.locator('main').innerText(),/Packing tape.*PACK-TAPE[\s\S]*Waiting for approval/);
  assert.equal(await phone.getByRole('button',{name:'Approve and create draft PO'}).count(),0);
  assert.deepEqual(errors,[]);
  const pending=(await requests.page(db,member)).requests[0];
  assert.equal(pending.quantity,null);
  assert.equal(pending.reason,input.requestText);
  await assert.rejects(requests.submit(db,member,{...input,locationId:'outside'}),/outside your assigned warehouses/);
  await assert.rejects(requests.decide(db,member,pending.id,{decision:'approve',supplierId:supplier.id,quantity:7}),/Only the owner/);
  await assert.rejects(requests.decide(db,ctx,pending.id,{decision:'approve',supplierId:supplier.id}),/exact quantity/);

  await f.subscribe('starter');
  await assert.rejects(requests.decide(db,ctx,pending.id,{decision:'approve',supplierId:supplier.id,quantity:7}),/Growth/);
  await f.subscribe('growth');
  const list=await f.browser.get('/purchasing/requests').expect(200);
  assert.match(list.text,/Quantity to purchase \(rolls\)/);
  const accepted=await f.browser.post('/purchasing/requests/'+pending.id+'/decision').type('form')
    .send({_csrf:f.csrf(list.text),decision:'approve',supplierId:supplier.id,quantity:7}).expect(303);
  const po=await requests.decide(db,ctx,pending.id,{decision:'approve',supplierId:supplier.id,quantity:7});
  assert(accepted.headers.location.endsWith(po));
  const line=(await db.query(`SELECT p.status,l.quantity_units,l.unit_cost FROM purchase_orders p JOIN purchase_order_lines l
    ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.workspaceId,po])).rows[0];
  assert.deepEqual([line.status,Number(line.quantity_units),Number(line.unit_cost)],['DRAFT',7,2.5]);

  for(const plan of ['pro','enterprise']){
    await f.subscribe(plan);
    const counted={...input,requestKey:randomUUID(),requestText:'Please order 4 packing tape'};
    await assert.rejects(requests.submit(db,member,{...counted,quantity:5}),/different amounts/);
    const id=await requests.submit(db,member,counted);
    assert.equal(await requests.submit(db,member,counted),id);
    const draft=await requests.decide(db,ctx,id,{decision:'approve',supplierId:supplier.id});
    assert.equal(Number((await db.query('SELECT quantity_units FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',
      [ctx.workspaceId,draft])).rows[0].quantity_units),4);
  }
  const cuts=await catalog.createItem(db,ctx,{name:'Measured cuts',baseCode:'MEASURED-CUTS',trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
  await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:cuts.skuIds[0],lastUnitCost:'2.50',unitsPerPurchaseUnit:1});
  const measured=await requests.submit(db,member,{...input,requestKey:randomUUID(),requestText:'We need 3 measured cuts'});
  await assert.rejects(requests.decide(db,ctx,measured,{decision:'approve',supplierId:supplier.id}),/actual kg/);
  const measuredOrder=await requests.decide(db,ctx,measured,{decision:'approve',supplierId:supplier.id,secondaryQuantity:'5.375'});
  const quantities=(await db.query(`SELECT quantity_units,secondary_quantity_ordered FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2`,
    [ctx.workspaceId,measuredOrder])).rows[0];
  assert.deepEqual([Number(quantities.quantity_units),Number(quantities.secondary_quantity_ordered)],[3,5.375]);
});
