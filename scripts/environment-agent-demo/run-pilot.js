'use strict';
// Explicit operator entry point. No production imports this file. Approval is
// activated separately after certification; this runner cannot refill a ledger.
const fs=require('node:fs'),path=require('node:path');
const {directory,requireCertificate}=require('./certification');
const {ExperimentBudget}=require('./budget');
const fixtures=require('./pilot-fixtures'),candidates=require('./candidates');
const goals=require('../../src/assistant/postgres-goal-store');
const {restricted}=require('./network-guard');
const EXPERIMENT='environment-pilot-2026-10';
async function seedPrices(db){
 for(const [operation,dollars]of Object.entries({model_input:2,model_output:10,cache_write_5m:2.5,cache_write_1h:2.5,cache_read:.1}))
  await db.query(`INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,
   effective_from,source,pricing_basis,confidence) VALUES($1,'openai','gpt-6.1-sol','responses-2026-10-11',$2,'token',$3,'USD',
   '2026-10-11','https://developers.openai.com/api/docs/pricing','VERIFIED_PUBLIC','HIGH') ON CONFLICT DO NOTHING`,
   [`pilot-openai-${operation}`,operation,dollars/10000]);
}
async function attempt({candidate,task,budget,certificate,credentials,outputDirectory,
 fixtures=require('./pilot-fixtures'),approvalPolicy=require('./pilot-approval'),approvalDecision=null,helperProvider='anthropic',offlineFetch=null,visibleBrowser=false,
 codexLivePermit=null,countCodexInput=null,verifyOutcome=null}){
 if(typeof visibleBrowser!=='boolean')throw new Error('VISIBLE_BROWSER_MUST_BE_BOOLEAN');
 if(candidate==='codex'&&!offlineFetch&&credentials.openai!=='FAKE'&&!approvalDecision)throw Error('EXPLICIT_HUMAN_REVIEW_REQUIRED');
 if(offlineFetch&&(!certificate.testOnly||Object.values(credentials).some(v=>v!=='FAKE')))
  throw new Error('OFFLINE_TRANSPORT_REQUIRES_TEST_CERTIFICATE_AND_FAKE_KEYS');
 const started=Date.now(),events=[],interruptions=[];let modelResult=null,error=null,approvals=0,rejectedApprovals=0,answer='',goal,fixture,verdict;
 const cleanup=[];let db,activeSession;let humanReviews=0,humanApprovalResponses=0;
 const audit=event=>{const record={at:new Date().toISOString(),...event};events.push(record);fs.appendFileSync(path.join(outputDirectory,'trace.jsonl'),JSON.stringify(record)+'\n');};
 fs.mkdirSync(outputDirectory,{recursive:true});
 try{
  const cluster=await require('../../tests/helpers/postgres-cluster').startCluster();cleanup.push(()=>cluster.stop());
  db=require('../../src/db/postgres').openPostgres(cluster.connectionString);cleanup.push(()=>db.close());
  await require('../../src/db/migrate-postgres').migratePostgres(db);await seedPrices(db);
  if(candidate==='codex'){
   require('./codex-live-permit').assert(codexLivePermit,{budget,task:task.id,image:certificate.image});
   const profile=require('./codex-wire').PROFILE;
   for(const [operation,dollars]of Object.entries(profile.rates))
    await db.query(`INSERT INTO commercial_cost_rates(id,provider,model,provider_version,operation,unit,cost_per_unit_minor,currency,effective_from,source,pricing_basis,confidence)
     VALUES($1,'openai',$5,'responses-2026-10-11',$2,'token',$3,'USD',now(),$4,'VERIFIED_PUBLIC','HIGH')`,
     ['codex-certification-'+operation,operation,dollars/10000,require('./codex-wire').source,profile.model]);
  }
  fixture=await fixtures.seed(db,task);const {ctx}=fixture;
  const beforeRead=sql=>{if(fixture.changed&&!fixture.faulted&&fixture.faultEnabled!==false&&/^\s*SELECT\b/i.test(sql)&&/\b(balances|movements)\b/i.test(sql)){
   fixture.faulted=true;audit({kind:'injected_read_failure',semanticTrigger:'first stock read after concurrent update'});
   throw Object.assign(new Error('Temporary fixture stock read failure; retry from fresh evidence.'),{code:'DEMO_TRANSIENT_READ',retryableRead:true});
  }};
  const agentDb={...db,query:(sql,values)=>require('./read-recovery').query({query:async(sql,values)=>{beforeRead(sql);return db.query(sql,values);}},sql,values,
    detail=>audit({kind:'read_retry',...detail})),
   transaction:(operation,options)=>db.transaction(client=>operation({...client,query:async(sql,values)=>{beforeRead(sql);return client.query(sql,values);}}),options)};
  fs.writeFileSync(path.join(outputDirectory,'before.json'),JSON.stringify(fixture.before,null,2));
  process.env.STOCKCHIEF_ADAPTIVE_ASK='1';process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES=ctx.workspaceId;
  const goalBudgetMinor=candidate==='codex'?require('./codex-live-permit').assert(codexLivePermit,{budget,task:task.id}).goalBudgetMinor:75;
  goal=await goals.create(db,ctx,task.prompt,{budgetMinor:goalBudgetMinor,usageKey:`pilot:${task.id}:${candidate}`});
  let humanExecuting=false;
  async function authorize(){const current=await goals.get(db,ctx,goal.id);
   const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
   if(!actor||actor.role!=='owner'||!current||new Date(current.expires_at)<=new Date()||
    !(current.status==='RUNNING'&&new Date(current.lease_until)>new Date()||humanExecuting&&current.status==='WAITING_APPROVAL'))throw new Error('PILOT_GOAL_AUTHORITY_STOPPED');
  }
  const relay=await require('./relay').createRelay({budget,credentials,audit,countCodexInput,commercial:require('./commercial').createCommercialAccounting(db),
   ...(offlineFetch?{fetchImpl:offlineFetch}:{}),
   ...(candidate==='codex'||candidate==='openai'&&helperProvider==='openai'?{allowedProviders:['openai']}:{})});
  cleanup.push(()=>relay.close());
  if(!['openai','anthropic'].includes(helperProvider))throw new Error('UNAPPROVED_HELPER_PROVIDER');
  const helperTransport=candidate==='codex'?null:relay.grant({candidate,task:task.id,provider:helperProvider,ctx,goalId:goal.id,
   fundingKey:`pilot:${goal.id}`,accountingMode:'existing',authorize});
  // This approval covers the native runtime only. No hidden helper model calls.
  const raw=candidate==='codex'?{name:'openai',model:require('./codex-wire').MODEL,complete:async()=>{throw Error('UNAPPROVED_HELPER_MODEL_CALL');}}:
   require(helperProvider==='openai'?'./openai-structured-provider':'./structured-provider').createStructuredProvider(helperTransport);
  const policy={databaseUrl:cluster.connectionString,httpOrigins:helperTransport?[helperProvider==='openai'?helperTransport.openaiBaseURL:helperTransport.anthropicBaseURL]:[]};
  const observe=async output=>{if(await fixtures.perturb(db,fixture,output)){
   fixture.expectedReadState=await fixtures.snapshot(db,fixture);audit({kind:'fixture_changed',semanticTrigger:'first observed target SKU',reason:'independent operator state transition'});
  }};
  const baselineProvider={...raw,async complete(request){
   const current=await goals.get(db,ctx,goal.id);await observe(current.checkpoint.observations||[]);return raw.complete(request);
  }};
  let browser,sandbox,ui,transport;
  if(candidate!=='adaptive'){
   sandbox=await require('./sandbox').createSandbox({image:certificate.image});cleanup.push(()=>sandbox.close());
   const runtime=await sandbox.certify();audit({kind:'sandbox_certificate',...runtime});
   const server=await require('./inspection').createInspectionServer({cluster,database:db,ctx,beforeRead});cleanup.push(()=>server.close());
   // Host-owned presentation only: the embedded worker still chooses every action.
   browser=await require('playwright').chromium.launch({headless:!visibleBrowser});cleanup.push(()=>browser.close());
   // Evaluator-only environment variants wrap the real restricted renderer.
   // Only its origin reaches the browser; no route map or expected facts enter
   // the worker, gateway, prompt, sandbox or model requests.
   const environment=fixtures.environment?await fixtures.environment(db,fixture,server,{outputDirectory}):null;
   if(environment)cleanup.push(()=>environment.close());
   ui=await require('./browser').createBrowserTools(browser,{origin:environment?.origin||server.origin,audit});cleanup.push(()=>ui.close());
   transport=relay.grant({candidate,task:task.id,provider:['openai','codex'].includes(candidate)?'openai':'anthropic',ctx,goalId:goal.id,
    fundingKey:`pilot:${goal.id}`,authorize,...(candidate==='codex'?{wireProfile:'codex',livePermit:codexLivePermit,requestGate:()=>activeSession.codexRequest()}: {})});
   const entitlements=require('../../src/commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId);
   const units=Number((await db.query("SELECT units FROM commercial_operation_policies WHERE operation='ask'")).rows[0].units);
   await entitlements.reserveUsage(db,scope,{meter:'ai_work_credits',units,idempotencyKey:`${ctx.workspaceId}:pilot:${goal.id}`,detail:{operation:'ask',pilot:true}});
  }
  const privateHarnessDirectory=path.join(outputDirectory,'private-sdk-state');fs.mkdirSync(privateHarnessDirectory,{recursive:true});
  const abortController=new AbortController();let timer;
  cleanup.push(()=>clearTimeout(timer));
  // Native continuations remain the SAME goal/attempt. The durable request,
  // tool, lease and spending gates govern them; a separate demo phase counter
  // must not strand an otherwise authorized chain of approvals at phase four.
  for(let phase=0;candidate==='codex'||phase<4;phase++){
   timer=setTimeout(()=>abortController.abort(),8*60000);
   if(candidate==='adaptive')modelResult=await restricted(policy,()=>candidates.adaptive({database:agentDb,ctx,goalId:goal.id,provider:baselineProvider,
    budget,transport:helperTransport,isolationCertificate:certificate,audit}));
   else{
    await require('./waits').recover(db,ctx,goal.id);
    const lease=await goals.claim(db,ctx,goal.id);if(!lease)break;
    // Codex has no approved helper model. Reject a helper call before the legacy
    // wrapper can reserve money for its three-execution structured-call path.
    const funded=candidate==='codex'?raw:require('../../src/assistant/postgres-service').fundedAskProvider(db,{...ctx,goalId:goal.id},raw,`pilot-helper:${goal.id}:${phase}`);
    const gateway=require('./gateway').createGateway({database:agentDb,ctx,goal:task.prompt,goalId:goal.id,runToken:lease.run_token,provider:funded,rawProvider:raw,audit});
    const session=require('./session').createSession({database:db,ctx,goalId:goal.id,runToken:lease.run_token,candidate,authorize:gateway.authorize,
     verifyOutcome:verifyOutcome?((client,context)=>verifyOutcome(client,{...context,fixture,task})):null,
     onApprovalReady:candidate==='codex'?async card=>{
      audit({kind:'approval_ready',deliveryId:card.id,proposalId:card.proposalId});
      // Publish now; waiting for the decision belongs to the human stage below.
      if(approvalDecision?.publish)await approvalDecision.publish({task,candidate,proposal:card.proposal,outputDirectory,deliveryId:card.id});
     }:null});
    activeSession=session;
    const observedGateway={...gateway};
    for(const name of ['interfaces','dataset','operate'])observedGateway[name]=async input=>{
     const output=await restricted(policy,()=>gateway[name](input));audit({kind:'environment_observation',tool:name,output});await observe(output);return output;
    };
    const observedBrowser={restore:ui.restore,act:async input=>{
     const output=await ui.act(input);const screen=output.screen||output;
     audit({kind:'browser_observation',screen});
     await ui.page.screenshot({path:path.join(outputDirectory,`screen-${events.length}.png`),fullPage:false});
     await observe(screen);return output;
    }};
    modelResult=await require('./worker').run({candidate,goal:task.prompt,budget,transport,isolationCertificate:certificate,
     ...(candidate==='codex'?{codexLivePermit,codexImage:certificate.image,credentials,offlineOnly:false}:{}),
     session,gateway:observedGateway,browser:observedBrowser,sandbox,privateHarnessDirectory,abortController,signal:abortController.signal,audit,
     resumeContext:phase?'Required approvals were completed through the canonical engines. Reinvestigate current records and finish the original goal.':null});
    answer=modelResult.answer||'';verdict=await fixtures.verify(db,fixture,answer);
    if((await goals.get(db,ctx,goal.id)).status==='RUNNING')await session.finish({answer,verified:verdict.achieved});
    if(modelResult.interruption){interruptions.push(modelResult.interruption);error={name:modelResult.interruption.code,message:modelResult.interruption.message||'Recovered with a verified receipt.'};}
   }
   clearTimeout(timer);
   goal=await goals.get(db,ctx,goal.id);answer=goal.answer||modelResult?.answer||'';
   if(candidate==='codex'&&modelResult?.interruption&&goal.status!=='WAITING_APPROVAL')break; // No paid retry; durable approvals are independent.
   if(goal.status!=='WAITING_APPROVAL')break;
   // Canonical continuation can prepare another dependent proposal after the
   // first approval. The same test-operator policy reviews each one separately.
   // It never supplies an agent plan or approves an entire unknown mission.
   for(let review=0;(candidate==='codex'||review<4)&&goal.status==='WAITING_APPROVAL';review++){
    const pending=approvalPolicy.pending?await approvalPolicy.pending(db,ctx):
     (await db.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND actor_user_id=$2 AND status='PENDING' ORDER BY created_at,id`,[ctx.workspaceId,ctx.actorId])).rows;
    const inbox=candidate==='codex'?await activeSession.approvalInbox():null;
    let approved=0;
    for(const proposal of pending){
     const card=inbox?.approvals.find(c=>c.proposalId===proposal.id);
     if(candidate==='codex'&&!card)continue; // Never review another goal's pending proposals.
     if(!await approvalPolicy.permits(db,fixture,proposal)){rejectedApprovals++;audit({kind:'test_operator_refused',proposal});continue;}
     if(approvalDecision){humanReviews++;
      const decision=await approvalDecision({task,candidate,proposal,outputDirectory,deliveryId:card?.id});
      humanApprovalResponses+=decision.responded?1:0;
      audit({kind:'human_approval_decision',proposalId:proposal.id,...decision});
      if(!decision.approved){rejectedApprovals++;continue;}
      proposal.humanResponseReference=decision.responseReference;
     }
     humanExecuting=true;
     try{const execute=(approvedProposal=proposal,executionDb=db)=>restricted(policy,()=>approvalPolicy.execute?approvalPolicy.execute(executionDb,{...ctx,goalId:goal.id},approvedProposal,{provider:raw}):
      require('../../src/assistant/postgres-service').executeProposal(executionDb,{...ctx,goalId:goal.id},approvedProposal.id,{provider:raw}));
      if(card)await require('./approval-handoff').decide({database:db,ctx,goalId:goal.id,id:card.id,sha256:card.sha256,
       decision:{source:'human_user',approved:true,responseReference:proposal.humanResponseReference||'OFFLINE_TEST_OPERATOR'},execute});
      else await execute();
      approvals++;approved++;audit({kind:approvalDecision?'human_approved_fixture_execution':'simulated_human_approval',proposalId:proposal.id,action:proposal.action_type||'policy.propose'});
     }finally{humanExecuting=false;}
    }
    if(!approved)break;
    goal=await (candidate==='adaptive'?require('../../src/assistant/postgres-goal-resume'):require('./waits')).refresh(db,ctx,goal.id);
   }              
   if(goal?.status!=='READY')break;
  }
  goal=await goals.get(db,ctx,goal.id);answer=goal.answer||answer;
  verdict=await fixtures.verify(db,fixture,answer);
  // A recovered interruption remains in diagnostics, but must not convert a
  // subsequently completed, independently verified goal into a failed task.
  if(goal.status==='COMPLETED'&&verdict.achieved)error=null;
  const cost=(await db.query('SELECT COALESCE(sum(actual_minor),0) AS minor FROM commercial_model_cost_holds WHERE goal_id=$1 AND status=\'SETTLED\'',[goal.id])).rows[0];
  fs.writeFileSync(path.join(outputDirectory,'goal.json'),JSON.stringify(goal,null,2));
  fs.writeFileSync(path.join(outputDirectory,'goal-events.json'),JSON.stringify((await db.query(
   'SELECT sequence,kind,detail,created_at FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1 ORDER BY sequence',[goal.id])).rows,null,2));
  verdict.estimatedProviderUsd=Number(cost.minor)/100;
 }catch(e){error={name:e.name,message:e.message};audit({kind:'attempt_error',...error});
  if(activeSession)await activeSession.stop({code:e.code||'HARNESS_INTERRUPTED'}).catch(stopError=>audit({kind:'session_stop_failed',message:stopError.message}));
  if(db&&fixture){
   if(goal)goal=await goals.get(db,fixture.ctx,goal.id).catch(()=>goal);
   answer=goal?.answer||answer;
   verdict=await fixtures.verify(db,fixture,answer).catch(()=>null);
   if(goal){
    fs.writeFileSync(path.join(outputDirectory,'goal.json'),JSON.stringify(goal,null,2));
    const events=(await db.query('SELECT sequence,kind,detail,created_at FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1 ORDER BY sequence',[goal.id])).rows;
    fs.writeFileSync(path.join(outputDirectory,'goal-events.json'),JSON.stringify(events,null,2));
    const cost=(await db.query("SELECT COALESCE(sum(actual_minor),0) AS minor FROM commercial_model_cost_holds WHERE goal_id=$1 AND status='SETTLED'",[goal.id])).rows[0];
    if(verdict)verdict.estimatedProviderUsd=Number(cost.minor)/100;
   }
  }
 }finally{for(const close of cleanup.reverse())try{await close();}catch(e){audit({kind:'cleanup_error',message:e.message});}}
 const calls=budget.db.prepare('SELECT * FROM experiment_calls WHERE experiment=? AND candidate=? AND task=?').all(budget.experiment,candidate,task.id);
 const toolCalls=events.filter(e=>e.kind==='agent_tool_started');
 const browserCalls=toolCalls.filter(e=>e.name==='environment_browser');
 const result={task:task.id,candidate,sourceHash:certificate.sourceHash,goal:task.prompt,answer,status:goal?.status||'INFRASTRUCTURE_FAILURE',error,interruptions,
  failure:goal?.checkpoint?.harness?.failure||null,
  providerMode:offlineFetch?'OFFLINE_SYNTHETIC':'LIVE',
  verifiedOutcome:Boolean(verdict?.achieved),verdict,
  completedExperience:Boolean(verdict?.achieved)&&goal?.status==='COMPLETED'&&!error,
  modelCalls:calls.length,conservativeCostUsd:calls.reduce((n,c)=>n+(c.state==='SETTLED'?c.charged:c.reserved),0)/1e6,
  unresolvedModelCalls:calls.filter(c=>['RESERVED','UNKNOWN'].includes(c.state)).length,
  chargesWithoutProviderReceipt:calls.filter(c=>c.state!=='SETTLED').length,
  browserOperatedByAgent:browserCalls.some(c=>c.sdkToolCallId&&c.input.action!=='inspect'&&c.input.action!=='screenshot'),
  browserToolCalls:browserCalls.length,toolFailures:events.filter(e=>e.kind==='agent_tool_failed').length,
  requiredApprovalsSimulated:approvalDecision?0:approvals,requiredApprovalsExecuted:approvals,humanReviewsRequested:humanReviews,
  actualHumanApprovalResponses:humanApprovalResponses,rejectedApprovals,clarificationNeeded:goal?.status==='WAITING_USER',
  correctiveMessages:0,operatorRescues:0,humanReviewTimeMeasured:Boolean(approvalDecision),
  humanReviewWaitMs:events.filter(e=>e.kind==='human_approval_decision').reduce((n,e)=>n+(e.waitMs||0),0),
  changedState:fixture?.changed||false,injectedFailure:fixture?.faulted||false,elapsedSeconds:(Date.now()-started)/1000};
 fs.writeFileSync(path.join(outputDirectory,'result.json'),JSON.stringify(result,null,2));return result;
}
async function main(){
 if(process.argv[2]!=='--paid')throw new Error('Use certification.js for offline tests. The scored runner requires explicit --paid.');
 const certificate=requireCertificate();
 const env=require('node:util').parseEnv(fs.readFileSync(path.join(__dirname,'../../.env'),'utf8'));
 const credentials={openai:process.env.OPENAI_API_KEY||env.OPENAI_API_KEY,anthropic:process.env.ANTHROPIC_API_KEY||env.ANTHROPIC_API_KEY};
 if(!credentials.openai||!credentials.anthropic)throw new Error('Both provider API credentials are required; no partial paid pilot.');
 const budget=new ExperimentBudget(path.join(directory,'spending.sqlite'),EXPERIMENT);
 try{
  const status=budget.status();if(status.ceiling!==10000000||!status.approval||status.stopped||status.unresolved||status.expires<=Date.now())throw new Error('PAID_TESTING_LOCKED');
  const manifest={corpusHash:fixtures.corpusHash(),sourceHash:certificate.sourceHash,candidates:candidates.CANDIDATES,attempts:18};
  const journal=new (require('./pilot-journal').PilotJournal)(budget,manifest);
  if(journal.rows().length)throw new Error('This pilot already started. Do not rerun or reset it. Inspect durable results.');
  const names=['adaptive','openai','claude'];
  for(const [index,task]of fixtures.TASKS.entries())for(let position=0;position<3;position++){
   const candidate=names[(index+position)%3];const status=budget.status();
   if(status.unresolved||status.stopped||status.remaining<=0)throw new Error('Shared budget stopped the pilot. Remaining attempts were not run.');
   journal.begin(task.id,candidate);console.log(JSON.stringify({event:'attempt_started',task:task.id,candidate,remainingUsd:status.remaining/1e6}));
   const result=await attempt({candidate,task,budget,certificate,credentials,outputDirectory:path.join(directory,'pilot',task.id,candidate)});
   journal.finish(task.id,candidate,result);console.log(JSON.stringify({event:'attempt_finished',task:task.id,candidate,
    verified:result.verifiedOutcome,status:result.status,cost:result.conservativeCostUsd,error:result.error}));
   fs.writeFileSync(path.join(directory,'pilot-results.json'),JSON.stringify({manifest,budget:budget.status(),attempts:journal.rows()},null,2));
  }
 }finally{console.log(JSON.stringify({event:'budget_final',...budget.status()}));budget.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={attempt,seedPrices,EXPERIMENT};
