'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const slotting=require('../../src/forecasting/warehouse-slotting');
const transfers=require('../../src/transfers/postgres-transfer-service');
const reviews=require('../../src/autopilot/job-reviews');
const modes=require('../../src/autopilot/job-modes');
const authority=require('../../src/autopilot/postgres-service');
const path='/autopilot/warehouse-slotting';

async function setup(t,{units}={}){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f;
  const locations=require('../../src/domain/postgres-location-service'),inventory=require('../../src/domain/postgres-inventory-engine');
  const catalog=require('../../src/domain/postgres-catalog-service');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const bin=(name,parent=f.location.id)=>locations.createLocation(db,ctx,{name,kind:'bin',parentLocationId:parent});
  const product=async(code,extra={})=>(await catalog.createItem(db,ctx,{name:code+' product',baseCode:code,trackingMode:'quantity',...extra})).skuIds[0];
  const receive=(skuId,place,quantity,extra={})=>inventory.receive(db,ctx,{skuId,locationId:place.id,quantity,idempotencyKey:randomUUID(),...extra});
  const sell=async(skuId,place,times,extra={})=>{for(let i=0;i<times;i++)await inventory.issue(db,ctx,{skuId,locationId:place.id,quantity:1,reasonCode:'sale',reference:randomUUID(),idempotencyKey:randomUUID(),...extra});};
  const onHand=async(skuId,place)=>Number((await db.query('SELECT coalesce(sum(on_hand),0) n FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuId,place.id])).rows[0].n);
  const free=async(skuId,place)=>(await require('../../src/domain/postgres-stock-availability').read(db,ctx.workspaceId,skuId,place.id)).available;
  const measure=(place,metres,warehouseId=f.location.id)=>slotting.saveDistance(db,ctx,{bin:place.id,warehouseId,metres});
  const fit=(place,skuId,primaryLimit,extra={})=>slotting.saveCapacity(db,ctx,{bin:place.id,warehouseId:f.location.id,sku:skuId,primaryLimit,confirmed:'yes',...extra});
  const slotTransfers=async()=>(await db.query("SELECT id,status,decision_detail::jsonb AS decision_detail FROM inventory_transfers WHERE workspace_id=$1 AND decision_detail::jsonb->>'kind'='agent_slotting_move' ORDER BY created_at,id",[ctx.workspaceId])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);
  const load=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_slotting_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  return {...f,locations,inventory,catalog,bin,product,receive,sell,onHand,free,measure,fit,slotTransfers,audits,load};
}

test('Pro approves an exact re-slot list, and approved moves go through the ordinary bin transfer',{timeout:300000},async t=>{
  const f=await setup(t),{db,ctx,browser,subscribe,csrf}=f;
  const west=await f.locations.createLocation(db,ctx,{name:'West site',kind:'warehouse'});
  const far=await f.bin('Back bin'),near=await f.bin('Packing bin'),side=await f.bin('Side bin'),closest=await f.bin('West packing bin',west.id);
  const sku=f.item.skuIds[0];
  await f.receive(sku,far,15);await f.sell(sku,far,6);
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    assert.equal((await browser.get(path).expect(402)).text.includes('Pro'),true,tier+' shows the plan lock');
    await assert.rejects(slotting.prepare(db,ctx,{warehouseId:f.location.id}),e=>e.code==='entitlement_required');
    await assert.rejects(f.measure(far,40),e=>e.code==='entitlement_required');
    await assert.rejects(reviews.run(db,ctx,'warehouse-slotting'),e=>e.code==='entitlement_required');
  }
  await subscribe('pro');
  const home=await browser.get(path).expect(200);
  for(const [place,metres,site] of [[far,40,f.location],[near,3,f.location],[side,12,f.location],[closest,1,west]])
    await browser.post(path+'/distance').type('form').send({_csrf:csrf(home.text),warehouseId:site.id,bin:place.id,metres}).expect(303);
  await assert.rejects(f.measure(closest,2),/this warehouse/,'A bin is measured only inside its own warehouse.');
  const row=(await reviews.run(db,ctx,'warehouse-slotting')).rows[0];
  assert.deepEqual([row.From,row.To,row['Available units'],row['Order picks in 90 days'],row['Metres closer to packing']],['Back bin','Packing bin',9,6,37]);

  // The owner makes the list, then approves it in shadow mode, watch mode and for real.
  const made=await browser.post(path).type('form').send({_csrf:csrf(home.text),warehouseId:f.location.id,maximumMoves:50,minimumVisits:1}).expect(303);
  const id=made.headers.location.split('/').at(-1);
  const list=await browser.get(path+'/'+id).expect(200);
  assert.match(list.text,/Approve move to Packing bin/);assert.match(list.text,/Bin fit not checked yet/);
  const plan=await f.load(id),move=plan.snapshot.moves[0];
  assert.equal(plan.snapshot.moves.length,1);assert.deepEqual([move.from.name,move.to.name,move.quantity,move.metresSaved],['Back bin','Packing bin','9','37']);
  assert.equal((await slotting.prepare(db,ctx,{warehouseId:f.location.id})).replayed,true,'The same facts make the same list once.');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  await assert.rejects(slotting.approve(db,ctx,id,{move:move.fingerprint,confirmed:'yes'}),/14 days/);
  assert.match((await browser.get(path+'/'+id).expect(200)).text,/watching during the first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  await modes.save(db,ctx,122,{mode:'watch',revision:0});
  await assert.rejects(slotting.approve(db,ctx,id,{move:move.fingerprint,confirmed:'yes'}),/Watch only/);
  await modes.save(db,ctx,122,{mode:'inherit',revision:1});
  await assert.rejects(slotting.approve(db,ctx,id,{move:move.fingerprint}),/Confirm/);
  assert.deepEqual(await f.slotTransfers(),[]);
  await browser.post(path+'/'+id+'/approve').type('form').send({_csrf:csrf(list.text),move:move.fingerprint,confirmed:'yes'}).expect(303);
  const [moved]=await f.slotTransfers();
  assert.equal(moved.status,'APPROVED');assert.equal(moved.decision_detail.automatic,false);
  assert.equal(await f.onHand(sku,far),9,'Approval reserves the stock; staff still move it.');
  assert.equal(await f.free(sku,far),0);
  assert.equal((await slotting.approve(db,ctx,id,{move:move.fingerprint,confirmed:'yes'})).replayed,true);
  await assert.rejects(slotting.approve(db,ctx,id,{move:'all',confirmed:'yes'}),/already been approved/);
  assert.equal((await f.slotTransfers()).length,1);
  assert.equal(await f.audits('Approved a warehouse re-slot move'),1);
  assert.match((await browser.get(path+'/'+id).expect(200)).text,/Approved · ready to move/);

  // Staff do the physical work through the ordinary transfer steps.
  await transfers.pick(db,ctx,moved.id,{idempotencyKey:randomUUID()});
  await assert.rejects(slotting.undo(db,ctx,id,{move:move.fingerprint}),/Staff have started/);
  await transfers.dispatch(db,ctx,moved.id,{idempotencyKey:randomUUID()});
  const shipped=await transfers.get(db,ctx.workspaceId,moved.id);
  await transfers.receive(db,ctx,moved.id,{idempotencyKey:randomUUID(),lines:[{lineId:shipped.lines[0].id,received:9,lost:0,damaged:0}]});
  assert.deepEqual([await f.onHand(sku,far),await f.onHand(sku,near)],[0,9]);
  assert.equal((await transfers.verify(db,ctx.workspaceId,moved.id)).ok,true);
  assert.match((await browser.get(path+'/'+id).expect(200)).text,/Done/);

  // When the facts change after the list is made, it stops and asks for a fresh list.
  const second=await f.product('SECOND'),third=await f.product('THIRD');
  const spare=await f.bin('Spare bin'),other=await f.bin('Other bin');
  await f.measure(spare,5);await f.measure(other,6);
  await f.receive(second,far,8);await f.sell(second,far,4);
  await f.receive(third,side,6);await f.sell(third,side,2);
  const next=await slotting.prepare(db,ctx,{warehouseId:f.location.id}),nextPlan=await f.load(next.id);
  assert.deepEqual(nextPlan.snapshot.moves.map(m=>[m.code,m.from.name,m.to.name]),[['SECOND','Back bin','Spare bin'],['THIRD','Side bin','Other bin']]);
  await f.receive(third,other,1);
  await f.sell(second,far,3);
  await assert.rejects(slotting.approve(db,ctx,next.id,{move:nextPlan.snapshot.moves[1].fingerprint,confirmed:'yes'}),/changed since this list was made/);
  const all=await slotting.approve(db,ctx,next.id,{move:'all',confirmed:'yes'});
  assert.deepEqual([all.approved,all.held],[0,2],'Less free stock than planned, or a filled destination, holds the move.');
  assert.match((await browser.get(path+'/'+next.id).expect(200)).text,/Prepare a fresh list/);
  assert.equal((await f.slotTransfers()).length,1);

  // A person may approve batch-tracked stock; the list names the exact batch.
  const batch=await f.product('BATCH',{trackingMode:'lot'}),lotBin=await f.bin('Batch bin'),lotNear=await f.bin('Batch near bin');
  await f.measure(lotBin,30);await f.measure(lotNear,4);
  await f.receive(batch,lotBin,5,{lotCode:'L-1',expiresAt:'2030-01-31'});
  const lotId=(await db.query('SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,batch])).rows[0].id;
  await f.sell(batch,lotBin,2,{lotId});
  const batchList=await slotting.prepare(db,ctx,{warehouseId:f.location.id,minimumVisits:2}),batchMove=(await f.load(batchList.id)).snapshot.moves.find(m=>m.code==='BATCH');
  assert.deepEqual(batchMove.protections,['tracked']);assert.equal(batchMove.lines[0].lot,'L-1');
  const page=await browser.get(path+'/'+batchList.id).expect(200);
  assert.match(page.text,/tracked by batch, serial number or expiry date/);assert.match(page.text,/Batch L-1/);
  await slotting.approve(db,ctx,batchList.id,{move:batchMove.fingerprint,confirmed:'yes'});
  const lotTransfer=await transfers.get(db,ctx.workspaceId,(await f.slotTransfers()).at(-1).id);
  assert.deepEqual([lotTransfer.status,lotTransfer.lines[0].lot_id,Number(lotTransfer.lines[0].approved_quantity)],['APPROVED',lotId,3]);
  await slotting.undo(db,ctx,batchList.id,{move:batchMove.fingerprint});
  assert.equal((await transfers.get(db,ctx.workspaceId,lotTransfer.id)).status,'CANCELLED');
  assert.equal(await f.free(batch,lotBin),3);
  assert.equal((await slotting.undo(db,ctx,batchList.id,{move:batchMove.fingerprint})).replayed,true);
  assert.equal(await f.audits('Undid a warehouse re-slot move'),1);

  // Routine re-slots are Custom only.
  await assert.rejects(slotting.configure(db,ctx,{warehouseId:f.location.id,cadenceDays:7,maximumMoves:5,maximumUnits:5,minimumVisits:1,confirmed:'yes'}),e=>e.code==='entitlement_required');
  assert.match((await browser.get(path).expect(200)).text,/Routine re-slots are on Custom/);

  // The list and warehouse pages fit a desktop and a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const tab=await chrome.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500});tab.setDefaultTimeout(15000);
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const target of [path,path+'/'+next.id,path+'/'+batchList.id,path+'/routine']){
      assert.equal((await tab.goto(origin+target)).status(),200,target);
      assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),viewport.width+' px fits '+target);
    }
    assert.equal(await tab.getByRole('button',{name:'Undo this move'}).count(),0);
    await tab.close();
  }
});

test('Custom re-slots on its own inside the owner limits and leaves protected stock for a person',{timeout:300000},async t=>{
  const f=await setup(t),{db,ctx,browser,subscribe,csrf}=f;
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const work=async()=>(await queue.processOne(db,handlers,{owner:'slotting-test',kinds:[slotting.kind]}))?.result;
  const cycle=async id=>{await slotting.enqueue(db,ctx.workspaceId,id);return work();};
  await subscribe('enterprise');await authority.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const names=['plain','unchecked','large','batch','reserved','counted'];
  const sources={},targets={};
  for(const [index,name] of names.entries()){
    sources[name]=await f.bin('Far '+name);targets[name]=await f.bin('Near '+name);
    await f.measure(sources[name],40-index);await f.measure(targets[name],2+index);
  }
  const sku={plain:await f.product('PLAIN'),unchecked:await f.product('UNCHECKED'),large:await f.product('LARGE'),
    batch:await f.product('LOTTED',{trackingMode:'lot'}),reserved:await f.product('RESERVED'),counted:await f.product('COUNTED')};
  await f.receive(sku.plain,sources.plain,10);await f.sell(sku.plain,sources.plain,6);
  await f.receive(sku.unchecked,sources.unchecked,8);await f.sell(sku.unchecked,sources.unchecked,5);
  await f.receive(sku.large,sources.large,12);await f.sell(sku.large,sources.large,4);
  await f.receive(sku.batch,sources.batch,6,{lotCode:'B-7',expiresAt:'2031-06-30'});
  const lotId=(await db.query('SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku.batch])).rows[0].id;
  await f.sell(sku.batch,sources.batch,3,{lotId});
  await f.receive(sku.reserved,sources.reserved,5);await f.sell(sku.reserved,sources.reserved,2);
  await f.receive(sku.counted,sources.counted,4);await f.sell(sku.counted,sources.counted,1);
  for(const name of names)if(name!=='unchecked')await f.fit(targets[name],sku[name],50);
  // Stock promised elsewhere, and a count sheet still open on one bin.
  const promised=await transfers.request(db,ctx,{fromLocationId:sources.reserved.id,toLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku.reserved,quantity:1}]});
  await transfers.approve(db,ctx,promised.id,{idempotencyKey:randomUUID()});
  await require('../../src/operations/postgres-count-campaigns').create(db,ctx,{locationId:sources.counted.id,title:'Cycle count'});

  // The owner sets the limits on the page: weekly, up to 10 moves of 5 units each.
  const home=await browser.get(path).expect(200);
  await browser.post(path+'/routine').type('form').send({_csrf:csrf(home.text),warehouseId:f.location.id,revision:'',cadenceDays:7,maximumMoves:10,maximumUnits:5,minimumVisits:1}).expect(303);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_slotting_schedules')).rows[0].n,0,'The owner must confirm the limits.');
  await browser.post(path+'/routine').type('form').send({_csrf:csrf(home.text),warehouseId:f.location.id,revision:'',cadenceDays:7,maximumMoves:10,maximumUnits:5,minimumVisits:1,confirmed:'yes'}).expect(303);
  assert.match((await browser.get(path).expect(200)).text,/Every week · Next/);

  // Shadow mode and pause stop routine work before anything is prepared.
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const schedule=(await db.query('SELECT * ,next_on::text due_on FROM stockchief_runtime.agent_slotting_schedules')).rows[0];
  const direct=()=>slotting.run({workspaceId:ctx.workspaceId,payload:{warehouseId:f.location.id,actorId:ctx.actorId,revision:schedule.revision,dueOn:schedule.due_on}},db);
  assert.match((await direct()).held,/14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  await authority.pause(db,ctx,{role:'owner'},'Checking the warehouse');
  assert.equal(await cycle('paused'),undefined,'Nothing is queued while paused.');
  assert.match((await direct()).held,/paused/);
  await authority.resume(db,ctx,{role:'owner'});
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_slotting_plans')).rows[0].n,0);

  const outcome=await cycle('first');
  assert.deepEqual([outcome.approved,outcome.waiting],[1,5]);
  const saved=await f.load(outcome.planId),byCode=Object.fromEntries(saved.snapshot.moves.map(m=>[m.code,m]));
  const [auto]=await f.slotTransfers();
  assert.deepEqual([auto.status,auto.decision_detail.automatic,auto.decision_detail.moveHash],['APPROVED',true,byCode.PLAIN.fingerprint]);
  assert.equal(await f.onHand(sku.plain,sources.plain),4);assert.equal(await f.free(sku.plain,sources.plain),0);
  assert.equal(await f.audits('Approved a warehouse re-slot move on its own'),1);
  const problem=code=>saved.problems[byCode[code].fingerprint];
  assert.match(problem('UNCHECKED'),/fits Near unchecked/);
  assert.match(problem('LARGE'),/this move is 8 and you allow 5 in one move/);
  assert.match(problem('LOTTED'),/batch, serial number or expiry date/);
  assert.match(problem('RESERVED'),/reserved for orders or on hold/);assert.deepEqual(byCode.RESERVED.protections,['reserved','picking']);
  assert.match(problem('COUNTED'),/count is in progress/);
  for(const name of ['unchecked','large','batch','reserved','counted'])assert.equal(await f.free(sku[name],sources[name])>0,true,name+' stays free');

  // Replays and stale jobs change nothing.
  assert.equal(await cycle('first'),undefined);
  assert.equal(await cycle('second'),undefined,'The schedule is not due again until next week.');
  assert.match((await direct()).held,/no longer due/);
  assert.equal((await f.slotTransfers()).length,1);

  // A person can still approve the protected moves on the list, and undo the routine one.
  await slotting.approve(db,ctx,saved.id,{move:byCode.LOTTED.fingerprint,confirmed:'yes'});
  assert.equal((await f.slotTransfers()).length,2);
  const listPage=await browser.get(path+'/'+saved.id).expect(200);
  assert.match(listPage.text,/Approved on its own/);assert.match(listPage.text,/you allow 5 in one move/);
  await browser.post(path+'/'+saved.id+'/undo').type('form').send({_csrf:csrf(listPage.text),move:byCode.PLAIN.fingerprint}).expect(303);
  assert.equal((await transfers.get(db,ctx.workspaceId,auto.id)).status,'CANCELLED');
  assert.equal(await f.free(sku.plain,sources.plain),4);

  // Ask me first: the routine list is made, but every move waits for a person.
  await db.query('UPDATE stockchief_runtime.agent_slotting_schedules SET next_on=$1',[today]);
  await modes.save(db,ctx,122,{mode:'ask',revision:0});
  const asked=await cycle('ask');
  assert.equal(asked.approved,0);assert(asked.waiting>0);
  assert.match(Object.values((await f.load(asked.planId)).problems)[0],/Ask me first/);
  assert.equal((await f.slotTransfers()).length,2);
  await modes.save(db,ctx,122,{mode:'routine',revision:1});

  // A downgrade stops routine work; the owner can still stop the schedule.
  await db.query('UPDATE stockchief_runtime.agent_slotting_schedules SET next_on=$1',[today]);
  await subscribe('pro');
  assert.equal(await cycle('pro'),undefined);
  const current=(await db.query('SELECT revision,next_on::text due_on FROM stockchief_runtime.agent_slotting_schedules')).rows[0];
  assert.match((await slotting.run({workspaceId:ctx.workspaceId,payload:{warehouseId:f.location.id,actorId:ctx.actorId,revision:current.revision,dueOn:current.due_on}},db)).held,/Custom/);
  await assert.rejects(slotting.configure(db,ctx,{warehouseId:f.location.id,revision:current.revision,cadenceDays:1,maximumMoves:5,maximumUnits:5,minimumVisits:1,confirmed:'yes'}),e=>e.code==='entitlement_required');
  await subscribe('starter');
  const routinePage=await browser.get(path+'/routine').expect(200);
  assert.match(routinePage.text,/Stop routine re-slots for Dispatch/);
  await browser.post(path+'/routine').type('form').send({_csrf:csrf(routinePage.text),warehouseId:f.location.id,revision:current.revision,stop:'yes'}).expect(303);
  assert.equal((await db.query('SELECT enabled FROM stockchief_runtime.agent_slotting_schedules')).rows[0].enabled,false);
  assert.equal(await f.audits('Stopped routine warehouse re-slots'),1);
  assert.equal((await f.slotTransfers()).length,2);
});
