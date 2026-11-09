'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
 await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const connector=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Forecast mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'forecast-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'synthetic-token'}));
 await db.query("UPDATE suppliers SET email='forecast@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const forecasts=require('../../src/purchasing/agent-supplier-forecasts'),outbound=require('../../src/connections/postgres-outbound-mail'),sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
 const preview=(supplierId='fixture-supplier')=>forecasts.preview(db,ctx,{supplierId,connectorId:connector,skuIds:f.item.skuIds,requestKey:randomUUID()}),send=(saved,extra={})=>forecasts.send(db,ctx,saved.id,{expectedFingerprint:saved.source_fingerprint,confirmed:'yes',...extra}),schedule=(saved,extra={})=>forecasts.configure(db,ctx,saved.id,{confirmed:'yes',firstSendOn:saved.snapshot.today,expectedFingerprint:saved.source_fingerprint,revision:0,...extra});
 return {...f,connector,forecasts,outbound,sent,provider,preview,send,schedule};
}
test('each supplier forecast requires the correct plan and exact approval; real scoped worker sends it once',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,roi=require('../../src/autopilot/time-saved'),before=await f.balance();
 await f.subscribe('starter');await assert.rejects(f.preview(),e=>e.code==='entitlement_required');
 await f.subscribe('growth');const saved=await f.preview();
 const repeated=await f.forecasts.preview(db,ctx,{supplierId:'fixture-supplier',connectorId:f.connector,skuIds:f.item.skuIds,requestKey:saved.request_key});assert.equal(repeated.id,saved.id);
 await assert.rejects(f.forecasts.send(db,ctx,saved.id,{expectedFingerprint:saved.source_fingerprint}),/Confirm the supplier/);
 await assert.rejects(f.send(saved,{expectedFingerprint:'changed'}),/Review this exact/);
 await assert.rejects(f.schedule(saved),e=>e.code==='entitlement_required');
 const r=await f.send(saved);assert.equal((await f.send(saved)).replayed,true);
 const mail=await f.outbound.get(db,ctx.workspaceId,'supplier',r.communicationId);
 assert.match(mail.body,/unknown — more confirmed order history/);assert.match(mail.body,/not stock available to promise/);assert.doesNotMatch(mail.body,/receiver@example|\$1\.00|1200/);
 await f.subscribe('pro');assert.equal((await roi.report(db,ctx)).rows.find(r=>r.key==='supplier-forecast').count,0);
 const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>f.provider}),kind='agent.mail.supplier_forecast.v1';
 assert.equal(await jobs.claim(db,{owner:'previous-published-worker',kinds:['provider.effect','agent.mail.quote_share.v1','agent.mail.quote_followup.v1']}),null);
 assert(handlers[kind]?.externalEffect);const completed=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'forecast-current-worker'});assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));assert.equal(f.sent.length,1);
 assert.equal(await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'forecast-current-worker'}),null);
 const report=await roi.report(db,ctx);assert.equal(report.rows.find(r=>r.key==='supplier-forecast').count,1);assert.equal(report.rows.find(r=>r.key==='supplier-forecast').minutes,null);
 assert.equal((await f.send(saved)).replayed,true);assert.equal(f.sent.length,1);assert.equal(await f.balance(),before);
 const newer=await f.preview();await assert.rejects(f.send(newer),/Another forecast already|earlier forecast delivery/);
});
test('Pro and Custom explicitly authorize weekly scopes; native evaluation queues once and honors stop',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;
 for(const plan of ['pro','enterprise']){
  await f.subscribe(plan);const supplier='forecast-'+plan;await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,email,created_at,updated_at) VALUES($1,$2,$1,'active','USD',$3,now(),now())",[supplier,ctx.workspaceId,plan+'@example.test']);
  const saved=await f.preview(supplier);await f.schedule(saved);
  const run=await require('../../src/autopilot/postgres-service').run(db,ctx);assert.equal(run.supplierForecasts.queued,1);
  assert.equal((await f.forecasts.run(db,ctx.workspaceId)).queued,0);
  const rule=(await db.query('SELECT *,next_due_on::text AS next_due_on FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,supplier])).rows[0];
  assert(rule.next_due_on>saved.snapshot.today);
  const delivery=(await db.query("SELECT e.id FROM stockchief_runtime.provider_effects e JOIN supplier_communications m ON m.id=e.aggregate_id AND m.workspace_id=e.workspace_id WHERE m.workspace_id=$1 AND m.supplier_id=$2 AND e.kind='mail.outbound.send'",[ctx.workspaceId,supplier])).rows[0];
  if(plan==='pro')await f.outbound.executeSendEffect(db,ctx.workspaceId,delivery.id,{provider:f.provider});
  else{
   await f.forecasts.configure(db,ctx,null,{stop:'yes',ruleId:rule.id,revision:rule.revision});
   await assert.rejects(f.outbound.executeSendEffect(db,ctx.workspaceId,delivery.id,{provider:f.provider}),/scope changed/);
  }
 }
 assert.equal(f.sent.length,1);
});
test('queued automatic forecasts recheck downgrade, shadow, pause, per-job mode, mailbox, product and recipient immediately before delivery',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
 const cases=[
  ['downgrade',()=>f.subscribe('growth'),()=>f.subscribe('pro')],
  ['shadow',()=>db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]),()=>db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId])],
  ['pause',()=>autopilot.pause(db,ctx,{role:'owner'},'Synthetic pause'),()=>autopilot.resume(db,ctx,{role:'owner'})],
  ['ask-mode',()=>modes.save(db,ctx,36,{mode:'ask',revision:0}),()=>modes.save(db,ctx,36,{mode:'inherit',revision:1})],
  ['mailbox',()=>db.query("UPDATE workspace_connectors SET provider_account_id='different-account' WHERE id=$1",[f.connector]),()=>db.query("UPDATE workspace_connectors SET provider_account_id='forecast-mailbox' WHERE id=$1",[f.connector])],
  ['recipient',supplier=>db.query("UPDATE suppliers SET email='changed@example.test' WHERE id=$1",[supplier]),supplier=>db.query("UPDATE suppliers SET email=$2 WHERE id=$1",[supplier,supplier+'@example.test'])],
  ['units',()=>db.query("UPDATE items SET unit_label='changed unit' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.item.itemId]),()=>db.query("UPDATE items SET unit_label='unit' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.item.itemId])]
 ];
 const originalUnit=(await db.query('SELECT unit_label FROM items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.itemId])).rows[0].unit_label;
 for(const [name,change,restore]of cases){
  const supplier='safety-'+name;await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,email,created_at,updated_at) VALUES($1,$2,$1,'active','USD',$3,now(),now())",[supplier,ctx.workspaceId,supplier+'@example.test']);
  const saved=await f.preview(supplier);await f.schedule(saved);assert.equal((await f.forecasts.run(db,ctx.workspaceId)).queued,1,name);
  const delivery=(await db.query("SELECT e.id FROM stockchief_runtime.provider_effects e JOIN supplier_communications m ON m.id=e.aggregate_id AND m.workspace_id=e.workspace_id WHERE m.workspace_id=$1 AND m.supplier_id=$2 AND e.kind='mail.outbound.send'",[ctx.workspaceId,supplier])).rows[0];
  await assert.rejects(f.outbound.executeSendEffect(db,ctx.workspaceId,delivery.id,{provider:f.provider,beforeSend:()=>change(supplier)}),undefined,name+' must stop before provider call');
  await restore(supplier);if(name==='units')await db.query('UPDATE items SET unit_label=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.itemId,originalUnit]);
 }
 assert.equal(f.sent.length,0);
});
test('ambiguous provider acceptance cannot count saved time or trigger another forecast email',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,saved=await f.preview(),r=await f.send(saved);let calls=0;
 await assert.rejects(f.outbound.executeSendEffect(db,ctx.workspaceId,r.effectId,{provider:{send:async()=>{calls++;throw Error('Synthetic connection lost after request');}}}),e=>e.code==='email_send_ambiguous');
 await assert.rejects(f.send(saved),/earlier forecast delivery/);assert.equal(calls,1);
 assert.equal((await require('../../src/autopilot/time-saved').report(db,ctx)).rows.find(r=>r.key==='supplier-forecast').count,0);
});
test('concurrent weekly supplier scopes share the Pro rule limit and a stopped scope frees its slot',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;
 await db.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by)
  SELECT $1,'sales_order.repeat','forecast-limit-'||n,'Synthetic existing rule','USD',100,$2 FROM generate_series(1,499)n`,[ctx.workspaceId,ctx.actorId]);
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,email,created_at,updated_at) VALUES('other-forecast-supplier',$1,'Other forecast supplier','active','USD','other@example.test',now(),now())",[ctx.workspaceId]);
 const reports=await Promise.all([f.preview(),f.preview('other-forecast-supplier')]),results=await Promise.allSettled(reports.map(saved=>f.schedule(saved)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/500 active rules/);
 const rules=(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1 AND enabled',[ctx.workspaceId])).rows;assert.equal(rules.length,1);
 await f.forecasts.configure(db,ctx,null,{stop:'yes',ruleId:rules[0].id,revision:rules[0].revision});
 const rejected=reports.find(saved=>saved.supplier_id!==rules[0].supplier_id);await f.schedule(rejected);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_supplier_forecast_rules WHERE workspace_id=$1 AND enabled',[ctx.workspaceId])).rows[0].n,1);
});
test('weekly forecasts prepare fresh evidence and skip missed-week backlogs instead of emailing repeatedly',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,saved=await f.preview();await f.schedule(saved);
 const deliver=async()=>{
  const r=await f.forecasts.run(db,ctx.workspaceId);assert.equal(r.queued,1);
  const effect=(await db.query("SELECT e.id FROM stockchief_runtime.provider_effects e JOIN supplier_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id WHERE e.workspace_id=$1 AND e.kind='mail.outbound.send' AND m.status='QUEUED' ORDER BY m.created_at LIMIT 1",[ctx.workspaceId])).rows[0];
  await f.outbound.executeSendEffect(db,ctx.workspaceId,effect.id,{provider:f.provider});
  assert.equal((await f.forecasts.run(db,ctx.workspaceId)).queued,0);
 };
 await deliver();t.mock.timers.enable({apis:['Date'],now:Date.now()+22*86400000});await deliver();
 assert.equal(f.sent.length,2);assert.notEqual(f.sent[0].body,f.sent[1].body);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_supplier_forecast_reports WHERE workspace_id=$1 AND communication_id IS NOT NULL',[ctx.workspaceId])).rows[0].n,2);
});
