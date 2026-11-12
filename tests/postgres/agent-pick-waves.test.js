'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const release=require('../../src/warehouse/agent-pick-release');
const zoneWaves=require('../../src/warehouse/agent-pick-waves');
const waves=require('../../src/operations/postgres-fulfillment-waves');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const places=require('../../src/domain/postgres-location-service');
const time=require('../../src/lib/business-time');
const {addDays}=require('../../src/accounting/customer-money');

// Dispatch > Zone A (A-01 at 30 m, A-02 at 10 m) and Zone B (B-01 at 20 m).
async function setup(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx}=f,ws=ctx.workspaceId,dispatch=f.location.id;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const catalog=require('../../src/domain/postgres-catalog-service'),flows=f.workflows,native=require('../../src/sales/postgres-order-allocations'),receipt=require('../../src/accounting/postgres-stock-receipt');
 const make=async(name,kind,parent,sequence,barcode)=>{const l=await places.createLocation(db,ctx,{name,kind,parentLocationId:parent});await db.query('UPDATE locations SET pick_sequence=$3,barcode=$4 WHERE workspace_id=$1 AND id=$2',[ws,l.id,sequence,barcode||null]);return l.id;};
 const zoneA=await make('Zone A','zone',dispatch,1),zoneB=await make('Zone B','zone',dispatch,2);
 const a1=await make('A-01','bin',zoneA,0,'BIN-A01'),a2=await make('A-02','bin',zoneA,0,'BIN-A02'),b1=await make('B-01','bin',zoneB,0,'BIN-B01');
 const slotting=require('../../src/forecasting/warehouse-slotting');
 for(const [bin,metres] of [['A-01','30'],['A-02','10'],['B-01','20']])await slotting.saveDistance(db,ctx,{bin,warehouseId:dispatch,metres});
 const plain=f.item.skuIds[0];await db.query("UPDATE skus SET barcode='PICK-ITEM' WHERE workspace_id=$1 AND id=$2",[ws,plain]);
 const blue=(await catalog.createItem(db,ctx,{name:'Blue cups',baseCode:'BLUE-'+randomUUID().slice(0,6),trackingMode:'quantity'})).skuIds[0];
 const syrup=(await catalog.createItem(db,ctx,{name:'Batch syrup',baseCode:'SYR-'+randomUUID().slice(0,6),trackingMode:'lot'})).skuIds[0];
 const scanner=(await catalog.createItem(db,ctx,{name:'Serial scanner',baseCode:'SER-'+randomUUID().slice(0,6),trackingMode:'serial'})).skuIds[0];
 const cheese=(await catalog.createItem(db,ctx,{name:'Cheese wheel',baseCode:'CHZ-'+randomUUID().slice(0,6),trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'})).skuIds[0];
 for(const [sku,bin,quantity] of [[plain,a1,20],[blue,b1,20]])await receipt.receive(db,ctx,{skuId:sku,locationId:bin,quantity,unitCost:'1.00',idempotencyKey:randomUUID()});
 await require('../../src/domain/postgres-opening-stock').receive(db,ctx,{skuId:cheese,locationId:a1,quantity:6,secondaryQuantity:'7.2',unitCost:5,idempotencyKey:randomUUID()});
 const today=await time.today(db,ws);
 const buy=async(sku,bin,lines)=>{const po=await flows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:dispatch,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:lines.reduce((n,l)=>n+l.quantity,0),unitCost:2}]});
  await flows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await flows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  for(const l of lines)await flows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],locationId:bin,...l}]});};
 await buy(syrup,a2,[{quantity:3,lotCode:'SOON',expiresAt:addDays(today,20)},{quantity:3,lotCode:'LATE',expiresAt:addDays(today,90)}]);
 await buy(scanner,b1,[{quantity:2,serials:['SN-1','SN-2']}]);
 // An order with each line reserved in the given bins.
 const order=async(lines,{priority=100}={})=>{
  const o=await flows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',shipToAddress:'10 Jobsite Rd, Albany, NY 12207',fulfillmentLocationId:dispatch,idempotencyKey:randomUUID(),
   lines:lines.map(l=>({skuId:l.sku,quantity:l.quantity,unitPriceMinor:1000,...(l.weight?{secondaryQuantity:l.weight}:{})}))});
  await flows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
  const version=async()=>Number((await db.query('SELECT version FROM sales_orders WHERE id=$1',[o.salesOrderId])).rows[0].version);
  const held=(await db.query('SELECT a.sales_order_line_id "lineId",a.location_id "locationId",a.quantity::int quantity FROM sales_order_allocations a JOIN sales_order_lines l ON l.id=a.sales_order_line_id WHERE l.sales_order_id=$1',[o.salesOrderId])).rows;
  if(held.length)await native.giveBack(db,ctx,o.salesOrderId,{expectedVersion:await version(),idempotencyKey:randomUUID(),lines:held});
  await native.setAside(db,ctx,o.salesOrderId,{expectedVersion:await version(),idempotencyKey:randomUUID(),lines:lines.map((l,i)=>({lineId:o.lineIds[i],locationId:l.bin,quantity:l.quantity}))});
  if(priority!==100)await db.query('UPDATE sales_orders SET allocation_priority=$2 WHERE id=$1',[o.salesOrderId,priority]);
  return o;};
 const rows=async(where='true')=>(await db.query(`SELECT a.*,f.status native,f.wave_number FROM stockchief_runtime.agent_pick_waves a JOIN fulfillment_waves f ON f.id=a.wave_id WHERE a.workspace_id=$1 AND ${where} ORDER BY a.created_at,a.id`,[ws])).rows;
 const ordersOf=w=>w.plan.orders.map(o=>o.id);
 const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
 return {...f,ws,dispatch,a1,a2,b1,plain,blue,syrup,scanner,cheese,order,rows,ordersOf,audits,today,rotation:require('../../src/operations/postgres-stock-rotation')};
}
const id=o=>o.salesOrderId;

