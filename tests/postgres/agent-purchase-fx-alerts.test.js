'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fx=require('../../src/purchasing/agent-purchase-fx');
const rates=require('../../src/purchasing/fx-rates');
const {ValidationError}=require('../../src/domain/errors');

// Job 40: purchases in other currencies, and alerts when exchange rates change
// landed cost. Every rate comes from a fake provider; nothing reaches the network.
async function setup(t,plan='growth'){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f,ws=ctx.workspaceId;
  await f.subscribe(plan);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const today=await require('../../src/lib/business-time').today(db,ws),day=n=>rates.addDays(today,n);
  const quote={date:day(-4),base:'EUR',rates:{EUR:'1',USD:'1.1',GBP:'0.8'}};
  let failure=null,calls=0;
  const provider={source:'ECB',label:'Test reference rates',link:'https://rates.example.test/daily',
    async latest(){calls++;if(failure)throw failure;return {date:quote.date,base:quote.base,rates:{...quote.rates},reference:'https://rates.example.test/daily'};}};
  const previous=rates.use(provider);t.after(()=>rates.use(previous));
  const setRate=(date,usd)=>{quote.date=date;quote.rates.USD=String(usd);};
  await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('euro-supplier',$1,'Euro mill','active','EUR',now()::text,now()::text)",[ws]);
  const imported=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Imported linen',baseCode:'LINEN-'+randomUUID().slice(0,6),trackingMode:'quantity'});
  const sku=imported.skuIds[0];
  async function order({currency='EUR',quantity=10,cost=10,place=true,skuId=sku}={}){
    const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'euro-supplier',currency,destinationLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:quantity,unitCost:cost}]});
    if(place){
      await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
      await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    }
    return {id:po.purchaseOrderId,number:po.poNumber,lineId:po.lineIds[0]};
  }
  const receive=(o,quantity,extra={})=>f.workflows.receivePurchaseOrder(db,ctx,o.id,{idempotencyKey:randomUUID(),
    lines:[{lineId:o.lineId,quantity,locationId:f.location.id}],...extra});
  const alerts=async(where='true')=>(await db.query(`SELECT *,change_percent::float8 pct FROM stockchief_runtime.agent_fx_alerts WHERE workspace_id=$1 AND ${where} ORDER BY subject_kind,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const rule=async(input={})=>fx.configure(db,ctx,{thresholdPercent:'5',confirmed:'yes',revision:(await fx.readRule(db,ws))?.revision||0,...input});
  const onHand=async(skuId=sku)=>Number((await db.query('SELECT coalesce(sum(on_hand),0) n FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ws,skuId])).rows[0].n);
  const stockValue=async()=>(await db.query('SELECT quantity_units::float8 q,total_cost_minor::float8 v FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ws,sku])).rows.map(r=>[r.q,r.v]);
  const records=async()=>({lines:(await db.query('SELECT id,quantity_units::text,unit_cost::text,line_total::text FROM purchase_order_lines WHERE workspace_id=$1 ORDER BY id',[ws])).rows,
    prices:(await db.query('SELECT * FROM sku_prices WHERE workspace_id=$1 ORDER BY sku_id',[ws])).rows,
    costs:(await db.query('SELECT * FROM sku_purchase_costs WHERE workspace_id=$1 ORDER BY sku_id',[ws])).rows,
    stock:await stockValue(),journals:Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ws])).rows[0].n)});
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(r=>String(r.sourceId).startsWith('fx-alert:'));
  const pilot=async(set)=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  return {...f,ws,today,day,quote,setRate,fail:error=>{failure=error;},calls:()=>calls,sku,order,receive,alerts,audits,rule,onHand,stockValue,records,needs,pilot};
}
async function mailbox(f){
  const connector=randomUUID();
  await f.db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mailbox',now(),now())`,[connector,f.ws,'connection_credentials:'+connector,f.ctx.actorId]);
  await f.db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,f.ws,connector,'provider',{accessToken:'test-token'}));
  return connector;
}

