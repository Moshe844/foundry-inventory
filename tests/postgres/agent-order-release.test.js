'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const release=require('../../src/warehouse/agent-pick-release');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const places=require('../../src/domain/postgres-location-service');
const stock=require('../../src/domain/postgres-inventory-engine');
const time=require('../../src/lib/business-time');
const {addDays}=require('../../src/accounting/customer-money');

async function mission(db,ctx,p){
 const assistant=require('../../src/assistant/postgres-service'),plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 const noModel={name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('Warehouse release must use its native saved steps.');}};
 if(!await plans.missionForProposal(db,ctx.workspaceId,ctx.actorId,p.id)){
  const goal=await require('../../src/assistant/postgres-goal-store').create(db,ctx,'Release warehouse work then inspect stock permissions');
  await db.query("UPDATE stockchief_runtime.assistant_goals SET status='WAITING_APPROVAL',checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,goal.id]);
  const chain=await plans.save(db,ctx,'Release warehouse work then inspect stock permissions',randomUUID(),[{contract:registry.get(p.action_type),args:{recordReference:p.payload.recordId||p.payload.orderIds[0]},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'financial-permissions'},dependsOn:[0]}],[{result:{status:'PREPARED',proposal:{id:p.id}}},{result:{status:'CLARIFY',reason:'dependency_waiting'}}]);
  await db.query('UPDATE stockchief_runtime.assistant_capability_plans SET goal_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,chain.id,goal.id]);
 }
 return assistant.executeMission(db,ctx,p.id,{provider:noModel});
}

