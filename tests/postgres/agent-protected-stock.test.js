'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const service=require('../../src/sales/agent-stock-protections'),stock=require('../../src/domain/postgres-stock-availability');

// Job 12: the owner protects stock for a big customer or an upcoming order.
async function fixture(t,plan){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,workflows}=f;
  const at=new Date().toISOString();
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at)
    VALUES('other-buyer',$1,'Other buyer','other@example.test','ACTIVE',$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const lot=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Batch item',baseCode:'LOT-'+randomUUID().slice(0,6),trackingMode:'lot'});
  const lotCode=(await db.query('SELECT code FROM skus WHERE id=$1',[lot.skuIds[0]])).rows[0].code;
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await f.subscribe(plan);
  async function order(customerId,quantity){
    const o=await workflows.createSalesOrder(db,ctx,{customerId,deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),
      lines:[{skuId:sku,quantity,unitPriceMinor:1000}]});
    const confirmed=await workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    return {...o,...confirmed};
  }
  const allocated=async o=>Number((await db.query(`SELECT coalesce(sum(a.quantity),0) n FROM sales_order_allocations a JOIN sales_order_lines l
    ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,[ctx.workspaceId,o.salesOrderId])).rows[0].n);
  const position=()=>stock.read(db,ctx.workspaceId,sku,f.location.id);
  const rows=async id=>(await db.query(`SELECT * FROM stockchief_runtime.agent_stock_reservations WHERE workspace_id=$1 AND protection_id=$2 ORDER BY created_at,id`,
    [ctx.workspaceId,id])).rows;
  const changes=async()=>(await db.query(`SELECT * FROM stockchief_runtime.agent_stock_reservation_changes WHERE workspace_id=$1 ORDER BY created_at,id`,
    [ctx.workspaceId])).rows;
  const protect=(input)=>service.save(db,ctx,{customer:'Receiver',kind:'customer',locationId:f.location.id,lines:code+', 6',requestKey:randomUUID(),...input});
  const run=id=>service.run(db,ctx.workspaceId,{protectionId:id});
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  // The big customer already has one confirmed order, so it is an established customer.
  const known=await order('fixture-customer',1);
  return {...f,sku,code,lotCode,order,allocated,position,rows,changes,protect,run,today,known};
}

test('Pro proposes until taught, then keeps protected stock out of other orders, channels, reorder and lookups',{timeout:360000},async t=>{
  const f=await fixture(t,'pro'),{db,ctx,browser}=f;
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    const locked=await browser.get(service.href);
    assert.equal(locked.status,200);assert.match(locked.text,/data-agent-plan-locked/);assert.match(locked.text,/Pro/);
    await assert.rejects(f.protect(),/Pro/);
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_stock_protections WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  await f.subscribe('pro');
  await assert.rejects(f.protect({lines:f.lotCode+', 2'}),/lot, serial or weight/);
  await assert.rejects(f.protect({lines:'NO-SUCH-CODE, 2'}),/No single product/);
  await assert.rejects(f.protect({customer:'Nobody at all'}),/No single customer/);

  // Untaught Pro only proposes. Nothing is held yet.
  const key=randomUUID(),saved=await f.protect({requestKey:key});
  assert.equal(saved.mode,'draft');assert.equal(saved.proposed,6);assert.equal(saved.held,0);
  assert.equal((await f.protect({requestKey:key})).replayed,true);
  let [r]=await f.rows(saved.id);
  assert.equal(r.held,0);assert.equal(r.proposed,6);assert.equal((await f.position()).available,19);

  // The owner approves the exact suggestion on the page; a repeat post changes nothing.
  const page=await browser.get(service.href);
  assert.equal(page.status,200);assert.match(page.text,/Reserve 6 now/);assert.match(page.text,/Asks you first/);
  const csrf=f.csrf(page.text),approval={_csrf:csrf,revision:String(r.revision),quantity:'6',requestKey:'approve-'+r.id};
  assert.equal((await browser.post(service.href+'/reservations/'+r.id+'/approve').type('form').send(approval)).status,303);
  assert.equal((await browser.post(service.href+'/reservations/'+r.id+'/approve').type('form').send(approval)).status,303);
  [r]=await f.rows(saved.id);
  assert.equal(r.held,6);assert.equal(r.proposed,0);
  const held=(await f.changes()).filter(c=>c.kind==='held');
  assert.equal(held.length,1);assert.equal(held[0].authority,'INDIVIDUAL');
  assert.equal((await db.query('SELECT example_id FROM stockchief_runtime.agent_stock_protections WHERE id=$1',[saved.id])).rows[0].example_id,r.id);

  // Every reader of availability sees the 6 units as not available.
  const p=await f.position();assert.equal(p.available,13);assert.equal(p.committed,7);
  const channel=await require('../../src/connections/postgres-commerce-sync').local(db,{workspace_id:ctx.workspaceId,sku_id:f.sku,location_id:f.location.id,field:'quantity',id:'none'});
  assert.equal(channel.committed,7);assert.equal(channel.value,Math.max(0,Math.min(channel.physical,channel.costed)-7));
  const reorder=(await require('../../src/purchasing/postgres-replenishment-state').rows(db,ctx.workspaceId,{onlySkuIds:[f.sku]})).find(row=>row.location_id===f.location.id);
  assert.equal(Number(reorder.committed),7);
  assert.equal(await stock.total(db,ctx.workspaceId),13);
  const lookup=await require('../../src/autopilot/stock-reading').lookup(db,ctx,{filter:f.code,today:f.today});
  assert.match(lookup.rows.find(row=>row.View==='SKU balance')['Commitment records'],/Protected for customer Receiver: 6/);

  // Another customer's order cannot take it.
  const other=await f.order('other-buyer',19);
  assert.equal(await f.allocated(other),13);assert.equal(other.status,'BACKORDERED');
  assert.equal((await f.rows(saved.id))[0].held,6);
  assert.equal((await f.position()).available,0);
  // Nor can a transfer move it away.
  const overflow=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Overflow',kind:'warehouse'});
  await assert.rejects(require('../../src/transfers/postgres-transfer-service').request(db,ctx,{fromLocationId:f.location.id,toLocationId:overflow.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.sku,quantity:1}]}),/only has 0 available/);

  // The protected customer's own order uses its reservation, even with no other free stock.
  const own=await f.order('fixture-customer',4);
  assert.equal(await f.allocated(own),4);assert.equal(own.status,'CONFIRMED');
  [r]=await f.rows(saved.id);assert.equal(r.held,2);assert.equal(r.status,'OPEN');
  const arrived=(await f.changes()).find(c=>c.kind==='order_arrived');
  assert.equal(arrived.handed_over,4);assert.equal(arrived.sales_order_id,own.salesOrderId);
  assert.equal((await db.query("SELECT count(*)::int n FROM sales_order_events WHERE sales_order_id=$1 AND event_type='protected_stock_used'",[own.salesOrderId])).rows[0].n,1);

  // Taught by the approval, Pro now tops up on its own, but never ahead of the waiting order.
  let result=await f.run(saved.id);
  assert.equal(result.mode,'auto');assert.equal(result.held,0);assert.equal((await f.rows(saved.id))[0].held,2);
  await f.workflows.cancelSalesOrder(db,ctx,other.salesOrderId,{idempotencyKey:randomUUID(),reason:'Customer withdrew'});
  result=await f.run(saved.id);
  assert.equal(result.held,4);assert.equal((await f.rows(saved.id))[0].held,6);
  const topped=(await f.changes()).filter(c=>c.kind==='topped_up');assert.equal(topped.length,1);assert.equal(topped[0].authority,'TRAINED');
  result=await f.run(saved.id);assert.equal(result.held,0);
  assert.equal((await f.changes()).length,3,'A repeated routine run changes nothing');

  // A saved rule also teaches Pro: an expected order is held on its own straight away.
  const expected=await f.protect({kind:'expected',nextOn:f.today,leadDays:'0',graceDays:'1',lines:f.code+', 3',routine:'yes'});
  assert.equal(expected.mode,'auto');assert.equal(expected.held,3);
  assert.equal((await f.changes()).filter(c=>c.kind==='held').at(-1).authority,'TRAINED');
  assert.equal((await f.position()).available,20-1-4-6-3);

  // Saved protections count as rules, and every change is in the security audit.
  assert.equal(require('../../src/commercial/agent-rule-quota').sources.some(([table])=>table==='agent_stock_protections'),true);
  const audited=(await db.query(`SELECT action FROM security_event_history WHERE workspace_id=$1 AND reference IN(
    SELECT id FROM stockchief_runtime.agent_stock_reservations WHERE workspace_id=$1)`,[ctx.workspaceId])).rows.map(r=>r.action);
  for(const action of ['Reserved stock for a customer','Topped up a customer reservation','Passed reserved stock to the customer’s order'])
    assert(audited.includes(action),action);

  // The routine is queued once per protection and quarter hour, and its worker kind is registered.
  const queued=await service.schedule(db,ctx.workspaceId);assert.equal(queued.queued,2);
  assert.equal((await service.schedule(db,ctx.workspaceId)).queued,0);
  assert.equal(typeof require('../../src/operations/postgres-runtime-handlers').create()[service.KIND],'function');
  const review=await browser.get('/autopilot/reviews/protected-stock');assert.equal(review.status,303);
  assert.equal((await require('../../src/autopilot/job-reviews').run(db,ctx,'protected-stock')).rows.length,2);

  // The page renders at desktop width and on a 390 px phone without sideways scrolling.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chromium=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chromium.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const tab=await chromium.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500});tab.setDefaultTimeout(15000);
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    assert.equal((await tab.goto(origin+service.href)).status(),200);
    const main=await tab.locator('main').innerText();
    assert.match(main,/Protected stock/);assert.match(main,/Receiver · Big customer/);assert.match(main,/Receiver · Expected order/);
    assert.match(main,/Used by their order/);assert.doesNotMatch(main,/stock-reservation_|undefined|NaN/);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scroll at '+viewport.width);
    require('node:fs').mkdirSync('output',{recursive:true});await tab.screenshot({path:'output/protected-stock-'+viewport.width+'.png',fullPage:true});
    await tab.close();
  }
});

test('Custom acts alone inside pause, watch, shadow and Ask me first, releases on arrival or expiry, never goes negative and undoes',{timeout:360000},async t=>{
  const f=await fixture(t,'enterprise'),{db,ctx}=f;
  // Custom reserves on its own without teaching.
  const standing=await f.protect({lines:f.code+', 5'});
  assert.equal(standing.mode,'auto');assert.equal(standing.held,5);
  assert.equal((await f.changes())[0].authority,'CUSTOM');
  assert.equal((await f.position()).available,14);

  // Shadow mode only watches: it shows what it would reserve, and approval waits.
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const watched=await f.protect({kind:'expected',nextOn:f.today,leadDays:'0',graceDays:'0',lines:f.code+', 2'});
  assert.equal(watched.mode,'watch');assert.equal(watched.held,0);assert.equal(watched.proposed,0);
  const preview=await f.browser.get(service.href);assert.match(preview.text,/Would reserve 2/);assert.match(preview.text,/watching/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  // Ask me first turns automatic work into suggestions.
  await require('../../src/autopilot/job-modes').save(db,ctx,12,{mode:'ask',revision:0});
  let result=await f.run(watched.id);
  assert.equal(result.mode,'draft');assert.equal(result.proposed,2);assert.equal(result.held,0);
  await require('../../src/autopilot/job-modes').save(db,ctx,12,{mode:'routine',revision:1});
  result=await f.run(watched.id);assert.equal(result.held,2);
  assert.equal((await f.position()).available,12);

  // The order arrives: the expected reservation goes to it first and ends; the standing one gives the rest.
  const own=await f.order('fixture-customer',3);
  assert.equal(await f.allocated(own),3);
  const [expectedRow]=await f.rows(watched.id);
  assert.equal(expectedRow.status,'RELEASED');assert.equal(expectedRow.release_reason,'order_arrived');assert.equal(expectedRow.held,0);
  assert.equal((await f.rows(standing.id))[0].held,4);

  // Paused: the top-up waits for approval. Resumed: it happens on its own.
  await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);
  result=await f.run(standing.id);assert.equal(result.mode,'draft');assert.equal(result.proposed,1);
  assert.equal((await f.rows(standing.id))[0].held,4);
  await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
  result=await f.run(standing.id);assert.equal(result.held,1);assert.equal((await f.rows(standing.id))[0].held,5);

  // Watch only takes nothing and clears suggestions.
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'OBSERVE');
  const newcomer=await f.protect({customer:'Other buyer',lines:f.code+', 2'});
  assert.equal(newcomer.mode,'watch');assert.equal(newcomer.held,0);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  // A customer with no confirmed orders needs the owner's approval even on Custom.
  result=await f.run(newcomer.id);assert.equal(result.mode,'draft');assert.match(result.reason,/no confirmed orders/);assert.equal(result.proposed,2);
  const [suggested]=await f.rows(newcomer.id);
  await assert.rejects(service.approve(db,ctx,suggested.id,{revision:suggested.revision,quantity:'3',requestKey:randomUUID()}),/changed/);
  await service.approve(db,ctx,suggested.id,{revision:suggested.revision,quantity:'2',requestKey:randomUUID()});
  assert.equal((await f.rows(newcomer.id))[0].held,2);
  // Facts that no longer match stop the routine and ask.
  await db.query("UPDATE customers SET record_state='ARCHIVED' WHERE id='other-buyer'");
  result=await f.run(newcomer.id);assert.match(result.problem,/no longer active/);
  assert.match((await db.query('SELECT problem FROM stockchief_runtime.agent_stock_protections WHERE id=$1',[newcomer.id])).rows[0].problem,/no longer active/);
  await service.stop(db,ctx,newcomer.id,{revision:(await db.query('SELECT revision FROM stockchief_runtime.agent_stock_protections WHERE id=$1',[newcomer.id])).rows[0].revision});
  assert.equal((await f.rows(newcomer.id))[0].release_reason,'removed');
  await db.query("UPDATE customers SET record_state='ACTIVE' WHERE id='other-buyer'");
  // Stock now: 20 on hand, 1+3 on orders, 5 protected.
  assert.equal((await f.position()).available,11);

  // A repeating order is held, released when its order arrives, and moves to its next date.
  const repeat=await f.protect({kind:'recurring',nextOn:f.today,everyDays:'7',leadDays:'2',graceDays:'0',lines:f.code+', 2'});
  assert.equal(repeat.held,2);
  const repeatOrder=await f.order('fixture-customer',2);assert.equal(await f.allocated(repeatOrder),2);
  assert.equal((await f.rows(repeat.id))[0].release_reason,'order_arrived');
  await f.run(repeat.id);
  const moved=(await db.query('SELECT next_on::text FROM stockchief_runtime.agent_stock_protections WHERE id=$1',[repeat.id])).rows[0].next_on;
  const nextWeek=new Date(Date.parse(f.today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
  assert.equal(moved,nextWeek);assert.equal((await f.rows(repeat.id)).length,1,'The next window has not opened yet');

  // An expected order with no order by its end releases on time, and undo puts it back until released.
  const late=await f.protect({kind:'expected',nextOn:f.today,leadDays:'0',graceDays:'0',lines:f.code+', 3'});
  assert.equal(late.held,3);assert.equal((await f.position()).available,6);
  await db.query("UPDATE stockchief_runtime.agent_stock_reservations SET expires_at=now()-interval '1 second' WHERE protection_id=$1",[late.id]);
  assert.equal((await f.position()).available,9,'An ended reservation stops holding at its end time');
  result=await f.run(late.id);assert.equal(result.released,1);
  let [lateRow]=await f.rows(late.id);assert.equal(lateRow.release_reason,'expired');
  const expiry=(await f.changes()).find(c=>c.kind==='expired');assert.equal(expiry.authority,'UPKEEP');
  await service.undo(db,ctx,expiry.id,{requestKey:'undo-expiry'});
  assert.equal((await service.undo(db,ctx,expiry.id,{requestKey:'undo-expiry'})).replayed,true);
  [lateRow]=await f.rows(late.id);assert.equal(lateRow.held,3);assert.equal(lateRow.kept,true);assert.equal(lateRow.expires_at,null);
  await f.run(late.id);assert.equal((await f.rows(late.id))[0].held,3,'Kept stock is left alone by the routine');

  // Undo of an automatic hold gives the stock back and the routine does not take it again.
  const standingId=(await f.rows(standing.id))[0].id,hold=(await f.changes()).find(c=>c.kind==='held'&&c.reservation_id===standingId);
  await service.undo(db,ctx,hold.id,{requestKey:randomUUID()});
  const [standingRow]=await f.rows(standing.id);assert.equal(standingRow.held,0);assert.equal(standingRow.release_reason,'undone');
  await f.run(standing.id);assert.equal((await f.rows(standing.id))[0].held,0);
  await assert.rejects(service.undo(db,ctx,(await f.changes()).find(c=>c.kind==='order_arrived').id,{requestKey:randomUUID()}),/customer’s order/);

  // A physical loss cuts the reservation back; nothing ever goes negative.
  const kept=await f.protect({lines:f.code+', 4'});assert.equal(kept.held,4);
  // On hand 20; orders 1+3+2; kept expected 3; this one 4 => 7 free.
  assert.equal((await f.position()).available,7);
  await require('../../src/domain/postgres-inventory-engine').adjust(db,ctx,{skuId:f.sku,locationId:f.location.id,countedQuantity:11,reasonCode:'cycle_count',idempotencyKey:randomUUID()});
  result=await f.run(kept.id);assert.equal(result.trimmed,2);
  assert.equal((await f.rows(kept.id))[0].held,2);
  const after=await f.position();assert.equal(after.available,0);
  assert((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_stock_reservations WHERE workspace_id=$1 AND (held<0 OR proposed<0)',[ctx.workspaceId])).rows[0].n===0);
  const trim=(await f.changes()).find(c=>c.kind==='trimmed');
  await assert.rejects(service.undo(db,ctx,trim.id,{requestKey:randomUUID()}),/Only 0 units are free/);

  // Changing a protection keeps what is already held and moves it to the new amount.
  const before=(await db.query('SELECT revision FROM stockchief_runtime.agent_stock_protections WHERE id=$1',[kept.id])).rows[0].revision;
  await service.save(db,ctx,{id:kept.id,revision:String(before),lines:f.code+', 1',requestKey:randomUUID()});
  const openKept=(await f.rows(kept.id)).filter(r=>r.status==='OPEN');assert.equal(openKept.length,1);assert.equal(openKept[0].held,1);assert.equal(openKept[0].target,1);

  // A plan that no longer includes the job gives every reservation back.
  await f.subscribe('growth');
  for(const id of [standing.id,late.id,kept.id,repeat.id])await f.run(id);
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_stock_reservations WHERE workspace_id=$1 AND status='OPEN'",[ctx.workspaceId])).rows[0].n,0);
  assert((await f.changes()).some(c=>c.kind==='plan'));
  await assert.rejects(f.protect(),/Pro/);
  assert.equal((await f.position()).available,5);
});
