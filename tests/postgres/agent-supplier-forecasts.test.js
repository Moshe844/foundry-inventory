'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const forecasts=require('../../src/purchasing/agent-supplier-forecasts');

// Job 36 (Starter excluded, Growth draft, Pro and Custom alone): each week the
// key suppliers the owner chose get our stock and a 12-week forecast of their
// own products, from the owner's chosen mailbox.
async function setup(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,ws=ctx.workspaceId,sku=f.item.skuIds[0],at=new Date().toISOString();
 const {addDays}=require('../../src/accounting/customer-money'),today=await require('../../src/lib/business-time').today(db,ws);
 await db.query("UPDATE suppliers SET email='forecast@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ws]);
 const other=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Bought from someone else',baseCode:'ELSE-'+randomUUID().slice(0,6),trackingMode:'quantity'});
 await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,created_at,updated_at) VALUES($1,$2,'fixture-supplier',$3,$4,$4) ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET is_active=1`,[randomUUID(),ws,sku,at]);
 for(let day=40;day>=1;day-=3){const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',orderDate:addDays(today,-day),currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1200},{skuId:other.skuIds[0],quantity:5,unitPriceMinor:900}]});
  await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});}
 const mailbox=async name=>{const id=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
   VALUES($1,$2,$1,$3,'gmail','[]','{}','connected','["MAIL_SEND"]',$4,'CONNECTED',$5,$6,now(),now())`,[id,ws,name,'connection_credentials:'+id,ctx.actorId,name.toLowerCase().replace(/\W+/g,'-')]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,id,'provider',{accessToken:'synthetic-token'}));return id;};
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}},outbound=require('../../src/connections/postgres-outbound-mail');
 const effects=async(supplierId='fixture-supplier')=>(await db.query(`SELECT e.id,e.status AS effect_status,m.status,m.recipient,m.connector_id,m.subject,m.body FROM stockchief_runtime.provider_effects e JOIN supplier_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
  WHERE e.workspace_id=$1 AND m.supplier_id=$2 AND e.kind='mail.outbound.send' ORDER BY m.created_at,m.id`,[ws,supplierId])).rows;
 const deliver=id=>outbound.executeSendEffect(db,ws,id,{provider});
 const rows=async()=>(await db.query("SELECT *,week_start::text AS week_start FROM stockchief_runtime.agent_supplier_forecast_reports WHERE workspace_id=$1 AND status IS NOT NULL ORDER BY created_at,id",[ws])).rows;
 const latest=async()=>(await rows()).at(-1);
 const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
 const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('supplier-forecasts:'));
 const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const work=()=>forecasts.run(db,ws),autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
 let base=Date.now();const week=n=>{t.mock.timers.setTime(base+n*7*86400000);};
 return {...f,ws,sku,other,today,mailbox,sent,provider,outbound,effects,deliver,rows,latest,audits,needs,older,work,autopilot,modes,week,
  enableClock:()=>{t.mock.timers.enable({apis:['Date'],now:base});}};
}

