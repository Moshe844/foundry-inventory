'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const margin=require('../../src/reports/agent-net-margin');

// Job 85: true net margin per item, channel and customer after marketplace
// fees, shipping and returns. Fees come from the owner's channel fee terms or a
// checked import; shipping from carrier labels and recorded carrier costs.
async function setup(t,{through}={}){
  const f=await require('../helpers/agent-net-contribution-fixture').fixture(t,{paid:true}),{db,ctx}=f,ws=ctx.workspaceId;
  const service=f.service,records=require('../../src/connections/postgres-provider-sync');
  const connectorId='shop-'+randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provider_account_id,status,capabilities,provides,config,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES($1,$2,$1,'Web shop','fixture_sync','fixture-account','connected','[]','[]','{}','CONNECTED',$3,now()::text,now()::text)`,[connectorId,ws,ctx.actorId]);
  const label={async quote(){return {rates:[{rateId:'rate-ground',carrier:'usps',service:'Ground',amountMinor:250,currency:'USD'}]};},
    async buy(){return {providerShipmentIds:['shp-'+randomUUID()],trackingNumber:'TRACK'+randomUUID().slice(0,8),carrier:'usps',service:'Ground',labelUrl:'https://carrier.test/label.pdf',amountMinor:250,currency:'USD'};}};
  // A web-shop parcel sent with a bought carrier label.
  const shopped=await f.parcel();
  const quoted=await f.shipping.quote(db,ctx,shopped.shipmentId,{provider:label});
  await f.shipping.buyLabel(db,ctx,shopped.shipmentId,quoted.rates[0].id,{idempotencyKey:'label-'+randomUUID()},{provider:label});
  await f.shipping.handoff(db,ctx,shopped.shipmentId,{idempotencyKey:'handoff-'+randomUUID()});
  await db.transaction(tx=>records.setMappingInTransaction(tx,ctx,{connectorId,entityType:'sales_order',externalId:'#1001',foundryRecordId:shopped.order.salesOrderId}));
  // A parcel handed to a carrier with its cost recorded, and one with no cost recorded.
  const costed=await f.parcel();await f.shipping.markPacked(db,ctx,costed.shipmentId);
  await f.shipping.handoff(db,ctx,costed.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z'+randomUUID().slice(0,10),shippingCostMinor:300});
  const unknown=await f.parcel();await f.shipping.markPacked(db,ctx,unknown.shipmentId);
  await f.shipping.handoff(db,ctx,unknown.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'1Z'+randomUUID().slice(0,10)});
  const number=async id=>(await db.query('SELECT order_number FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ws,id])).rows[0].order_number;
  const orders={pickup:f.sale.salesOrderId,shop:shopped.order.salesOrderId,costed:costed.order.salesOrderId,unknown:unknown.order.salesOrderId};
  const row=(report,id)=>report.rows.find(r=>r.id===id);
  const group=(report,label)=>report.groups.find(g=>g.label===label);
  const fees=(input)=>margin.saveFeeRule(db,ctx,{revision:0,currency:'USD',fixed:'0',sourceReference:'Channel fee page, checked today',...input});
  const rule=(input={})=>margin.configure(db,ctx,{revision:0,thresholdPercent:'60',periodDays:'30',confirmed:'yes',...input});
  const ruleRevision=async()=>(await margin.readRule(db,ws))?.revision||0;
  const alerts=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_net_margin_alerts WHERE workspace_id=$1 AND ${where} ORDER BY subject_kind,label`,[ws])).rows;
  const runs=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_net_margin_runs WHERE workspace_id=$1 ORDER BY created_at,id',[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('net-margin'));
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const books=async()=>(await db.query(`SELECT (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1)::int journals,(SELECT count(*) FROM accounting_payments WHERE workspace_id=$1)::int payments,
    (SELECT count(*) FROM sku_prices WHERE workspace_id=$1)::int prices,(SELECT sum(on_hand) FROM balances WHERE workspace_id=$1)::int stock`,[ws])).rows[0];
  const worker=async()=>{
    const queued=await margin.schedule(db,ws);
    const job=(await db.query('SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1',[ws,margin.KIND])).rows[0];
    const handler=require('../../src/operations/postgres-runtime-handlers').create()[margin.KIND];
    return {queued,result:await handler({workspaceId:ws,payload:job?.payload||{}},db)};
  };
  return {...f,ws,service,connectorId,orders,number,row,group,fees,rule,ruleRevision,alerts,runs,audits,needs,pilot,books,worker,label};
}

