'use strict';
process.env.NODE_ENV='test';
// Job 61: an order that is partly in stock is split by the owner's rules. The
// part set aside goes to picking through the normal shipment path, the rest
// waits on the same order, job 64 fills it when stock arrives and the rest then
// ships the same way. Pro proposes until taught; Custom splits alone.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const splits=require('../../src/sales/agent-order-splits');
const backorders=require('../../src/sales/agent-backorders');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const ADDRESS='10 Jobsite Rd, Albany, NY 12207';

async function setup(t,{plan='pro',units=5}={}){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f;
  await f.subscribe(plan);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const ws=ctx.workspaceId,sku=f.item.skuIds[0],at=new Date().toISOString();
  for(const [id,name] of [['wholesale','Wholesale buyer'],['shop','Corner shop']])
    await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'5185550100',$5,'ACTIVE',$6,$7,$7)`,[id,ws,name,id+'@example.test',ADDRESS,ctx.actorId,at]);
  const order=async(customerId,lines,{address=ADDRESS}={})=>{
    const o=await f.workflows.createSalesOrder(db,ctx,{customerId,deliveryMethod:'SHIP',shipToAddress:address,fulfillmentLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:(Array.isArray(lines)?lines:[{skuId:sku,quantity:lines}]).map(l=>({unitPriceMinor:1000,...l}))});
    await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    return o;
  };
  const row=async o=>(await db.query('SELECT status,version FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ws,o.salesOrderId])).rows[0];
  const boxes=async o=>(await db.query(`SELECT h.id,h.status,coalesce((SELECT sum(l.quantity) FROM sales_shipment_lines l WHERE l.workspace_id=h.workspace_id AND l.shipment_id=h.id),0)::int units
    FROM sales_shipments h WHERE h.workspace_id=$1 AND h.sales_order_id=$2 ORDER BY h.created_at,h.id`,[ws,o.salesOrderId])).rows;
  const list=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_order_splits WHERE workspace_id=$1 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const mode=async(job,value)=>{const r=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[ws,job])).rows[0];await modes.save(db,ctx,job,{mode:value,revision:r?.revision||0});};
  const rules=async(input={})=>splits.configure(db,ctx,{revision:(await splits.read(db,ws))?.revision||0,customers:'accepting',minPercent:'30',maxSplits:'2',notify:'off',confirmed:'yes',...input});
  const approve=s=>splits.approve(db,ctx,s.id,{confirmed:'yes',fingerprint:s.fingerprint});
  async function handoff(shipmentId){
    await f.shipping.setPackages(db,ctx,shipmentId,[{weightGrams:500,lengthMm:200,widthMm:150,heightMm:100}]);
    await f.shipping.markPacked(db,ctx,shipmentId,{packageCount:1});
    return f.shipping.handoff(db,ctx,shipmentId,{idempotencyKey:randomUUID(),handover:'DELIVERED_BY_US'});
  }
  async function refill(quantity,skuId=sku){
    const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:quantity,unitCost:1}]});
    await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    return f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity,locationId:f.location.id}]});
  }
  const invoiced=async o=>Number((await db.query('SELECT coalesce(sum(total_minor),0) n FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ws,o.salesOrderId])).rows[0].n);
  return {...f,ws,sku,order,row,boxes,list,audits,mode,rules,approve,handoff,refill,invoiced};
}

test('Starter and Growth are locked out; Pro splits by the owner rules only after teaching, and job 64 fills the backorder that then ships',{timeout:400000},async t=>{
  const f=await setup(t),{db,ctx,browser}=f;
  const known=await f.order('fixture-customer',1),target=await f.order('fixture-customer',10);
  assert.equal((await f.row(target)).status,'BACKORDERED');

  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    const locked=await browser.get(splits.href).expect(200);
    assert.match(locked.text,/Pro/);assert.doesNotMatch(locked.text,/Save rules/);
    await assert.rejects(f.rules(),e=>e.code==='entitlement_required');
    assert.deepEqual(await splits.run(db,f.ws),{split:0,drafted:0,held:0,waiting:0,watching:false});
  }
  await f.subscribe('pro');
  await f.rules({automatic:'yes'});
  assert.equal((await splits.read(db,f.ws)).automatic,false,'Pro cannot split alone before teaching.');
  assert.equal(await f.audits('Saved order split rules'),1);

  // The customer has not said it accepts partial shipments, so the order waits.
  let result=await splits.run(db,f.ws);
  assert.equal(result.waiting,1);assert.equal((await f.list()).length,0);
  await splits.setConsent(db,ctx,{customerId:'fixture-customer',accepts:'yes'});
  // Four of ten units (40%) are below a 50% minimum, and below a $50 minimum value.
  await f.rules({minPercent:'50'});
  assert.equal((await splits.run(db,f.ws)).waiting,1);
  let p=await splits.facts(db,ctx,target.salesOrderId,await splits.read(db,f.ws));
  assert.match(p.wait,/40% of the order is ready, below your minimum of 50%/);
  await f.rules({minPercent:'30',minValue:'50'});
  p=await splits.facts(db,ctx,target.salesOrderId,await splits.read(db,f.ws));
  assert.match(p.wait,/\$40\.00 is ready, below your minimum of \$50\.00/);
  await f.rules({minPercent:'30',minValue:'40'});

  // Pro proposes: nothing goes to picking before approval.
  result=await splits.run(db,f.ws);
  assert.equal(result.drafted,1);assert.equal(result.split,0);
  let [draft]=await f.list("status='DRAFT'");
  assert.match(draft.reason,/teach/);assert.equal(draft.plan.readyUnits,4);assert.equal(draft.plan.waitingUnits,6);
  assert.equal((await f.boxes(target)).length,0);
  const need=(await splits.inbox(db,f.ws)).find(r=>r.sourceId==='order-split:'+draft.id);
  assert.match(need.title,/Split/);assert.match(need.happened,/4 units are in stock and 6 still wait/);
  assert.equal((await splits.run(db,f.ws)).drafted,0,'An unchanged split is proposed once.');

  // A stale fingerprint is refused; the exact split goes to picking once.
  await assert.rejects(splits.approve(db,ctx,draft.id,{confirmed:'yes',fingerprint:'x'}),/exact split/);
  const approved=await f.approve(draft);
  assert.equal(approved.applied,true);
  assert.equal((await f.approve(draft)).replayed,true);
  let shipments=await f.boxes(target);
  assert.equal(shipments.length,1);assert.equal(shipments[0].status,'PICKING');assert.equal(shipments[0].units,4);
  assert.equal((await f.row(target)).status,'BACKORDERED','The rest waits on the original order.');
  assert.equal(await f.audits('Approved splitting an order'),1);
  assert.equal((await db.query("SELECT count(*)::int n FROM sales_order_events WHERE sales_order_id=$1 AND event_type='order_split'",[target.salesOrderId])).rows[0].n,1);
  assert.equal(await f.invoiced(target),0);
  assert.equal(await f.balance(),5,'Opening a pick moves no stock.');

  // Teach the approved split; the routine never opens a second pick while one is open.
  const page=await browser.get(splits.href).expect(200);
  assert.match(page.text,/Teach these rules/);
  await splits.teach(db,ctx,{revision:(await splits.read(db,f.ws)).revision,splitId:draft.id,confirmed:'yes'});
  assert.equal((await splits.read(db,f.ws)).automatic,true);
  assert.equal((await splits.run(db,f.ws)).split,0);

  // People pack and hand over the ready part; only those units are invoiced.
  await f.handoff(shipments[0].id);
  assert.equal(await f.balance(),1);
  assert.equal((await f.row(target)).status,'PARTIALLY_FULFILLED');
  assert.equal(await f.invoiced(target),4000);

  // Job 64 fills the backorder when stock arrives; the rest then ships on its own, taught.
  await backorders.configure(db,ctx,{revision:0,maxUnits:'100',releaseReady:'yes',confirmed:'yes'});
  await f.refill(6);
  assert.equal((await backorders.run(db,f.ws)).applied,1);
  const queued=(await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2",[f.ws,splits.KIND])).rows[0].n;
  assert(queued>=1,'Setting stock aside queues a split check.');
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  for(let i=0;i<5;i++){const r=await jobs.processOne(db,{[splits.KIND]:handlers[splits.KIND]},{owner:'split-worker',kinds:[splits.KIND]});if(!r)break;assert.equal(r.status,'COMPLETED',JSON.stringify(r.lastError));}
  shipments=await f.boxes(target);
  assert.equal(shipments.length,2);assert.equal(shipments[1].units,6);
  const rest=(await f.list("status='APPLIED'")).at(-1);
  assert.equal(rest.authorization_kind,'AUTOMATIC');assert.equal(rest.plan.final,true);
  await f.handoff(shipments[1].id);
  assert.equal((await f.row(target)).status,'FULFILLED');
  assert.equal(await f.invoiced(target),10000);
  assert.equal((await f.row(known)).status,'CONFIRMED');

  // A changed rule needs fresh teaching.
  await f.rules({minPercent:'20'});
  assert.equal((await splits.read(db,f.ws)).automatic,false);
});

test('Custom splits alone within the rules: kits leave whole, batches wait for picking, the customer is emailed, and every stop is respected',{timeout:400000},async t=>{
  const f=await setup(t,{plan:'enterprise',units:3}),{db,ctx}=f;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipts=require('../../src/accounting/postgres-stock-receipt'),kits=require('../../src/domain/postgres-kit-service');
  const item=async(code,extra={})=>(await catalog.createItem(db,ctx,{name:code,baseCode:code+'-'+randomUUID().slice(0,6),trackingMode:'quantity',...extra})).skuIds[0];
  const receive=(skuId,quantity,extra={})=>receipts.receive(db,ctx,{skuId,locationId:f.location.id,quantity,unitCost:'1.00',reference:'stock '+randomUUID().slice(0,6),idempotencyKey:randomUUID(),...extra});
  const part=await item('PART'),box=await item('BOX'),kit=await item('KIT'),paint=await item('PAINT',{trackingMode:'lot'});
  await kits.define(db,ctx,{kitSkuId:kit,components:[{skuId:part,quantity:1},{skuId:box,quantity:2}],stockBasis:'components'});
  await receive(part,3);await receive(box,5);await receive(paint,2,{lotCode:'PAINT-1'});

  // Mailbox and a fake provider for the customer email.
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Sales mailbox','gmail','[]','{}','connected','["MAIL_SEND","MAIL_READ"]',$3,'CONNECTED',$4,'sales@example.test',now(),now())`,[connector,f.ws,'connection_credentials:'+connector,ctx.actorId]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,f.ws,connector,'provider',{accessToken:'synthetic-split-token'}));
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'split-accepted-'+message.id};}};
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>provider});
  const mailKind='agent.mail.'+splits.NOTICE+'.v1';
  async function deliver(){const out=[];for(let i=0;i<10;i++){const r=await jobs.processOne(db,{[mailKind]:handlers[mailKind]},{owner:'split-mail',kinds:[mailKind]});if(!r)break;out.push(r);}return out;}

  await f.order('wholesale',1);
  // Three kits need three parts and six boxes: two whole kits are ready (five boxes), one waits.
  // Four litres of paint: two are in stock in a batch.
  const target=await f.order('wholesale',[{skuId:kit,quantity:3},{skuId:paint,quantity:4},{skuId:f.sku,quantity:4}]);
  assert.equal((await f.row(target)).status,'BACKORDERED');
  await f.rules({customers:'all',minPercent:'10',maxSplits:'1',notify:'send',connectorId:connector,automatic:'yes'});
  assert.equal((await splits.read(db,f.ws)).automatic,true,'Custom splits alone without teaching.');

  // Ask me first, pause and a first delivery address keep the split for approval.
  await f.mode(61,'ask');
  assert.equal((await splits.run(db,f.ws)).drafted,1);
  let [draft]=await f.list("status='DRAFT'");assert.match(draft.reason,/Ask me first/);
  await f.mode(61,'inherit');
  await autopilot.pause(db,ctx,{role:'owner'},'Owner is reviewing');
  await splits.run(db,f.ws);[draft]=await f.list("status='DRAFT'");assert.match(draft.reason,/paused/i);
  await autopilot.resume(db,ctx,{role:'owner'});
  // Watch only and shadow mode only watch.
  await f.mode(61,'watch');
  assert.equal((await splits.run(db,f.ws)).watching,true);
  await f.mode(61,'inherit');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  assert.equal((await splits.run(db,f.ws)).watching,true);
  await assert.rejects(splits.prepare(db,ctx,{orderId:target.salesOrderId}),/14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal((await f.boxes(target)).length,0);

  // Custom splits alone: whole kits only, the batch item and plain units go to picking.
  const result=await splits.run(db,f.ws);
  assert.equal(result.split,1,JSON.stringify(result));
  const [applied]=await f.list("status='APPLIED'");
  assert.equal(applied.authorization_kind,'AUTOMATIC');
  const ready=Object.fromEntries(applied.plan.lines.map(l=>[l.code.split('-')[0],[l.ready,l.waiting]]));
  assert.deepEqual(ready,{KIT:[2,1],PAINT:[2,2],PARCEL:[2,2]});
  assert.equal((await f.list("status='STALE'")).length,1,'The waiting draft is replaced by the split.');
  const [shipment]=await f.boxes(target);
  const lines=(await db.query('SELECT quantity::int,uses_kit_components kit FROM sales_shipment_lines WHERE shipment_id=$1 ORDER BY quantity,uses_kit_components',[shipment.id])).rows;
  assert.deepEqual(lines.map(l=>[l.quantity,Boolean(l.kit)]),[[2,false],[2,false],[2,true]]);
  assert.equal(await f.audits('StockChief split an order and sent the ready part to picking'),1);
  // Replay does nothing: the open pick holds the order.
  assert.equal((await splits.run(db,f.ws)).split,0);

  // The customer is emailed through the outbox and the mail worker rechecks the split.
  assert.ok(applied.notice_id||(await f.list("status='APPLIED'"))[0].notice_id);
  await deliver();
  assert.equal(sent.length,1);assert.equal(sent[0].recipient,'wholesale@example.test');
  assert.match(sent[0].body,/2 × KIT/);assert.match(sent[0].body,/The rest will follow/);

  // Undo cancels the unpacked pick; stock stays set aside for the order.
  await splits.undo(db,ctx,applied.id,{confirmed:'yes'});
  assert.equal((await f.boxes(target))[0].status,'CANCELLED');
  assert.equal((await splits.undo(db,ctx,applied.id,{confirmed:'yes'})).replayed,true);
  assert.equal(await f.audits('Undid an order split'),1);

  // A queued email for an undone split is not sent.
  await splits.run(db,f.ws);
  const again=(await f.list("status='APPLIED'")).at(-1);
  await splits.undo(db,ctx,again.id,{confirmed:'yes'});
  await deliver();
  assert.equal(sent.length,1,'The worker refuses to tell the customer about an undone split.');

  // The customer's own order can be marked to ship complete; a new address needs a person.
  await splits.setConsent(db,ctx,{orderNumber:(await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[target.salesOrderId])).rows[0].order_number,accepts:'no'});
  assert.match((await splits.facts(db,ctx,target.salesOrderId,await splits.read(db,f.ws))).wait,/ship complete/);
  await receive(f.sku,3);
  const fresh=await f.order('shop',[{skuId:f.sku,quantity:6}],{address:'20 Market St, Albany, NY 12207'});
  await splits.run(db,f.ws);
  const [newDraft]=await f.list(`status='DRAFT' AND sales_order_id='${fresh.salesOrderId}'`);
  assert.match(newDraft.reason,/first order for a new customer or delivery address/);

  // Packing ends the chance to undo.
  await splits.approve(db,ctx,newDraft.id,{confirmed:'yes',fingerprint:newDraft.fingerprint});
  const [packed]=await f.boxes(fresh);
  await f.shipping.setPackages(db,ctx,packed.id,[{weightGrams:500,lengthMm:200,widthMm:150,heightMm:100}]);
  await f.shipping.markPacked(db,ctx,packed.id,{packageCount:1});
  const last=(await f.list(`status='APPLIED' AND sales_order_id='${fresh.salesOrderId}'`))[0];
  await assert.rejects(splits.undo(db,ctx,last.id,{confirmed:'yes'}),/already packed/);
});

