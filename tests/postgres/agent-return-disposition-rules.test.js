'use strict';process.env.NODE_ENV='test';
// Job 113 on every plan: the owner's rules decide restock, repair or scrap for
// each returned product from its recorded physical condition, the return
// reason, the goods value, how long ago the goods left and the days left
// before the batch expires. Restock and repair moves then happen on their own;
// scrap is a write-off and always waits for the owner's approval.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-return-disposition-fixture');
const {hash}=require('../../src/pricing/postgres-promotions');
async function setup(t){
 const f=await fixture(t),{db,ctx,service:s}=f,jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
 // The worker prepares decisions and then makes the moves it may make alone.
 async function worker(){for(let n=0;n<20;n++){const j=await jobs.processOne(db,{[s.kind]:handlers[s.kind],[s.applyKind]:handlers[s.applyKind]},{owner:'return-decisions'});if(!j)break;assert.equal(j.status,'COMPLETED',JSON.stringify(j.lastError));}}
 const rule=async(input)=>{const r=await s.saveRule(db,ctx,{conditionLabel:'Checked '+input.conditionCode,maximumUnits:5,confirmed:'yes',currency:'USD',...input});return r;};
 const on=async(id,extra={})=>{const r=await db.query('SELECT revision FROM stockchief_runtime.agent_return_disposition_rules WHERE id=$1',[id]);return s.configure(db,ctx,id,{revision:r.rows[0].revision,confirmed:'yes',...extra});};
 const native=id=>f.returns.getCustomerReturn(db,ctx.workspaceId,id);
 const moved=async id=>(await native(id)).lines.map(l=>({restock:Number(l.quantity_restocked),repair:Number(l.quantity_repair),scrap:Number(l.quantity_scrapped)}))[0];
 async function aged(id,daysAgo){const lines=(await native(id)).lines.map(l=>l.sales_order_line_id);
  await db.transaction(async c=>{await c.query("SET LOCAL session_replication_role='replica'");await c.query(`UPDATE accounting_journal_entries SET created_at=(now()-make_interval(days=>$3))::text WHERE workspace_id=$1 AND source_type='sale_fulfillment' AND metadata::jsonb->>'salesOrderLineId'=ANY($2::text[])`,[ctx.workspaceId,lines,daysAgo]);await c.query("UPDATE sales_shipments SET shipped_at=(now()-make_interval(days=>$2))::text,delivered_at=NULL WHERE workspace_id=$1 AND sales_order_id=(SELECT sales_order_id FROM customer_returns WHERE id=$3)",[ctx.workspaceId,daysAgo,id]);});}
 const because=(id,reason)=>db.query('UPDATE customer_returns SET reason=$2 WHERE id=$1',[id,reason]);
 const approve=async(id,extra={})=>{const a=await s.assessment(db,ctx,id);return s.apply(db,ctx,id,{revision:a.revision,proposalHash:hash(a.proposal),confirmed:'yes',...extra});};
 return {...f,worker,rule,on,native,moved,aged,because,approve};
}