test('Fee terms, carrier labels and posted returns give net margin per item, channel and customer; the worker flags and clears low margins',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,service,orders}=f;

  // No fee terms yet: fees are missing, never zero, so no margin is shown.
  let report=await service.screen(db,ctx,{group:'channel'});
  assert.equal(report.rows.length,4);
  assert.equal(f.row(report,orders.shop).channel,'Web shop');
  assert.equal(f.row(report,orders.pickup).channel,'Direct');
  assert.equal(f.row(report,orders.shop).shipping,250);assert.equal(f.row(report,orders.shop).shippingSource,'Carrier labels');
  assert.equal(f.row(report,orders.costed).shipping,300);assert.equal(f.row(report,orders.costed).shippingSource,'Recorded carrier cost');
  assert.equal(f.row(report,orders.pickup).shipping,0);assert.equal(f.row(report,orders.pickup).shippingSource,'Collected by the customer');
  assert.equal(f.row(report,orders.unknown).shipping,null);assert.match(f.row(report,orders.unknown).problem,/No carrier cost is recorded/);
  for(const r of report.rows){assert.equal(r.fees,null);assert.equal(r.net,null);}
  assert.match(f.row(report,orders.shop).problem,/No fee record or fee terms for Web shop in USD/);
  assert.equal(f.group(report,'Web shop').net,null);

  // The owner records each channel's fee terms; an explicit zero for direct sales.
  await f.fees({channel:'Web shop',percent:'10',fixed:'0.30'});
  await f.fees({channel:'Direct',percent:'0'});
  await assert.rejects(f.fees({channel:'web shop',percent:'5'}),/already has fee terms/);
  await assert.rejects(f.fees({channel:'Market',percent:'101'}),/0% to 100%/);
  assert.equal(await f.audits('Channel fee terms saved'),2);
  report=await service.screen(db,ctx,{group:'channel'});
  assert.deepEqual([f.row(report,orders.shop).fees,f.row(report,orders.shop).net],[150,700],'1200 sale - 100 cost - 10% + 0.30 fees - 2.50 label');
  assert.equal(f.row(report,orders.costed).net,800);
  assert.equal(f.row(report,orders.pickup).net,1800);
  assert.equal(f.row(report,orders.unknown).net,null);
  assert.equal(f.group(report,'Web shop').net,700);
  assert.equal(f.group(report,'Direct').net,null);assert.equal(f.group(report,'Direct').missing,1);

  // Growth and above keep it current on a schedule and flag low margins.
  await f.rule();
  assert.equal(await f.audits('Saved the net margin rule'),1);
  const first=await f.worker();
  assert.deepEqual(first.queued,{queued:1});
  assert.equal(first.result.outcome,'CHECKED');assert.equal(first.result.opened.length,1);
  let open=await f.alerts("status='OPEN'");
  assert.deepEqual(open.map(a=>[a.subject_kind,a.label,Number(a.net_minor),Number(a.revenue_minor),a.margin_bps]),[['CHANNEL','Web shop',700,1200,5833]]);
  assert.equal(first.result.incompleteCount,1,'The parcel with no carrier cost is reported, not counted as zero');
  assert.equal(await f.audits('StockChief checked net margins'),1);
  let needs=await f.needs();
  assert(needs.some(n=>n.title==='Channel below your net margin: Web shop'&&/58.33%/.test(n.happened)));
  assert(needs.some(n=>/missing costs for 1 order/.test(n.title)));
  // Replaying the same facts changes nothing.
  const replay=await f.worker();
  assert.deepEqual(replay.queued,{queued:0});assert.equal(replay.result.replayed,true);
  assert.equal((await f.runs()).length,1);assert.equal(await f.audits('StockChief checked net margins'),1);

  // A checked import fills the missing carrier cost for that one order.
  const preview=await service.preview(db,ctx,{rows:service.columns.join(',')+'\n'+await f.number(orders.unknown)+',USD,Direct,0.00,5.00,Carrier invoice 7731'});
  await service.apply(db,ctx,preview.id,{confirmed:'yes'});
  report=await service.screen(db,ctx,{group:'item'});
  assert.equal(f.row(report,orders.unknown).net,600);assert.equal(f.row(report,orders.unknown).feeSource,'Checked import');
  assert.equal(report.groups[0].net,700+800+1800+600);
  const second=await f.worker();
  assert.deepEqual([second.result.opened.length,second.result.updated.length,second.result.incompleteCount],[0,1,0]);
  needs=await f.needs();assert(!needs.some(n=>/missing costs/.test(n.title)));

  // A posted refund of one returned unit lowers sales and product cost.
  const receive=await f.prepare('customer_return.receive');await f.assistant.executeProposal(db,ctx,receive.proposal.id);
  const returned=await f.get();
  await f.returns.inspectCustomerReturn(db,ctx,f.returnId,{idempotencyKey:randomUUID(),lines:[{lineId:returned.lines[0].id,restock:1,restockLocationId:f.location.id,conditionNote:'Checked returned unit'}]});
  const refund=await f.prepare('customer_return.refund',{refundDestination:'CASH'});await f.assistant.executeProposal(db,ctx,refund.proposal.id);
  report=await service.screen(db,ctx,{group:'customer'});
  assert.deepEqual([f.row(report,orders.pickup).revenue,f.row(report,orders.pickup).cogs,f.row(report,orders.pickup).net],[1000,100,900]);
  const books=await f.books();

  // Lower web-shop fees bring the channel back above the line and the alert clears.
  const shop=(await db.query("SELECT id,revision FROM stockchief_runtime.agent_channel_fee_rules WHERE workspace_id=$1 AND channel='Web shop'",[ws])).rows[0];
  await f.fees({id:shop.id,revision:shop.revision,channel:'Web shop',percent:'0'});
  const third=await f.worker();
  assert.equal(third.result.cleared.length,1);
  assert.match((await f.alerts("status='CLEARED'"))[0].cleared_reason,/Back at or above your 60% net margin/);
  assert.equal((await f.needs()).length,0);

  // A higher line flags every group below it. A seen alert stays quiet.
  await f.rule({revision:await f.ruleRevision(),thresholdPercent:'75'});
  const fourth=await f.worker();
  open=await f.alerts("status='OPEN'");
  assert.deepEqual(open.map(a=>[a.subject_kind,a.label]),[['CHANNEL','Direct'],['CHANNEL','Web shop'],['CUSTOMER','Receiver'],['ITEM',report.rows[0].lines[0].sku+' · Parcel item']]);
  assert.equal(fourth.result.opened.length,4);
  await margin.dismiss(db,ctx,open.find(a=>a.subject_kind==='CUSTOMER').id);
  assert.equal(await f.audits('Marked a net margin alert as seen'),1);
  const direct=(await db.query("SELECT id,revision FROM stockchief_runtime.agent_channel_fee_rules WHERE workspace_id=$1 AND channel='Direct'",[ws])).rows[0];
  await f.fees({id:direct.id,revision:direct.revision,channel:'Direct',percent:'1'});
  const fifth=await f.worker();
  assert.equal(fifth.result.replayed,undefined);assert.equal(fifth.result.updated.length,4);
  assert.equal((await f.alerts("status='OPEN'")).length,3,'The seen customer alert does not reopen while still below the line');
  assert.equal((await f.needs()).filter(n=>/^Customer/.test(n.title)).length,0);

  // Turning the rule off clears the alerts. Nothing posted money, prices or stock.
  await f.rule({revision:await f.ruleRevision(),stop:'yes'});
  assert.equal((await f.alerts("status IN ('OPEN','DISMISSED')")).length,0);
  assert.deepEqual(await f.books(),books,'Checks, alerts and fee terms never post money or change prices or stock');
});