test('The split page reads well on a desktop and on a 390 px phone',{timeout:300000},async t=>{
  const f=await setup(t),{db,ctx}=f;
  await f.order('fixture-customer',1);const target=await f.order('fixture-customer',10);
  await splits.setConsent(db,ctx,{customerId:'fixture-customer',accepts:'yes'});
  await f.rules();
  await splits.run(db,f.ws);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const page=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});page.setDefaultTimeout(15000);
    await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(base+splits.href);
    assert(await page.getByRole('heading',{name:'Split orders',exact:true}).isVisible());
    assert(await page.getByRole('heading',{name:'Waiting for your approval'}).isVisible());
    assert(await page.getByRole('button',{name:'Approve and send to picking'}).isVisible());
    assert(await page.getByRole('heading',{name:'Your rules'}).isVisible());
    const text=await page.locator('main').innerText();
    assert.match(text,/Ships now from Dispatch: 4 × /);assert.match(text,/Waits on the order: 6 × /);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await page.screenshot({path:require('node:path').join(folder,'order-splits-'+name+'.png'),fullPage:true});
    if(phone){
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and send to picking'}).click()]);
      assert.match(await page.locator('main').innerText(),/Recent splits/);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await page.close();
  }
  assert.equal((await f.boxes(target)).length,1);
  // The review page links to the rules, and Needs you lists nothing once approved.
  assert.match((await f.browser.get('/autopilot/reviews/partial-shipments').expect(200)).text,/Split orders by your rules/);
  assert.equal((await splits.inbox(db,f.ws)).length,0);
});
