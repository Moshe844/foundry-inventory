'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 69 on every plan: the ship-to address is checked before any label is
// bought. A test carrier stands in for the connected account's own address
// check; no live carrier is called.
function carrierFor(state){
  return {
    quote:async()=>({providerShipmentIds:['parcel'],rates:[
      {rateId:'usps',carrier:'usps',service:'Ground Advantage',amountMinor:700,currency:'USD',deliveryDays:3},
      {rateId:'ups',carrier:'ups',service:'Ground',amountMinor:650,currency:'USD',deliveryDays:2}]}),
    buy:async(_ctx,input)=>{state.buys++;return {providerLabelIds:['label-'+state.buys],providerShipmentId:'label-'+state.buys,trackingNumber:'TRACK'+state.buys,
      labelUrl:'https://labels.example.test/'+state.buys+'.pdf',labelFormat:'PDF',amountMinor:input.approvedAmountMinor,currency:'USD',carrier:'usps',service:'Ground'};},
    validateAddress:async(_ctx,to)=>{state.checks++;const answer=state.answer(to);if(answer instanceof Error)throw answer;return answer;}
  };
}
const exact=to=>({status:'VERIFIED',matched:{line1:to.line1,line2:to.line2,city:to.city,state:to.state,postalCode:to.postalCode,country:'US'},residential:false,messages:[]});