test('Custom decides alone by condition, product, reason, value and age; the most specific rule wins; scrap waits for the write-off approval',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');
 for(const r of [
  {conditionCode:'UNOPENED',allProducts:'yes',outcome:'RESTOCK',destinationId:f.location.id,maximumValue:'15'},
  {conditionCode:'UNOPENED',allProducts:'yes',outcome:'REPAIR',destinationId:f.repair.id},
  {conditionCode:'DAMAGED',skuId:f.skuId,outcome:'SCRAP',reasonContains:'broken'},
  {conditionCode:'DAMAGED',allProducts:'yes',outcome:'REPAIR',destinationId:f.repair.id,maximumAgeDays:'30'}])await f.on((await f.rule(r)).id);
 // Worth $10, within the $15 restock rule: back on the shelf alone, cost and all.
 const cheap=await f.received({quantity:1}),ca=await f.observe(cheap,'UNOPENED');const before=await f.balance();await f.worker();
 assert.deepEqual(await f.moved(cheap),{restock:1,repair:0,scrap:0});assert.equal((await f.native(cheap)).status,'COMPLETED');
 const shelf=(await db.query('SELECT on_hand::int n FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.skuId,f.location.id])).rows[0].n;assert.ok(shelf>=1);assert.equal(await f.balance(),before,'a move, not new stock');
 // Worth $20: the less specific UNOPENED rule sends it to repair, held from sale.
 const dear=await f.received({quantity:2});await f.observe(dear,'UNOPENED');await f.worker();
 assert.deepEqual(await f.moved(dear),{restock:0,repair:2,scrap:0});assert.equal((await db.query("SELECT quantity FROM stockchief_runtime.agent_return_repair_holds WHERE workspace_id=$1 AND status='HELD'",[ctx.workspaceId])).rows[0].quantity,2);
 // Damaged and the customer says it arrived broken: the product rule scraps it, after approval only.
 const broken=await f.received();await f.because(broken,'Arrived broken in the box');const a=await f.observe(broken,'DAMAGED');await f.worker();
 let plan=await s.assessment(db,ctx,a.id);assert.equal(plan.status,'READY');assert.equal(plan.proposal.lines[0].outcome,'SCRAP');assert.equal(plan.proposal.lines[0].writeoffMinor,100);assert.match(plan.proposal.lines[0].ruleConditions,/broken/);
 assert.deepEqual(await f.moved(broken),{restock:0,repair:0,scrap:0},'no write-off without a person');
 await assert.rejects(f.approve(a.id),/Separately approve/);await f.approve(a.id,{writeoffConfirmed:'yes'});assert.deepEqual(await f.moved(broken),{restock:0,repair:0,scrap:1});
 // Damaged for another reason, sold 10 days ago: the age rule repairs it. Sold 45 days ago: no rule covers it and a person decides.
 const recent=await f.received();await f.because(recent,'Scratched lid');await f.aged(recent,10);await f.observe(recent,'DAMAGED');await f.worker();assert.deepEqual(await f.moved(recent),{restock:0,repair:1,scrap:0});
 const old=await f.received();await f.because(old,'Scratched lid');await f.aged(old,45);const late=await f.observe(old,'DAMAGED');await f.worker();
 plan=await s.assessment(db,ctx,late.id);assert.equal(plan.status,'OBSERVED');assert.match(plan.problem,/No current owner rule covers/);assert.equal((await f.native(old)).status,'RECEIVED');
 const audits=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Returned goods moved on their own'",[ctx.workspaceId])).rows;assert.equal(audits.length,3);assert.equal(audits[0].after_state.automatic,true);
 // Replaying the worker moves nothing twice.
 const balance=await f.balance();assert.equal((await s.applyRoutine(db,ctx.workspaceId,ca.id,ctx.actorId)).skipped,true);assert.equal(await f.balance(),balance);
 assert.deepEqual(await f.moved(cheap),{restock:1,repair:0,scrap:0});
});

test('Pro drafts until a completed manual example teaches the rule; Starter and Growth cannot use rules',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,service:s}=f;
 const r=await f.rule({conditionCode:'UNOPENED',allProducts:'yes',outcome:'RESTOCK',destinationId:f.location.id,maximumUnits:1});
 await assert.rejects(f.on(r.id),/Individually approve a matching example/);
 const first=await f.received(),a=await f.observe(first,'UNOPENED');await f.worker();
 assert.equal((await s.assessment(db,ctx,a.id)).status,'OBSERVED','untrained Pro only drafts');assert.equal((await f.native(first)).status,'RECEIVED');
 await s.prepare(db,ctx,a.id,{revision:(await s.assessment(db,ctx,a.id)).revision,byRules:'yes',confirmed:'yes'});assert.equal((await s.assessment(db,ctx,a.id)).proposal.lines[0].outcome,'RESTOCK');
 // A by-rules draft is not a manual example; an individually chosen and completed one is.
 const manual=await f.received(),m=await f.observe(manual,'UNOPENED');await f.manual(m.id,'RESTOCK',f.location.id);await f.approve(m.id);
 await f.on(r.id,{exampleId:m.id});
 const next=await f.received(),b=await f.observe(next,'UNOPENED');await f.worker();assert.deepEqual(await f.moved(next),{restock:1,repair:0,scrap:0});assert.equal((await s.assessment(db,ctx,b.id)).status,'APPLIED');
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(f.rule({conditionCode:'OTHER-'+plan,allProducts:'yes',outcome:'SCRAP'}),/Pro/);}
});

test('pause, Ask me first for restocking and the first 14 days leave decided moves for a person',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');await f.on((await f.rule({conditionCode:'UNOPENED',allProducts:'yes',outcome:'RESTOCK',destinationId:f.location.id})).id);
 const auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
 await auto.pause(db,ctx,{role:'owner'},'Owner pause');const paused=await f.received(),p=await f.observe(paused,'UNOPENED');await f.worker();assert.equal((await s.assessment(db,ctx,p.id)).status,'OBSERVED');await auto.resume(db,ctx,{role:'owner'});
 await modes.save(db,ctx,114,{mode:'ask',revision:0});const ask=await f.received(),q=await f.observe(ask,'UNOPENED');await f.worker();
 const held=await s.assessment(db,ctx,q.id);assert.equal(held.status,'READY');assert.match(held.problem,/Ask me first/);assert.deepEqual(await f.moved(ask),{restock:0,repair:0,scrap:0});
 await f.approve(q.id);assert.deepEqual(await f.moved(ask),{restock:1,repair:0,scrap:0},'the owner approves the restock');
 await modes.save(db,ctx,114,{mode:'inherit',revision:1});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);const shadow=await f.received(),w=await f.observe(shadow,'UNOPENED');await f.worker();assert.equal((await s.assessment(db,ctx,w.id)).status,'OBSERVED');assert.equal((await f.native(shadow)).status,'RECEIVED');
});

