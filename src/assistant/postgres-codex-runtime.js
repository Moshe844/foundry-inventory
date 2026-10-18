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
 const cleanup=[],preparations=[],directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-codex-staging-'));
 cleanup.push(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let session;
 let auditQueue=Promise.resolve(),auditTimer=null;
 const pendingActivity=[];
 function flushActivity(){
  clearTimeout(auditTimer);auditTimer=null;
  if(!pendingActivity.length)return auditQueue;
  const batch=pendingActivity.splice(0);
  // Progress is an outbox, not an execution checkpoint. Append a burst under
  // one goal lock so observations cannot queue dozens of competing locks in
  // front of native checkpoints, approval handoff or final verification.
  auditQueue=auditQueue.catch(()=>{}).then(()=>database.transaction(async client=>{
   await client.query('SELECT id FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE',[ctx.workspaceId,ctx.actorId,id]);
   await client.query(`INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail)
    SELECT entry->>'id',$1,base.sequence+ordinality,'agent_activity',entry->'detail'
    FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS entries(entry,ordinality)
    CROSS JOIN (SELECT COALESCE(max(sequence),0) AS sequence FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1) base`,
    [id,JSON.stringify(batch)]);
  },{isolation:'SERIALIZABLE',retrySafe:true}));
  auditQueue.catch(()=>{});return auditQueue;
 }
 const audit=event=>{
  if(['context_preparation_timing','browser_preparation_timing'].includes(event.kind)){
   if(process.env.STOCKCHIEF_CODEX_TIMING==='1')console.log(JSON.stringify({kind:event.kind,goalId:id,phase:event.phase,ms:event.ms}));
   return;
  }
  // Native SDK events are retained in its durable journal. These two event
  // kinds previously wrote empty UI records and locked the goal on every SDK
  // acknowledgement/checkpoint, competing with actual session work.
  if(['codex_event','codex_resources'].includes(event.kind))return;
  // The customer timeline stores activity, not raw prompts, tokens or fields.
  const detail={kind:event.source==='host_initial_observation'?event.kind.replace('agent_tool_','initial_page_'):event.kind,
   tool:event.name||event.tool||null,action:event.action||null,status:event.status||null,
   code:event.code||event.reason||null,
   limitKind:typeof event.limitKind==='string'&&/^[a-z_]{1,80}$/.test(event.limitKind)?event.limitKind:null};
  if(event.timings)detail.timings=Object.fromEntries(Object.entries(event.timings).filter(([key,value])=>
   ['admissionMs','tokenPreflightMs','providerMs','commercialSettlementMs','nativeCheckpointMs','finalVerificationMs'].includes(key)&&Number.isFinite(value)&&value>=0));
  pendingActivity.push({id:require('../lib/util').newId('goalevent'),detail});
  if(pendingActivity.length>=32)flushActivity();
  else if(!auditTimer)auditTimer=setTimeout(flushActivity,25);
 };
 try{
  const budget=require('./postgres-codex-budget').createBudget(database,ctx,id);
  const routing=require('./codex-model-routing');ctx=await routing.context(database,ctx);
  let modelProfile=routing.selected(goal,ctx);
  audit({kind:'runtime_starting',status:'Checking model pricing and permissions'});
  const image=options.image||process.env.STOCKCHIEF_CODEX_PILOT_IMAGE;
  let helper;
  const provider=require('../commercial/relay-provider').register({name:'openai',get model(){return modelProfile.verificationProfile?
   require(base+'codex-models').getProfile(modelProfile.verificationProfile).model:modelProfile.model;},
   complete:request=>{if(!helper)throw Error('GOVERNED_HELPER_NOT_READY');return helper.complete(request);}});
  const gateway=require(base+'gateway').createGateway({database,ctx:{...ctx,goalRunToken:goal.run_token},goal:goal.original_request,goalId:id,
   runToken:goal.run_token,provider,rawProvider:provider,audit,accessGuard:async()=>{await require('../connections/postgres-document-review').authorize(database,ctx,goal.checkpoint.sourceAutomation);return pilot.access(database,ctx,{enabled:true});}});
  const authorize=settings=>gateway.authorize(settings);
  session=require(base+'session').createSession({database,ctx,goalId:id,runToken:goal.run_token,candidate:'codex',authorize});
  // Publish is durable in the shared goal outbox. There is no file-review loop
  // and no test operator; the authenticated website owns the human stage.
  const pending=await session.handoffApprovals();if(pending)return pending;
  const ui=require(base+'lazy-browser').lazyBrowser(async firstAction=>{
   audit({kind:'runtime_starting',status:'Opening the isolated business browser'});
   const connectionString=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
   let server,phaseStarted=Date.now();
   if(options.inspectionPool){
    const lease=await options.inspectionPool.acquire({database,ctx,connectionString});
    server=lease.server;cleanup.push(()=>lease.release());
   }else{
    const token=await pilot.readAuthorization(database,ctx,connectionString);
    server=await require(base+'inspection').createInspectionServer({cluster:{connectionString},database,ctx,stagingAuthorization:token});cleanup.push(()=>server.close());
   }
   audit({kind:'browser_preparation_timing',phase:'renderer_acquire',ms:Date.now()-phaseStarted});phaseStarted=Date.now();
   const browser=await require('playwright').chromium.launch({headless:true});cleanup.push(()=>browser.close());
   audit({kind:'browser_preparation_timing',phase:'chromium_launch',ms:Date.now()-phaseStarted});phaseStarted=Date.now();
   const observedPaths=goal.checkpoint.conversation?.environment?.pages?.map(p=>p.path)||[];
   const openedPath=firstAction?.action==='open'?require('./agent-navigation-path').localPath(firstAction.value):null;
   let resumedPath=null;
   if(goal.checkpoint.harness?.native?.codex?.threadId&&goal.checkpoint.harness.native.browserUrl){
    const previous=new URL(goal.checkpoint.harness.native.browserUrl);
    if(previous.protocol!=='http:'||previous.hostname!=='127.0.0.1')throw Error('INVALID_RECORDED_BROWSER_ORIGIN');
    resumedPath=require('./agent-navigation-path').localPath(previous.pathname+previous.search);
   }
   const tools=await require(base+'browser').createBrowserTools(browser,{origin:server.origin,audit,
    startPath:openedPath&&observedPaths.includes(openedPath)?openedPath:resumedPath||goal.checkpoint.page?.path||observedPaths[0],observedPaths});cleanup.push(()=>tools.close());
   // Durable canonical record links are navigation knowledge across restarts,
   // never current facts or execution grants. The restricted app rechecks
   // tenant membership and permissions on each destination GET.
   require(base+'read-navigation').restoreReadLinks(tools,goal.checkpoint.harness?.evidence);
   audit({kind:'browser_preparation_timing',phase:'current_page_load',ms:Date.now()-phaseStarted});
   return tools;
  });
  // A settled, natively completed turn has already done its reasoning. Host
  // delivery is a separate durable stage: recheck the exact saved final with
  // CURRENT authority, canonical receipts and fresh records/browser evidence.
  // No credential, token count, spending hold or new SDK turn is needed here.
  let savedFinal=require(base+'codex-runtime').savedFinal(goal.checkpoint.harness,{profile:modelProfile,messages:goal.checkpoint.messages||[]});
  let verificationSourceHash=null;
  if(savedFinal){
   verificationSourceHash=await require(base+'source-hash-worker').sourceHash();
   const rejected=goal.checkpoint.harness.verificationFailure;
   // A settled native message is not a reusable VERIFIED result when this
   // same host release already rejected that exact message. On an explicit
   // Continue, resume the actual SDK with typed diagnostic feedback. A changed
   // verifier release can first recheck the saved message without paid work.
   if(rejected?.nativeDigest===goal.checkpoint.harness.native?.codex?.digest&&rejected.sourceHash===verificationSourceHash)savedFinal=null;
  }
  if(savedFinal){
   audit({kind:'saved_native_result_verifying'});
   const checked=await session.finish(async(client,{goal,access})=>({...await require('./postgres-codex-verification').verify(client,ctx,goal,savedFinal,access.catalogue,{browser:ui}),verificationSourceHash}),{allowReportCorrection:true});
   if(!checked?.needsCorrection)return store.get(database,ctx,id);
   audit({kind:'native_report_correction',code:checked.code});
  }
  const key=options.apiKey||process.env.OPENAI_API_KEY;if(!key)throw Error('OPENAI_API_KEY_REQUIRED');
  const counter=options.countInput||require(base+'codex-token-counter').createTokenCounter({apiKey:key});
  // Warm only a session that actually needs reasoning. Every paid request
  // still receives exact native preflight and every unchanged spending hold.
  if(!options.countInput){const warm=counter({model:modelProfile.model,reasoning:{effort:modelProfile.effort},
   input:[{role:'user',content:'Connection readiness check only; no model generation.'}]}).catch(()=>null);preparations.push(warm);}
  let preparedSandbox=options.sandboxPool?options.sandboxPool.take(image):require(base+'codex-runtime').prepareSandbox(image);
  const initialSandbox=preparedSandbox;preparations.push(preparedSandbox);preparedSandbox.catch(()=>{});
  cleanup.push(async()=>{const prepared=await initialSandbox.catch(()=>null);if(prepared)await prepared.sandbox.close();});
  // Prepare the browser only when the user actually supplied page context.
  // Otherwise the native agent can choose records without opening Chromium.
  if(goal.checkpoint.page?.path&&!goal.checkpoint.harness?.native?.codex?.threadId){
   const initialBrowser=ui.prepare();preparations.push(initialBrowser);initialBrowser.catch(()=>{});
  }
  let preparedContext=require(base+'codex-runtime').prepareContext({session,browser:ui,gateway,audit});
  preparations.push(preparedContext);preparedContext.catch(()=>{});
  const fundingKey=`codex-staging:${id}`;
  const entitlements=require('../commercial/entitlements');
  // These fresh admission reads are independent. Join all of them before
  // reserving usage or exposing transport to the SDK; no check is skipped.
  const [,permit,scope,policy]=await Promise.all([
   require('./codex-staging-readiness').verifyPricing(database,modelProfile),
   require('./codex-staging-permit').issue({database,ctx,goalId:id,budget,image}),
   entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),
   database.query("SELECT units FROM commercial_operation_policies WHERE operation='ask'")]);
  const units=Number(policy.rows[0].units);
  await entitlements.reserveUsage(database,scope,{meter:'ai_work_credits',units,idempotencyKey:`${ctx.workspaceId}:${fundingKey}`,detail:{operation:'ask',runtime:'codex-sdk-staging'}});
  const relay=await require(base+'relay').createRelay({budget,credentials:{openai:key},commercial:require(base+'commercial').createCommercialAccounting(database),
   allowedProviders:['openai'],countCodexInput:counter,audit,...(options.fetchImpl?{fetchImpl:options.fetchImpl}:{})});cleanup.push(()=>relay.close());
  let result;
  while(true){
  const modelPolicy=require(base+'codex-wire').forProfile(modelProfile.id);
  // Exploration may use a cheaper profile. Canonical semantic helpers retain
  // the previously configured verification strength and their own exact rates.
  const helperPolicy=modelProfile.verificationProfile?require(base+'codex-wire').forProfile(modelProfile.verificationProfile):modelPolicy;
  if(helperPolicy!==modelPolicy)await require('./codex-staging-readiness').verifyPricing(database,helperPolicy.PROFILE);
  audit({kind:'model_profile_selected',status:`${modelProfile.model} · ${modelProfile.effort}`});
  const transport=relay.grant({candidate:'codex',provider:'openai',task:id,ctx,goalId:id,budget,fundingKey,authorize:()=>authorize({catalogue:false}),
   codexPolicy:modelPolicy,
   wireProfile:'codex',livePermit:permit,requestGate:access=>session.codexRequest(access)});
  const helperTransport=relay.grant({candidate:'codex',provider:'openai',task:id,ctx,goalId:id,budget,fundingKey,authorize:()=>authorize({catalogue:false}),
   codexPolicy:helperPolicy,
   wireProfile:'codex',livePermit:permit,requestGate:access=>session.codexRequest(access)});
  helperTransport.setNativeSession(session.helperDelivery());
  helper=require(base+'codex-helper-provider').create({transport:helperTransport,policy:helperPolicy});
  audit({kind:'runtime_starting',status:'Starting the Codex SDK session'});
  result=await require(base+'worker').run({candidate:'codex',session,gateway:{...gateway,authorize},browser:ui,budget,transport,
   codexPolicy:modelPolicy,modelRoutingInstructions:routing.instructions(ctx,modelProfile),
   preparedCodexSandbox:preparedSandbox,preparedCodexContext:preparedContext,
   credentials:{openai:key},codexLivePermit:permit,codexImage:image,privateHarnessDirectory:directory,audit,
   finalReportInstructions:require('./postgres-codex-verification').instructions});
  const report=require('./agent-conversation').parse(result.answer);
  if(report?.status==='needs_reasoning'){
   const ready=await session.handoffApprovals();if(ready)return ready;
   const stronger=await session.promoteReasoning(report);modelProfile=require(base+'codex-models').getProfile(stronger.profile);
   await require('./codex-staging-readiness').verifyPricing(database,modelProfile);
  }else{
   const current=await store.get(database,ctx,id);if(current.status!=='RUNNING')break;
   const finalStarted=Date.now();
   const checked=await session.finish(async(client,{goal,access})=>({...await require('./postgres-codex-verification').verify(client,ctx,goal,result.answer,access.catalogue,{browser:ui}),
    verificationSourceHash:require('./codex-staging-permit').assertBinding(permit,{budget,task:id,image}).sourceHash}),{allowReportCorrection:true});
   audit({kind:'host_final_verification',timings:{finalVerificationMs:Date.now()-finalStarted}});
   if(!checked?.needsCorrection)break;
   audit({kind:'native_report_correction',code:checked.code});
  }
  transport.revoke();helperTransport.revoke();
  await (await preparedSandbox).sandbox.close();
  preparedSandbox=options.sandboxPool?options.sandboxPool.take(image):require(base+'codex-runtime').prepareSandbox(image);
  const nextSandbox=preparedSandbox;preparations.push(nextSandbox);nextSandbox.catch(()=>{});
  cleanup.push(async()=>{const prepared=await nextSandbox.catch(()=>null);if(prepared)await prepared.sandbox.close();});
  preparedContext=require(base+'codex-runtime').prepareContext({session,browser:ui,gateway,audit});
  preparations.push(preparedContext);preparedContext.catch(()=>{});
  }
  return store.get(database,ctx,id);
 }catch(error){
  audit({kind:'runtime_failed',code:error.code||'STAGING_RUNTIME_STOPPED'});
  if(session){const ready=await session.handoffApprovals().catch(()=>null);if(ready)return ready;
   return session.stop({code:error.code||error.message||'STAGING_RUNTIME_STOPPED',limitKind:error.limitKind||null});}
  await database.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',run_token=NULL,lease_until=NULL,
   answer=$5,updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND run_token=$4`,[ctx.workspaceId,ctx.actorId,id,goal.run_token,
    error.code==='STAGING_MODEL_PRICE_UNVERIFIED'?error.message:'The Staging runtime could not start. No business operation was executed.']);
  throw error;
 }finally{
  await Promise.allSettled(preparations);await flushActivity().catch(()=>{});
  // Attempt every independent cleanup. One transient resource failure must
  // not leak the remaining resources or overwrite a durable business outcome.
  for(const close of cleanup.reverse())try{await close();}catch(error){
   audit({kind:'runtime_cleanup_failed',code:require(base+'tool-error').code(error)});
  }
  await flushActivity().catch(()=>{});
 }
}
module.exports={run};
