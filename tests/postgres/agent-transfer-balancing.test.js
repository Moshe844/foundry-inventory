'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const balancing=require('../../src/transfers/agent-transfer-balancing');
const native=require('../../src/transfers/postgres-transfer-service');
const assistant=require('../../src/assistant/postgres-service');
const reviews=require('../../src/autopilot/job-reviews');
const autonomy=require('../../src/autopilot/postgres-service');
const jobs=require('../../src/operations/postgres-job-queue');
const {addDays}=require('../../src/accounting/customer-money');
const {fixture:base}=require('../helpers/agent-workflow-fixture');

async function fixture(t){
  const f=await base(t,{units:20}),{db,ctx}=f;
  await f.subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  await autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const makeLocation=name=>require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name,kind:'warehouse'});
  const destination=await makeLocation('Balancing destination'),spare=await makeLocation('Other outbound destination');
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,sku])).rows[0].code;
  async function target(skuId,locationId,targetStock){
    const changed=await db.query('UPDATE reorder_policies SET reorder_point=$4,target_stock=$4 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,skuId,locationId,targetStock]);
    if(!changed.rowCount)await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,skuId,locationId,targetStock]);
  }
  async function purchase(skuId,quantity,{destinationId=f.location.id,arrive=true,extra={},expectedDate=addDays(today,2)}={}){
    const p=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',currency:'USD',destinationLocationId:destinationId,
      expectedDate,idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:quantity,unitCost:1.25,secondaryQuantity:extra.secondaryQuantity}]});
    await f.workflows.approvePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});
    if(arrive){
      await f.workflows.placePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});
      await f.workflows.receivePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID(),
        lines:[{lineId:p.lineIds[0],locationId:destinationId,quantity,...extra}]});
    }
    return p;
  }
  const args={sku:code,fromLocation:f.location.name,toLocation:destination.name};
  async function prepare(values={}){
    const p=await assistant.prepareAction(db,ctx,'Prepare this exact balance request',{action:balancing.action,...args,...values});
    return {...p,proposal:await assistant.getProposal(db,ctx.workspaceId,p.proposal.id)};
  }
  async function mission(p){
    const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
    if(!(await db.query('SELECT 1 FROM stockchief_runtime.assistant_capability_plans WHERE workspace_id=$1 AND waiting_proposal_id=$2',[ctx.workspaceId,p.proposal.id])).rowCount){
      await plans.save(db,ctx,'Prepare transfer then review stock',randomUUID(),[
        {contract:registry.get(balancing.action),args:{},dependsOn:[]},
        {contract:registry.get('read.agent_review'),args:{agentJob:'balance-transfers'},dependsOn:[0]},
      ],[{result:p},{result:{status:'CLARIFY'}}]);
    }
    return assistant.executeMission(db,ctx,p.proposal.id);
  }
  async function queue(cycle=randomUUID()){await balancing.enqueue(db,ctx.workspaceId,cycle);return cycle;}
  async function run(){
    const h=require('../../src/operations/postgres-runtime-handlers').create();
    const done=await jobs.processOne(db,h,{owner:'balance-test',kinds:[balancing.jobKind],leaseMs:30000});
    assert.equal(done?.status,'COMPLETED',JSON.stringify(done?.lastError));return done.result;
  }
  const balanceDrafts=async()=>(await db.query("SELECT * FROM inventory_transfers WHERE workspace_id=$1 AND decision_detail::jsonb->>'kind'='agent_balance_request' ORDER BY created_at,id",[ctx.workspaceId])).rows;
  const amounts=async()=>(await db.query('SELECT sku_id,location_id,on_hand::text FROM balances WHERE workspace_id=$1 ORDER BY sku_id,location_id',[ctx.workspaceId])).rows;
  return {...f,sku,code,makeLocation,destination,spare,today,target,purchase,args,prepare,mission,queue,run,balanceDrafts,amounts};
}