test('lot expiry decides batches: enough days left goes back to stock, a batch near expiry is prepared for scrap',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');
 const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt'),today=new Date(),inDays=n=>new Date(today.getTime()+n*86400000).toISOString().slice(0,10);
 const food=(await catalog.createItem(db,ctx,{name:'Returned batch food',trackingMode:'lot',purchaseCost:'2'})).skuIds[0];
 for(const [code,days]of [['LONG-LOT',400],['SOON-LOT',10]])await receipt.receive(db,ctx,{skuId:food,locationId:f.location.id,quantity:1,lotCode:code,expiresAt:inDays(days),idempotencyKey:'lot-'+code});
 await f.on((await f.rule({conditionCode:'SEALED',allProducts:'yes',outcome:'RESTOCK',destinationId:f.location.id,minimumExpiryDays:'30'})).id);
 await f.on((await f.rule({conditionCode:'SEALED',allProducts:'yes',outcome:'SCRAP'})).id);
 async function returned(lotCode){
  const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:food,quantity:1,unitPriceMinor:900}]});
  await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});await f.workflows.fulfillSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:o.lineIds[0],locationId:f.location.id,quantity:1,lotCode}],shipment:{handover:'COLLECTED'}});
  const r=await f.returns.requestCustomerReturn(db,ctx,{salesOrderId:o.salesOrderId,quarantineLocationId:f.quarantine.id,resolution:'NO_REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:o.lineIds[0],quantity:1}]});
  await f.returns.authorizeCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID()});const row=await f.native(r.customerReturnId);
  await f.returns.receiveCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID(),lines:[{lineId:row.lines[0].id,quantity:1,lotCode}]});return r.customerReturnId;
 }
 const fresh=await returned('LONG-LOT');await f.observe(fresh,'SEALED');await f.worker();assert.deepEqual(await f.moved(fresh),{restock:1,repair:0,scrap:0});
 const lot=(await db.query("SELECT b.quantity::int n FROM lot_balances b JOIN lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id WHERE b.workspace_id=$1 AND l.code='LONG-LOT' AND b.location_id=$2",[ctx.workspaceId,f.location.id])).rows[0];assert.equal(lot.n,1,'the same batch is back on the shelf');
 const soon=await returned('SOON-LOT'),a=await f.observe(soon,'SEALED');await f.worker();
 const plan=await s.assessment(db,ctx,a.id);assert.equal(plan.proposal.lines[0].outcome,'SCRAP');assert.ok(plan.proposal.lines[0].daysToExpiry<30);assert.deepEqual(await f.moved(soon),{restock:0,repair:0,scrap:0});
 await f.approve(a.id,{writeoffConfirmed:'yes'});assert.deepEqual(await f.moved(soon),{restock:0,repair:0,scrap:1});
});

test('the rules page renders the new conditions at desktop width and on a phone',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx}=f;await f.subscribe('enterprise');await f.rule({conditionCode:'UNOPENED',allProducts:'yes',outcome:'RESTOCK',destinationId:f.location.id,maximumValue:'15',reasonContains:'wrong size'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:1366,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});page.setDefaultTimeout(12000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/autopilot/return-disposition');const text=await page.locator('main').innerText();
  assert.match(text,/Any product · Checked UNOPENED/);assert.match(text,/reason mentions “wrong size” · worth up to \$15\.00/);
  assert(await page.getByLabel('Only when at least this many days are left before expiry').isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll at '+viewport.width);
  if(viewport.width===390){await page.getByLabel('Any product (leave the SKU code empty)').check();await page.getByLabel('Condition code',{exact:true}).fill('OPENED');await page.getByLabel('Physical condition label',{exact:true}).fill('Opened, all parts there');
   await page.getByLabel('Rule outcome',{exact:true}).selectOption('RESTOCK');await page.getByLabel('Only when the goods left us within this many days').fill('30');
   await page.getByLabel('I approve this exact product, physical condition, outcome, destination and limit.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save disposition rule',exact:true}).click()]);
   assert.match(await page.locator('main').innerText(),/OPENED → restock[\s\S]*left us within 30 days/);}
  await page.close();
 }
});
