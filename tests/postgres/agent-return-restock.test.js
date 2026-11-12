'use strict';process.env.NODE_ENV='test';
// Job 114 on every plan: after staff check returned goods on the phone, the
// ones recorded as good go back into sellable stock where they were sold from,
// through the return's own path, with their batch, serials and cost.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-return-disposition-fixture');
const {hash}=require('../../src/pricing/postgres-promotions');
async function setup(t){
 const f=await fixture(t),{db,ctx,service:s}=f,jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
 const staffId=randomUUID(),other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Inspector',businessName:'Inspector home',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
 await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Warehouse inspector','staff','["VIEW","OPERATE","INSPECT_CUSTOMER_RETURN"]',now()::text)`,[staffId,ctx.workspaceId,other.accountId]);
 const staff={workspaceId:ctx.workspaceId,actorId:staffId};
 async function worker(){for(let n=0;n<20;n++){const j=await jobs.processOne(db,{[s.kind]:handlers[s.kind],[s.applyKind]:handlers[s.applyKind]},{owner:'return-restock'});if(!j)break;assert.equal(j.status,'COMPLETED',JSON.stringify(j.lastError));}}
 // Staff record what they found, product by product.
 async function check(id,conditions){const facts=await s.facts(db,ctx,id);return s.observe(db,staff,{returnId:id,sourceHash:facts.sourceHash,confirmed:'yes',
  lines:facts.lines.map((l,i)=>({lineId:l.id,conditionCode:Array.isArray(conditions)?conditions[i]:conditions,note:'Opened the box and checked every part.'}))});}
 const onHand=async(skuId,locationId)=>Number((await db.query('SELECT coalesce(sum(on_hand),0) n FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuId,locationId])).rows[0].n);
 const cost=async(skuId,locationId)=>Number((await db.query('SELECT coalesce(sum(total_cost_minor),0) n FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuId,locationId])).rows[0].n);
 const native=id=>f.returns.getCustomerReturn(db,ctx.workspaceId,id);
 const confirm=async id=>{const a=await s.assessment(db,ctx,id);return s.apply(db,ctx,id,{revision:a.revision,proposalHash:hash(a.proposal),confirmed:'yes'});};
 const limit=maximum=>s.saveRestockLimit(db,ctx,{maximum,currency:'USD',confirmed:'yes'});
 const needs=async actor=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,actor)).filter(n=>/^return-(check|restock):/.test(String(n.sourceId)));
 return {...f,staff,staffId,worker,check,onHand,cost,native,confirm,limit,needs};
}

test('Starter is locked; Growth prepares the restock of goods staff checked as good and the owner confirms it, with the original cost',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,service:s}=f;
 await f.subscribe('starter');const locked=await f.received();await assert.rejects(f.check(locked,'GOOD'),/Growth/);
 await f.subscribe('growth');const id=await f.received();
 assert.ok((await f.needs(f.staffId)).some(n=>n.href==='/returns/'+id+'#return-check'&&n.actionLabel==='Check the goods'),'staff are asked to check the goods');
 const shelf=await f.onHand(f.skuId,f.location.id),held=await f.cost(f.skuId,f.quarantine.id),waiting=await f.onHand(f.skuId,f.quarantine.id);
 const a=await f.check(id,'GOOD');await f.worker();
 let plan=await s.assessment(db,ctx,a.id);assert.equal(plan.status,'READY');assert.deepEqual([plan.proposal.lines[0].outcome,plan.proposal.lines[0].destinationId,plan.proposal.lines[0].job],['RESTOCK',f.location.id,114]);
 assert.match(plan.problem,/Confirm putting these checked goods back/);assert.equal(await f.onHand(f.skuId,f.location.id),shelf,'nothing moves before the owner confirms');
 assert.ok((await f.needs(ctx.actorId)).some(n=>n.actionLabel==='Put back into stock'));
 await assert.rejects(s.apply(db,f.staff,a.id,{confirmed:'yes'}),/owner/);
 await f.confirm(a.id);assert.equal((await f.native(id)).status,'COMPLETED');
 assert.equal(await f.onHand(f.skuId,f.location.id),shelf+1);assert.equal(await f.onHand(f.skuId,f.quarantine.id),waiting-1);assert.equal(await f.cost(f.skuId,f.quarantine.id),held-100,'its $1.00 cost left quarantine with it');
 assert.equal((await f.confirm(a.id)).replayed,true,'confirming again changes nothing');
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Returned goods checked'",[ctx.workspaceId])).rows[0].n,1);
});

test('Pro and Custom put good goods back alone within the owner’s limit; over the limit, Ask me first, pause and the first 14 days wait',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,service:s}=f;
 const first=await f.received(),a=await f.check(first,'GOOD');await f.worker();assert.match((await s.assessment(db,ctx,a.id)).problem,/Set your limit for good returns/);assert.equal((await f.native(first)).status,'RECEIVED');
 await f.limit('50');await s.applyRoutine(db,ctx.workspaceId,a.id,ctx.actorId);assert.equal((await f.native(first)).status,'COMPLETED');assert.equal((await s.assessment(db,ctx,a.id)).status,'APPLIED');
 const before=await f.onHand(f.skuId,f.location.id);assert.equal((await s.applyRoutine(db,ctx.workspaceId,a.id,ctx.actorId)).skipped,true,'replay moves nothing');assert.equal(await f.onHand(f.skuId,f.location.id),before);
 const big=await f.received({quantity:6}),b=await f.check(big,'GOOD');await f.worker();assert.match((await s.assessment(db,ctx,b.id)).problem,/worth more than the \$50\.00/);assert.equal((await f.native(big)).status,'RECEIVED');
 await f.subscribe('enterprise');const custom=await f.received(),c=await f.check(custom,'GOOD');await f.worker();assert.equal((await f.native(custom)).status,'COMPLETED');
 const modes=require('../../src/autopilot/job-modes'),auto=require('../../src/autopilot/postgres-service');
 await modes.save(db,ctx,114,{mode:'ask',revision:0});const ask=await f.received(),d=await f.check(ask,'GOOD');await f.worker();assert.match((await s.assessment(db,ctx,d.id)).problem,/Ask me first/);await modes.save(db,ctx,114,{mode:'inherit',revision:1});
 await auto.pause(db,ctx,{role:'owner'},'Owner pause');const paused=await f.received(),e=await f.check(paused,'GOOD');await f.worker();assert.match((await s.assessment(db,ctx,e.id)).problem,/paused/i);await auto.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);const watched=await f.received(),w=await f.check(watched,'GOOD');await f.worker();assert.match((await s.assessment(db,ctx,w.id)).problem,/14 days/);
 for(const id of [ask,paused,watched])assert.equal((await f.native(id)).status,'RECEIVED');
 const moved=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Returned goods moved on their own'",[ctx.workspaceId])).rows;assert.equal(moved.length,2);assert.equal(moved[0].after_state.automatic,true);
});