test('Starter suggests and Growth learns an exact route from a reviewed request before scheduled native drafting',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  await f.target(f.sku,f.location.id,7);
  await f.target(f.sku,f.destination.id,8);
  await f.purchase(f.sku,1,{destinationId:f.destination.id,arrive:false});
  const sold=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.sku,quantity:4,unitPriceMinor:250}]});
  await f.workflows.confirmSalesOrder(db,ctx,sold.salesOrderId,{idempotencyKey:randomUUID()});
  await native.request(db,ctx,{fromLocationId:f.location.id,toLocationId:f.spare.id,idempotencyKey:randomUUID(),lines:[{skuId:f.sku,quantity:2}]});
  const before=await f.amounts();
  await f.subscribe('starter');
  const suggestion=await reviews.run(db,ctx,'balance-transfers',{filter:f.code});
  assert.equal(suggestion.mode,'suggest');assert.match(suggestion.rows[0].Suggestion,/7 .*Balancing destination/);
  assert.equal(suggestion.balanceForm,undefined);
  await assert.rejects(f.prepare(),e=>e.code==='entitlement_required');
  assert.equal((await f.balanceDrafts()).length,0);
  await f.subscribe('growth');
  let p=await f.prepare();assert.equal(p.proposal.payload.quantity,'7');
  assert.match(p.proposal.summary,/14 .*usable after 4 committed and 2 otherwise held/);
  assert.match(p.proposal.summary,/1 dated incoming/);
  await assert.rejects(f.mission(p),e=>e.code==='entitlement_required');
  await assert.rejects(balancing.configure(db,ctx,{...f.args,revision:0,confirmed:'yes',maximumBalanceQuantity:'5'}),/individually approved/);
  const competing=await f.prepare();
  const attempts=await Promise.allSettled([p,competing].map(item=>assistant.executeProposal(db,ctx,item.proposal.id)));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  assert.match(attempts.find(r=>r.status==='rejected').reason.message,/draft|changed|stock/);
  if(attempts[0].status!=='fulfilled')p=competing;
  const decided=attempts.find(r=>r.status==='fulfilled').value;
  assert.equal((await assistant.executeProposal(db,ctx,p.proposal.id)).replayed,true);
  const first=await native.get(db,ctx.workspaceId,decided.result.transferId);
  assert.equal(first.status,'REQUESTED');assert.equal(first.totals.requested,7);
  assert.deepEqual(await f.amounts(),before);
  await assert.rejects(balancing.configure(db,ctx,{...f.args,revision:0,confirmed:'yes',maximumBalanceQuantity:'8',exampleId:p.proposal.id}),/at or above/);
  const saved=await balancing.configure(db,ctx,{...f.args,revision:0,confirmed:'yes',maximumBalanceQuantity:'5',exampleId:p.proposal.id});
  await native.cancel(db,ctx,first.id,{reason:'Complete the example and wait for the next planning cycle',idempotencyKey:randomUUID()});
  const qty=await f.prepare({maximumBalanceQuantity:'5'});
  assert.equal(await balancing.trained(db,ctx.workspaceId,qty.proposal.payload),true);
  const schedule=(await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:'autopilot.evaluate',idempotencyKey:randomUUID(),
    payload:{actorId:ctx.actorId,requestedByUser:true},priority:40,maxAttempts:1})).job;
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const planner=await jobs.processOne(db,handlers,{owner:'balance-planner-test',kinds:['autopilot.evaluate'],leaseMs:30000});
  assert.equal(planner?.id,schedule.id);assert.equal(planner?.status,'COMPLETED',JSON.stringify(planner?.lastError));
  const worker=schedule.id;assert.deepEqual(await f.run(),{prepared:1,held:0});
  await f.queue(worker);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2',[ctx.workspaceId,balancing.jobKind])).rows[0].n,1);
  const draft=(await f.balanceDrafts()).find(t=>t.status==='REQUESTED');assert(draft);
  assert.equal((await native.get(db,ctx.workspaceId,draft.id)).totals.requested,5);
  assert.deepEqual(await f.amounts(),before);
  await assert.rejects(f.prepare(),/existing draft/);
  await f.queue();assert.deepEqual(await f.run(),{prepared:0,held:1});
  for(const op of ['approve','pick','dispatch','markInTransit'])await native[op](db,ctx,draft.id,{idempotencyKey:randomUUID()});
  const line=(await native.get(db,ctx.workspaceId,draft.id)).lines[0],receipt={idempotencyKey:randomUUID(),lines:[{lineId:line.id,received:5}]};
  await native.receive(db,ctx,draft.id,receipt);assert.equal((await native.receive(db,ctx,draft.id,receipt)).replayed,true);
  assert.equal((await native.verify(db,ctx.workspaceId,draft.id)).ok,true);
  assert.equal((await db.query('SELECT on_hand::text FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.sku,f.destination.id])).rows[0].on_hand,'5');
  await f.queue();await f.subscribe('starter');assert.deepEqual(await f.run(),{held:true});
  await balancing.configure(db,ctx,{mode:'remove',scope:saved.scope,revision:1});
  assert.equal((await balancing.settings(db,ctx)).rules.length,0);
});

test('Pro and Custom can authorize and execute new bounded routes without a taught example',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  await f.target(f.sku,f.location.id,6);await f.target(f.sku,f.destination.id,9);
  await f.subscribe('pro');const unscoped=await f.prepare({maximumBalanceQuantity:'3'});
  await assert.rejects(f.mission(unscoped),/exact route/);
  await balancing.configure(db,ctx,{...f.args,revision:0,confirmed:'yes',maximumBalanceQuantity:'3'});
  await assert.rejects(f.mission(await f.prepare({maximumBalanceQuantity:'4'})),/exact route/);
  const draft=(await f.mission(await f.prepare({maximumBalanceQuantity:'3'}))).result;
  assert.equal(draft.automatic,true);assert.equal((await native.get(db,ctx.workspaceId,draft.transferId)).status,'REQUESTED');
  const extra=await f.makeLocation('Custom balancing donor');
  await f.purchase(f.sku,5,{destinationId:extra.id});
  await f.target(f.sku,extra.id,1);await f.subscribe('enterprise');
  const custom={...f.args,fromLocation:extra.name};
  await balancing.configure(db,ctx,{...custom,revision:0,confirmed:'yes',maximumBalanceQuantity:'2'});
  const state=await balancing.settings(db,ctx);
  assert.equal(state.rules.length,2);assert.ok(state.rules.every(r=>r.taught_proposal_id===null));
  await f.queue();await autonomy.pause(db,ctx,{role:'owner'},'Review the balancing rules');
  assert.deepEqual(await f.run(),{prepared:0,held:2});
  await autonomy.resume(db,ctx,{role:'owner'});
  await f.queue();assert.deepEqual(await f.run(),{prepared:1,held:1});
  const customRequest=(await f.balanceDrafts()).find(r=>r.source_location_id===extra.id);assert(customRequest);
  assert.equal((await native.get(db,ctx.workspaceId,customRequest.id)).totals.requested,2);
  assert.equal(await f.balance(),25);
  await native.cancel(db,ctx,customRequest.id,{reason:'Exercise lower plan reuse',idempotencyKey:randomUUID()});
  await f.queue();await f.subscribe('growth');assert.deepEqual(await f.run(),{prepared:0,held:2});
  assert.equal((await f.balanceDrafts()).length,2);
});