test('weekly supplier forecasts follow each plan: older terms see the card, Starter is locked, Growth prepares and the owner sends',{timeout:900000},async t=>{
 const f=await setup(t),{db,ctx,ws}=f;
 // An account on its older terms sees the shared plan card; nothing runs.
 assert.match((await f.browser.get(forecasts.href).expect(200)).text,/data-agent-plan-locked/);
 assert.deepEqual(await f.work(),{skipped:'plan'});
 await f.subscribe('starter');
 await f.browser.get(forecasts.href).expect(402);
 assert.deepEqual(await f.work(),{skipped:'plan'});
 await assert.rejects(forecasts.addKey(db,ctx,{supplierId:'fixture-supplier'}),e=>e.code==='entitlement_required');
 assert.deepEqual(await forecasts.inbox(db,ws),[]);

 // Growth, first 14 days: the owner chooses a key supplier; StockChief keeps the forecast and sends nothing.
 await f.subscribe('growth');
 let page=await f.browser.get(forecasts.href).expect(200);
 await f.browser.post(forecasts.href+'/key').type('form').send({_csrf:f.csrf(page.text),supplierId:'fixture-supplier'}).expect(303);
 assert.equal(await f.audits('Made a key supplier for weekly forecasts'),1);
 assert.deepEqual(await forecasts.addKey(db,ctx,{supplierId:'fixture-supplier'}),{unchanged:true});
 let r=await f.work();assert.equal(r.watched,1);
 let report=await f.latest();assert.equal(report.status,'WATCHED');assert.match(report.reason,/first 14 days/);
 assert.equal((await f.effects()).length,0);assert.deepEqual(await f.needs(),[]);
 await assert.rejects(forecasts.send(db,ctx,report.id,{fingerprint:report.source_fingerprint}),/first 14 days/);
 assert.equal(await f.audits('StockChief prepared a supplier forecast'),1);
 // The forecast: only this supplier's products, twelve weeks from the demand forecast, no prices or customers.
 const p=report.snapshot;assert.deepEqual(p.skuIds,[f.sku]);assert.equal(p.rows[0].weeks.length,12);assert(p.rows[0].total>0);assert(p.rows[0].method);
 const words=forecasts.words(p);assert.match(words.body,/Week 12 \(/);assert.doesNotMatch(words.body,/Receiver|receiver@example|12\.00|1200|Bought from someone else/);
 // A replay changes nothing.
 await f.work();assert.equal((await f.rows()).length,1);assert.equal(await f.audits('StockChief prepared a supplier forecast'),1);

 // After 14 days: no mailbox stops and asks; two mailboxes with no choice stop and ask.
 await f.older();
 await f.work();report=await f.latest();assert.deepEqual([report.status,report.problem],['STOPPED','mailbox']);
 assert.deepEqual((await f.needs()).map(n=>n.title),['Connect a mailbox to send supplier forecasts']);
 const main=await f.mailbox('Main mailbox');await f.mailbox('Other mailbox');
 await f.work();assert.equal((await f.latest()).problem,'mailbox_choice');
 assert.deepEqual((await f.needs()).map(n=>n.title),['Choose the mailbox for supplier forecasts']);
 page=await f.browser.get(forecasts.href).expect(200);
 await f.browser.post(forecasts.href+'/mailbox').type('form').send({_csrf:f.csrf(page.text),connectorId:main,revision:0}).expect(303);
 assert.equal(await f.audits('Chose the mailbox for supplier forecasts'),1);
 // A supplier with no email stops and asks too.
 await db.query("UPDATE suppliers SET email=NULL WHERE workspace_id=$1 AND id='fixture-supplier'",[ws]);
 await f.work();report=await f.latest();assert.equal(report.problem,'recipient');assert.match((await f.needs())[0].title,/Add an email for Fixture parts/);
 await db.query("UPDATE suppliers SET email='forecast@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ws]);
 // Growth: ready for the owner, never sent alone.
 await f.autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 r=await f.work();assert.equal(r.waiting,1);assert.equal(r.queued,0);
 report=await f.latest();assert.equal(report.status,'WAITING');assert.match(report.reason,/first forecast to forecast@example.test/);
 assert.match((await f.needs())[0].title,/1 supplier forecast is ready to send/);
 assert.equal((await f.effects()).length,0);
 // Pause holds everything, including the owner's send.
 await f.autopilot.pause(db,ctx,{role:'owner'},'Synthetic pause');
 assert.deepEqual(await f.work(),{held:'paused'});
 await assert.rejects(forecasts.send(db,ctx,report.id,{fingerprint:report.source_fingerprint}),/paused/);
 await f.autopilot.resume(db,ctx,{role:'owner'});
 // The owner presses send on the page.
 page=await f.browser.get(forecasts.href+'/'+report.id).expect(200);
 assert.match(page.text,/Read the exact email/);assert.match(page.text,/Send this forecast/);
 await assert.rejects(forecasts.send(db,ctx,report.id,{fingerprint:'changed'}),/changed after you opened it/);
 await f.browser.post(forecasts.href+'/'+report.id+'/send').type('form').send({_csrf:f.csrf(page.text),fingerprint:report.source_fingerprint}).expect(303);
 report=await f.latest();assert.equal(report.status,'QUEUED');assert.equal(report.authorization_kind,'INDIVIDUAL');assert.equal(report.connector_id,main);
 assert.equal(await f.audits('Sent a supplier forecast'),1);
 let mail=await f.effects();assert.equal(mail.length,1);assert.equal(mail[0].recipient,'forecast@example.test');assert.equal(mail[0].connector_id,main);
 await f.deliver(mail[0].id);assert.equal(f.sent.length,1);assert.match(f.sent[0].subject,/12-week forecast/);
 // One forecast per supplier and week: replays, a second send and another check send nothing more.
 assert.equal((await forecasts.send(db,ctx,report.id,{fingerprint:report.source_fingerprint})).replayed,true);
 r=await f.work();assert.equal(r.prepared,0);assert.equal((await f.effects()).length,1);assert.equal(f.sent.length,1);
 assert.deepEqual(await f.needs(),[]);
 // Growth never sends on its own: a queued automatic grant is refused at the mailbox.
 await assert.rejects(forecasts.authority(db,ws,{kind:'supplier_forecast',version:2,reportId:report.id,fingerprint:report.source_fingerprint,attempt:0,automatic:true}),e=>e.code==='entitlement_required');
 // An email queued before this change is held, not sent on old checks.
 await assert.rejects(forecasts.authority(db,ws,{kind:'supplier_forecast',recordId:report.id}),/prepared before weekly forecasts changed/);
 assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ws])).rows[0].n)>=0,true);
});

