'use strict';
const {createHash}=require('node:crypto');
const TABLE='stockchief_runtime.assistant_goals';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const failureReason=value=>typeof value==='string'?require('../../src/assistant/agent-conversation').publicText(value,'').slice(0,200):'';

// The existing goal owns checkpoints. Interrupted consequential calls require
// reconciliation against canonical records, never blind replay.
function createSession({database,ctx,goalId,runToken,candidate,authorize,verifyOutcome,onApprovalReady}){
 async function notifyApprovals(result){
  if(!result||!onApprovalReady)return result;
  for(const card of result.approvals||[])if(!card.deliveredAt){
   try{await onApprovalReady(card);await require('./approval-handoff').acknowledge(database,ctx,goalId,card.id,card.sha256);}
   catch{/* Durable unacknowledged card remains replayable with the same ID. */}
  }
  return result;
 }
 function checkAuthority(h,access){if(access?.actor){
  const stamp=createHash('sha256').update(JSON.stringify(stable(access.actor))).digest('hex');
  if(h.authorityStamp&&h.authorityStamp!==stamp)throw new Error('SESSION_AUTHORITY_CHANGED');h.authorityStamp=stamp;
 }}
 // Validate the fresh authority and persist its stamp in the SAME transaction
 // as the checkpoint it protects. No authority is cached between operations.
 async function authorizedUpdate(change,settings={catalogue:false}){
  const access=await authorize(settings);return update(change,{access});
 }
 async function authority(settings={catalogue:true}){
  const access=await authorize(settings);await read(()=>null,access);return access;
 }
 function held(goal,cleanup=false){
  if(!goal||goal.status!=='RUNNING'||goal.run_token!==runToken||!cleanup&&(new Date(goal.lease_until)<=new Date()||new Date(goal.expires_at)<=new Date()))
   throw new Error('SESSION_LEASE_LOST');
 }
 function harness(goal){const cp=goal.checkpoint;cp.harness||={candidate,sequence:0,calls:{},native:{}};
  if(cp.harness.candidate!==candidate)throw new Error('SESSION_CANDIDATE_MISMATCH');return cp.harness;
 }
 async function read(select,access){access||=await authorize({catalogue:false});
  const goal=(await database.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
  held(goal);const h=harness(goal);checkAuthority(h,access);return select(h,goal);
 }
 function present(h,output,{full=false}={}){
  const text=JSON.stringify(output)??'null',legacyText=JSON.stringify(output?.image?output.screen:output)??'null';
  const entry=require('./observations').ordered(Object.values(h.evidence||{})).findLast(e=>e.text===text||e.text===legacyText||e.truncated&&e.text===text.slice(0,128000));
  if(full&&entry){const reference={evidenceId:entry.id,sha256:entry.sha256,observedAt:entry.at,untrusted:true,
   valuePointerPrefix:output?.image&&entry.text===text?'/screen':'',complete:!entry.truncated};
   const presented=require('./source-references').present(entry,require('./evidence-presentation').project(entry.name,output));
   return presented?.image?{...presented,screen:{...presented.screen,_stockchiefEvidence:reference}}:{...presented,_stockchiefEvidence:reference};}
  return entry?require('./context').preview(output,entry.id):output;
 }
 async function update(change,{cleanup=false,access}={}){return database.transaction(async client=>{
  const goal=(await client.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,
   [ctx.workspaceId,ctx.actorId,goalId])).rows[0];
  held(goal,cleanup);
  const cp=goal.checkpoint;checkAuthority(harness(goal),access);
  const result=await change(cp.harness,goal,client,access);
  require('../../src/assistant/agent-conversation').sync(goal);
  if(Buffer.byteLength(JSON.stringify(cp))>8*1024*1024)throw new Error('SESSION_SIZE_LIMIT');
  await client.query(`UPDATE ${TABLE} SET checkpoint=$4::jsonb,status=$5,answer=$6,tool_calls=$7,
   run_token=CASE WHEN $5='RUNNING' THEN run_token ELSE NULL END,
   lease_until=CASE WHEN $5='RUNNING' THEN now()+interval '10 minutes' ELSE NULL END,updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
   [ctx.workspaceId,ctx.actorId,goalId,JSON.stringify(cp),goal.status,goal.answer,goal.tool_calls]);
  return result;
 },{isolation:'SERIALIZABLE',retrySafe:true});}
 async function checkpointUpdate(change){return update(async(h,goal,client)=>{
  // Settled response persistence grants no new model/tool/business operation.
  // Match native checkpoint semantics: current actor, stamp, lease and tenant
  // in the same transaction, including after a spending pause.
  const actor=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2 FOR SHARE',
   [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor||!h.authorityStamp)throw Error('SESSION_AUTHORITY_CHANGED');checkAuthority(h,{actor});
  return change(h,goal,client);
 });}
 return {
  identity:Object.freeze({workspaceId:ctx.workspaceId,actorId:ctx.actorId,goalId,candidate}),
  async approvalInbox(){return candidate==='codex'?notifyApprovals(await require('./approval-handoff').inbox(database,ctx,goalId)):null;},
  async handoffApprovals(){return candidate==='codex'?notifyApprovals(await require('./approval-handoff').inbox(database,ctx,goalId,{pause:true,runToken})):null;},
  async completed(){
   // A committed completion survives loss of the SDK/process acknowledgement.
   // This read needs no execution lease, but still binds tenant, actor, current
   // permissions, candidate and the exact original request.
   const goal=(await database.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
   const h=goal?.checkpoint.harness;
   if(goal?.status!=='COMPLETED'||h?.candidate!==candidate||!['host_verified_receipt','host_verified_answer'].includes(h.completionSource))return null;
   const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
   if(!actor||!h.authorityStamp||createHash('sha256').update(JSON.stringify(stable(actor))).digest('hex')!==h.authorityStamp)
    throw new Error('SESSION_AUTHORITY_CHANGED');
   await require('../../src/commercial/enforcement').workspace(database,ctx.workspaceId,'ask.lookup');
   if(h.receipt?.requestHash!==require('./receipts').requestHash(goal))throw new Error('COMPLETION_REQUEST_MISMATCH');
   return {answer:goal.answer,completionSource:h.completionSource,checkedAt:h.receipt.checkedAt};
  },
  async load(){return authorizedUpdate((h,goal,client,access)=>{
   let environment=null;
   if(access?.environment){
    const id=`${goalId}:environment:${createHash('sha256').update(JSON.stringify(access.environment)).digest('hex').slice(0,24)}`;
    require('./observations').store(h,{id,name:'authorized_environment',result:access.environment});
    environment=present(h,access.environment,{full:true});
   }
   return {...structuredClone(h),goalContext:{environment,
   originalRequest:goal.original_request,messages:structuredClone(goal.checkpoint.messages||[]),
   // Page metadata is only a location hint. Read its content with current
   // browser/gateway permissions, not by trusting fields posted by a client.
   page:goal.checkpoint.page?{path:goal.checkpoint.page.path}:null,
   continuation:structuredClone(goal.checkpoint.continuation||null),
   conversation:structuredClone(goal.checkpoint.conversation||null),
   conversationState:structuredClone(goal.checkpoint.conversationState||null),
   verificationFeedback:h.verificationFailure?{kind:'host_verification_feedback',code:h.verificationFailure.code,
    ...(h.verificationFailure.reason?{reason:h.verificationFailure.reason}:{}),
    ...(Number.isInteger(h.verificationFailure.claimIndex)?{claimIndex:h.verificationFailure.claimIndex}:{}),
    ...(h.verificationFailure.sourceRef?{sourceRef:h.verificationFailure.sourceRef}:{}),
    ...(h.verificationFailure.evidenceId?{evidenceId:h.verificationFailure.evidenceId,path:h.verificationFailure.path}:{}),
    notice:'The host did not verify the preceding final answer. This is diagnostic feedback, not a user request, approval or new execution authority. Preserve completed canonical effects and the original goal; use actual durable evidence and current records to correct the result. Resolve internal evidence references with the tools; ask the user only for genuinely missing business information.'}:null,
   modelRouting:structuredClone(goal.checkpoint.modelRouting||null),
   executionBudget:{toolsUsed:goal.tool_calls,toolsRemaining:Math.max(0,30-goal.tool_calls),
    modelRequestsUsed:Number(h.codexRequests||0),modelRequestsRemaining:Math.max(0,24-Number(h.codexRequests||0))}}};
  });},
  async checkpoint(native){
   if(candidate!=='codex')return authorizedUpdate(h=>{h.native={...h.native,...native};});
   // Native persistence is host bookkeeping, not a new grant to read records,
   // call a model or execute an operation. Keep the lease, tenant and fresh
   // actor stamp in this transaction; those effect boundaries still perform
   // their own complete commercial/authority admission. This also lets the
   // SDK save its settled state if the spending lock changes mid-response.
   return checkpointUpdate(h=>{h.native={...h.native,...native};});
  },
  async executionState(){return authorizedUpdate(async(h,goal,client,access)=>{
   const receipt=await require('./receipts').collect(client,ctx,goal,h,access.catalogue);
   if(!receipt.operations.length&&!receipt.humanDecisions.length)return null;
   const id=`${goalId}:host-receipt:${createHash('sha256').update(JSON.stringify(receipt)).digest('hex').slice(0,24)}`;
   require('./observations').store(h,{id,name:'canonical_execution_state',result:receipt});
   h.receipt=receipt;
   // Deliver committed effects before spending on the SDK's remaining work.
   // This is a partial receipt, never proof of the full original goal.
   const recorded=require('./receipts').render(receipt);
   if(recorded&&goal.checkpoint.lifecycleStage==='verification')goal.answer=recorded;
   return present(h,receipt,{full:true});
  },{catalogue:true});},
  async promoteReasoning(request){return authorizedUpdate((h,goal)=>{
   if(candidate!=='codex'||h.pendingReport?.status!=='needs_reasoning')throw Error('INVALID_MODEL_TIER_HANDOFF');
   const routing=require('../../src/assistant/codex-model-routing').promote(goal,ctx,request);
   h.pendingReport=null;return routing;
  });},
  async recordReport(raw){
   const report=require('../../src/assistant/agent-conversation').parse(raw);
   if(!report)return;
   return authorizedUpdate(h=>{h.pendingReport=report;});
  },
  async workingMemory(){return authorizedUpdate(h=>require('./memory').working(h));},
  async codexRequest(admissionAccess=null){const change=h=>{
   if(candidate!=='codex')throw new Error('NOT_A_CODEX_SESSION');
   h.codexRequests||=0;
   if(h.codexRequests>=24)throw new Error('DURABLE_MODEL_REQUEST_LIMIT');
   h.codexRequests++;
   return {request:h.codexRequests};
  };return admissionAccess?.actor?update(change,{access:admissionAccess}):authorizedUpdate(change);},
  async codexReplay(hash,admissionAccess=null){return read(h=>{
   if(candidate!=='codex')throw new Error('NOT_A_CODEX_SESSION');
   if(h.codexDelivery?.state==='PENDING')throw new Error('CODEX_RESPONSE_RECONCILIATION_REQUIRED');
   return h.codexDelivery?.hash===hash?require('./replay-packet').unpack(h.codexDelivery.packet):null;
  },admissionAccess);},
  async codexPending(hash,admissionAccess=null){const change=h=>{
   if(candidate!=='codex'||h.codexDelivery?.state==='PENDING')throw new Error('CODEX_RESPONSE_RECONCILIATION_REQUIRED');
   h.codexDelivery={hash,state:'PENDING'};
  };return admissionAccess?.actor?update(change,{access:admissionAccess}):authorizedUpdate(change);},
  async codexDelivered(hash,packet,outcome){return checkpointUpdate(h=>{
   if(candidate!=='codex'||h.codexDelivery?.hash!==hash||h.codexDelivery.state!=='PENDING')throw new Error('CODEX_RESPONSE_SEQUENCE_MISMATCH');
   h.codexDelivery={hash,state:'SETTLED',packet:require('./replay-packet').pack(packet)};h.lastCodexResponse={...outcome,request:h.codexRequests};
  });},
  // A helper's delivery must never overwrite the SDK response/checkpoint.
  // Its own durable slot still prevents spending again on an unknown outcome.
  helperDelivery(){return {
   identity:Object.freeze({workspaceId:ctx.workspaceId,actorId:ctx.actorId,goalId,candidate}),
   codexReplay:async(hash,admissionAccess=null)=>{return read(h=>{
    if(h.helperDelivery?.state==='PENDING')throw Error('CODEX_RESPONSE_RECONCILIATION_REQUIRED');
    return h.helperDelivery?.hash===hash?require('./replay-packet').unpack(h.helperDelivery.packet):null;
   },admissionAccess);},
   codexPending:async(hash,admissionAccess=null)=>{const change=h=>{
    if(h.helperDelivery?.state==='PENDING')throw Error('CODEX_RESPONSE_RECONCILIATION_REQUIRED');
    h.helperDelivery={hash,state:'PENDING'};
   };return admissionAccess?.actor?update(change,{access:admissionAccess}):authorizedUpdate(change);},
   codexDelivered:async(hash,packet)=>{return checkpointUpdate(h=>{
    if(h.helperDelivery?.hash!==hash||h.helperDelivery.state!=='PENDING')throw Error('CODEX_RESPONSE_SEQUENCE_MISMATCH');
    h.helperDelivery={hash,state:'SETTLED',packet:require('./replay-packet').pack(packet)};
   });}
  };},
  async answerReview(raw){return authorizedUpdate((h,goal)=>{
   const review=require('../../src/assistant/native-answer-review');let bound;
   try{bound=review.binding(goal,raw);}catch{
    // Reference/integrity errors belong to the existing deterministic verifier
    // and its bounded native correction path. Never buy a semantic opinion on
    // evidence the host cannot resolve, or turn that correction into a stop.
    return {required:false,preflightRejected:true};
   }
   if(!bound)return {required:false};
   if(h.answerScopeReview?.version===review.version&&h.answerScopeReview.hash===bound.hash&&h.answerScopeReview.state==='SETTLED')
    return {...bound,required:true,verdict:h.answerScopeReview.verdict};
   h.answerScopeReview={version:review.version,hash:bound.hash,state:'PREPARED',input:bound.input};
   return {...bound,required:true};
  });},
  async answerReviewed(raw,hash,value){return authorizedUpdate((h,goal)=>{
   const review=require('../../src/assistant/native-answer-review'),bound=review.binding(goal,raw);
   if(!bound||bound.hash!==hash||h.answerScopeReview?.hash!==hash)throw Error('ANSWER_SCOPE_REVIEW_CHANGED');
   h.answerScopeReview={version:review.version,hash,state:'SETTLED',input:bound.input,verdict:review.verdict(value)};
   return h.answerScopeReview.verdict;
  });},
  async modelControl({budgetFinal=false}={}){return authorizedUpdate(h=>{
   h.modelRequests||=0;
   if(h.lastModelResponse?.empty)throw Object.assign(new Error(require('./finalization').EMPTY_MESSAGE),{code:'EMPTY_MODEL_FINAL'});
   if(h.modelRequests>=24||h.finalRequestSent)throw Object.assign(new Error('FINAL_REQUEST_EXHAUSTED'),{code:'FINAL_REQUEST_EXHAUSTED'});
   h.modelRequests++;
   const reason=h.progress?.finalReason||(h.modelRequests===24?'FINAL_TURN_RESERVED':budgetFinal?'FINAL_COST_HEADROOM':null);
   if(reason)h.finalRequestSent=true;
   return {request:h.modelRequests,final:Boolean(reason),reason};
  });},
  async modelResponse(outcome){return authorizedUpdate(h=>{
   if(outcome.request!==h.modelRequests)throw new Error('MODEL_RESPONSE_SEQUENCE_MISMATCH');
   h.lastModelResponse={request:outcome.request,final:Boolean(outcome.final),terminal:Boolean(outcome.terminal),
    visible:Boolean(outcome.visible),tool:Boolean(outcome.tool),empty:Boolean(outcome.empty),stopReason:outcome.stopReason,
    usageSettled:Boolean(outcome.usageSettled)};
  });},
  async evidenceIndex(){return read(h=>require('./observations').index(h));},
  async present(output,options){return read(h=>present(h,output,options));},
  async evidence(input){return read(h=>require('./observations').retrieve(h,input));},
  async executePresented(name,input,operation,presentation){return this.execute(name,input,operation,{presentation});},
  async execute(name,input,operation,{presentation}={}){
   const business=name==='business_operations';
   // Browser/evidence/scratch tools need current lease and actor authority,
   // not a rebuilt catalogue of every possible commercial operation. The
   // interface/record gateway performs its own fresh contract checks.
   const access=await authorize({catalogue:business});
   let intent=business&&typeof input.stepsJson==='string'?{steps:require('./contracts').parseJson(input.stepsJson)}:input;
   if(business&&Array.isArray(intent.steps)&&intent.steps.length&&access?.catalogue)
    intent={steps:require('./contracts').operationSteps(intent.steps,access.catalogue)};
   const readOnly=business&&Array.isArray(intent.steps)&&intent.steps.length>0&&intent.steps.every(step=>
    require('../../src/assistant/postgres-capability-registry').registry.get(step.capability)?.kind==='read');
   const consequential=business&&!readOnly;
   const fingerprint=createHash('sha256').update(JSON.stringify(stable({name,input:intent}))).digest('hex');
   let start;try{start=await update(async(h,goal,client)=>{
    if(candidate!=='codex'&&(h.finalRequestSent||h.lastModelResponse?.empty))throw Object.assign(new Error('FINAL_TOOLS_DISABLED'),{code:'FINAL_TOOLS_DISABLED'});
    if(h.inflight)throw new Error('SESSION_OPERATION_UNRESOLVED');
    if(goal.tool_calls>=30)throw new Error('DURABLE_TOOL_LIMIT');
    const id=`${goalId}:${++h.sequence}`;goal.tool_calls++;
    if(consequential&&h.calls[fingerprint]?.state==='DONE'){
     const replay={...h.calls[fingerprint].result,replayed:true,
      notice:'Original outcomes describe the previous preparation. canonicalReceipt is the fresh status. No business operation was repeated.',
      canonicalReceipt:await require('./receipts').collect(client,ctx,goal,h,access?.catalogue)};
     require('./observations').store(h,{id,name,result:replay});
     return {replay:presentation?present(h,replay,presentation):replay};
    }
    h.inflight={id,name,fingerprint,consequential};return {id};
   },{access});}catch(error){
    if(['DURABLE_TOOL_LIMIT','SESSION_OPERATION_UNRESOLVED'].includes(error.message))
     await update(h=>{h.admissionBlock={code:error.message,requiresUserInput:false};}).catch(()=>{});
    throw error;
   }
   if(Object.hasOwn(start,'replay'))return start.replay;
   try{
    const result=await operation(start.id);
    // Evidence must not be released if authority changed while the tool ran.
    // Persist/present it together, but retain the fresh post-operation check.
    const deliveryAccess=presentation?await authorize({catalogue:false}):undefined;
    const completed=await update(async(h,goal,client)=>{
     if(h.inflight?.id!==start.id)throw new Error('SESSION_OPERATION_MISMATCH');
     const onlyQuestions=Array.isArray(result?.outcomes)&&result.outcomes.length&&result.outcomes.every(o=>o.result?.status==='CLARIFY'&&!o.result.proposal);
     // No business effect was prepared for a pure question. After the owner
     // supplies the missing facts, the same zero-argument contract must run
     // with that clarification rather than replaying an obsolete question.
     if(consequential&&!onlyQuestions)h.calls[fingerprint]={id:start.id,state:'DONE',result};
     if(name!=='environment_evidence'){
      require('./observations').store(h,{id:start.id,name,result,
       source:name==='environment_dataset'||name==='environment_browser'||name==='environment_interfaces'||business?{version:1,name,input:intent}:null});
     }
     if(business){
      // Recovery destinations come from canonical operation results, never
      // model prose or a catalogue of chat-specific workflows. Keep the
      // durable evidence reference so delivery does not need another turn.
      goal.checkpoint.prerequisiteHandoffs=(result?.outcomes||[]).flatMap(outcome=>{
       const handoff=outcome.result?.handoff;
       const href=require('../../src/assistant/agent-navigation-path').localPath(handoff?.href);
       return href&&typeof handoff.label==='string'&&handoff.label.trim()
        ?[{href,label:handoff.label.trim().slice(0,120),evidenceId:start.id}]:[];
      }).slice(0,10);
     }
     if(candidate!=='codex'){
      require('./memory').observe(h,name,input,result,start.id);
      require('./evidence').remember(h,name,input,result,start.id);
     }
     if(name==='environment_browser'){
      const screen=result?.screen||result;
      if(screen?.url)h.native.browserUrl=screen.url;
     }
     h.inflight=null;
     const approvals=candidate==='codex'&&business?await require('./approval-handoff').stage(client,ctx,goal,h):[];
     return {approvals,output:presentation?present(h,result,presentation):result};
    },{access:deliveryAccess});
    await notifyApprovals(completed);return completed.output;
   }catch(error){
    await update((h,goal)=>{
     h.lastToolError={name,code:require('./tool-error').code(error),effectMayHaveOccurred:error.effectMayHaveOccurred!==false};
     if(consequential&&error.effectMayHaveOccurred!==false){goal.status='BLOCKED';goal.answer='An operation was interrupted. Reconcile its canonical records before retrying.';}
     else {h.inflight=null;h.lastToolError.message=error.code==='TOOL_CONTRACT_INVALID'?String(error.message).slice(0,1500):'This step failed before making a business change.';}
    });throw error;
   }
  },
  async finish(result,{allowReportCorrection=false}={}){
   const access=await authorize();return update(async(h,goal,client)=>{
    if(h.inflight)throw new Error('SESSION_OPERATION_UNRESOLVED');
    // A trusted host verifier runs inside the same final transaction and fresh
    // authority boundary. Models cannot supply a callback or a verified receipt.
    const check=typeof result==='function'?await result(client,{goal,access}):result;
    const {answer,verified=false,navigation=null,report=null}=check;
    // Only a host verifier may set verified; SDK final text is not verification.
    goal.answer=String(answer||'').slice(0,20000);
    const waits=require('./waits');const refs=waits.dependencies(h);
    const current=await waits.current(client,ctx,goalId,refs);
    h.dependencies=refs;
    h.receipt=typeof result==='function'&&check.receipt?check.receipt:
     await require('./receipts').collect(client,ctx,goal,h,access?.catalogue);
    const canonicalVerified=!h.receipt.operations.some(op=>!op.verified);
    const failure=verified?null:{code:/^[A-Z][A-Z0-9_]{0,99}$/.test(check.verificationFailure||'')?check.verificationFailure:'OUTCOME_UNVERIFIED',
     nativeDigest:h.native?.codex?.digest||null,sourceHash:check.verificationSourceHash||null,
     ...(Number.isInteger(check.verificationDetail?.claimIndex)?{claimIndex:check.verificationDetail.claimIndex}:{}),
     ...(failureReason(check.verificationDetail?.reason)?{reason:failureReason(check.verificationDetail.reason)}:{}),
     ...(check.verificationDetail?.sourceRef?{sourceRef:check.verificationDetail.sourceRef}:{}),
     ...(check.verificationDetail?.evidenceId?{evidenceId:check.verificationDetail.evidenceId,path:check.verificationDetail.path}:{})};
    // A settled SDK report can have a bad citation without an uncertain paid
    // request or business effect. Return that typed rejection to the SAME
    // native thread once. This uses the existing request/goal/period gates,
    // keeps every rejected assertion unverified and never repeats an effect.
    // Persist the allowance so interruptions cannot reset it into a loop.
    const correctable=['SOURCE_REFERENCE_NOT_FOUND','INVALID_SOURCE_REFERENCE','FIELD_REFERENCE_MUST_NOT_SUPPLY_PATH','EVIDENCE_VALUE_MISMATCH','EVIDENCE_POINTER_NOT_FOUND','ANSWER_SCOPE_UNVERIFIED'].includes(failure?.code);
    if(candidate==='codex'&&allowReportCorrection&&correctable&&current==='READY'&&h.receipt.dependencyState==='READY'&&canonicalVerified&&!h.admissionBlock&&
     Number(h.codexRequests||0)<24&&Number(h.verificationCorrections||0)<1){
     h.verificationCorrections=1;h.verificationFailure=failure;h.pendingReport=null;h.failure=null;h.userQuestion=null;
     goal.answer='Checking the supporting evidence before delivering the answer.';
     h.reportCorrection={...failure,at:new Date().toISOString()};
     return {needsCorrection:true,code:failure.code};
    }
    const classified=require('./outcome').classify({report,answer:goal.answer,verified,current,canonicalVerified,
     progress:h.admissionBlock?{...h.progress,finalReason:h.admissionBlock.code,requiresUserInput:false}:h.progress});
    goal.status=classified.status;goal.answer=classified.answer;
    if(verified&&goal.status==='COMPLETED'&&check.delivery)goal.checkpoint.delivery=check.delivery;
    if(verified&&navigation&&goal.status==='COMPLETED'){
     // A private browser observation is preparation, not user-visible delivery.
     // The authenticated website acknowledges the actual rendered destination.
     goal.checkpoint.navigation={...navigation,id:require('node:crypto').randomUUID(),state:'PENDING',
      resultAnswer:goal.answer};
     goal.status='WAITING_EVENT';goal.answer=`Ready to open ${navigation.label} in your browser.`;
    }
    h.failure=classified.failure||null;h.userQuestion=classified.question||null;
    h.verificationFailure=failure;
    h.pendingReport=null;goal.checkpoint.lifecycleStage=null;
    h.completionSource=goal.status==='COMPLETED'?'host_verified_answer':'unverified_answer';
    // A rejected narrative must not hide canonically committed work. Keep the
    // goal blocked and its precise verification failure; report only freshly
    // verified execution receipts, never promote a partial effect to success.
    if(!verified&&goal.status==='BLOCKED'&&canonicalVerified){
     const partial=require('./receipts').render(h.receipt);
     if(partial){goal.answer=partial;h.completionSource='partial_verified_receipt';}
    }
    h.finishedAt=new Date().toISOString();
   },{access});
  },
  async completeIfVerified(){
   // The verifier is supplied by trusted host code, never by a tool argument.
   // It must cover the ORIGINAL request, not merely the agent's chosen plan.
   if(!verifyOutcome)return null;
   const access=await authorize();return update(async(h,goal,client)=>{
    if(h.inflight)return null;
    const receipts=require('./receipts'),receipt=await receipts.collect(client,ctx,goal,h,access?.catalogue);
    if(receipt.dependencyState!=='READY'||receipt.operations.some(op=>!op.verified))return null;
    let verdict;try{verdict=await verifyOutcome(client,{goal:structuredClone(goal),receipt});}
    catch(error){throw Object.assign(new Error('WHOLE_GOAL_VERIFICATION_FAILED'),{code:'WHOLE_GOAL_VERIFICATION_FAILED',cause:error});}
    if(verdict?.complete!==true||!verdict.answer||!Array.isArray(verdict.evidence)||!verdict.evidence.length)return null;
    goal.answer=String(verdict.answer).slice(0,20000);goal.status='COMPLETED';
    h.userQuestion=null;h.pendingReport=null;
    h.receipt={...receipt,wholeGoalVerification:verdict.evidence};h.completionSource='host_verified_receipt';
    h.finishedAt=new Date().toISOString();return {answer:goal.answer,completionSource:h.completionSource};
   },{access});
  },
  async stop({code='HARNESS_INTERRUPTED',limitKind=null}={}){
   const interruption=()=>({code:String(code).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80),
    ...(typeof limitKind==='string'&&/^[a-z_]{1,80}$/.test(limitKind)?{limitKind}:{}),at:new Date().toISOString()});
   const existing=(await database.query(`SELECT status,run_token FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,goalId])).rows[0];
   if(!existing||existing.status!=='RUNNING'||existing.run_token!==runToken)return {
    status:existing&&existing.status!=='RUNNING'?existing.status:'BLOCKED',completionSource:'already_stopped',
    answer:'This worker no longer holds the goal. Its recorded state was not changed; review canonical status before continuing.'};
   // Reading business results still requires current authority. If it was
   // revoked, bookkeeping below records no new evidence or record content.
   let access;try{access=await authority();}catch{}
   // Host bookkeeping only: no provider request, approval, or effect. Match the
   // original lease so cleanup cannot overwrite cancellation or another run.
   return update(async(h,goal,client)=>{
    const waits=require('./waits');const refs=waits.dependencies(h);
    let current='BLOCKED';
    await client.query('SAVEPOINT dependency_check');
    try{current=!access||h.inflight?'BLOCKED':await waits.current(client,ctx,goalId,refs);await client.query('RELEASE SAVEPOINT dependency_check');}
    catch{await client.query('ROLLBACK TO SAVEPOINT dependency_check');h.verificationUnavailable=true;}
    // A saved question is a host handoff, independent of SDK completion. It
    // never overrides an uncertain effect or a canonical approval/event wait.
    if(access&&!h.inflight&&current==='READY'&&h.pendingReport?.status==='needs_user'){
     const classified=require('../../src/assistant/agent-conversation').classify({report:h.pendingReport});
     goal.status=classified.status;goal.answer=classified.answer;h.userQuestion=classified.question;
     h.pendingReport=null;h.failure=null;h.completionSource='durable_input_handoff';
     h.interruption=interruption();
     return {answer:goal.answer,status:goal.status,completionSource:h.completionSource};
    }
    goal.status=['WAITING_APPROVAL','WAITING_EVENT'].includes(current)?current:'BLOCKED';
    goal.answer=goal.status==='WAITING_APPROVAL'
     ?'The investigation stopped before final verification. Prepared changes still require approval; they are not completed.'
     :goal.status==='WAITING_EVENT'
      ?'The investigation stopped while canonical work is still pending. Its outcome is not yet verified.'
      :'The investigation stopped before final verification. Previously recorded business effects retain their canonical status; review them before continuing.';
    if(access?.catalogue&&!h.inflight){
     // A failed verifier must not roll back interruption bookkeeping. It is
     // intentionally not retried here, and its old receipt cannot earn success.
     // A SQL error aborts this transaction, so fresh checks are performed below
     // only in a savepoint that can be rolled back without losing the stop.
     await client.query('SAVEPOINT receipt_check');
     try{h.receipt=await require('./receipts').collect(client,ctx,goal,h,access.catalogue);
      const answer=require('./receipts').render(h.receipt);
      if(answer){goal.answer=answer;h.completionSource='partial_verified_receipt';}
      else {const observations=require('./evidence').report(h);if(observations){goal.answer=observations;h.completionSource='partial_observation_report';}}
      await client.query('RELEASE SAVEPOINT receipt_check');
     }catch{await client.query('ROLLBACK TO SAVEPOINT receipt_check');h.receipt=null;h.verificationUnavailable=true;}
    }
    h.dependencies=refs;
    if(code==='WHOLE_GOAL_VERIFICATION_FAILED')h.verificationUnavailable=true;
    h.interruption=interruption();
    return {answer:goal.answer,status:goal.status,completionSource:h.completionSource||'interrupted'};
   },{cleanup:true});
  }
 };
}
module.exports={createSession};