test('Growth, Pro and Custom: orders are estimated and booked at the actual rate, and the worker alerts and clears on its own',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws}=f,outbound=require('../../src/connections/postgres-outbound-mail');
  // The latest rates the source has are four days old; the owner saves them.
  assert.deepEqual(await fx.refreshNow(db,ctx),{date:f.day(-4),source:'ECB',stored:2});
  assert.deepEqual(await fx.refreshNow(db,ctx),{date:f.day(-4),source:'ECB',stored:0},'The same rate date stores once');
  const stored=(await db.query(`SELECT source,rate_date::text,from_currency,to_currency,rate,source_reference,recorded_by FROM stockchief_runtime.agent_fx_rates WHERE workspace_id=$1 ORDER BY to_currency`,[ws])).rows;
  assert.deepEqual(stored.map(r=>[r.source,r.rate_date,r.from_currency,r.to_currency,r.rate,r.recorded_by]),[['ECB',f.day(-4),'EUR','GBP','0.8',null],['ECB',f.day(-4),'EUR','USD','1.1',null]]);
  assert.equal(stored[0].source_reference,'https://rates.example.test/daily');

  // Ordering estimates the landed cost in USD at the rate of the day.
  const po=await f.order();
  const estimate=(await db.query('SELECT rate,rate_date::text d,rate_source,goods_minor::int g,estimate_minor::int e FROM stockchief_runtime.agent_fx_order_estimates WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,po.id])).rows[0];
  assert.deepEqual(estimate,{rate:'1.1',d:f.day(-4),rate_source:'ECB',g:10000,e:11000});

  // Goods are booked in USD at the rate of the receipt day; the supplier amount and rate are kept.
  const received=await f.receive(po,4);
  assert.deepEqual([received.lines[0].totalCostMinor,received.lines[0].currency,received.lines[0].supplierCurrency,received.lines[0].supplierCostMinor,received.lines[0].rate],[4400,'USD','EUR',4000,'1.1']);
  const entry=(await db.query(`SELECT e.metadata,l.currency,l.debit_minor::int debit FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
    WHERE e.workspace_id=$1 AND e.id=$2 AND l.debit_minor>0`,[ws,received.lines[0].journalEntryId])).rows[0];
  const meta=typeof entry.metadata==='string'?JSON.parse(entry.metadata):entry.metadata;
  assert.deepEqual([entry.currency,entry.debit,meta.exchange.currency,meta.exchange.amountMinor,meta.exchange.rate,meta.exchange.rateDate],['USD',4400,'EUR',4000,'1.1',f.day(-4)]);
  assert.deepEqual(await f.stockValue(),[[4,4400]]);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_fx_receipt_rates WHERE workspace_id=$1 AND purchase_order_id=$2 AND base_minor=4400 AND foreign_minor=4000',[ws,po.id])).rows[0].n,1);

  // The owner's rule: alert over 5%, by email from the connected mailbox. It counts as a rule.
  const connector=await mailbox(f);
  assert.deepEqual(await f.rule({mailbox:connector}),{saved:true});
  assert.deepEqual(await f.rule({mailbox:connector}),{unchanged:true});
  assert.equal(await f.audits('Saved the exchange-rate alert rule'),1);
  await assert.rejects(f.rule({thresholdPercent:'0'}),/0.01% to 50%/);
  await assert.rejects(f.rule({mailbox:'someone-else'}),/connected mailbox/);

  // The euro rises 10%. The real worker fetches the new rates and opens alerts on its own.
  const before=await f.records();
  f.setRate(f.day(-3),'1.21');
  assert.deepEqual(await fx.schedule(db,ws),{queued:1});
  const job=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2",[ws,fx.KIND])).rows[0];
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[fx.KIND];
  const first=await handler({workspaceId:ws,payload:job.payload},db);
  assert.equal(first.fetched.date,f.day(-3));assert.equal(first.opened.length,2);
  const [itemAlert,orderAlert]=await f.alerts("status='OPEN'");
  assert.deepEqual([orderAlert.subject_kind,orderAlert.subject_id,Number(orderAlert.basis_minor),Number(orderAlert.current_minor),Number(orderAlert.impact_minor),orderAlert.pct,orderAlert.basis_rate,orderAlert.current_rate],
    ['ORDER',po.id,6600,7260,660,10,'1.1','1.21']);
  assert.deepEqual([itemAlert.subject_kind,itemAlert.subject_id,Number(itemAlert.basis_minor),Number(itemAlert.current_minor),Number(itemAlert.impact_minor),itemAlert.pct],
    ['ITEM',f.sku,1100,1210,110,10]);
  assert.equal(await f.audits('StockChief checked exchange-rate costs'),1);
  assert.deepEqual(await f.records(),before,'Alerts never change a price, a cost or the books');

  // The owner hears about it in Needs you and by email.
  const needs=await f.needs();
  assert.deepEqual(needs.map(n=>n.sourceId).sort(),['fx-alert:'+itemAlert.id,'fx-alert:'+orderAlert.id].sort());
  assert.match(needs.find(n=>n.sourceId==='fx-alert:'+orderAlert.id).title,new RegExp('raised the cost of '+po.number));
  assert.match(needs.find(n=>n.sourceId==='fx-alert:'+orderAlert.id).happened,/\$6\.60 more/);
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  assert.equal((await outbound.executeSendEffect(db,ws,first.email.effectId,{provider})).message.status,'SENT');
  await outbound.executeSendEffect(db,ws,first.email.effectId,{provider});
  assert.equal(sent.length,1);assert.equal(sent[0].recipient,f.email);
  assert.match(sent[0].body,new RegExp(po.number+'.*up \\$6\\.60 \\(10\\.0%\\)'));assert.match(sent[0].body,/each unit up \$1\.10/);assert.match(sent[0].body,/has not changed any price or cost/);

  // Replaying the same rate date opens nothing and sends nothing.
  const again=await fx.run(db,ws);
  assert.equal(again.replayed,true);
  assert.equal((await f.alerts()).length,2);
  assert.equal((await db.query("SELECT count(*)::int n FROM customer_communications WHERE workspace_id=$1 AND idempotency_key LIKE 'fx-alert-email:%'",[ws])).rows[0].n,1);

  // The page shows the alerts on a desktop and on a 390 px phone; receiving shows the rate it books at.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port;
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+fx.href);
    assert(await view.getByRole('heading',{name:'Foreign purchase costs',exact:true}).isVisible());
    assert(await view.getByRole('heading',{name:'Cost alerts',exact:true}).isVisible());
    const text=await view.locator('main').innerText();
    assert.match(text,new RegExp(po.number));assert.match(text,/\+\$6\.60 \(\+10\.0%\)/);assert.match(text,/1 EUR = 1\.21 USD/);
    assert.equal(await view.getByRole('button',{name:'Mark as seen'}).count(),2);
    assert(await view.getByRole('button',{name:'Save alert rule'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    require('node:fs').mkdirSync('output',{recursive:true});await view.screenshot({path:'output/purchase-fx-alerts-'+name+'.png',fullPage:true});
    await view.goto(base+'/purchasing/orders/'+po.id+'/receive');
    assert.match(await view.locator('main').innerText(),/Stock value is booked in USD at 1 EUR = 1\.21 USD \(Test reference rates, /);
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' receiving must not scroll sideways');
    await view.close();
  }

  // The euro falls back within 5%: the worker clears both alerts on its own.
  f.setRate(f.day(-2),'1.12');
  const back=await fx.run(db,ws);
  assert.equal(back.cleared.length,2);
  assert.deepEqual((await f.alerts()).map(a=>[a.status,a.cleared_reason]),[['CLEARED','Back within your 5% limit.'],['CLEARED','Back within your 5% limit.']]);
  assert.deepEqual(await f.needs(),[]);

  // Pro: alone as well. An email whose alerts cleared before sending is held.
  await f.subscribe('pro');
  f.setRate(f.day(-1),'1.25');
  const pro=await fx.run(db,ws);
  assert.equal(pro.opened.length,2);assert(pro.email.effectId);
  f.setRate(f.today,'1.11');
  assert.equal((await fx.run(db,ws)).cleared.length,2);
  await assert.rejects(outbound.executeSendEffect(db,ws,pro.email.effectId,{provider}),/changed before the email was sent/);
  assert.equal(sent.length,1);

  // Custom: the owner's own rate for the day comes first, for alerts and for receipts.
  await f.subscribe('enterprise');
  await fx.refreshNow(db,ctx);
  await assert.rejects(rates.saveManual(db,ctx,{currency:'USD',rate:'1',note:'Bank',confirmed:'yes'}),/other than your accounting currency/);
  await assert.rejects(rates.saveManual(db,ctx,{currency:'EUR',rate:'1.3',rateDate:f.day(1),note:'Bank',confirmed:'yes'}),/future/);
  await rates.saveManual(db,ctx,{currency:'EUR',rate:'1.3',rateDate:f.today,note:'Bank quote 4471',confirmed:'yes'});
  assert.equal(await f.audits('Exchange rate entered'),1);
  assert.deepEqual(await rates.rateOn(db,ws,'EUR','USD',f.today),{rate:'1.3',date:f.today,source:'MANUAL',reference:'Bank quote 4471',manual:true});
  const custom=await fx.run(db,ws);
  assert.equal(custom.opened.length,2);
  assert.deepEqual((await f.alerts("status='OPEN'")).map(a=>[a.rate_source,a.current_rate]),[['MANUAL','1.3'],['MANUAL','1.3']]);
  // A receipt checked against an older rate stops; at the owner's rate it books.
  const stockBefore=await f.onHand();
  await assert.rejects(f.receive(po,1,{fxRate:'1.25'}),/exchange rate changed to 1 EUR = 1\.3 USD/);
  assert.equal(await f.onHand(),stockBefore);
  const manualReceipt=await f.receive(po,1,{fxRate:'1.3'});
  assert.deepEqual([manualReceipt.lines[0].totalCostMinor,manualReceipt.lines[0].rateSource],[1300,'MANUAL']);
  // Marking an alert as seen takes it out of Needs you; removing the owner's rate restores the reference rate.
  const [, openOrder]=await f.alerts("status='OPEN'");
  await fx.dismiss(db,ctx,openOrder.id);
  assert.equal(await f.audits('Marked an exchange-rate alert as seen'),1);
  assert.deepEqual((await f.needs()).map(n=>n.sourceId),['fx-alert:'+(await f.alerts("status='OPEN'"))[0].id]);
  await rates.removeManual(db,ctx,{currency:'EUR',rateDate:f.today});
  assert.equal(await f.audits('Exchange rate removed'),1);
  assert.equal((await rates.rateOn(db,ws,'EUR','USD',f.today)).rate,'1.11');
  assert.equal((await db.query('SELECT rate FROM stockchief_runtime.agent_fx_receipt_rates WHERE workspace_id=$1 AND base_minor=1300',[ws])).rows[0].rate,'1.3','Booked receipts keep their rate');
});

test('Starter only suggests; pause, Watch only, Ask me first and shadow only watch; missing facts stop and ask',{timeout:900000},async t=>{
  const f=await setup(t,'starter'),{db,ctx,ws}=f;
  await fx.refreshNow(db,ctx);
  const po=await f.order();
  await f.receive(po,2);
  f.setRate(f.day(-3),'1.21');
  // Starter: a suggestion on the page, nothing on its own.
  assert.deepEqual(await fx.run(db,ws),{skipped:'plan'});
  assert.deepEqual(await fx.schedule(db,ws),{queued:0});
  await assert.rejects(f.rule(),/Growth/);
  await assert.rejects(fx.checkNow(db,ctx),/Growth/);
  const page=await fx.screen(db,ctx);
  assert.equal(page.starter,true);assert.equal(page.allowed,false);
  assert.match(page.suggestion.text,new RegExp(po.number+'|Imported linen'));assert.equal(Math.abs(page.suggestion.percent),10);
  assert.deepEqual(await fx.inbox(db,ws),[]);
  const review=await require('../../src/autopilot/job-reviews').run(db,ctx,'purchase-fx',{});
  assert.equal(review.mode,'suggest');assert.equal(review.rows.length,1);assert.match(review.rows[0].Suggestion,/ up \$/);
  assert.equal((await f.alerts()).length,0);
  const starterPage=await f.browser.get(fx.href);
  assert.equal(starterPage.status,200);assert.match(starterPage.text,/Suggestion/);assert.match(starterPage.text,/Growth/);assert.doesNotMatch(starterPage.text,/Save alert rule/);

  // Growth with a rule, under each stop.
  await f.subscribe('growth');await f.rule();
  await f.pilot('paused=1');
  assert.deepEqual(await fx.run(db,ws),{held:'paused'});
  await f.pilot('paused=0');
  await f.pilot("mode='OBSERVE'");
  const observed=await fx.run(db,ws);
  assert.match(observed.reason,/watch-only/);assert.equal(observed.watched.length,2);
  await f.pilot("mode='SUPERVISED'");
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,40,{mode:'ask',revision:0});
  const asked=await fx.run(db,ws);
  assert.match(asked.reason,/Ask me first/);assert.equal(asked.watched.length,2);
  assert.equal((await f.alerts()).length,0,'Watching opens no alert');
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_fx_runs WHERE workspace_id=$1 AND outcome='WATCHED'",[ws])).rows[0].n,2);
  // With Ask me first, the owner checks and the alerts open on their say.
  const checked=await fx.checkNow(db,ctx);
  assert.equal(checked.opened.length,2);assert.equal(checked.email,undefined);
  assert.equal(await f.audits('Checked exchange-rate costs'),1);
  await modes.save(db,ctx,40,{mode:'inherit',revision:1});
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  await rates.saveManual(db,ctx,{currency:'EUR',rate:'1.3',rateDate:f.today,note:'Bank',confirmed:'yes'});
  const shadow=await fx.run(db,ws);
  assert.match(shadow.reason,/first 14 days/);
  await assert.rejects(fx.checkNow(db,ctx),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  // A missing price stops and asks: back near the old rate, the alerts still stay open.
  await db.query('UPDATE purchase_order_lines SET unit_cost=NULL,line_total=NULL WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,po.id]);
  await rates.saveManual(db,ctx,{currency:'EUR',rate:'1.105',rateDate:f.today,note:'Bank',confirmed:'yes'});
  const partial=await fx.run(db,ws);
  assert.deepEqual(partial.cleared,[]);
  assert.deepEqual((await f.alerts()).map(a=>[a.subject_kind,a.status]),[['ITEM','OPEN'],['ORDER','OPEN']]);
  const reviewed=await fx.screen(db,ctx);
  assert.match(reviewed.rows.find(r=>r.id===po.id).problem,/missing prices/);
  assert.match(reviewed.items[0].problem,/price cannot be read/);

  // Stale or failed rates stop the check and leave alerts as they are.
  await db.query('DELETE FROM stockchief_runtime.agent_fx_rates WHERE workspace_id=$1',[ws]);
  f.fail(new ValidationError('ECB reference rates are unavailable.'));
  const stale=await fx.run(db,ws);
  assert.match(stale.fetched.problem,/unavailable/);assert.equal(stale.problem,'No current exchange rate is stored.');
  assert.equal((await f.alerts("status='OPEN'")).length,2);
  f.fail(null);f.setRate(f.day(1),'1.2');
  assert.match((await fx.run(db,ws)).fetched.problem,/future/);
  f.setRate(f.day(-30),'1.2');
  assert.match((await fx.run(db,ws)).fetched.problem,/more than a week old/);

  // Receiving without a rate for the day stops before anything moves.
  const other=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Swiss part',baseCode:'CHF-'+randomUUID().slice(0,6),trackingMode:'quantity'});
  const swiss=await f.order({currency:'CHF',skuId:other.skuIds[0]});
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_fx_order_estimates WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,swiss.id])).rows[0].n,0,'No rate, no estimate, and placing still works');
  await assert.rejects(f.receive(swiss,1),/No CHF to USD exchange rate is recorded/);
  assert.equal(await f.onHand(other.skuIds[0]),0);
  assert.equal((await db.query('SELECT count(*)::int n FROM purchase_order_receipts WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,swiss.id])).rows[0].n,0);
});
