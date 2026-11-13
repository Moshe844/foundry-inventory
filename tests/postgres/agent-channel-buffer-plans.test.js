'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 183: per-channel buffers keep whole units, or a share of the stock, back
// from what a channel may sell. StockChief works each buffer out from how fast
// the product sells elsewhere and how far behind the channel can be. Starter
// is excluded; Growth drafts the buffers for approval; Pro and Custom set them
// on their own within the owner's rule for the channel, through the same
// buffer recipes. Over the owner's limit, pause, Ask me first and the first 14
// days wait for the owner. Everything is audited and can be undone.
test('channel buffers are drafted on Growth and set alone on Pro and Custom from sales speed and sync lag, within the owner rule',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-buffer-fixture').fixture(t,'growth'),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId,sku=f.item.skuIds[0];
  const plans=require('../../src/connections/agent-channel-buffer-plans'),needs=require('../../src/projections/postgres-service');
  const modes=require('../../src/autopilot/job-modes');
  const run=()=>plans.run(db,ws);
  const local=async()=>f.sync.local(db,await f.service.position(db,ctx,f.positionId));
  const buffer=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_channel_buffers WHERE position_id=$1',[f.positionId])).rows[0];
  const latest=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_channel_buffer_plans WHERE position_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[f.positionId])).rows[0];
  const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
  const sell=async(quantity,channel=false)=>{
    const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor:1000}]});
    await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    // An order the channel itself took: the channel already lowered its own count.
    if(channel)await db.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,created_at,updated_at)
      VALUES($1,$2,$3,'sales_order',$4,$5,'exact',now()::text,now()::text)`,[randomUUID(),ws,f.connectorId,'channel-order-'+randomUUID(),o.salesOrderId]);
  };
  const form=async()=>f.csrf((await browser.get('/autopilot/channel-buffers').expect(200)).text);
  const saveRule=async body=>{const r=await browser.post('/autopilot/channel-buffers/rules').type('form').send({_csrf:await form(),connectorId:f.connectorId,...body});assert.equal(r.status,303,r.text.slice(0,400));return r;};
  // The channel is checked every 12 hours.
  await db.query('UPDATE workspace_connectors SET expected_interval_minutes=720 WHERE id=$1',[f.connectorId]);
  await sell(4);await sell(1,true);

  // StockChief works the buffer out from sales elsewhere on the busiest day and the channel's lag.
  const {recommendations:[rec]}=await plans.recommend(db,ws,{connector_id:f.connectorId,authorized_by:ctx.actorId});
  assert.equal(rec.units,2);
  assert.deepEqual({...rec.basis},{checkMinutes:720,deliveryMinutes:0,lagMinutes:720,busiestDay:4,soldElsewhere:4,days:28},'The channel’s own order is not counted.');

  // An account still on its older terms sees the plan card; Starter is excluded.
  await db.query('DELETE FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId]);
  assert.match((await browser.get('/autopilot/channel-buffers').expect(200)).text,/data-agent-plan-locked/);
  await subscribe('starter');
  assert.deepEqual(await run(),{skipped:'plan'});
  await assert.rejects(plans.saveRule(db,ctx,{connectorId:f.connectorId,maxUnits:'5'}),/Growth/);

  // Growth: the rule drafts each buffer for the owner's approval.
  await subscribe('growth');
  await assert.rejects(plans.saveRule(db,ctx,{connectorId:f.connectorId,maxUnits:'5',automatic:'yes'}),/Pro/);
  await saveRule({maxUnits:'5'});
  assert.deepEqual(await run(),{applied:0,drafted:1,held:0,unchanged:0,skipped:0});
  assert.deepEqual(await run(),{applied:0,drafted:0,held:0,unchanged:1,skipped:0},'Replays add nothing.');
  let draft=await latest();assert.equal(draft.status,'DRAFT');assert.equal(draft.units,2);assert.equal(await buffer(),undefined);
  const waiting=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='channel-buffer-plans');
  assert.equal(waiting.title,'1 channel stock buffer waits for your approval');
  let page=await browser.get('/autopilot/channel-buffers').expect(200);
  assert.match(page.text,/Keep <strong>2 units<\/strong> back\. Sold up to 4 a day elsewhere in the last 28 days; the channel can be 720 minutes behind/);
  await browser.post('/autopilot/channel-buffer-plans/'+draft.id+'/approve').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  let b=await buffer();assert.equal(b.set_by,'AGENT');assert.equal(b.buffer_units,2);assert.equal(b.automatic_enabled,false);assert.equal(b.basis.busiestDay,4);
  assert.equal((await local()).value,13,'20 on hand, 5 on orders, 2 kept back.');
  assert.equal((await f.reconcile()).queued,0,'Growth still reviews each channel quantity.');
  // A dismissed buffer is not proposed again until the facts change.
  await sell(2);await run();draft=await latest();assert.equal(draft.units,3);
  await plans.dismiss(db,ctx,draft.id);
  assert.equal((await run()).unchanged,1);

  // Pro: within the owner's rule StockChief sets the buffer on its own, and the channel gets it.
  await subscribe('pro');
  await saveRule({maxUnits:'5',automatic:'yes',revision:'1'});
  await sell(2);
  assert.equal((await run()).applied,1);
  const applied=await latest();assert.equal(applied.status,'APPLIED');assert.equal(applied.units,4);assert.equal(applied.prior.units,2);
  b=await buffer();assert.equal(b.buffer_units,4);assert.equal(b.automatic_enabled,true);
  assert.equal(await audits('StockChief set a channel stock buffer'),1);
  assert.equal((await local()).value,7);
  await f.reconcile();await f.deliver();assert.equal(f.remote.value,7);
  assert.equal((await run()).unchanged,1);
  // Undo brings the earlier buffer back, and StockChief does not set it again.
  page=await browser.get('/autopilot/channel-buffers').expect(200);
  await browser.post('/autopilot/channel-buffer-plans/'+applied.id+'/undo').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  b=await buffer();assert.equal(b.buffer_units,2);assert.equal(b.automatic_enabled,false);assert.equal(b.set_by,'AGENT');
  assert.equal((await latest()).status,'UNDONE');assert.equal((await run()).unchanged,1);
  // Over the owner's limit: it waits for the owner, who can approve it.
  await saveRule({maxUnits:'3',automatic:'yes',revision:'2'});
  await sell(2);
  assert.equal((await run()).held,1);
  const held=await latest();assert.equal(held.units,5);assert.match(held.reason,/Over your limit of 3 units/);
  await plans.approve(db,ctx,held.id);
  b=await buffer();assert.equal(b.buffer_units,5);assert.equal(b.automatic_enabled,true);
  // Ask me first and the first 14 days keep it for the owner.
  await modes.save(db,ctx,183,{mode:'ask',revision:0});
  await saveRule({maxUnits:'10',automatic:'yes',revision:'3'});
  await sell(2);
  assert.equal((await run()).drafted,1);
  const asked=await latest();assert.equal(asked.units,6);assert.match(asked.reason,/Ask me first/);
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  await assert.rejects(plans.approve(db,ctx,asked.id),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await plans.approve(db,ctx,asked.id);
  assert.equal((await buffer()).buffer_units,6);

  // Custom: a buffer the owner set themselves, here half the stock, is left alone.
  await subscribe('enterprise');
  await modes.save(db,ctx,183,{mode:'inherit',revision:1});
  await f.configure({revision:(await buffer()).revision,bufferUnits:'',bufferPercent:'50'});
  let now=await local();assert.equal(now.unbufferedValue,7);assert.equal(now.bufferUnits,4);assert.equal(now.value,3);
  assert.deepEqual(await run(),{applied:0,drafted:0,held:0,unchanged:0,skipped:1});
  b=await buffer();assert.equal(b.set_by,'OWNER');assert.equal(b.buffer_percent,50);
  // Once the owner removes it, StockChief sets its own on its own.
  await f.configure({revision:b.revision,stop:'yes'});
  assert.equal((await run()).applied,1);
  b=await buffer();assert.equal(b.set_by,'AGENT');assert.equal(b.buffer_units,6);assert.equal(b.automatic_enabled,true);
  now=await local();assert.equal(now.value,1);
  // The rule counts as one saved rule, and stopping it leaves the buffers in place.
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stockchief_runtime.agent_channel_buffer_rules WHERE workspace_id=$1 AND enabled',[ws])).rows[0].n,1);
  await saveRule({stop:'yes',revision:'4'});
  assert.equal((await buffer()).enabled,true);assert.deepEqual(await run(),{applied:0,drafted:0,held:0,unchanged:0,skipped:0});

  // The page reads well on a desktop and on a 390 px phone.
  await saveRule({maxUnits:'10',automatic:'yes',revision:'5'});
  assert.equal((await browser.get('/autopilot/channel-buffers').expect(200)).text.match(/Undo this buffer/g).length,1,'Only the buffer in place can be undone.');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+'/autopilot/channel-buffers');
    assert(await tab.getByRole('heading',{name:'Let StockChief set buffers'}).isVisible());
    assert(await tab.getByRole('heading',{name:'Buffers StockChief worked out'}).isVisible());
    assert.match(await tab.locator('main').innerText(),/Set on its own/);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'channel-buffer-plans-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});

test('a channel scan reaches all 800 product mappings and rechecks changed rules before the next page',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-buffer-fixture').fixture(t,'growth'),{db,ctx}=f,ws=ctx.workspaceId;
  const plans=require('../../src/connections/agent-channel-buffer-plans');
  const jobs=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(f.providers);
  const processPage=()=>jobs.processOne(db,{[plans.KIND]:handlers[plans.KIND]},{owner:'channel-buffer-volume'});
  await db.query(`INSERT INTO items(id,workspace_id,name,tracking_mode,created_at,updated_at)
    SELECT 'volume-item-'||n,$1,'Volume product '||n,'quantity',now()::text,now()::text FROM generate_series(1,799)n`,[ws]);
  await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,created_at)
    SELECT 'volume-sku-'||n,$1,'volume-item-'||n,'VOLUME-'||n,now()::text FROM generate_series(1,799)n`,[ws]);
  await db.query(`INSERT INTO connection_commerce_positions(id,workspace_id,connector_id,provider_account_id,provider_type,sku_id,location_id,
    external_id,external_location_id,field,mode,authorized_by_user_id)
    SELECT 'z-volume-position-'||lpad(n::text,3,'0'),$1,$2,'synthetic-buffer-merchant','shopify','volume-sku-'||n,$3,
      'volume-variant-'||n,'buffer-room','quantity','outbound',$4 FROM generate_series(1,799)n`,
    [ws,f.connectorId,f.location.id,ctx.actorId]);
  await db.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,created_at,updated_at)
    SELECT 'volume-map-'||n,$1,$2,'sku','volume-variant-'||n,'volume-sku-'||n,'exact',now()::text,now()::text FROM generate_series(1,799)n`,
    [ws,f.connectorId]);
  await db.query("UPDATE workspace_connectors SET expected_interval_minutes=720 WHERE id=$1",[f.connectorId]);
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',
    fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:'volume-sku-799',quantity:4,unitPriceMinor:1000}]});
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  const input={connectorId:f.connectorId,maxUnits:'5'};
  const pending=async()=>Number((await db.query(`SELECT count(*) FROM stockchief_runtime.agent_channel_buffer_plans
    WHERE workspace_id=$1 AND position_id='z-volume-position-799' AND status='DRAFT'`,[ws])).rows[0].count);
  const lastChecked=async()=>(await db.query(`SELECT last_checked_at FROM stockchief_runtime.agent_channel_buffer_rules
    WHERE workspace_id=$1 AND connector_id=$2`,[ws,f.connectorId])).rows[0].last_checked_at;
  await plans.saveRule(db,ctx,input);
  assert.equal((await processPage()).result.skipped,500);
  assert.equal(await lastChecked(),null);
  assert.equal(await pending(),0);
  await plans.saveRule(db,ctx,{...input,revision:'1',maxUnits:'6'});
  assert.equal((await processPage()).result.drafted,0,'The first continuation belongs to the old rule.');
  assert.equal((await processPage()).result.skipped,500);
  assert.equal(await pending(),0);
  const final=await processPage();
  assert.equal(final.result.skipped,299);
  assert.equal(final.result.drafted,1);
  assert.equal(await pending(),1);
  assert.ok(await lastChecked());
  assert.equal(await processPage(),null);
});