test('Starter gets one read-only view; Growth and Custom run alone; pause holds; Watch only, Ask me first and shadow only watch',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,service}=f;
  await f.fees({channel:'Web shop',percent:'10',fixed:'0.30'});await f.fees({channel:'Direct',percent:'0'});

  // Starter: the whole view when opened, read-only. Nothing scheduled, saved or flagged.
  await f.subscribe('starter');
  const view=await service.screen(db,ctx,{group:'item'});
  assert.equal(view.allowed,false);assert.equal(view.rows.length,4);assert.equal(view.groups.length,1);
  assert.deepEqual(await margin.schedule(db,ws),{queued:0});
  assert.deepEqual(await margin.run(db,ws),{skipped:'plan'});
  await assert.rejects(f.rule(),/Growth/);
  await assert.rejects(margin.checkNow(db,ctx),/Growth/);
  await assert.rejects(service.preview(db,ctx,{rows:f.rows()}),/Growth/);
  assert.deepEqual(await margin.inbox(db,ws),[]);
  const review=await require('../../src/autopilot/job-reviews').run(db,ctx,'net-contribution',{});
  assert.equal(review.mode,'suggest');assert.equal(review.rows.length,1);
  const starterPage=await f.browser.get(margin.href+'?group=channel').expect(200);
  assert.match(starterPage.text,/Web shop/);assert.match(starterPage.text,/Growth \/ Pro \/ Custom/);
  assert.doesNotMatch(starterPage.text,/Save margin rule|Review these cost facts/);
  assert.equal((await f.runs()).length,0);

  // Growth with a rule, under each stop.
  await f.subscribe('growth');await f.rule();
  await f.pilot('paused=1');
  assert.deepEqual(await margin.run(db,ws),{held:'paused'});
  await f.pilot('paused=0');
  await f.pilot("mode='OBSERVE'");
  const observed=await margin.run(db,ws);
  assert.equal(observed.outcome,'WATCHED');assert.match(observed.reason,/watch-only/);
  assert.deepEqual(observed.flagged.map(s=>s.label),['Web shop']);
  await f.pilot("mode='SUPERVISED'");
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,85,{mode:'ask',revision:0});
  const asked=await margin.run(db,ws);
  assert.equal(asked.outcome,'WATCHED');assert.match(asked.reason,/Ask me first/);
  assert.equal((await f.alerts()).length,0,'Watching opens no alert');
  assert.deepEqual(await f.needs(),[]);
  // With Ask me first the owner checks, and alerts open on the owner's say.
  const checked=await margin.checkNow(db,ctx);
  assert.equal(checked.outcome,'CHECKED');assert.equal(checked.opened.length,1);
  assert.equal(await f.audits('Checked net margins'),1);
  await modes.save(db,ctx,85,{mode:'watch',revision:1});
  await assert.rejects(margin.checkNow(db,ctx),/Watch only/);
  await modes.save(db,ctx,85,{mode:'inherit',revision:2});
  // The first 14 days only watch.
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const shadow=await margin.run(db,ws);
  assert.equal(shadow.outcome,'WATCHED');assert.match(shadow.reason,/first 14 days/);
  await assert.rejects(margin.checkNow(db,ctx),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  // Custom runs alone too, and a plan lock stops the worker without losing alerts.
  await f.subscribe('enterprise');
  const custom=await margin.run(db,ws);
  assert.equal(custom.outcome,'CHECKED');assert.equal((await f.alerts("status='OPEN'")).length,1);
  await f.subscribe('starter');
  assert.deepEqual(await margin.run(db,ws),{skipped:'plan'});
  assert.equal((await f.alerts("status='OPEN'")).length,1);

  // Bad input is refused before anything is saved; staff cannot change the terms.
  await f.subscribe('growth');
  await assert.rejects(f.rule({revision:await f.ruleRevision(),thresholdPercent:'abc'}),/percentage/);
  await assert.rejects(f.rule({revision:await f.ruleRevision(),periodDays:'3'}),/7 to 365/);
  await assert.rejects(f.rule({revision:0}),/Reload/);
  await assert.rejects(f.fees({channel:'Web shop',currency:'ZZZ',percent:'1'}),/currency/);
  await assert.rejects(f.fees({channel:'Line\nbreak',percent:'1'}),/one line/);
  await db.query("UPDATE users SET role='staff' WHERE id=$1",[ctx.actorId]);
  await assert.rejects(f.fees({channel:'Market',percent:'1'}),/owner/);
  await db.query("UPDATE users SET role='owner' WHERE id=$1",[ctx.actorId]);
});

