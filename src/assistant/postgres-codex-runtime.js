'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const store=require('./postgres-goal-store'),pilot=require('./postgres-codex-pilot');
const base='../../scripts/environment-agent-demo/';
async function run(database,ctx,id,options={}){
 if((options.fetchImpl||options.countInput||options.apiKey)&&!(process.env.NODE_ENV==='test'&&options.apiKey==='FAKE'&&options.fetchImpl&&options.countInput))
  throw Error('TEST_TRANSPORT_REQUIRES_FAKE_CREDENTIALS');
 await pilot.access(database,ctx,{enabled:true});
 await require(base+'waits').recover(database,ctx,id);
 const goal=await store.claim(database,ctx,id);if(!goal)return store.get(database,ctx,id);
 const cleanup=[],directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-staging-'));
 cleanup.push(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let session;
 let auditQueue=Promise.resolve();
 const audit=event=>{
  // The customer timeline stores activity, not raw prompts, tokens or fields.
  const detail={kind:event.kind,tool:event.name||event.tool||null,action:event.action||null,status:event.status||null,
   code:event.code||event.reason||null};
  auditQueue=auditQueue.then(()=>database.transaction(async client=>{
   await client.query('SELECT id FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE',[ctx.workspaceId,ctx.actorId,id]);
   await client.query(`INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail)
    SELECT $1,$2,COALESCE(max(sequence),0)+1,'agent_activity',$3::jsonb FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$2`,
    [require('../lib/util').newId('goalevent'),id,JSON.stringify(detail)]);
  },{isolation:'SERIALIZABLE',retrySafe:true}));
  auditQueue.catch(()=>{});
 };
 try{
  const budget=require('./postgres-codex-budget').createBudget(database,ctx,id);
  audit({kind:'runtime_starting',status:'Checking model pricing and permissions'});
  await require('./codex-staging-readiness').verifyPricing(database);
  const image=options.image||process.env.STOCKCHIEF_CODEX_PILOT_IMAGE;
  const permit=await require('./codex-staging-permit').issue({database,ctx,goalId:id,budget,image});
  let helper;
  const provider=require('../commercial/relay-provider').register({name:'openai',model:require(base+'codex-wire').MODEL,
   complete:request=>{if(!helper)throw Error('GOVERNED_HELPER_NOT_READY');return helper.complete(request);}});
  const gateway=require(base+'gateway').createGateway({database,ctx:{...ctx,goalRunToken:goal.run_token},goal:goal.original_request,goalId:id,
   runToken:goal.run_token,provider,rawProvider:provider,audit});
  const authorize=async settings=>{await pilot.access(database,ctx,{enabled:true});return gateway.authorize(settings);};
  session=require(base+'session').createSession({database,ctx,goalId:id,runToken:goal.run_token,candidate:'codex',authorize});
  // Publish is durable in the shared goal outbox. There is no file-review loop
  // and no test operator; the authenticated website owns the human stage.
  const pending=await session.handoffApprovals();if(pending)return pending;
  const key=options.apiKey||process.env.OPENAI_API_KEY;if(!key)throw Error('OPENAI_API_KEY_REQUIRED');
  const fundingKey=`codex-staging:${id}`;
  const entitlements=require('../commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
  const units=Number((await database.query("SELECT units FROM commercial_operation_policies WHERE operation='ask'")).rows[0].units);
  await entitlements.reserveUsage(database,scope,{meter:'ai_work_credits',units,idempotencyKey:`${ctx.workspaceId}:${fundingKey}`,detail:{operation:'ask',runtime:'codex-sdk-staging'}});
  const counter=options.countInput||require(base+'codex-token-counter').createTokenCounter({apiKey:key});
  const relay=await require(base+'relay').createRelay({budget,credentials:{openai:key},commercial:require(base+'commercial').createCommercialAccounting(database),
   allowedProviders:['openai'],countCodexInput:counter,audit,...(options.fetchImpl?{fetchImpl:options.fetchImpl}:{})});cleanup.push(()=>relay.close());
  const transport=relay.grant({candidate:'codex',provider:'openai',task:id,ctx,goalId:id,budget,fundingKey,authorize:()=>authorize({catalogue:false}),
   wireProfile:'codex',livePermit:permit,requestGate:()=>session.codexRequest()});
  const helperTransport=relay.grant({candidate:'codex',provider:'openai',task:id,ctx,goalId:id,budget,fundingKey,authorize:()=>authorize({catalogue:false}),
   wireProfile:'codex',livePermit:permit,requestGate:()=>session.codexRequest()});
  helperTransport.setNativeSession(session.helperDelivery());
  helper=require(base+'codex-helper-provider').create({transport:helperTransport});
  // Both resources are brand-new and goal-local. Prepare the credential-free
  // sandbox concurrently with the restricted renderer, never reuse a browser
  // or another goal's files. Join cleanup even if either initialization fails.
  const preparedSandbox=options.sandboxPool?options.sandboxPool.take(image):require(base+'codex-runtime').prepareSandbox(image);
  preparedSandbox.catch(()=>{});
  cleanup.push(async()=>{const prepared=await preparedSandbox.catch(()=>null);if(prepared)await prepared.sandbox.close();});
  const ui=require(base+'lazy-browser').lazyBrowser(async()=>{
   audit({kind:'runtime_starting',status:'Opening the isolated business browser'});
   const connectionString=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
   const token=await pilot.readAuthorization(database,ctx,connectionString);
   const server=await require(base+'inspection').createInspectionServer({cluster:{connectionString},database,ctx,stagingAuthorization:token});cleanup.push(()=>server.close());
   const browser=await require('playwright').chromium.launch({headless:true});cleanup.push(()=>browser.close());
   const tools=await require(base+'browser').createBrowserTools(browser,{origin:server.origin,audit,startPath:goal.checkpoint.page?.path});cleanup.push(()=>tools.close());
   return tools;
  });
  audit({kind:'runtime_starting',status:'Starting the Codex SDK session'});
  const result=await require(base+'worker').run({candidate:'codex',session,gateway:{...gateway,authorize},browser:ui,budget,transport,
   preparedCodexSandbox:await preparedSandbox,
   credentials:{openai:key},codexLivePermit:permit,codexImage:image,privateHarnessDirectory:directory,audit,
   finalReportInstructions:require('./postgres-codex-verification').instructions});
  const current=await store.get(database,ctx,id);
  if(current.status==='RUNNING'){
   const check=await require('./postgres-codex-verification').verify(database,ctx,current,result.answer,(await gateway.authorize()).catalogue);
   await session.finish(check);
  }
  return store.get(database,ctx,id);
 }catch(error){
  audit({kind:'runtime_failed',code:error.code||'STAGING_RUNTIME_STOPPED'});
  if(session){const ready=await session.handoffApprovals().catch(()=>null);if(ready)return ready;
   return session.stop({code:error.code||error.message||'STAGING_RUNTIME_STOPPED'});}
  await database.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',run_token=NULL,lease_until=NULL,
   answer=$5,updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND run_token=$4`,[ctx.workspaceId,ctx.actorId,id,goal.run_token,
    error.code==='STAGING_MODEL_PRICE_UNVERIFIED'?error.message:'The Staging runtime could not start. No business operation was executed.']);
  throw error;
 }finally{await auditQueue.catch(()=>{});for(const close of cleanup.reverse())await close();}
}
module.exports={run};