test('actual phone review drafts exact measured batches, preserves tracked commitments, and holds unknown catch weights or stale supply',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
  await f.subscribe('pro');
  const measured=(await catalog.createItem(db,ctx,{name:'Balancing measured cable',baseCode:'BAL-CABLE',trackingMode:'lot',
    unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'})).skuIds[0];
  await f.purchase(measured,'0.5',{extra:{lotCode:'EARLY',expiresAt:addDays(f.today,7)}});
  await f.purchase(measured,'0.875',{extra:{lotCode:'LATER',expiresAt:addDays(f.today,30)}});
  await f.target(measured,f.location.id,'0.5');await f.target(measured,f.destination.id,'1');
  const from=f.location.id,to=f.destination.id,common={fromLocation:from,toLocation:to};
  const draft=await f.prepare({...common,sku:'BAL-CABLE'});
  assert.equal(draft.proposal.payload.quantity,'0.875');
  assert.deepEqual(draft.proposal.payload.lines.map(l=>l.quantity),['0.5','0.375']);
  assert.match(draft.proposal.summary,/Lot EARLY/);assert.match(draft.proposal.summary,/Lot LATER/);

  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});
  const chrome=await require('playwright').chromium.launch(),phone=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const url='http://127.0.0.1:'+server.address().port;
  await phone.goto(url+'/login');await phone.locator('[name=email]').fill(f.email);await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(url+'/autopilot/reviews/balance-transfers?filter=BAL-CABLE');
  await phone.getByText('Prepare a stock balancing request',{exact:true}).click();
  await phone.locator('input[name=fromLocation]').fill(f.location.name);await phone.locator('input[name=toLocation]').fill(f.destination.name);
  await phone.getByRole('button',{name:'Review the balancing request'}).click();
  await phone.waitForURL(/\/actions\//);assert.match(await phone.textContent('body'),/Lot EARLY/);
  assert.equal(await phone.locator('body').evaluate(b=>b.scrollWidth<=innerWidth+2),true);
  await phone.getByRole('button',{name:/Approve only this change/}).click();
  await phone.waitForLoadState('networkidle');assert.match(await phone.textContent('body'),/Completed change/);
  const measuredDraft=(await f.balanceDrafts())[0];
  assert.equal((await native.get(db,ctx.workspaceId,measuredDraft.id)).status,'REQUESTED');
  await assert.rejects(assistant.executeProposal(db,ctx,draft.proposal.id),/existing draft|changed/);
  await native.approve(db,ctx,measuredDraft.id,{idempotencyKey:randomUUID()});
  assert.equal((await native.get(db,ctx.workspaceId,measuredDraft.id)).status,'APPROVED');
  assert.equal((await db.query('SELECT on_hand::text FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,measured,from])).rows[0].on_hand,'1.375');

  const serial=(await catalog.createItem(db,ctx,{name:'Balancing weighed serials',baseCode:'BAL-SERIAL',trackingMode:'serial',
    unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'})).skuIds[0];
  await f.purchase(serial,3,{extra:{secondaryQuantity:'6.25',serials:['SER-A','SER-B','SER-C'],
    serialWeights:{'SER-A':'1.125','SER-B':'2.25','SER-C':'2.875'}}});
  await f.target(serial,from,1);await f.target(serial,to,2);
  const a=(await db.query("SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND serial='SER-A'",[ctx.workspaceId,serial])).rows[0].id;
  await native.request(db,ctx,{fromLocationId:from,toLocationId:f.spare.id,idempotencyKey:randomUUID(),
    lines:[{skuId:serial,quantity:1,secondaryQuantity:'1.125',serialUnitIds:[a]}]});
  const weighed=await f.prepare({...common,sku:'BAL-SERIAL'});
  const payload=weighed.proposal.payload;
  assert.equal(payload.quantity,'1');assert.notEqual(payload.lines[0].serialUnitIds[0],a);
  assert.ok(['2.25','2.875'].includes(payload.lines[0].secondaryQuantity));
  const serialDraft=(await assistant.executeProposal(db,ctx,weighed.proposal.id)).result;
  const saved=(await native.get(db,ctx.workspaceId,serialDraft.transferId)).lines[0];
  assert.equal(Number(saved.requested_secondary_quantity),Number(payload.lines[0].secondaryQuantity));
  assert.equal(saved.serials[0].serial_unit_id,payload.lines[0].serialUnitIds[0]);

  const weighted=(await catalog.createItem(db,ctx,{name:'Bulk independently weighed units',baseCode:'BAL-WEIGHT',trackingMode:'quantity',
    unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'})).skuIds[0];
  await f.purchase(weighted,2,{extra:{secondaryQuantity:'5.123'}});
  await f.target(weighted,to,1);
  await assert.rejects(f.prepare({...common,sku:'BAL-WEIGHT'}),/independently weighed/);
  await f.target(weighted,to,2);
  const whole=await f.prepare({...common,sku:'BAL-WEIGHT'});
  assert.equal(whole.proposal.payload.lines[0].secondaryQuantity,'5.123');
  const incoming=await f.purchase(weighted,1,{destinationId:to,arrive:false,extra:{secondaryQuantity:'1.125'},expectedDate:addDays(f.today,-1)});
  await assert.rejects(assistant.executeProposal(db,ctx,whole.proposal.id),/overdue incoming/);
  assert.equal((await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,incoming.purchaseOrderId])).rows[0].status,'APPROVED');
  assert.equal((await f.balanceDrafts()).filter(row=>row.status==='REQUESTED').length,1);
});