test('Recorded carrier costs: unconfirmed labels and refunds are missing, other currencies are not converted',()=>{
  const order={currency:'USD',delivery_method:'SHIP',lines:[{weight:1000}]},parcel=(labels,extra={})=>({shipment_number:'SH-1',status:'SHIPPED',handover:'CARRIER',cost:null,currency:'USD',labels,...extra});
  const buy=(status,amount=500,currency='USD')=>({id:'p1',operation:'PURCHASE',status,amount:String(amount),currency});
  const voided=(status,refund,amount=500)=>({id:'v1',operation:'VOID',status,refund,amount:amount==null?null:String(amount),purchase:'p1'});
  assert.deepEqual(margin.shippingCost(order,[parcel([buy('SUCCEEDED')])]),{minor:500,source:'Carrier labels'});
  assert.match(margin.shippingCost(order,[parcel([buy('PENDING')])]).problem,/still being confirmed/);
  assert.match(margin.shippingCost(order,[parcel([buy('SUCCEEDED',500,'EUR')])]).problem,/EUR. It is not converted/);
  assert.equal(margin.shippingCost(order,[parcel([buy('SUCCEEDED'),voided('SUCCEEDED','CONFIRMED')])]).minor,0);
  assert.equal(margin.shippingCost(order,[parcel([buy('SUCCEEDED'),voided('SUCCEEDED','REJECTED')])]).minor,500);
  assert.match(margin.shippingCost(order,[parcel([buy('SUCCEEDED'),voided('SUCCEEDED','PENDING')])]).problem,/refund .* not confirmed/);
  assert.match(margin.shippingCost(order,[parcel([buy('SUCCEEDED'),voided('PENDING','PENDING')])]).problem,/not confirmed/);
  assert.equal(margin.shippingCost(order,[parcel([buy('FAILED')],{cost:'320'})]).minor,320);
  assert.match(margin.shippingCost(order,[parcel([],{cost:'320',currency:'GBP'})]).problem,/GBP/);
  assert.equal(margin.shippingCost(order,[parcel([],{status:'PACKED'})]).minor,0,'A parcel that has not left has cost nothing yet');
  assert.match(margin.shippingCost(order,[parcel([],{handover:'DELIVERED_BY_US'})]).problem,/No carrier cost/);
  assert.match(margin.shippingCost(order,[]).problem,/No shipment/);
  assert.equal(margin.shippingCost({...order,delivery_method:'PICKUP'},[]).minor,0);
  assert.equal(margin.shippingCost(order,[parcel([buy('SUCCEEDED',250)],{customer_return_id:'r1'}),parcel([buy('SUCCEEDED',400)])]).minor,650,'Return parcels count');
  const rules=new Map([['web shop|USD',{percent_bps:290,fixed_minor:'30'}]]);
  assert.deepEqual(margin.feeCost(order,{name:'Web shop'},rules),{minor:59,source:'Web shop fee terms'});
  assert.match(margin.feeCost({...order,currency:'EUR'},{name:'Web shop'},rules).problem,/in EUR/);
  assert.deepEqual([margin.marginBps(700,1200),margin.marginBps(-50,1000),margin.marginBps(5,0)],[5833,-500,null]);
});