test('serial goods go back as the exact unit, and a mixed return keeps the damaged product in quarantine for its own decision',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx,service:s}=f;await f.limit('500');
 const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
 const device=(await catalog.createItem(db,ctx,{name:'Returned serial device',trackingMode:'serial',purchaseCost:'3'})).skuIds[0];
 await receipt.receive(db,ctx,{skuId:device,locationId:f.location.id,quantity:2,serials:['DEV-1','DEV-2'],idempotencyKey:'serial-stock'});
 const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:device,quantity:1,unitPriceMinor:4000},{skuId:f.skuId,quantity:1,unitPriceMinor:1000}]});
 await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
 await f.workflows.fulfillSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:o.lineIds[0],locationId:f.location.id,quantity:1,serials:['DEV-1']},{lineId:o.lineIds[1],locationId:f.location.id,quantity:1}],shipment:{handover:'COLLECTED'}});
 const r=await f.returns.requestCustomerReturn(db,ctx,{salesOrderId:o.salesOrderId,quarantineLocationId:f.quarantine.id,resolution:'NO_REFUND',idempotencyKey:randomUUID(),lines:o.lineIds.map(salesOrderLineId=>({salesOrderLineId,quantity:1}))});
 await f.returns.authorizeCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID()});const row=await f.native(r.customerReturnId);
 await f.returns.receiveCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID(),lines:row.lines.map(l=>({lineId:l.id,quantity:1,...(l.sku_id===device?{serials:['DEV-1']}:{})}))});
 const facts=await s.facts(db,ctx,r.customerReturnId),conditions=facts.lines.map(l=>l.sku_id===device?'GOOD':'DAMAGED'),a=await f.check(r.customerReturnId,conditions);await f.worker();
 const unit=(await db.query("SELECT location_id,status FROM serial_units WHERE workspace_id=$1 AND serial='DEV-1'",[ctx.workspaceId])).rows[0];assert.equal(unit.location_id,f.location.id,'the same serial is back on the shelf');
 let native=await f.native(r.customerReturnId);assert.equal(native.status,'RECEIVED');
 assert.deepEqual(native.lines.map(l=>[l.sku_id===device?'device':'other',Number(l.quantity_restocked),Number(l.quantity_scrapped)]).sort(),[['device',1,0],['other',0,0]]);
 assert.equal(await f.onHand(f.skuId,f.quarantine.id),1,'the damaged product stays in quarantine');
 const damaged=native.lines.find(l=>l.sku_id!==device);
 await f.returns.inspectCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID(),lines:[{lineId:damaged.id,scrap:1}]});
 native=await f.native(r.customerReturnId);assert.equal(native.status,'COMPLETED');assert.equal((await s.assessment(db,ctx,a.id)).status,'STOPPED');
});

test('staff check the goods on a phone and the owner confirms on the return page, at desktop width and 390 px',{timeout:300000},async t=>{
 const f=await setup(t),{db,ctx}=f;await f.subscribe('growth');const id=await f.received(),code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.skuId])).rows[0].code;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:1366,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});page.setDefaultTimeout(12000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/returns/'+id);
  if(viewport.width===1366){assert(await page.getByLabel('Condition of '+code,{exact:true}).isVisible());assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll at desktop width');await page.close();continue;}
  await page.getByLabel('Condition of '+code,{exact:true}).selectOption('GOOD');await page.getByLabel('What you checked on '+code,{exact:true}).fill('Sealed, every part there.');
  await page.getByLabel('I checked every unit listed here.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save the check',exact:true}).click()]);
  assert.match(await page.locator('#return-check').innerText(),/Waiting for a decision/);
  await f.worker();await page.reload();assert.match(await page.locator('#return-check').innerText(),/Back into stock at Dispatch/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll at 390 px');
  await page.getByLabel('Put the goods marked good back into stock.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Put back into stock',exact:true}).click()]);
  assert.match(await page.locator('#return-check').innerText(),/Back into stock at Dispatch · done/);assert.equal((await f.native(id)).status,'COMPLETED');
  await page.close();
 }
});