test('released orders become zone waves with one pick list per zone in walking order; Growth prepares for a person until taught, Pro and Custom start within the wave size and cut-off',{timeout:480000},async t=>{
 const f=await setup(t),{db,ctx,ws,subscribe,browser,order,rows,ordersOf,audits}=f;
 const stockBefore=await f.balance();
 await subscribe('starter');
 assert.match((await browser.get('/autopilot/pick-waves').expect(200)).text,/data-agent-plan-locked/);
 await assert.rejects(zoneWaves.configure(db,ctx,{locationId:f.dispatch,revision:0,waveOrders:'2'}),e=>e.code==='entitlement_required');
 assert.deepEqual(await zoneWaves.run(db,ws),{built:0,started:0,watching:false});

 await subscribe('growth');
 await release.configure(db,ctx,{locationId:f.dispatch,revision:0,batchOrders:'10',automatic:'yes'});
 await zoneWaves.configure(db,ctx,{locationId:f.dispatch,revision:0,waveOrders:'2'});
 // Released in this order; zones decide the waves.
 const oA1=await order([{sku:f.plain,bin:f.a1,quantity:1},{sku:f.cheese,bin:f.a1,quantity:2,weight:'2.4'},{sku:f.syrup,bin:f.a2,quantity:1}]);
 const oB1=await order([{sku:f.blue,bin:f.b1,quantity:2},{sku:f.scanner,bin:f.b1,quantity:1}]);
 const oA2=await order([{sku:f.syrup,bin:f.a2,quantity:2}]);
 await f.rotation.bind(db,ctx,await f.rotation.plan(db,ctx,id(oA2),'FEFO'));
 const oB2=await order([{sku:f.blue,bin:f.b1,quantity:1}]);
 const released=await release.run(db,ws);assert.equal(released.released,4);
 let made=await rows();
 assert.equal(made.length,2,'The release built its waves at once.');
 assert.deepEqual(made.map(ordersOf),[[id(oA1),id(oA2)],[id(oB1),id(oB2)]],'Orders in the same zone go together, ahead of release order.');
 assert(made.every(w=>w.status==='PREPARED'&&w.native==='RELEASED'));assert.match(made[0].reason,/Growth prepares each wave/);
 await assert.rejects(waves.scan(db,ctx,made[0].wave_id,{clientScanId:randomUUID(),locationBarcode:'BIN-A01',itemBarcode:'PICK-ITEM',quantity:1}),/not open for picking/);
 assert.equal(await f.balance(),stockBefore,'Building waves moves no stock.');
 // One pick list per zone, farthest bin first, with exact or suggested identities.
 const [zoneA]=await zoneWaves.pickLists(db,ws,made[0].wave_id);
 assert.equal(zoneA.name,'Zone A');assert.equal(zoneA.walkMetres,60);
 assert.deepEqual(zoneA.lines.map(l=>l.bin),['A-01','A-01','A-02','A-02'],'Farthest bin first, ending near packing.');
 const lot=zoneA.lines.filter(l=>l.code.startsWith('SYR-'));
 assert.match(lot.find(l=>l.order_number===oA2.orderNumber).instruction,/Take exactly: batch SOON \(expires .*\) × 2/);
 assert.match(lot.find(l=>l.order_number===oA1.orderNumber).instruction,/Scan a batch, earliest expiry first: SOON \(expires .*\) · 1 here, LATE/);
 assert.match(zoneA.lines.find(l=>l.code.startsWith('CHZ-')).instruction,/Weigh it and record the actual kg at packing/);
 const [zoneB]=await zoneWaves.pickLists(db,ws,made[1].wave_id);
 assert.equal(zoneB.name,'Zone B');assert.equal(zoneB.walkMetres,40);assert.match(zoneB.lines.find(l=>l.code.startsWith('SER-')).instruction,/Scan a serial number, oldest first: SN-1, SN-2/);
 const needs=await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
 assert(needs.some(n=>n.sourceId==='pick-wave:'+made[0].id&&/Start pick wave #/.test(n.title)));

 // A person starts a wave from its page; picking can begin.
 const page=await browser.get('/warehouse/waves/'+made[0].wave_id).expect(200);
 assert.match(page.text,/Pick list · Zone A/);assert.match(page.text,/Start picking/);
 await browser.post('/warehouse/waves/'+made[0].wave_id+'/start').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
 made=await rows();assert.equal(made[0].status,'STARTED');assert.equal(made[0].started_kind,'INDIVIDUAL');assert.equal(made[0].native,'PICKING');
 assert.equal((await waves.scan(db,ctx,made[0].wave_id,{clientScanId:randomUUID(),locationBarcode:'BIN-A01',itemBarcode:'PICK-ITEM',quantity:1})).status,'ACCEPTED');
 await assert.rejects(zoneWaves.undo(db,ctx,made[0].id),/Picking has started/);
 // Teaching from it lets Growth start the waiting wave on its own.
 await zoneWaves.teach(db,ctx,made[0].id);assert.equal(await audits('Taught StockChief to start pick waves on its own'),1);
 assert.equal((await zoneWaves.run(db,ws)).started,1);
 made=await rows();assert.equal(made[1].status,'STARTED');assert.equal(made[1].started_kind,'AUTOMATIC');assert.equal(await audits('StockChief started a pick wave'),1);
 // Undo before picking starts: boxes are cancelled and the orders wait for a person.
 const undone=await zoneWaves.undo(db,ctx,made[1].id);assert.equal(undone.cancelledBoxes,2);
 assert.equal((await rows(`a.id='${made[1].id}'`))[0].native,'CANCELLED');
 assert.equal((await zoneWaves.run(db,ws)).built,0,'StockChief leaves undone orders for a person.');
 const rebuilt=await zoneWaves.buildNow(db,ctx,f.dispatch);assert.equal(rebuilt.built,1);assert.equal(rebuilt.started,1);
 assert.deepEqual(ordersOf((await rows("a.status='STARTED'")).at(-1)),[id(oB1),id(oB2)]);

 // Ask me first, pause, Watch only and shadow mode prepare or only watch.
 const next=await order([{sku:f.plain,bin:f.a1,quantity:1}]);
 await modes.save(db,ctx,57,{mode:'ask',revision:0});
 await release.run(db,ws);
 let latest=(await rows()).at(-1);assert.deepEqual(ordersOf(latest),[id(next)]);assert.equal(latest.status,'PREPARED');assert.match(latest.reason,/Ask me first/);
 await modes.save(db,ctx,57,{mode:'watch',revision:1});
 assert.equal((await zoneWaves.run(db,ws)).watching,true);
 await assert.rejects(zoneWaves.start(db,ctx,{id:latest.id}),/Watch only/);
 await modes.save(db,ctx,57,{mode:'inherit',revision:2});
 await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');assert.equal((await zoneWaves.run(db,ws)).started,0);await autopilot.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await zoneWaves.run(db,ws)).watching,true);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 assert.equal((await zoneWaves.run(db,ws)).started,1);

 // Pro starts waves on its own until the owner's last start time.
 await subscribe('pro');
 await zoneWaves.configure(db,ctx,{locationId:f.dispatch,revision:2,waveOrders:'5',startCutoff:'3:00 pm'});
 await modes.save(db,ctx,57,{mode:'watch',revision:3});
 const late=await order([{sku:f.blue,bin:f.b1,quantity:1}]);await release.run(db,ws);
 assert.equal((await rows()).filter(w=>ordersOf(w).includes(id(late))).length,0,'Watch only builds nothing.');
 await modes.save(db,ctx,57,{mode:'inherit',revision:4});
 const {timeZone}=await time.forWorkspace(db,ws);
 const at=(day,h)=>time.wall(day,h,0,timeZone);
 assert.equal((await zoneWaves.run(db,ws,{now:at(f.today,16)})).started,0);
 latest=(await rows()).at(-1);assert.deepEqual(ordersOf(latest),[id(late)]);assert.match(latest.reason,/past 15:00/);
 assert.equal((await zoneWaves.run(db,ws,{now:at(addDays(f.today,1),9)})).started,1,'The next morning it starts on its own.');

 // Custom builds and starts as soon as orders are released.
 await subscribe('enterprise');
 await zoneWaves.configure(db,ctx,{locationId:f.dispatch,revision:3,waveOrders:'5'});
 const custom=await order([{sku:f.plain,bin:f.a1,quantity:1}]);await release.run(db,ws);
 latest=(await rows()).at(-1);assert.deepEqual(ordersOf(latest),[id(custom)]);assert.equal(latest.status,'STARTED');assert.equal(latest.started_kind,'AUTOMATIC');
 assert.equal(await f.balance(),stockBefore,'No wave moved stock.');
 assert.equal((await db.query('SELECT count(*) n FROM accounting_customer_invoices WHERE workspace_id=$1',[ws])).rows[0].n,'0');
});

test('one-order waves from Ask follow the plan and the taught wave rule while scans, packing and handoff stay with people',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,ws,subscribe,order}=f,assistant=require('../../src/assistant/postgres-service');let handed=0;
 const prepare=async(action,reference,extra={})=>{const p=await assistant.prepareAction(db,ctx,'Prepare warehouse work '+randomUUID(),{action,recordReference:reference,...extra});assert.equal(p.status,'PREPARED',JSON.stringify(p));return assistant.getProposal(db,ws,p.proposal.id);};
 const mission=async p=>{const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
  const noModel={name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('Native steps only.');}};
  if(!await plans.missionForProposal(db,ws,ctx.actorId,p.id)){const goal=await require('../../src/assistant/postgres-goal-store').create(db,ctx,'Pick this order then inspect permissions');
   await db.query("UPDATE stockchief_runtime.assistant_goals SET status='WAITING_APPROVAL',checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE workspace_id=$1 AND id=$2",[ws,goal.id]);
   const chain=await plans.save(db,ctx,'Pick this order then inspect permissions',randomUUID(),[{contract:registry.get(p.action_type),args:{recordReference:p.payload.recordId||p.payload.orderIds[0]},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'financial-permissions'},dependsOn:[0]}],[{result:{status:'PREPARED',proposal:{id:p.id}}},{result:{status:'CLARIFY',reason:'dependency_waiting'}}]);
   await db.query('UPDATE stockchief_runtime.assistant_capability_plans SET goal_id=$3 WHERE workspace_id=$1 AND id=$2',[ws,chain.id,goal.id]);}
  return assistant.executeMission(db,ctx,p.id,{provider:noModel});};
 await subscribe('starter');const first=await order([{sku:f.plain,bin:f.a1,quantity:1}]);await assert.rejects(prepare('warehouse.wave.create',id(first)),e=>e.code==='entitlement_required');
 for(const tier of ['growth','growth','pro','enterprise']){
  await subscribe(tier);const o=handed===0?first:await order([{sku:f.plain,bin:f.a1,quantity:1}]),p=await prepare('warehouse.wave.create',id(o),{strategy:'WAVE'});
  if(handed===0){await assert.rejects(mission(p),/teach|Individually approve|Pro plan/i);await assistant.executeProposal(db,ctx,p.id);
   await zoneWaves.configure(db,ctx,{locationId:f.dispatch,revision:0,waveOrders:'10',automatic:'yes'});}else await mission(p);
  const waveId=(await assistant.getProposal(db,ws,p.id)).result.waveId;assert(waveId);
  const scan=await prepare('warehouse.wave.scan',waveId,{scanLocation:'BIN-A01',scanItem:'PICK-ITEM',quantity:1});await assert.rejects(mission(scan),/own confirmation/);await assistant.executeProposal(db,ctx,scan.id);
  const pack=await prepare('warehouse.wave.pack',waveId,{weightGrams:350});await assert.rejects(mission(pack),/own confirmation/);await assistant.executeProposal(db,ctx,pack.id);
  const shipment=(await db.query('SELECT shipment_id FROM fulfillment_wave_shipments WHERE workspace_id=$1 AND wave_id=$2',[ws,waveId])).rows[0].shipment_id;
  const key=randomUUID();await f.shipping.handoff(db,ctx,shipment,{idempotencyKey:key,handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z'+randomUUID().slice(0,10)});await f.shipping.handoff(db,ctx,shipment,{idempotencyKey:key});handed++;
 }
 const invoices=(await db.query('SELECT count(*) n FROM accounting_customer_invoices WHERE workspace_id=$1',[ws])).rows[0];assert.equal(invoices.n,'4','The physical handoff invoices each order once.');
});