test('every plan checks the ship-to address with the carrier before a label is bought',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,shipping,subscribe}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const checks=require('../../src/shipping/agent-address-checks'),state={buys:0,checks:0,answer:exact},carrier=carrierFor(state);
  const quote=id=>shipping.quote(db,ctx,id,{providerResolver:()=>carrier});
  const rate=(view,service)=>view.rates.find(r=>r.service===service);
  const buy=async(id,rateId,key=randomUUID())=>{const queued=await shipping.queueLabelPurchase(db,ctx,id,rateId,{idempotencyKey:key});
    return shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider:carrier});};
  const parcelText=async id=>(await shipping.requireShipment(db,ctx.workspaceId,id)).ship_to_address;
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('address-check:'));
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);

  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    // A confirmed address passes, and a second fetch reuses the same answer.
    const ok=await f.parcel();let view=await quote(ok.shipmentId);
    assert.equal((await checks.view(db,ctx.workspaceId,ok.shipmentId)).result,'VERIFIED');
    const before=state.checks;view=await quote(ok.shipmentId);assert.equal(state.checks,before,'the same address is not checked twice');
    assert.equal((await buy(ok.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');

    // Only formatting changed: StockChief applies the carrier's form itself.
    state.answer=to=>({status:'VERIFIED',matched:{line1:to.line1.toUpperCase(),city:to.city.toUpperCase(),state:to.state,postalCode:to.postalCode+'-4021',country:'US'},residential:false,messages:[]});
    const tidy=await f.parcel();view=await quote(tidy.shipmentId);
    assert.equal(await parcelText(tidy.shipmentId),'10 JOBSITE RD, ALBANY, NY 12207-4021');
    assert.equal((await checks.view(db,ctx.workspaceId,tidy.shipmentId)).decision,'FORMATTED');
    assert.equal((await buy(tidy.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');

    // A real correction waits for a person, who accepts it for parcel and order.
    state.answer=to=>to.line1.startsWith('10 ')?{status:'VERIFIED',matched:{line1:'100 Jobsite Rd',city:'Albany',state:'NY',postalCode:'12207',country:'US'},residential:false,messages:['Street number corrected']}:exact(to);
    const fix=await f.parcel();view=await quote(fix.shipmentId);
    const held=await checks.view(db,ctx.workspaceId,fix.shipmentId);
    assert.equal(held.held,true);assert.match(held.reason,/suggests a corrected address: 100 Jobsite Rd/);
    const bought=state.buys;
    await assert.rejects(shipping.queueLabelPurchase(db,ctx,fix.shipmentId,rate(view,'Ground Advantage').id,{idempotencyKey:randomUUID()}),/Confirm the address/);
    assert.equal(state.buys,bought);assert.ok((await needs()).some(n=>n.href==='/orders/'+fix.order.salesOrderId+'#ship-now'));
    await assert.rejects(checks.decide(db,ctx,fix.shipmentId,{checkId:'not-this-one',action:'accept'}),/changed/);
    assert.equal((await checks.decide(db,ctx,fix.shipmentId,{checkId:held.id,action:'accept'})).addressChanged,true);
    assert.equal(await parcelText(fix.shipmentId),'100 Jobsite Rd, Albany, NY 12207');
    assert.equal((await db.query('SELECT ship_to_address FROM sales_orders WHERE id=$1',[fix.order.salesOrderId])).rows[0].ship_to_address,'100 Jobsite Rd, Albany, NY 12207');
    view=await quote(fix.shipmentId);assert.equal((await checks.view(db,ctx.workspaceId,fix.shipmentId)).held,false);
    assert.equal((await buy(fix.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');
    assert.equal((await needs()).length,0);
    state.answer=exact;
  }
  assert.ok(await audits('Held a label for an address check')>=4);assert.ok(await audits('Used the suggested delivery address')>=4);
  assert.ok(await audits('Applied the carrier’s address formatting')>=4);

  await subscribe('growth');
  // Undeliverable or unconfirmed: a person may keep the address as it is.
  state.answer=()=>({status:'UNDELIVERABLE',matched:null,residential:null,messages:['Address not found']});
  const lost=await f.parcel();let view=await quote(lost.shipmentId);let ac=await checks.view(db,ctx.workspaceId,lost.shipmentId);
  assert.match(ac.reason,/cannot deliver/);assert.equal(ac.canAccept,false);
  await assert.rejects(buy(lost.shipmentId,rate(view,'Ground Advantage').id),/cannot deliver/);
  await checks.decide(db,ctx,lost.shipmentId,{checkId:ac.id,action:'keep'});
  assert.equal((await buy(lost.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');

  // A home address for a business customer is a mismatch a person confirms.
  await db.query("UPDATE customers SET company='Jobsite Supply Co' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);
  state.answer=to=>({...exact(to),residential:true});
  const home=await f.parcel();view=await quote(home.shipmentId);ac=await checks.view(db,ctx.workspaceId,home.shipmentId);
  assert.equal(ac.hold,'residential');assert.match(ac.reason,/home address.*Jobsite Supply Co/);
  await assert.rejects(buy(home.shipmentId,rate(view,'Ground Advantage').id),/home address/);
  await checks.decide(db,ctx,home.shipmentId,{checkId:ac.id,action:'keep'});
  assert.equal((await buy(home.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');
  await db.query("UPDATE customers SET company=NULL WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);
  state.answer=exact;

  // A parcel addressed differently from its order is held without a carrier call.
  const moved=await f.parcel();
  await db.query("UPDATE sales_shipments SET ship_to_address='22 Other Rd, Albany, NY 12207' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,moved.shipmentId]);
  const calls=state.checks;view=await quote(moved.shipmentId);ac=await checks.view(db,ctx.workspaceId,moved.shipmentId);
  assert.equal(state.checks,calls);assert.equal(ac.hold,'changed');assert.equal(ac.suggested,'10 Jobsite Rd, Albany, NY 12207');
  await assert.rejects(buy(moved.shipmentId,rate(view,'Ground Advantage').id),/addressed differently from the order/);
  await checks.decide(db,ctx,moved.shipmentId,{checkId:ac.id,action:'accept'});
  assert.equal(await parcelText(moved.shipmentId),'10 Jobsite Rd, Albany, NY 12207');
  view=await quote(moved.shipmentId);assert.equal(state.checks,calls+1);
  assert.equal((await buy(moved.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');

  // The order's address changing after the label was queued stops the carrier call.
  const late=await f.parcel();view=await quote(late.shipmentId);
  const queued=await shipping.queueLabelPurchase(db,ctx,late.shipmentId,rate(view,'Ground Advantage').id,{idempotencyKey:randomUUID()});
  await db.query("UPDATE sales_orders SET ship_to_address='5 Elsewhere Ave, Troy, NY 12180' WHERE id=$1",[late.order.salesOrderId]);
  const priorBuys=state.buys;
  await assert.rejects(shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider:carrier}),/check this address/);
  assert.equal(state.buys,priorBuys);assert.equal((await shipping.requireShipment(db,ctx.workspaceId,late.shipmentId)).label_status,'FAILED');

  // PO boxes: UPS refuses them, the postal service does not.
  await db.query("UPDATE customers SET shipping_address='PO Box 12, Albany, NY 12207' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);
  const box=await f.parcel();view=await quote(box.shipmentId);
  assert.equal((await checks.view(db,ctx.workspaceId,box.shipmentId)).poBox,true);
  await assert.rejects(shipping.queueLabelPurchase(db,ctx,box.shipmentId,rate(view,'Ground').id,{idempotencyKey:randomUUID()}),/does not deliver to PO boxes/);
  assert.equal((await buy(box.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');
  await db.query("UPDATE customers SET shipping_address='10 Jobsite Rd, Albany, NY 12207' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);

  // A failed carrier check holds the label and is tried again next time.
  state.answer=()=>Object.assign(new Error('Carrier timeout'),{status:503});
  const down=await f.parcel();view=await quote(down.shipmentId);
  assert.equal((await checks.view(db,ctx.workspaceId,down.shipmentId)).hold,'failed');
  await assert.rejects(buy(down.shipmentId,rate(view,'Ground Advantage').id),/could not check/);
  state.answer=exact;view=await quote(down.shipmentId);
  assert.equal((await checks.view(db,ctx.workspaceId,down.shipmentId)).result,'VERIFIED');
  assert.equal((await buy(down.shipmentId,rate(view,'Ground Advantage').id)).shipment.label_status,'PURCHASED');
  assert.equal(await f.balance(),40,'buying labels never moves stock');
});

test('formatting waits for a person under Ask me first, Watch only, observe and shadow; holds always apply',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12}),{db,ctx,shipping,subscribe}=f;
  await subscribe('pro');
  const checks=require('../../src/shipping/agent-address-checks'),state={buys:0,checks:0,answer:null},carrier=carrierFor(state);
  state.answer=to=>({status:'VERIFIED',matched:{line1:to.line1.toUpperCase(),city:to.city,state:to.state,postalCode:to.postalCode+'-4021',country:'US'},residential:false,messages:[]});
  const quote=id=>shipping.quote(db,ctx,id,{providerResolver:()=>carrier});
  const untouched=async label=>{const p=await f.parcel();const view=await quote(p.shipmentId);const ac=await checks.view(db,ctx.workspaceId,p.shipmentId);
    assert.equal(ac.result,'FORMATTED',label);assert.equal(ac.decision,null,label);assert.equal(ac.held,false,label);
    assert.equal((await shipping.requireShipment(db,ctx.workspaceId,p.shipmentId)).ship_to_address,'10 Jobsite Rd, Albany, NY 12207',label);
    const queued=await shipping.queueLabelPurchase(db,ctx,p.shipmentId,view.rates[0].id,{idempotencyKey:randomUUID()});assert.ok(queued.effectId,label);};
  await untouched('shadow');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,69,{mode:'ask',revision:0});await untouched('ask me first');
  await modes.save(db,ctx,69,{mode:'watch',revision:1});await untouched('watch only');
  await modes.save(db,ctx,69,{mode:'inherit',revision:2});
  const auto=require('../../src/autopilot/postgres-service');
  await auto.setMode(db,ctx,{role:'owner'},'OBSERVE');await untouched('observe');
  // Holds are a safety gate: they apply in every mode.
  state.answer=()=>({status:'UNDELIVERABLE',matched:null,residential:null,messages:[]});
  const p=await f.parcel(),view=await quote(p.shipmentId);
  await assert.rejects(shipping.queueLabelPurchase(db,ctx,p.shipmentId,view.rates[0].id,{idempotencyKey:randomUUID()}),/cannot deliver/);
});

test('the order Ship panel shows a held address and a person answers it in one press',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:8}),{db,ctx,shipping,subscribe}=f;
  await subscribe('starter');await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const checks=require('../../src/shipping/agent-address-checks'),state={buys:0,checks:0,answer:to=>to.line1.startsWith('10 ')?{status:'VERIFIED',matched:{line1:'100 Jobsite Rd',city:'Albany',state:'NY',postalCode:'12207',country:'US'},residential:false,messages:[]}:exact(to)},carrier=carrierFor(state);
  const p=await f.parcel();await shipping.quote(db,ctx,p.shipmentId,{providerResolver:()=>carrier});
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),shippingOptions:{providerResolver:()=>carrier}});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const width of [1280,390]){
    const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+'/orders/'+p.order.salesOrderId);
    const block=page.locator('#ship-now [data-address-check]');
    assert.match(await block.innerText(),/Check the address before the label is bought/);assert.match(await block.innerText(),/100 Jobsite Rd/);
    assert.equal(await page.locator('#ship-now').getByRole('button',{name:'Buy label',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'no sideways scroll at '+width);
    await page.goto(origin+'/fulfilment/'+p.shipmentId);
    assert.match(await page.locator('[data-address-check]').innerText(),/Correct the address/);
    if(width===390){
      await page.goto(origin+'/orders/'+p.order.salesOrderId);
      await Promise.all([page.waitForNavigation(),block.getByRole('button',{name:'Use the suggested address'}).click()]);
      assert.match(await page.locator('#ship-now').innerText(),/100 Jobsite Rd/);
      assert.match(await page.locator('#ship-now [data-address-check]').innerText(),/confirmed this address/);
      assert.equal(await page.locator('#ship-now').getByRole('button',{name:'Buy label',exact:true}).count(),1);
    }
    await page.close();
  }
  assert.equal((await checks.view(db,ctx.workspaceId,p.shipmentId)).result,'VERIFIED');assert.equal(state.buys,0);
});
