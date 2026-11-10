'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vans=require('../../src/shipping/agent-van-routes');

test('owners route actual packed shipments on Pro and Custom with exact, plan-bound routine authority',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12,timeZone:'America/New_York',through:'338-agent-inbound-freight.sql'});
  const {db,ctx,browser,csrf}=f;
  const date=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const packed=await f.parcel();
  assert.deepEqual(await require('../../src/db/migrate-postgres').migratePostgres(db),['339-agent-van-routes.sql']);
  const pagePath=vans.path+'?'+new URLSearchParams({depot:f.location.id});
  const standard='Van 1 | Jordan | 1000 | 08:00 | 17:00';
  const input=(box,extra={})=>({selected:box.shipmentId,depotId:f.location.id,deliveryDate:date,vans:standard,
    opens:{[box.shipmentId]:'08:00'},closes:{[box.shipmentId]:'16:00'},service:{[box.shipmentId]:'10'},
    roadTimes:JSON.stringify({points:['DEPOT',box.shipmentNumber],seconds:[[0,600],[900,0]]}),confirmed:'yes',...extra});
  const submit=async(box,extra={})=>{
    const fields=input(box,extra),page=await browser.get(pagePath).expect(200);
    return browser.post(vans.path).type('form').send({
      ...fields,opens:undefined,closes:undefined,service:undefined,
      ['opens['+box.shipmentId+']']:fields.opens[box.shipmentId],
      ['closes['+box.shipmentId+']']:fields.closes[box.shipmentId],
      ['service['+box.shipmentId+']']:fields.service[box.shipmentId],_csrf:csrf(page.text)
    });
  };
  const run=async id=>(await vans.page(db,ctx,{id})).run;
  const confirm=async id=>vans.approve(db,ctx,id,{confirmed:'yes',revision:(await run(id)).revision});
  const makeRule={confirmed:'yes',ruleRevision:0,maximumStops:3};

  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    const locked=await browser.get(pagePath).expect(200);
    assert.match(locked.text,/Van routes require Pro or Custom/);
    assert.doesNotMatch(locked.text,/Plan delivery routes|Jobsite Rd/);
    await assert.rejects(vans.prepare(db,ctx,input(packed)),error=>error.code==='entitlement_required'&&/Pro/.test(error.message));
    await assert.rejects(vans.approve(db,ctx,'unknown',{}),error=>error.code==='entitlement_required');
  }
  await f.subscribe('pro');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const page=await browser.get(pagePath).expect(200);
  assert.match(page.text,/Plan delivery routes/);
  assert.match(page.text,new RegExp(packed.shipmentNumber));
  const response=await submit(packed,{routine:'yes'});
  assert.equal(response.status,303,response.text.slice(-2000));
  const id=response.headers.location.split('/').at(-1);
  const view=await browser.get(response.headers.location).expect(200);
  assert.match(view.text,/08:10–08:20/);
  assert.match(view.text,/Needs your review/);
  await assert.rejects(vans.configure(db,ctx,id,makeRule),/approve a matching example/i);
  await browser.post(vans.path+'/'+id+'/approve').type('form').send({confirmed:'yes',revision:1,_csrf:csrf(view.text)}).expect(303);
  assert.equal((await run(id)).status,'READY');
  assert.equal(await f.balance(),12);
  await vans.configure(db,ctx,id,makeRule);
  const repeat=await f.parcel();
  const jobModes=require('../../src/autopilot/job-modes');
  await jobModes.save(db,ctx,71,{mode:'ask',revision:0});
  const asked=await vans.prepare(db,ctx,input(repeat,{routine:'yes'}));
  assert.equal(asked.published,false);
  await jobModes.save(db,ctx,71,{mode:'routine',revision:1});
  const routine=await vans.prepare(db,ctx,input(repeat,{routine:'yes'}));
  assert.equal(routine.published,true);
  assert.equal((await run(routine.id)).automatic,true);
  await assert.rejects(vans.prepare(db,ctx,input(repeat,{routine:'yes'})),/already on a published route/);
  const changed=await f.parcel();
  const stale=await vans.prepare(db,ctx,input(changed));
  await f.shipping.setPackages(db,ctx,changed.shipmentId,[{weightGrams:510,lengthMm:200,widthMm:150,heightMm:100}]);
  await assert.rejects(confirm(stale.id),/changed.*current packages/i);
  const unresolved=await vans.prepare(db,ctx,input(changed,{roadTimes:JSON.stringify({points:['DEPOT',changed.shipmentNumber],seconds:[[0,null],[600,0]]}),routine:'yes'}));
  assert.equal(unresolved.published,false);
  assert.equal((await run(unresolved.id)).manifest.unassigned.length,1);
  await assert.rejects(confirm(unresolved.id),/Resolve the unassigned stops/);
  await f.subscribe('enterprise');
  const largerFleet='Van 2 | Jamie | 1500 | 08:00 | 17:00';
  const firstCustom=await vans.prepare(db,ctx,input(changed,{vans:largerFleet}));
  await vans.configure(db,ctx,firstCustom.id,makeRule);
  const custom=await vans.prepare(db,ctx,input(changed,{vans:largerFleet,routine:'yes'}));
  assert.equal(custom.published,true);
  assert.equal((await run(firstCustom.id)).status,'DRAFT');
  await f.subscribe('pro');
  const downgradeBox=await f.parcel();
  const downgraded=await vans.prepare(db,ctx,input(downgradeBox,{vans:largerFleet,routine:'yes'}));
  assert.equal(downgraded.published,false);
  const previousRouter=process.env.STOCKCHIEF_OSRM_URL;
  process.env.STOCKCHIEF_OSRM_URL='https://routing.example.test/private';
  t.after(()=>{if(previousRouter===undefined)delete process.env.STOCKCHIEF_OSRM_URL;else process.env.STOCKCHIEF_OSRM_URL=previousRouter;});
  const roadFetch=t.mock.method(globalThis,'fetch',async(url,options)=>{
    const route=new URL(url);
    assert.equal(route.hostname,'routing.example.test');
    assert.equal(route.pathname,'/private/table/v1/driving/-74.2,41.32;-73.75,42.65');
    assert.equal(route.searchParams.get('annotations'),'duration');
    assert.equal(options.redirect,'error');
    return Response.json({code:'Ok',durations:[[0,660],[840,0]]});
  });
  const pins={roadSource:'router',roadTimes:'',depotPin:'41.32, -74.2',pins:{[downgradeBox.shipmentId]:'42.65, -73.75'}};
  assert.match((await browser.get(pagePath).expect(200)).text,/Calculate with the connected road router/);
  await assert.rejects(vans.prepare(db,ctx,input(downgradeBox,{...pins,depotPin:'500, 900'})),/Check the latitude/);
  assert.equal(roadFetch.mock.callCount(),0);
  const routed=await vans.prepare(db,ctx,input(downgradeBox,pins));
  assert.equal((await run(routed.id)).facts.roadSource,'router');
  assert.equal((await run(routed.id)).manifest.routes[0].stops[0].arrival,491);
  assert.equal(roadFetch.mock.callCount(),1);
  await f.subscribe('growth');
  assert.doesNotMatch((await browser.get(vans.path+'/'+id).expect(200)).text,/Jobsite Rd/);
  await assert.rejects(vans.prepare(db,ctx,input(downgradeBox,{routine:'yes'})),error=>error.code==='entitlement_required');
  await assert.rejects(vans.prepare(db,ctx,input(downgradeBox,pins)),error=>error.code==='entitlement_required');
  assert.equal(roadFetch.mock.callCount(),1);
  await f.shipping.handoff(db,ctx,repeat.shipmentId,{handover:'DELIVERED_BY_US'});
  assert.equal(await f.balance(),11);
});
