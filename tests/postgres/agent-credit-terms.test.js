'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
test('fixed credits cover multi-call questions, file mapping and reports with a depleted customer balance',{timeout:180000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async()=>{await db.close();await cluster.stop();});
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Credit terms',email:randomUUID()+'@example.test',password:'Demo!'+randomUUID()});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},scope={...ctx,accountId:owner.accountId};
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,'starter','agent-v3:starter','ACTIVE')",[randomUUID(),scope.accountId]);
  const ent=require('../../src/commercial/entitlements'),model=require('../../src/commercial/model');
  const provider={name:'anthropic',model:PRICED_MODEL,complete:async()=>({data:{ok:true},usage:pricedUsage()})};
  const request={schemaName:'stockchief_answer',schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},system:'Read only',prompt:'Confirmed?',maxOutputTokens:100};
  await model.wrap(db,ctx,provider,'ask','question').complete(request);
  await model.wrap(db,ctx,provider,'ask','verified-answer',{chargeCustomer:false,fundingKey:'question'}).complete(request);
  assert.equal((await ent.meterState(db,scope,'ai_work_credits')).used,20);
  await model.wrap(db,ctx,provider,'import_mapping','document').complete(request);
  assert.equal((await ent.meterState(db,scope,'ai_work_credits')).used,120);
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'ai_work_credits',120,'Test an exhausted balance')",[randomUUID(),scope.accountId]);
  const assistant=require('../../src/assistant/postgres-service');
  const report=await assistant.buildReportDefinition(db,ctx,'Build a monthly line-chart report of inventory movement by date',{provider:{...provider,complete:async input=>{
    if(input.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
    assert.equal(input.schemaName,'stockchief_governed_report');
    return {data:{dataset:'movements',title:'Monthly movement',dateGrain:'month',columns:[],groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',filters:[],sort:'occurred_on',direction:'asc',chart:'line'},usage:pricedUsage()};
  }}});
  assert.ok(report.reportConfig,report.answer);assert.equal(report.creditsUsed,0);
  assert.equal((await ent.meterState(db,scope,'ai_work_credits')).used,120);
  assert.ok((await db.query("SELECT 1 FROM commercial_model_cost_holds WHERE workspace_id=$1 AND detail->>'includedReport'='true' AND status='SETTLED'",[ctx.workspaceId])).rowCount);
});
test('shared mailbox triage and sender-scoped unsent replies obey all four agent plans',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:9}),{db,ctx,browser,subscribe}=f;
  const mail=require('../../src/connections/postgres-mail'),draft=require('../../src/connections/postgres-reply-drafting');
  const preparation=require('../../src/connections/postgres-mail-preparation'),runtime=require('../../src/operations/postgres-runtime-handlers');
  const reviews=require('../../src/autopilot/job-reviews'),{PRICED_MODEL,pricedUsage}=require('../helpers/postgres-model-fixture');
  await subscribe('growth');await f.parcel({quantity:2});
  const now=new Date().toISOString(),connections=[];
  for(const provider of ['gmail','microsoft365']){
    const id='test-'+provider;
    connections.push((await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,
      expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at) VALUES($1,$2,$1,$3,$3,'[]','{}','connected','[]',5,'CONNECTED',$4,$5,$5) RETURNING *`,
      [id,ctx.workspaceId,provider,ctx.actorId,now])).rows[0]);
  }
  await db.query("UPDATE suppliers SET email='parts@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  const examples=[
    [0,'order','receiver@example.test','New order','We would like to order five more units.'],
    [1,'invoice','parts@example.test','Invoice 876','Invoice for the stock delivered last week.'],
    [0,'question','receiver@example.test','Stock and delivery','How many are available?'],
    [1,'bulk','newsletter@example.test','News','You can unsubscribe from this mailing list.'],
    [1,'review','someone@example.test','Introduction','Hello team.']
  ];
  const messages={};for(const [index,category,sender,subject,bodyText] of examples){
    const msg={externalMessageId:'triage-'+category,sender,subject,bodyText,receivedAt:now};
    const one=await mail.capture(db,connections[index],msg);assert.equal((await mail.capture(db,connections[index],msg)).replayed,true);
    messages[category]=one.messageId||one.id;
  }
  const question=messages.question;
  let calls=0;
  const ai={name:'anthropic',model:PRICED_MODEL,async complete(input){
    calls++;assert.match(input.prompt,/7 available after existing commitments/);assert.doesNotMatch(input.prompt,/Our purchase order/);
    return {data:{subject:'Re: Stock and delivery',body:'There are 7 available after existing commitments.'},usage:pricedUsage()};
  }};
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const benefit=await require('../../src/commercial/entitlements').capabilityState(db,{accountId:f.owner.accountId,workspaceId:ctx.workspaceId},'communications.ai_drafts');
    assert.equal(benefit.enabled,tier!=='starter',tier+' mailbox drafting entitlement');
    if(tier==='starter'){
      await browser.get('/autopilot/reviews/shared-inbox-triage').expect(402);
      await assert.rejects(draft.prepare(db,ctx,question,{provider:ai}),/Growth/);
      await assert.rejects(preparation.configure(db,ctx,connections[0].id,true),/Growth/);assert.equal(calls,0);continue;
    }
    const result=await reviews.run(db,ctx,'shared-inbox-triage');
    assert.deepEqual(new Set(result.rows.map(r=>r.Category)),new Set(['Order','Invoice','Question','Bulk or automated','Review sender']));
    assert.deepEqual((await reviews.run(db,ctx,'shared-inbox-triage',{filter:'Invoice'})).rows.map(r=>r.Mailbox),['microsoft365']);
    assert.equal((await browser.get('/autopilot/reviews/shared-inbox-triage').query({filter:'question'}).expect(200)).text.includes('/mail/'+question),true);
    if(tier==='enterprise'){
      await assert.rejects(draft.prepare(db,ctx,question,{provider:ai,key:'unfunded-custom'}),/AI Work Credits/);
      assert.equal(calls,2);
      await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'ai_work_credits',500,'Fixture Custom contract monthly credit allowance')",[randomUUID(),f.owner.accountId]);
    }
    await draft.prepare(db,ctx,question,{provider:ai,key:'approved-mail-review-'+tier});
    const stored=await mail.get(db,ctx.workspaceId,question);assert.match(stored.draft_body,/7 available/);assert.equal(stored.reply_sent_at,null);
  }
  assert.equal(calls,3);await preparation.configure(db,ctx,connections[0].id,true);
  await db.query("UPDATE suppliers SET email='receiver@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  assert.deepEqual(await draft.factsFor(db,ctx.workspaceId,{sender:'receiver@example.test'}),[]);
  await subscribe('starter');const queued=await runtime.mailReplyDraft({workspaceId:ctx.workspaceId,payload:{messageId:question,actorId:ctx.actorId}},db,{aiProvider:ai});
  assert.equal(queued.skipped,'draft_capability_unavailable');assert.equal(calls,3);
  await assert.rejects(draft.savePrepared(db,ctx,question,{subject:'Changed',body:'New content'}),/Growth/);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.email_reply_outbox WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});