async function setup(t,units=40){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f,ws=ctx.workspaceId;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const assistant=require('../../src/assistant/postgres-service'),sku=f.item.skuIds[0];
 await db.query("UPDATE skus SET barcode='PICK-ITEM' WHERE workspace_id=$1 AND id=$2",[ws,sku]);await db.query("UPDATE locations SET barcode='PICK-BIN' WHERE workspace_id=$1 AND id=$2",[ws,f.location.id]);
 const order=async({quantity=2,price=1000,priority=100,neededBy=null,location=f.location.id,address='10 Jobsite Rd, Albany, NY 12207',customer='fixture-customer',skuId=sku}={})=>{
  const o=await f.workflows.createSalesOrder(db,ctx,{customerId:customer,deliveryMethod:'SHIP',shipToAddress:address,fulfillmentLocationId:location,neededBy,idempotencyKey:randomUUID(),lines:[{skuId,quantity,unitPriceMinor:price}]});
  await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
  if(priority!==100)await db.query('UPDATE sales_orders SET allocation_priority=$3 WHERE workspace_id=$1 AND id=$2',[ws,o.salesOrderId,priority]);
  return o;};
 const prepare=async(action,reference,extra={})=>{const p=await assistant.prepareAction(db,ctx,'Prepare warehouse work '+randomUUID(),{action,recordReference:reference,...extra});assert.equal(p.status,'PREPARED',JSON.stringify(p));return assistant.getProposal(db,ctx.workspaceId,p.proposal.id);};
 const releases=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_pick_releases WHERE workspace_id=$1 AND ${where} ORDER BY created_at,id`,[ws])).rows;
 const members=async id=>(await db.query('SELECT sales_order_id FROM stockchief_runtime.agent_pick_release_orders WHERE workspace_id=$1 AND release_id=$2 ORDER BY position',[ws,id])).rows.map(r=>r.sales_order_id);
 const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
 const boxes=async()=>Number((await db.query("SELECT count(*) n FROM sales_shipments WHERE workspace_id=$1 AND status<>'CANCELLED'",[ws])).rows[0].n);
 const today=await time.today(db,ws);
 return {...f,ws,sku,assistant,order,prepare,releases,members,audits,boxes,today};
}
const id=o=>o.salesOrderId;

test('ready orders go out in pick order; Starter is refused, Growth proposes until taught and Pro and Custom release on their own within each warehouse rule',{timeout:420000},async t=>{
 const f=await setup(t,200),{db,ctx,ws,subscribe,browser,order,releases,members,audits,boxes,today}=f;
 // East dock has an earlier carrier cut-off than Dispatch.
 const east=await places.createLocation(db,ctx,{name:'East dock',kind:'warehouse',address:'5 Port Rd, Newark, NJ 07114'});
 await stock.receive(db,ctx,{skuId:f.sku,locationId:east.id,quantity:60,idempotencyKey:randomUUID()});
 const plain=await order(),later=await order({neededBy:addDays(today,30)}),dueHere=await order({neededBy:addDays(today,2)});
 const dueEast=await order({neededBy:addDays(today,2),location:east.id}),urgent=await order({priority:10,neededBy:addDays(today,30)});
 const stockBefore=await f.balance();

 await subscribe('starter');
 assert.match((await browser.get('/autopilot/pick-release').expect(200)).text,/data-agent-plan-locked/);
 assert.deepEqual(await release.run(db,ws),{released:0,releases:0,proposed:0,held:0,watching:false});
 await assert.rejects(release.configure(db,ctx,{locationId:f.location.id,revision:0,batchOrders:'2'}),e=>e.code==='entitlement_required');
 await assert.rejects(f.prepare('warehouse.release_orders',id(urgent)),e=>e.code==='entitlement_required');

 await subscribe('growth');
 await release.configure(db,ctx,{locationId:f.location.id,revision:0,batchOrders:'2',cutoffs:'UPS 17:00'});
 await release.configure(db,ctx,{locationId:east.id,revision:0,batchOrders:'5',cutoffs:'FedEx 2:00 pm'});
 assert.deepEqual((await db.query('SELECT cutoffs FROM stockchief_runtime.agent_pick_release_rules WHERE workspace_id=$1 AND location_id=$2',[ws,east.id])).rows[0].cutoffs,[{carrier:'FedEx',time:'14:00'}]);
 // Priority first, then the ship-by date, then the earlier carrier cut-off on that date, then order age.
 assert.deepEqual((await release.candidates(db,ws)).map(o=>o.id),[id(urgent),id(dueEast),id(dueHere),id(later),id(plain)]);
 await assert.rejects(release.configure(db,ctx,{locationId:f.location.id,revision:1,batchOrders:'2',cutoffs:'UPS at five'}),/carrier and a time/);
 await assert.rejects(release.configure(db,ctx,{locationId:f.location.id,revision:1,batchOrders:'0'}),/whole number/);

 // Growth proposes each release until taught. Nothing moves.
 let result=await release.run(db,ws);
 assert.deepEqual([result.proposed,result.released],[2,0]);
 const [dispatchProposal]=await releases(`status='PROPOSED' AND location_id='${f.location.id}'`);
 assert.deepEqual(dispatchProposal.plan.orders.map(o=>o.id),[id(urgent),id(dueHere)],'The rule sends two at a time, in pick order.');
 assert.match(dispatchProposal.reason,/Growth proposes each release/);
 assert.match(dispatchProposal.plan.orders[0].why,/Priority 10 · ship by .* · carrier cut-off 17:00 · ordered/);
 assert.equal((await release.run(db,ws)).proposed,2);assert.equal((await releases("status='PROPOSED'")).length,2,'An unchanged proposal is kept, not repeated.');
 const needs=await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
 assert(needs.some(n=>n.sourceId==='pick-release:'+dispatchProposal.id&&/Release orders to Dispatch/.test(n.title)));
 // An Ask mission on Growth is refused until taught; the person still approves from the page.
 const asked=await f.prepare('warehouse.release_orders',id(later),{quantity:5});
 assert.deepEqual(asked.payload.orderIds,[id(urgent),id(dueHere),id(later),id(plain)],'No fixed cap: the request releases up to the asked number.');
 await assert.rejects(mission(db,ctx,asked),/teach|Individually approve|Pro plan/i);
 await f.assistant.cancelProposal?.(db,ctx,asked.id).catch(()=>{});
 const view=await browser.get('/autopilot/pick-release').expect(200);assert.match(view.text,/Waiting for you/);assert.match(view.text,/East dock/);
 await browser.post('/autopilot/pick-release/releases/'+dispatchProposal.id+'/approve').type('form').send({_csrf:f.csrf(view.text),fingerprint:dispatchProposal.fingerprint,confirmed:'yes'}).expect(303);
 const [approved]=await releases("status='RELEASED'");
 assert.equal(approved.id,dispatchProposal.id);assert.equal(approved.authorization_kind,'INDIVIDUAL');
 assert.deepEqual(await members(approved.id),[id(urgent),id(dueHere)]);
 assert.equal((await release.approve(db,ctx,approved.id,{confirmed:'yes',fingerprint:approved.fingerprint})).replayed,true);
 assert.equal(await boxes(),0,'A release makes no box.');assert.equal(await f.balance(),stockBefore,'A release moves no stock.');
 assert.equal(await audits('Released orders to the warehouse'),1);
 assert.deepEqual((await release.candidates(db,ws,{locationId:f.location.id})).map(o=>o.id),[id(later),id(plain)],'Released orders are no longer waiting to be released.');

 // Teaching from the approved example lets Growth release on its own.
 await release.teach(db,ctx,approved.id);assert.equal(await audits('Taught StockChief to release orders on its own'),1);
 result=await release.run(db,ws);assert.equal(result.released,2);assert.equal(result.proposed,1,'East dock is not taught yet.');
 const [auto]=await releases("status='RELEASED' AND authorization_kind='AUTOMATIC'");
 assert.deepEqual(await members(auto.id),[id(later),id(plain)]);assert.equal(await audits('StockChief released orders to the warehouse'),1);
 const digest=await require('../../src/autopilot/agent-work-digest').report(db,ctx,{});
 assert(digest.rows.some(r=>/Released orders to the warehouse: 2 orders at Dispatch/.test(r.Action)));
 // Undo before picking starts; StockChief does not release those orders again on its own.
 const undone=await release.undo(db,ctx,auto.id);assert.equal(undone.orders,2);
 assert.equal((await release.run(db,ws)).released,0);
 assert.deepEqual((await release.candidates(db,ws,{locationId:f.location.id})).map(o=>o.id),[id(later),id(plain)],'A person can still release them.');

 // Ask me first, Watch only, pause and shadow mode propose or only watch.
 const fresh=await order();
 await modes.save(db,ctx,56,{mode:'ask',revision:0});
 result=await release.run(db,ws);assert.equal(result.released,0);
 const [asking]=await releases(`status='PROPOSED' AND location_id='${f.location.id}'`);assert.deepEqual(asking.plan.orders.map(o=>o.id),[id(fresh)]);assert.match(asking.reason,/Ask me first/);
 await modes.save(db,ctx,56,{mode:'watch',revision:1});
 assert.equal((await release.run(db,ws)).watching,true);
 await assert.rejects(release.approve(db,ctx,asking.id,{confirmed:'yes',fingerprint:asking.fingerprint}),/Watch only/);
 await modes.save(db,ctx,56,{mode:'inherit',revision:2});
 await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');assert.equal((await release.run(db,ws)).released,0);await autopilot.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await release.run(db,ws)).watching,true);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 assert.equal((await release.run(db,ws)).released,1);

 // Pro releases on its own without teaching, and no batch is capped at 20.
 await subscribe('pro');
 assert.equal((await release.run(db,ws)).released,1,'East dock releases on Pro without teaching.');
 const many=[];for(let i=0;i<24;i++)many.push(await order({quantity:1}));
 await release.configure(db,ctx,{locationId:f.location.id,revision:2,batchOrders:'30',cutoffs:'UPS 17:00'});
 result=await release.run(db,ws);
 const big=(await releases("status='RELEASED'")).sort((a,b)=>b.released_at-a.released_at)[0];
 const bigOrders=await members(big.id);assert.equal(bigOrders.length,24,'All 24 new orders go out together: no fixed cap of 20.');
 assert(!bigOrders.includes(id(later))&&!bigOrders.includes(id(plain)),'Orders the owner took back still wait for a person.');
 // A warehouse limit on orders waiting to be picked sizes the batch.
 const open=await release.openWork(db,ws,f.location.id);assert.equal(open,27,'Released orders not yet packed are waiting in the warehouse.');
 await release.configure(db,ctx,{locationId:f.location.id,revision:3,batchOrders:'5',capacityOrders:'29'});
 for(let i=0;i<3;i++)await order({quantity:1});
 result=await release.run(db,ws);assert.equal(result.released,2,'Only the room left under the limit is released.');
 result=await release.run(db,ws);assert.equal(result.released,0);assert.equal(result.held,1);
 assert.match((await db.query('SELECT problem FROM stockchief_runtime.agent_pick_release_checks WHERE workspace_id=$1 AND location_id=$2',[ws,f.location.id])).rows[0].problem,/already has 29 orders waiting/);

 // Without a rule and without a shipping record StockChief stops and asks;
 // once the warehouse has shipped, its busiest day sizes the batch.
 const north=await places.createLocation(db,ctx,{name:'North store',kind:'warehouse',address:'9 Lake St, Plattsburgh, NY 12901'});
 await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:f.sku,locationId:north.id,quantity:20,unitCost:'1.00',idempotencyKey:randomUUID()});
 const n1=await order({location:north.id,quantity:1}),n2=await order({location:north.id,quantity:1}),n3=await order({location:north.id,quantity:1});
 await release.recheck(db,ctx);result=await release.run(db,ws);
 const [northAsk]=await releases(`status='PROPOSED' AND location_id='${north.id}'`);assert.match(northAsk.reason,/Save how many orders this warehouse takes at a time/);
 const box=await f.shipping.prepare(db,ctx,id(n1),{idempotencyKey:randomUUID(),lines:[{lineId:n1.lineIds[0],locationId:north.id,quantity:1}]});
 await f.shipping.markPacked(db,ctx,box.shipmentId);await f.shipping.handoff(db,ctx,box.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z'+randomUUID().slice(0,10)});
 assert.equal(await release.shippedPerDay(db,ws,north.id),1);
 result=await release.run(db,ws);
 const [northAuto]=await releases(`status='RELEASED' AND location_id='${north.id}'`);
 assert.deepEqual(await members(northAuto.id),[id(n2)],'One order a day was shipped here, so one goes out.');
 assert.equal((await releases(`status='PROPOSED' AND location_id='${north.id}'`)).length,0,'The automatic release replaces the waiting proposal.');
 void n3;

 // Custom releases on its own too.
 await subscribe('enterprise');
 const custom=await order({location:east.id});
 assert.equal((await release.run(db,ws)).released,1);
 assert((await releases('true')).some(r=>r.location_id===east.id&&r.authorization_kind==='AUTOMATIC'&&r.plan.orders[0].id===id(custom)));
 assert.equal(await f.balance(),stockBefore+20-1,'Only the North receipt and handoff moved stock.');
 assert.equal((await db.query('SELECT count(*) n FROM accounting_customer_invoices WHERE workspace_id=$1',[ws])).rows[0].n,'1','Releasing never invoices.');
 for(const o of many)void o;
});

test('only ready orders go out: bins inside the warehouse, tracked goods and FEFO batches count, while address, credit, warehouse questions and missing stock stop and ask',{timeout:420000},async t=>{
 const f=await setup(t,40),{db,ctx,ws,order,releases,members}=f,catalog=require('../../src/domain/postgres-catalog-service'),rotation=require('../../src/operations/postgres-stock-rotation');
 const flows=f.workflows,native=require('../../src/sales/postgres-order-allocations');
 await release.configure(db,ctx,{locationId:f.location.id,revision:0,batchOrders:'50'});
 // Zone A > bin A-01 inside Dispatch, with its own stock.
 const zone=await places.createLocation(db,ctx,{name:'Zone A',kind:'zone',parentLocationId:f.location.id});
 const bin=await places.createLocation(db,ctx,{name:'A-01',kind:'bin',parentLocationId:zone.id});
 await stock.receive(db,ctx,{skuId:f.sku,locationId:bin.id,quantity:10,idempotencyKey:randomUUID()});
 const inBin=await order({quantity:3});
 const version=Number((await db.query('SELECT version FROM sales_orders WHERE id=$1',[id(inBin)])).rows[0].version);
 const back=await native.giveBack(db,ctx,id(inBin),{expectedVersion:version,idempotencyKey:randomUUID(),lines:[{lineId:inBin.lineIds[0],locationId:f.location.id,quantity:3}]});
 await native.setAside(db,ctx,id(inBin),{expectedVersion:back.version,idempotencyKey:randomUUID(),lines:[{lineId:inBin.lineIds[0],locationId:bin.id,quantity:3}]});
 // Lot goods reserved by FEFO, and a serial-tracked product.
 const lotted=(await catalog.createItem(db,ctx,{name:'Batch syrup',baseCode:'SYR-'+randomUUID().slice(0,6),trackingMode:'lot'})).skuIds[0];
 const po=await flows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:lotted,quantityUnits:6,unitCost:1}]});
 await flows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await flows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 await flows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:3,locationId:f.location.id,lotCode:'SOON',expiresAt:addDays(f.today,20)}]});
 await flows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:3,locationId:f.location.id,lotCode:'LATE',expiresAt:addDays(f.today,90)}]});
 const fefo=await order({skuId:lotted,quantity:2}),recalled=await order({skuId:lotted,quantity:2});
 for(const o of [fefo,recalled])await rotation.bind(db,ctx,await rotation.plan(db,ctx,id(o),'FEFO'));
 await db.query("UPDATE lots SET recalled_at=now() WHERE workspace_id=$1 AND code='LATE'",[ws]);
 const serialized=(await catalog.createItem(db,ctx,{name:'Serial scanner',baseCode:'SER-'+randomUUID().slice(0,6),trackingMode:'serial'})).skuIds[0];
 const spo=await flows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:serialized,quantityUnits:2,unitCost:5}]});
 await flows.approvePurchaseOrder(db,ctx,spo.purchaseOrderId,{idempotencyKey:randomUUID()});await flows.placePurchaseOrder(db,ctx,spo.purchaseOrderId,{idempotencyKey:randomUUID()});
 await flows.receivePurchaseOrder(db,ctx,spo.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:spo.lineIds[0],quantity:2,locationId:f.location.id,serials:['SN-1','SN-2']}]});
 const serial=await order({skuId:serialized,quantity:1});

 // What holds orders back.
 const noAddress=await order({address:'Back door'});
 await db.query(`INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at)
   VALUES('late-payer',$1,'Late payer','late@example.test','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
 const paid=await order({customer:'late-payer',quantity:1}),onCredit=await order({customer:'late-payer',quantity:1});
 const parcel=await f.shipping.prepare(db,ctx,id(paid),{idempotencyKey:randomUUID(),lines:[{lineId:paid.lineIds[0],locationId:f.location.id,quantity:1}]});
 await f.shipping.markPacked(db,ctx,parcel.shipmentId);await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z'+randomUUID().slice(0,10)});
 await db.query('UPDATE accounting_customer_invoices SET due_date=$2 WHERE workspace_id=$1',[ws,addDays(f.today,-3)]);
 await require('../../src/sales/agent-order-checks').configure(db,ctx,'on');
 const question=await order({quantity:1});
 await db.query(`INSERT INTO stockchief_runtime.agent_warehouse_routings(id,workspace_id,sales_order_id,status,plan,fingerprint,request_key,reason,prepared_by)
   VALUES($1,$2,$3,'ASK','{}'::jsonb,'x',$4,'The address is unclear.',$5)`,[randomUUID(),ws,id(question),randomUUID(),ctx.actorId]);
 const shelf=(await catalog.createItem(db,ctx,{name:'Short shelf item',baseCode:'SHF-'+randomUUID().slice(0,6),trackingMode:'quantity'})).skuIds[0];
 await stock.receive(db,ctx,{skuId:shelf,locationId:f.location.id,quantity:2,idempotencyKey:randomUUID()});
 const short=await order({skuId:shelf,quantity:2});
 // A count finds one missing after the order was reserved.
 await stock.adjust(db,ctx,{skuId:shelf,locationId:f.location.id,countedQuantity:1,reasonCode:'count',idempotencyKey:randomUUID()});
 const page=await release.page(db,ctx);
 const reasons=Object.fromEntries(page.held.map(h=>[h.id,h.reason]));
 assert.match(reasons[id(noAddress)],/address is missing or incomplete/);
 assert.match(reasons[id(onCredit)],/overdue invoice/);
 assert.match(reasons[id(recalled)],/Batch LATE reserved for .* was recalled/);
 assert.match(reasons[id(short)],/no longer covers what is reserved/);
 assert(!page.ready.some(o=>o.id===id(question))&&!reasons[id(question)],'An open warehouse question keeps the order out of the queue.');
 const result=await release.run(db,ws);
 const [made]=await releases("status='RELEASED'");
 const out=await members(made.id);
 assert(out.includes(id(inBin)),'Stock reserved in a bin inside the warehouse is ready.');
 assert(out.includes(id(fefo))&&out.includes(id(serial)),'Lot and serial goods are released.');
 for(const held of [noAddress,onCredit,recalled,question,short])assert(!out.includes(id(held)));
 assert.equal(result.released,out.length);
 // Picking that has started cannot be undone; an unstarted box is cancelled by the undo.
 const waves=require('../../src/operations/postgres-fulfillment-waves');
 const wave=await waves.create(db,ctx,{orderIds:[id(inBin),id(fefo)],strategy:'WAVE',idempotencyKey:randomUUID()});
 await db.query("UPDATE locations SET barcode='A-01-BIN' WHERE workspace_id=$1 AND id=$2",[ws,bin.id]);
 assert.equal((await waves.scan(db,ctx,wave.waveId,{clientScanId:randomUUID(),locationBarcode:'A-01-BIN',itemBarcode:'PICK-ITEM',quantity:1})).status,'ACCEPTED');
 await assert.rejects(release.undo(db,ctx,made.id),/Picking has started for/);
 const shipmentOf=async o=>(await db.query("SELECT id FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status<>'CANCELLED'",[ws,id(o)])).rows[0].id;
 await f.shipping.cancel(db,ctx,await shipmentOf(inBin),{reason:'Recount the bin'});
 const done=await release.undo(db,ctx,made.id);
 assert.equal(done.cancelledBoxes,1,'The unstarted FEFO box is cancelled with the release.');
 assert.equal((await db.query("SELECT status FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2",[ws,id(fefo)])).rows[0].status,'CANCELLED');
 assert.equal(await release.run(db,ws).then(r=>r.released),0,'Undone orders wait for a person.');
 assert.equal(await f.audits('Undid a release to the warehouse'),1);
});

