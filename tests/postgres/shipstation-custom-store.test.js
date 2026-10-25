'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
test('ShipStation Custom Store exports prepared parcels and accepts idempotent tracking without moving stock',{timeout:90000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,store=require('../../src/shipping/shipstation-custom-store');
 const setup=await store.setup(db,ctx),replay=await store.setup(db,ctx);assert.equal(replay.connectorId,setup.connectorId);assert.equal(replay.password,setup.password);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'custom-store-test'});f.cleanup(()=>app.locals.sessionStore.close());
 const parcel=await f.parcel(),endpoint='/api/v1/shipping/shipstation-custom/'+setup.connectorId,basic='Basic '+Buffer.from(setup.username+':'+setup.password).toString('base64');
 const from=store.date('01/01/2020 00:00'),to=store.date('01/01/2090 00:00');assert.ok(from<to);
 await t.test('authentication scopes every export and notification to one merchant inventory',async()=>{
  assert.equal((await request(app).get(endpoint+'?action=export').set('Authorization','Basic wrong')).status,401);
  await assert.rejects(store.authenticate(db,'other-connection',basic),/not accepted/);
  const exported=await request(app).get(endpoint).query({action:'export',start_date:'01/01/2020 00:00',end_date:'01/01/2090 00:00',page:1}).set('Authorization',basic);assert.equal(exported.status,200);assert.match(exported.text,new RegExp(parcel.shipmentId));assert.match(exported.text,/PARCEL-/);assert.match(exported.text,/<Orders pages="1">/);assert.doesNotMatch(exported.text,new RegExp(setup.password));
 });
 await t.test('an authenticated HTTP fixture notification updates tracking once, without inventing physical dispatch',async()=>{
  const before=await f.balance(),journals=Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),query={action:'shipnotify',carrier:'USPS',tracking_number:'9400111899223856929144',order_number:parcel.shipmentNumber};
  // The provider protocol uses the exported OrderID when XML is supplied.
  const body='<ShipNotice><OrderID>'+parcel.shipmentId+'</OrderID><Carrier>USPS</Carrier><TrackingNumber>'+query.tracking_number+'</TrackingNumber></ShipNotice>';
  for(let i=0;i<2;i++){const r=await request(app).post(endpoint).query(query).set('Authorization',basic).set('Content-Type','text/xml').send(body);assert.equal(r.status,200,r.text);}
  const shipment=await f.shipping.requireShipment(db,ctx.workspaceId,parcel.shipmentId);assert.equal(shipment.status,'PACKED');assert.equal(shipment.tracking_number,query.tracking_number);assert.match(shipment.tracking_url,/tools.usps.com/);assert.equal(await f.balance(),before);
  assert.equal(Number((await db.query('SELECT count(*) n FROM shipment_tracking_events WHERE workspace_id=$1 AND shipment_id=$2',[ctx.workspaceId,parcel.shipmentId])).rows[0].n),1);assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),journals);
  await assert.rejects(f.shipping.queueLabelPurchase(db,ctx,parcel.shipmentId,'unused',{idempotencyKey:'must-not-buy-twice'}),/will not buy a second label/);
 });
 await t.test('conflicting tracking, unrelated parcels and XML entities are refused',async()=>{
  await assert.rejects(store.notify(db,{...ctx,connectorId:setup.connectorId},{order_number:parcel.shipmentId,carrier:'UPS',tracking_number:'DIFFERENT'},''),/different tracking/);
  await assert.rejects(store.notify(db,{...ctx,connectorId:setup.connectorId},{order_number:'other-inventory-parcel',carrier:'UPS',tracking_number:'TRACK'},''),/does not belong/);
  assert.throws(()=>store.notice('<!DOCTYPE x [<!ENTITY ext SYSTEM "file:///private">]><ShipNotice><OrderID>&ext;</OrderID></ShipNotice>'),/declarations/);
  assert.throws(()=>store.date('02/31/2026 10:00'),/not valid/);
 });
 await t.test('disconnect revokes credentials while preserving existing tracking history',async()=>{await store.disconnect(db,ctx,setup.connectorId);await assert.rejects(store.authenticate(db,setup.connectorId,basic),/not accepted/);assert.equal(Number((await db.query('SELECT count(*) n FROM shipment_tracking_events WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),1);});
});
