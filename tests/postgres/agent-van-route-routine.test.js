'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const vans=require('../../src/shipping/agent-van-routes'),routine=require('../../src/shipping/agent-van-route-routine');
const queue=require('../../src/operations/postgres-job-queue');

// Job 71 on its own: excluded on Starter and Growth, taught on Pro, alone on
// Custom. Each day at the rule's time StockChief plans the next delivery day
// from packed deliveries to addresses the vans already deliver to. A route
// that fully fits is published; anything else waits in Needs you with the
// reason. Held modes never publish, a day is planned once, and an automatic
// route can be undone from the activity log while its loads are at the depot.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:30,timeZone:'America/New_York'}),{db,ctx}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('market-customer',$1,'Market Deli','deli@example.test','5185550111','25 Market St, Troy, NY 12180','ACTIVE',$2,now()::text,now()::text)`,[ctx.workspaceId,ctx.actorId]);
  let n=0;
  // A packed delivery for one customer, measured like the fixture's parcels.
  f.packed=async(customerId='fixture-customer')=>{
    const key='van-'+(++n)+'-'+randomUUID(),order=await f.workflows.createSalesOrder(db,ctx,{customerId,deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,
      idempotencyKey:key,lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1200}]});
    await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:key+'-confirm'});
    const shipment=await f.shipping.prepare(db,ctx,order.salesOrderId,{idempotencyKey:key+'-pack',lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:1}]});
    await f.shipping.setPackages(db,ctx,shipment.shipmentId,[{weightGrams:350,lengthMm:200,widthMm:150,heightMm:100}]);
    return shipment;
  };
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  f.tomorrow=require('../../src/accounting/customer-money').addDays(today,1);
  // The owner plans and publishes one route by hand: the vans now know these addresses and road times.
  f.manual=async(boxes,fleet,{publish=true}={})=>{
    const points=['DEPOT',...boxes.map(b=>b.shipmentNumber)],seconds=points.map((a,i)=>points.map((b,j)=>i===j?0:600+60*(i+j)));
    const made=await vans.prepare(db,ctx,{selected:boxes.map(b=>b.shipmentId),depotId:f.location.id,deliveryDate:f.tomorrow,vans:fleet,
      opens:Object.fromEntries(boxes.map(b=>[b.shipmentId,'08:00'])),closes:Object.fromEntries(boxes.map(b=>[b.shipmentId,'16:00'])),
      service:Object.fromEntries(boxes.map(b=>[b.shipmentId,'10'])),roadTimes:JSON.stringify({points,seconds}),confirmed:'yes'});
    if(publish)await vans.approve(db,ctx,made.id,{confirmed:'yes',revision:1});
    return made.id;
  };
  f.rule=async(id,extra={})=>{
    const current=(await db.query('SELECT r.revision FROM stockchief_runtime.agent_van_route_rules r JOIN stockchief_runtime.agent_van_routes x ON x.workspace_id=r.workspace_id AND x.depot_id=r.depot_id AND x.fleet_key=r.fleet_key WHERE x.workspace_id=$1 AND x.id=$2',[ctx.workspaceId,id])).rows[0];
    return vans.configure(db,ctx,id,{confirmed:'yes',ruleRevision:current?.revision||0,maximumStops:3,planAt:'00:00',days:['1','2','3','4','5','6','7'],...extra});
  };
  // One autopilot check: schedule the routine and let a worker run it.
  f.cycle=async name=>{
    const scheduled=await routine.schedule(db,ctx.workspaceId,name);if(!scheduled.queued)return null;
    const handlers=require('../../src/operations/postgres-runtime-handlers').create();
    const job=await queue.processOne(db,{[routine.KIND]:handlers[routine.KIND]},{owner:'van-route-test',kinds:[routine.KIND]});
    assert.equal(job.status,'COMPLETED',JSON.stringify(job));return job.result;
  };
  f.route=async id=>(await db.query('SELECT *,delivery_date::text AS delivery_date FROM stockchief_runtime.agent_van_routes WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  f.nextDay=()=>db.query('UPDATE stockchief_runtime.agent_van_route_rules SET planned_for=NULL WHERE workspace_id=$1',[ctx.workspaceId]);
  f.asks=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(r=>/^van-route:/.test(r.sourceId||''));
  return f;
}
const FLEET='Van 1 | Jordan | 1000 | 08:00 | 17:00',OTHER='Van 2 | Riley | 800 | 07:00 | 15:00';

test('Pro prepares routes for review until the owner publishes one of the fleet’s routes, then publishes alone; Custom publishes alone; Starter and Growth are locked',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,browser}=f;
  const autopilot=require('../../src/autopilot/postgres-service');
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    await browser.get(vans.path).expect(402);
    assert.equal((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,'plan');
    assert.equal((await routine.schedule(db,ctx.workspaceId,'locked-'+plan)).queued,false);
    assert.deepEqual(await routine.inbox(db,ctx.workspaceId),[]);
  }
  await f.subscribe('pro');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // The other van already delivers to this address: the depot knows its road times and window.
  await f.manual([await f.packed()],OTHER);
  // A rule saved from a draft route of the main fleet, not yet taught.
  const draft=await f.manual([await f.packed()],FLEET,{publish:false});
  await f.rule(draft,{planAt:'15:30',days:['1','3','5']});
  const saved=(await db.query('SELECT plan_at,delivery_days,example_id,vans FROM stockchief_runtime.agent_van_route_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  assert.equal(saved.plan_at,930);assert.deepEqual(saved.delivery_days,[1,3,5]);assert.equal(saved.example_id,null);assert.equal(saved.vans[0].driver,'Jordan');
  assert.equal(routine.nextDeliveryDay('2026-11-13',[1,3,5]),'2026-11-16','Friday plans for Monday');
  await assert.rejects(f.rule(draft,{days:['8']}),/days your vans deliver/);
  await f.rule(draft);
  const first=await f.packed();
  const drafted=await f.cycle('pro-1');
  assert.equal(drafted.drafted,1,JSON.stringify(drafted));assert.equal(drafted.published,0);
  const review=await f.route(drafted.routes[0]);
  assert.equal(review.status,'DRAFT');assert.equal(review.delivery_date,f.tomorrow);assert.equal(review.prepared_by_routine,true);
  assert.match(review.waiting_reason,/Publish one route for this fleet yourself/);
  assert.deepEqual(review.facts.stops.map(s=>s.id),[first.shipmentId],'only the new delivery to a known address');
  const [ask]=await f.asks();assert.match(ask.title,new RegExp('Review the van route for '+f.tomorrow));assert.equal(ask.href,vans.path+'/'+review.id);
  // Replays plan nothing more that day.
  assert.equal(await f.cycle('pro-1'),null);assert.equal(await f.cycle('pro-2'),null);
  const shown=await browser.get(vans.path+'/'+review.id).expect(200);
  assert.match(shown.text,/Planned by the fleet rule/);assert.match(shown.text,/Publish one route for this fleet yourself/);
  // The owner publishes it: that is the completed example that teaches the rule.
  await vans.approve(db,ctx,review.id,{confirmed:'yes',revision:1});
  assert.equal((await db.query('SELECT example_id FROM stockchief_runtime.agent_van_route_rules WHERE workspace_id=$1 AND enabled',[ctx.workspaceId])).rows[0].example_id,review.id);
  assert.equal((await f.asks()).length,0);
  await f.nextDay();
  const second=await f.packed(),alone=await f.cycle('pro-3');
  assert.equal(alone.published,1,JSON.stringify(alone));
  const published=await f.route(alone.routes[0]);
  assert.equal(published.status,'READY');assert.equal(published.automatic,true);assert.equal(published.facts.stops[0].id,second.shipmentId);
  assert.equal(published.manifest.routes[0].stops[0].arrival,8*60+10+1,'the remembered road time and window');
  // The activity log shows it, with undo while the load is at the depot.
  const activity=require('../../src/autopilot/agent-activity');
  const entry=(await db.query("SELECT id FROM security_event_history WHERE workspace_id=$1 AND action='Van manifest published' AND reference=$2",[ctx.workspaceId,published.id])).rows[0];
  const log=await activity.report(db,ctx);assert.match(JSON.stringify(log.rows),/Van manifest published/);
  await activity.undo(db,ctx,{origin:'audit',id:entry.id});
  assert.equal((await f.route(published.id)).status,'STOPPED');
  assert.equal((await activity.undo(db,ctx,{origin:'audit',id:entry.id})).replayed,true);
  // Custom publishes alone with a rule saved from a draft route, without a taught example.
  await f.subscribe('enterprise');
  const big='Van 3 | Casey | 1500 | 08:00 | 17:00';
  await f.rule(await f.manual([await f.packed()],big,{publish:false}));
  await db.query("UPDATE stockchief_runtime.agent_van_route_rules SET enabled=false WHERE workspace_id=$1 AND vans->0->>'id'<>'Van 3'",[ctx.workspaceId]);
  await f.nextDay();
  const custom=await f.cycle('custom-1');
  assert.equal(custom.published,1,JSON.stringify(custom));
  assert.equal((await f.route(custom.routes[0])).facts.vans[0].driver,'Casey');
  // A downgrade below Pro stops the routine.
  await f.subscribe('growth');await f.nextDay();await f.packed();
  assert.equal(await f.cycle('growth-1'),null);
  assert.equal(await f.balance(),30,'planning moves no stock');
});

test('Missing facts, the stop limit and held modes stop and ask; pause, Watch only and the first 14 days do nothing',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx}=f;
  const autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  await f.subscribe('enterprise');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // Both addresses are known, each from its own published route, so the road time between them is not.
  await f.manual([await f.packed()],OTHER);await f.manual([await f.packed('market-customer')],OTHER);
  await f.rule(await f.manual([await f.packed()],FLEET,{publish:false}),{maximumStops:1});
  // Not due before the planning time.
  const clock=await require('../../src/lib/business-time').forWorkspace(db,ctx.workspaceId);
  const local=require('../../src/lib/business-time').parts(new Date(clock.instant),clock.timeZone),minute=local.hour*60+local.minute;
  if(minute<1430){
    await db.query('UPDATE stockchief_runtime.agent_van_route_rules SET plan_at=$2 WHERE workspace_id=$1',[ctx.workspaceId,minute+5]);
    assert.deepEqual(await routine.due(db,ctx.workspaceId),[]);
    assert.equal((await routine.due(db,ctx.workspaceId,{now:true})).length,1,'a start from another system plans now');
    await db.query('UPDATE stockchief_runtime.agent_van_route_rules SET plan_at=0 WHERE workspace_id=$1',[ctx.workspaceId]);
  }
  const home=await f.packed(),market=await f.packed('market-customer'),unmeasured=await f.packed();
  await db.query("UPDATE shipment_packages SET weight_source='ESTIMATED' WHERE workspace_id=$1 AND shipment_id=$2",[ctx.workspaceId,unmeasured.shipmentId]);
  const stopped=await f.cycle('facts-1');
  assert.equal(stopped.drafted,1,JSON.stringify(stopped));assert.equal(stopped.held,2);
  const run=await f.route(stopped.routes[0]);
  assert.equal(run.status,'DRAFT');assert.match(run.waiting_reason,/2 packed deliveries could not be routed/);
  const why=Object.fromEntries(run.facts.held.map(h=>[h.id,h.reason]));
  assert.match(why[unmeasured.shipmentId],/measured weight/);
  assert.match(why[[home.shipmentId,market.shipmentId].sort()[1]],/does not have road times between this address/);
  const page=await f.browser.get(vans.path+'/'+run.id).expect(200);
  assert.match(page.text,/Deliveries not on this route/);assert.match(page.text,/measured weight/);
  assert.equal((await f.asks()).length,1);
  // The owner stops it; the deliveries wait for the next plan.
  await vans.stop(db,ctx,run.id,{confirmed:'yes',revision:1});
  await db.query("UPDATE shipment_packages SET weight_source='MEASURED' WHERE workspace_id=$1 AND shipment_id=$2",[ctx.workspaceId,unmeasured.shipmentId]);
  await db.query('UPDATE stockchief_runtime.agent_van_route_rules SET maximum_stops=3 WHERE workspace_id=$1',[ctx.workspaceId]);
  // The connected road router fills a missing leg only when every place has a saved pin.
  const previous=process.env.STOCKCHIEF_OSRM_URL;process.env.STOCKCHIEF_OSRM_URL='https://routing.example.test/private';
  t.after(()=>{if(previous===undefined)delete process.env.STOCKCHIEF_OSRM_URL;else process.env.STOCKCHIEF_OSRM_URL=previous;});
  const routed=t.mock.method(globalThis,'fetch',async url=>{
    const address=new URL(url);assert.equal(address.hostname,'routing.example.test');
    const count=address.pathname.split('/').at(-1).split(';').length;
    return Response.json({code:'Ok',durations:Array.from({length:count},(_,i)=>Array.from({length:count},(_,j)=>i===j?0:300+60*(i+j)))});
  });
  await f.nextDay();
  const noPins=await f.cycle('router-1');assert.equal(routed.mock.callCount(),0,'no pins saved, so nothing is sent');
  assert.match((await f.route(noPins.routes[0])).facts.held.map(h=>h.reason).join(' '),/road times/);
  await db.query("UPDATE stockchief_runtime.agent_van_routes SET status='STOPPED' WHERE workspace_id=$1 AND status='DRAFT' AND prepared_by_routine",[ctx.workspaceId]);
  const places=[...new Set((await db.query("SELECT facts FROM stockchief_runtime.agent_van_routes WHERE workspace_id=$1 AND status='READY'",[ctx.workspaceId])).rows.flatMap(r=>r.facts.points||[]))];
  assert.equal(places.length,3,'the depot and two delivery addresses');
  await db.query(`UPDATE stockchief_runtime.agent_van_routes SET facts=facts||jsonb_build_object('pins',$2::jsonb) WHERE workspace_id=$1 AND status='READY'`,
    [ctx.workspaceId,JSON.stringify(Object.fromEntries(places.map((p,i)=>[p,[-74+i/100,41+i/100]])))]);
  await f.nextDay();
  const both=await f.cycle('router-2');
  assert.equal(routed.mock.callCount(),1);assert.equal(both.published,1,JSON.stringify(both));
  const viaRouter=await f.route(both.routes[0]);
  assert.equal(viaRouter.facts.roadSource,'router');assert.equal(viaRouter.facts.stops.length,3);assert.deepEqual(viaRouter.facts.held,[]);
  // Over the rule's stop limit: prepared for review, not published.
  await db.query('UPDATE stockchief_runtime.agent_van_route_rules SET maximum_stops=1 WHERE workspace_id=$1',[ctx.workspaceId]);
  await f.packed();await f.packed();await f.nextDay();
  const over=await f.cycle('limit-1');assert.equal(over.drafted,1,JSON.stringify(over));
  assert.match((await f.route(over.routes[0])).waiting_reason,/more than the 1 your rule allows/);
  await db.query("UPDATE stockchief_runtime.agent_van_routes SET status='STOPPED' WHERE workspace_id=$1 AND status='DRAFT' AND prepared_by_routine",[ctx.workspaceId]);
  await db.query('UPDATE stockchief_runtime.agent_van_route_rules SET maximum_stops=3 WHERE workspace_id=$1',[ctx.workspaceId]);
  // Ask me first and routine work off prepare for review.
  await modes.save(db,ctx,71,{mode:'ask',revision:0});await f.nextDay();
  const asked=await f.cycle('ask-1');assert.equal(asked.drafted,1);assert.match((await f.route(asked.routes[0])).waiting_reason,/Ask me first/);
  await db.query("UPDATE stockchief_runtime.agent_van_routes SET status='STOPPED' WHERE workspace_id=$1 AND status='DRAFT' AND prepared_by_routine",[ctx.workspaceId]);
  await modes.save(db,ctx,71,{mode:'inherit',revision:1});
  await autopilot.setMode(db,ctx,{role:'owner'},'SUPERVISED');await f.nextDay();
  const off=await f.cycle('off-1');assert.equal(off.drafted,1);assert.match((await f.route(off.routes[0])).waiting_reason,/Routine work is off/);
  await db.query("UPDATE stockchief_runtime.agent_van_routes SET status='STOPPED' WHERE workspace_id=$1 AND status='DRAFT' AND prepared_by_routine",[ctx.workspaceId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // Watch only, pause and the first 14 days do nothing.
  await modes.save(db,ctx,71,{mode:'watch',revision:2});await f.nextDay();
  assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/Watch only/);
  await modes.save(db,ctx,71,{mode:'inherit',revision:3});
  await autopilot.pause(db,ctx,{role:'owner'},'Van check');assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  assert.match((await routine.run(db,{workspaceId:ctx.workspaceId})).skipped,/14 days/);
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_van_routes WHERE workspace_id=$1 AND status='DRAFT' AND prepared_by_routine",[ctx.workspaceId])).rows[0].n,0);
  // An older database without the routine's columns stays quiet.
  const older={query:async(sql,args)=>/pg_attribute/.test(sql)?{rows:[{ok:false}]}:db.query(sql,args)};
  assert.deepEqual(await routine.inbox(older,ctx.workspaceId),[]);assert.equal((await routine.run(older,{workspaceId:ctx.workspaceId})).skipped,'not_installed');
  assert.equal((await routine.schedule(older,ctx.workspaceId,'older')).queued,false);
});

test('A route waiting for review shows its held deliveries at phone and desktop width',{timeout:600000},async t=>{
  const f=await setup(t),{db,ctx}=f;
  await f.subscribe('enterprise');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await f.manual([await f.packed()],OTHER);
  await f.rule(await f.manual([await f.packed()],FLEET,{publish:false}));
  const unmeasured=await f.packed();await f.packed();
  await db.query("UPDATE shipment_packages SET weight_source='ESTIMATED' WHERE workspace_id=$1 AND shipment_id=$2",[ctx.workspaceId,unmeasured.shipmentId]);
  const result=await f.cycle('page-1');assert.equal(result.drafted,1);
  await require('../helpers/page-widths').widths(f,[[vans.path+'/'+result.routes[0],'van-route-review'],[vans.path,'van-routes']],async(page,path)=>{
    const text=await page.locator('main').innerText();
    if(path===vans.path)assert.match(text,/Fleet rules/);else{assert.match(text,/Deliveries not on this route/);assert.match(text,/Plans at 00:00/);}
  });
});