test('competing routines release once, a late failure rolls the release back, and the page reads well on a phone',{timeout:300000},async t=>{
 const f=await setup(t,40),{db,ctx,ws,order,releases}=f;
 await release.configure(db,ctx,{locationId:f.location.id,revision:0,batchOrders:'10',cutoffs:'UPS 16:00\nUSPS 15:30'});
 for(let i=0;i<4;i++)await order({quantity:1});
 await db.query("CREATE FUNCTION test_reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test late release failure'; END $$");
 await db.query('CREATE TRIGGER test_reject_release BEFORE INSERT ON stockchief_runtime.agent_pick_release_orders FOR EACH ROW EXECUTE FUNCTION test_reject_release()');
 await assert.rejects(release.run(db,ws),/test late release failure/);
 await db.query('DROP TRIGGER test_reject_release ON stockchief_runtime.agent_pick_release_orders');await db.query('DROP FUNCTION test_reject_release()');
 assert.equal((await releases()).length,0,'Nothing of the failed release was kept.');
 const raced=await Promise.all([release.run(db,ws),release.run(db,ws)]);
 assert.equal(raced.reduce((n,r)=>n+r.released,0),4);assert.equal((await releases("status='RELEASED'")).length,1);
 assert.equal(Number((await db.query("SELECT count(*) n FROM stockchief_runtime.agent_pick_release_orders WHERE workspace_id=$1 AND state='RELEASED'",[ws])).rows[0].n),4);
 assert.equal((await release.run(db,ws)).released,0,'A replay finds nothing left.');
 // A person releases the next orders straight from the page.
 for(let i=0;i<2;i++)await order({quantity:1});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const page=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});page.setDefaultTimeout(15000);
  await page.goto(base+'/login');await page.locator('input[name="email"]').fill(f.email);await page.locator('input[name="password"]').fill(f.password);await page.locator('button[type="submit"]').click();
  await page.goto(base+'/autopilot/pick-release');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,name+' has no sideways scroll');
  await page.screenshot({path:require('node:path').join(folder,'pick-release-'+name+'.png'),fullPage:true});
  if(name==='phone'){
   await page.getByRole('button',{name:/Release 2 orders to Dispatch now/}).click();
   await page.waitForURL(/pick-release/);assert.match(await page.textContent('body'),/2 orders released to Dispatch/);
  }
  await page.close();
 }
 assert.equal((await releases("status='RELEASED' AND authorization_kind='INDIVIDUAL'")).length,1);
 // The agent review lists ready orders and links to the page.
 const review=await f.browser.get('/autopilot/reviews/pick-release').expect(200);assert.match(review.text,/Release ready orders and set your release rules/);
});