test('Pro and Custom send each week on their own after the first, and the mailbox checks again',{timeout:900000},async t=>{
 const f=await setup(t),{db,ctx,ws}=f;
 await f.subscribe('pro');await f.older();await f.autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const box=await f.mailbox('Owner mailbox');await forecasts.addKey(db,ctx,{supplierId:'fixture-supplier'});
 f.enableClock();
 // The first forecast to a supplier's address needs a person.
 let r=await f.work();assert.equal(r.waiting,1);let report=await f.latest();assert.match(report.reason,/first forecast/);
 await forecasts.send(db,ctx,report.id,{fingerprint:report.source_fingerprint});await f.deliver((await f.effects())[0].id);assert.equal(f.sent.length,1);
 // Next week StockChief sends on its own, once.
 f.week(1);r=await f.work();assert.equal(r.queued,1);report=await f.latest();assert.equal(report.status,'QUEUED');assert.equal(report.authorization_kind,'AUTOMATIC');
 assert.equal(await f.audits('StockChief sent a supplier forecast'),1);
 assert.equal((await f.work()).queued,0);
 let mail=await f.effects();assert.equal(mail.length,2);assert.equal(mail[1].connector_id,box);await f.deliver(mail[1].id);assert.equal(f.sent.length,2);
 assert.notEqual(f.sent[0].subject,f.sent[1].subject,'A new week, a new forecast');
 // Ask me first: ready for the owner. Watch only: kept, nothing sent.
 f.week(2);await f.modes.save(db,ctx,36,{mode:'ask',revision:0});
 r=await f.work();assert.equal(r.waiting,1);assert.match((await f.latest()).reason,/Ask me first/);
 await f.modes.save(db,ctx,36,{mode:'watch',revision:1});
 r=await f.work();assert.equal(r.watched,1);report=await f.latest();
 await assert.rejects(forecasts.send(db,ctx,report.id,{fingerprint:report.source_fingerprint}),/Watch only/);
 await f.modes.save(db,ctx,36,{mode:'inherit',revision:2});
 r=await f.work();assert.equal(r.queued,1);
 // Checked again at the mailbox: a changed supplier email, a stopped key supplier and a downgrade each stop the send.
 mail=await f.effects();const queued=mail.at(-1);
 await assert.rejects(f.outbound.executeSendEffect(db,ws,queued.id,{provider:f.provider,beforeSend:()=>db.query("UPDATE suppliers SET email='changed@example.test' WHERE id='fixture-supplier'")}),/email changed/);
 assert.equal(f.sent.length,2);
 await db.query("UPDATE suppliers SET email='forecast@example.test' WHERE id='fixture-supplier'");
 f.week(3);r=await f.work();assert.equal(r.queued,1);
 const rule=(await db.query("SELECT * FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1",[ws])).rows[0];
 await forecasts.removeKey(db,ctx,{ruleId:rule.id,revision:rule.revision});assert.equal(await f.audits('Stopped weekly forecasts to a supplier'),1);
 await assert.rejects(f.deliver((await f.effects()).at(-1).id),/no longer a key supplier/);
 assert.deepEqual(await f.work(),{prepared:0,queued:0,waiting:0,stopped:0,watched:0},'A stopped key supplier gets nothing more');
 await forecasts.addKey(db,ctx,{supplierId:'fixture-supplier'});
 f.week(4);r=await f.work();assert.equal(r.queued,1);
 await f.subscribe('growth');await assert.rejects(f.deliver((await f.effects()).at(-1).id),e=>e.code==='entitlement_required');
 assert.equal(f.sent.length,2);
 // Custom sends on its own too.
 await f.subscribe('enterprise');f.week(5);r=await f.work();assert.equal(r.queued,1);await f.deliver((await f.effects()).at(-1).id);assert.equal(f.sent.length,3);
 // A definite delivery failure can be sent again by the owner; an uncertain one cannot.
 f.week(6);await f.work();report=await f.latest();
 await assert.rejects(f.outbound.executeSendEffect(db,ws,(await f.effects()).at(-1).id,{provider:{send:async()=>{throw Error('Synthetic connection lost after request');}}}),e=>e.code==='email_send_ambiguous');
 await assert.rejects(forecasts.send(db,ctx,report.id,{fingerprint:report.source_fingerprint}),/cannot tell whether the last email/);
 assert.equal(f.sent.length,3);
 // Each weekly forecast is its own record; only sent ones count as saved time.
 t.mock.timers.reset();assert.equal((await f.rows()).length,7);
 // The later weeks were sent under a simulated clock; bring their send times into the report's last seven days.
 await db.query("UPDATE supplier_communications SET sent_at=$2 WHERE workspace_id=$1 AND status='SENT'",[ws,new Date().toISOString()]);
 const roi=(await require('../../src/autopilot/time-saved').report(db,ctx)).rows.find(x=>x.key==='supplier-forecast');assert.equal(roi.count,3);
 // Key suppliers count against the plan's rule allowance.
 await db.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by)
  SELECT $1,'sales_order.repeat','forecast-limit-'||n,'Synthetic existing rule','USD',100,$2 FROM generate_series(1,499)n`,[ws,ctx.actorId]);
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,email,created_at,updated_at) VALUES('second-supplier',$1,'Second supplier','active','USD','second@example.test',now(),now())",[ws]);
 await f.subscribe('pro');await assert.rejects(forecasts.addKey(db,ctx,{supplierId:'second-supplier'}),/500 active rules/);
});