test('undoing a release ends its waves, competing builds make one wave, and the pages read well on a phone',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,ws,order,rows}=f;
 await release.configure(db,ctx,{locationId:f.dispatch,revision:0,batchOrders:'10'});
 await zoneWaves.configure(db,ctx,{locationId:f.dispatch,revision:0,waveOrders:'10'});
 await modes.save(db,ctx,57,{mode:'ask',revision:0});
 const one=await order([{sku:f.plain,bin:f.a1,quantity:1}]),two=await order([{sku:f.blue,bin:f.b1,quantity:1}]);
 await release.run(db,ws);
 const [prepared]=await rows();assert.equal(prepared.status,'PREPARED');assert.deepEqual(prepared.plan.orders.map(o=>o.id).sort(),[id(one),id(two)].sort());
 const [made]=(await db.query("SELECT id FROM stockchief_runtime.agent_pick_releases WHERE workspace_id=$1 AND status='RELEASED'",[ws])).rows;
 const undone=await release.undo(db,ctx,made.id);assert.equal(undone.cancelledBoxes,2);
 const [ended]=await rows();assert.equal(ended.status,'UNDONE');assert.equal(ended.native,'CANCELLED');
 await modes.save(db,ctx,57,{mode:'inherit',revision:1});
 // A new release and two builds racing make one wave.
 const fresh=await order([{sku:f.plain,bin:f.a1,quantity:1}]);
 await modes.save(db,ctx,57,{mode:'watch',revision:2});await release.run(db,ws);await modes.save(db,ctx,57,{mode:'inherit',revision:3});
 const raced=await Promise.all([zoneWaves.run(db,ws),zoneWaves.run(db,ws)]);
 assert.equal(raced.reduce((n,r)=>n+r.built,0),1);
 assert.equal((await rows()).filter(w=>w.plan.orders.some(o=>o.id===id(fresh))).length,1);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 const wave=(await rows()).at(-1);
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const page=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});page.setDefaultTimeout(15000);
  await page.goto(base+'/login');await page.locator('input[name="email"]').fill(f.email);await page.locator('input[name="password"]').fill(f.password);await page.locator('button[type="submit"]').click();
  for(const [label,path] of [['pick-waves','/autopilot/pick-waves'],['zone-wave','/warehouse/waves/'+wave.wave_id]]){
   await page.goto(base+path);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,label+' on '+name+' has no sideways scroll');
   await page.screenshot({path:require('node:path').join(folder,label+'-'+name+'.png'),fullPage:true});
  }
  await page.close();
 }
 const review=await f.browser.get('/autopilot/reviews/pick-waves').expect(200);assert.match(review.text,/Open pick waves and set your wave rules/);
});
