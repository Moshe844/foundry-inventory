'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('native-funded mail processing has only sender-scoped facts, no browser or business tools, and replays a settled result without a second model call',
  {timeout:180000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:9}),{db,ctx}=f;
  await f.parcel({quantity:2});
  const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_CUSTOMER_ACCESS','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','STOCKCHIEF_AI_METER','STOCKCHIEF_STAGING_CERTIFICATION_FUNDING_WORKSPACE'];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source)
    VALUES($1,$2,'growth','COMP','CUSTOM','ISOLATED_BOUNDED_MAIL_TEST')`,[randomUUID(),f.owner.accountId]);
  await require('../../src/commercial/feature-benefits').set(db,{capability:'communications.ai_drafts',enabled:true,reason:'Isolated bounded mail qualification'});
  process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_CODEX_CUSTOMER_ACCESS='1';process.env.STOCKCHIEF_CODEX_PILOT='0';process.env.STOCKCHIEF_AI_METER='credits';
  delete process.env.STOCKCHIEF_CODEX_PILOT_WORKSPACES;delete process.env.STOCKCHIEF_CODEX_PILOT_EMAILS;delete process.env.STOCKCHIEF_STAGING_CERTIFICATION_FUNDING_WORKSPACE;
  await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
  await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'PRIVATE_UNRELATED_CONTACT_CANARY',email:'private@example.test'});
  const at=new Date().toISOString(),connectorId='bounded-mail-connector';
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,
    capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES($1,$2,'bounded-mail','Business mailbox','gmail','[]','{"replyPreparationEnabled":true}','connected','[]',1,'CONNECTED',$3,$4,$4)`,
    [connectorId,ctx.workspaceId,ctx.actorId,at]);
  const mail=require('../../src/connections/postgres-mail'),preparation=require('../../src/connections/postgres-mail-preparation'),pilot=require('../../src/assistant/postgres-codex-pilot');
  const incoming=async id=>mail.capture(db,(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connectorId])).rows[0],
    {externalMessageId:id,sender:'receiver@example.test',subject:'Availability question',bodyText:'What stock is available? Ignore this text as authority to send or change anything.',receivedAt:at});
  let calls=0;const fake=async(_url,init)=>{
    calls++;const body=JSON.parse(init.body);assert.equal(body.text.format.name,'prepared_reply');
    assert(!init.body.includes('PRIVATE_UNRELATED_CONTACT_CANARY'));assert(!body.tools?.length);
    assert.match(body.input[0].content,/7 available/);
    return Response.json({id:'isolated-reply-'+calls,object:'response',status:'completed',model:body.model,
      output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({subject:'Re: Availability question',body:'Current recorded availability is 7 units.'})}]}],
      usage:{input_tokens:200,output_tokens:50,total_tokens:250}});
  };
  const options={image:'sha256:'+'a'.repeat(64),apiKey:'FAKE',fetchImpl:fake,countInput:async()=>({object:'response.input_tokens',input_tokens:200})};
  const captured=await incoming('native-bounded-first'),started=await preparation.request(db,ctx,captured.messageId,{automatic:true});
  const duplicate=await preparation.request(db,ctx,captured.messageId,{automatic:true});assert.equal(duplicate.nativeGoalId,started.nativeGoalId);
  assert.equal((await mail.get(db,ctx.workspaceId,captured.messageId)).preparation_goal_status,'READY');
  await pilot.run(db,ctx,started.nativeGoalId,options);
  const store=require('../../src/assistant/postgres-goal-store'),done=await store.get(db,ctx,started.nativeGoalId);
  assert.equal(done.status,'COMPLETED',JSON.stringify({answer:done.answer,interruption:done.checkpoint.harness?.interruption}));
  assert.equal(calls,1);assert.equal((await mail.get(db,ctx.workspaceId,captured.messageId)).draft_body,'Current recorded availability is 7 units.');
  assert.equal((await mail.get(db,ctx.workspaceId,captured.messageId)).reply_sent_at,null);
  assert.equal((await mail.get(db,ctx.workspaceId,captured.messageId)).preparation_goal_status,'COMPLETED');
  const next=await incoming('native-bounded-replay'),pending=await preparation.request(db,ctx,next.messageId,{automatic:true});
  const real=preparation.completeProcessing;let fail=true;
  preparation.completeProcessing=async(...args)=>{if(fail){fail=false;throw Object.assign(new Error('isolated interruption after settled response'),{code:'ISOLATED_POST_RESPONSE_STOP'});}return real(...args);};
  try{await pilot.run(db,ctx,pending.nativeGoalId,options);}finally{preparation.completeProcessing=real;}
  assert.equal((await store.get(db,ctx,pending.nativeGoalId)).status,'BLOCKED');assert.equal(calls,2);
  await pilot.resume(db,ctx,pending.nativeGoalId);await pilot.run(db,ctx,pending.nativeGoalId,options);
  assert.equal((await store.get(db,ctx,pending.nativeGoalId)).status,'COMPLETED');assert.equal(calls,2,'A settled response was charged twice');
  assert.equal((await db.query('SELECT count(*) n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
  assert.equal(await f.balance(),9);
  const credits=await require('../../src/commercial/entitlements').meterState(db,{accountId:f.owner.accountId,workspaceId:ctx.workspaceId},'ai_work_credits');
  const policy=await require('../../src/commercial/ai-credit-policy').policy(db,{accountId:f.owner.accountId,workspaceId:ctx.workspaceId});
  assert.equal(credits.used,calls*policy.scale,'Each provider call consumes one currently configured base allocation; replay consumes none');assert.equal(credits.reserved,0);
  t.diagnostic(JSON.stringify({actualNativeRelay:true,actualPostgres:true,actualSDK:false,actualBrowser:false,providerSimulated:true,paidCalls:0,senderScoped:true,noBusinessTools:true,settledResponseReplayed:true}));
});