test('Needs you still works on a database migrated only part of the way',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{through:'440-agent-negotiation-emails.sql'});
  assert.deepEqual(await margin.inbox(f.db,f.ctx.workspaceId),[]);
  await require('../../src/projections/postgres-service').needs(f.db,f.ctx.workspaceId,f.ctx.actorId);
});

test('An owner on a phone and a desktop saves fee terms and a margin rule, then sees the low margin in Needs you',{timeout:600000},async t=>{
  const f=await setup(t),{db,ctx,ws}=f;
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();page.setDefaultTimeout(15000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  const fits=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'The page fits without sideways scrolling');
  await page.goto(origin+margin.href);
  assert.match(await page.locator('main').innerText(),/Missing/);await fits();
  const terms=page.locator('#fee-terms');
  await terms.getByLabel('Channel',{exact:true}).fill('Web shop');
  await terms.getByLabel('Fee as % of the sale',{exact:true}).fill('10');
  await terms.getByLabel('Fixed fee per order',{exact:true}).fill('0.30');
  await terms.getByLabel('Where these terms come from',{exact:true}).fill('Web shop fee page');
  await Promise.all([page.waitForNavigation(),terms.getByRole('button',{name:'Save fee terms',exact:true}).click()]);
  assert.match(await page.locator('#fee-terms').innerText(),/Web shop · USD/);
  await terms.getByLabel('Channel',{exact:true}).fill('Direct');await terms.getByLabel('Fee as % of the sale',{exact:true}).fill('0');
  await terms.getByLabel('Where these terms come from',{exact:true}).fill('No channel fees on direct sales');
  await Promise.all([page.waitForNavigation(),terms.getByRole('button',{name:'Save fee terms',exact:true}).click()]);
  const rule=page.locator('#margin-rule');
  await rule.getByLabel('Flag a net margin below (%)',{exact:true}).fill('60');
  await rule.getByText('Check every few hours').click();
  await Promise.all([page.waitForNavigation(),rule.getByRole('button',{name:'Save margin rule',exact:true}).click()]);
  await Promise.all([page.waitForNavigation(),page.locator('#margin-alerts').getByRole('button',{name:'Check now',exact:true}).click()]);
  const alerts=await page.locator('#margin-alerts').innerText();
  assert.match(alerts,/Web shop/);assert.match(alerts,/58.33%/);await fits();
  await page.goto(origin+margin.href+'?group=channel');
  assert.match(await page.locator('main').innerText(),/58\.33%/);await fits();
  require('node:fs').mkdirSync('output',{recursive:true});
  await page.screenshot({path:'output/net-margin-mobile.png',fullPage:true,animations:'disabled'});
  const desktop=await browser.newContext({viewport:{width:1600,height:1000},storageState:await context.storageState()}),wide=await desktop.newPage();
  await wide.goto(origin+margin.href+'?group=channel');
  assert.match(await wide.locator('main').innerText(),/Web shop/);
  assert(await wide.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await wide.screenshot({path:'output/net-margin-desktop.png',fullPage:true,animations:'disabled'});
  const needs=await f.needs();
  assert(needs.some(n=>n.title==='Channel below your net margin: Web shop'));
  assert.equal(await f.audits('Checked net margins'),1);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_channel_fee_rules WHERE workspace_id=$1',[ws])).rows[0].n,2);
  void ctx;
});
