'use strict';
const {createHash}=require('node:crypto');
const TABLE='stockchief_runtime.assistant_goals';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

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
 async function authority(){const access=await authorize();
  if(access?.actor)await update(h=>{const stamp=createHash('sha256').update(JSON.stringify(stable(access.actor))).digest('hex');
   if(h.authorityStamp&&h.authorityStamp!==stamp)throw new Error('SESSION_AUTHORITY_CHANGED');h.authorityStamp=stamp;});
  return access;
 }
 async function update(change,{cleanup=false}={}){return database.transaction(async client=>{
  const goal=(await client.query(`SELECT * FROM ${TABLE} WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,
   [ctx.workspaceId,ctx.actorId,goalId])).rows[0];
  if(!goal||goal.status!=='RUNNING'||goal.run_token!==runToken||!cleanup&&(new Date(goal.lease_until)<=new Date()||new Date(goal.expires_at)<=new Date()))
   throw new Error('SESSION_LEASE_LOST');
  const cp=goal.checkpoint;cp.harness||={candidate,sequence:0,calls:{},native:{}};
  if(cp.harness.candidate!==candidate)throw new Error('SESSION_CANDIDATE_MISMATCH');
  const result=await change(cp.harness,goal,client);
  if(Buffer.byteLength(JSON.stringify(cp))>8*1024*1024)throw new Error('SESSION_SIZE_LIMIT');
  await client.query(`UPDATE ${TABLE} SET checkpoint=$4::jsonb,status=$5,answer=$6,tool_calls=$7,
   run_token=CASE WHEN $5='RUNNING' THEN run_token ELSE NULL END,
   lease_until=CASE WHEN $5='RUNNING' THEN now()+interval '10 minutes' ELSE NULL END,updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
   [ctx.workspaceId,ctx.actorId,goalId,JSON.stringify(cp),goal.status,goal.answer,goal.tool_calls]);
  return result;
 },{isolation:'SERIALIZABLE',retrySafe:true});}
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
  async load(){await authority();return update((h,goal)=>({...structuredClone(h),goalContext:{
   originalRequest:goal.original_request,messages:structuredClone(goal.checkpoint.messages||[])}}));},
  async checkpoint(native){await authority();return update(h=>{h.native={...h.native,...native};});},
  async workingMemory(){await authority();return update(h=>require('./memory').working(h));},
  async codexRequest(){await authority();return update(h=>{
   if(candidate!=='codex')throw new Error('NOT_A_CODEX_SESSION');
   h.codexRequests||=0;
   if(h.codexRequests>=24)throw new Error('DURABLE_MODEL_REQUEST_LIMIT');
   h.codexRequests++;
   return {request:h.codexRequests};
  });},
  async codexReplay(hash){await authority();return update(h=>{
   if(candidate!=='codex')throw new Error('NOT_A_CODEX_SESSION');
   if(h.codexDelivery?.state==='PENDING')throw new Error('CODEX_RESPONSE_RECONCILIATION_REQUIRED');
   return h.codexDelivery?.hash===hash?structuredClone(h.codexDelivery.packet):null;
  });},
  async codexPending(hash){await authority();return update(h=>{
   if(candidate!=='codex'||h.codexDelivery?.state==='PENDING')throw new Error('CODEX_RESPONSE_RECONCILIATION_REQUIRED');
   h.codexDelivery={hash,state:'PENDING'};
  });},
  async codexDelivered(hash,packet,outcome){await authority();return update(h=>{
   if(candidate!=='codex'||h.codexDelivery?.hash!==hash||h.codexDelivery.state!=='PENDING')throw new Error('CODEX_RESPONSE_SEQUENCE_MISMATCH');
   h.codexDelivery={hash,state:'SETTLED',packet};h.lastCodexResponse={...outcome,request:h.codexRequests};
  });},
  async modelControl({budgetFinal=false}={}){await authority();return update(h=>{
   h.modelRequests||=0;
   if(h.lastModelResponse?.empty)throw Object.assign(new Error(require('./finalization').EMPTY_MESSAGE),{code:'EMPTY_MODEL_FINAL'});
   if(h.modelRequests>=24||h.finalRequestSent)throw Object.assign(new Error('FINAL_REQUEST_EXHAUSTED'),{code:'FINAL_REQUEST_EXHAUSTED'});
   h.modelRequests++;
   const reason=h.progress?.finalReason||(h.modelRequests===24?'FINAL_TURN_RESERVED':budgetFinal?'FINAL_COST_HEADROOM':null);
   if(reason)h.finalRequestSent=true;
   return {request:h.modelRequests,final:Boolean(reason),reason};
  });},
  async modelResponse(outcome){await authority();return update(h=>{
   if(outcome.request!==h.modelRequests)throw new Error('MODEL_RESPONSE_SEQUENCE_MISMATCH');
   h.lastModelResponse={request:outcome.request,final:Boolean(outcome.final),terminal:Boolean(outcome.terminal),
    visible:Boolean(outcome.visible),tool:Boolean(outcome.tool),empty:Boolean(outcome.empty),stopReason:outcome.stopReason,
    usageSettled:Boolean(outcome.usageSettled)};
  });},
  async evidenceIndex(){await authority();return update(h=>require('./observations').index(h));},
  async present(output,{full=false}={}){await authority();return update(h=>{
   const text=JSON.stringify(output)??'null',legacyText=JSON.stringify(output?.image?output.screen:output)??'null';
   const entry=require('./observations').ordered(Object.values(h.evidence||{})).findLast(e=>e.text===text||e.text===legacyText||e.truncated&&e.text===text.slice(0,128000));
   if(full&&entry){const reference={evidenceId:entry.id,sha256:entry.sha256,observedAt:entry.at,untrusted:true};
    return output?.image?{...output,screen:{...output.screen,_stockchiefEvidence:reference}}:{...output,_stockchiefEvidence:reference};}
   return entry?require('./context').preview(output,entry.id):output;
  });},
  async evidence(input){await authority();return update(h=>require('./observations').retrieve(h,input));},
  async execute(name,input,operation){
   const access=await authority();
   const business=name==='business_operations';
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
     return {replay};
    }
    h.inflight={id,name,fingerprint,consequential};return {id};
   });}catch(error){
    if(['DURABLE_TOOL_LIMIT','SESSION_OPERATION_UNRESOLVED'].includes(error.message))
     await update(h=>{h.admissionBlock={code:error.message,requiresUserInput:false};}).catch(()=>{});
    throw error;
   }
   if(Object.hasOwn(start,'replay'))return start.replay;
   try{
    const result=await operation(start.id);
    const approvals=await update(async(h,goal,client)=>{
     if(h.inflight?.id!==start.id)throw new Error('SESSION_OPERATION_MISMATCH');
     if(consequential)h.calls[fingerprint]={id:start.id,state:'DONE',result};
     if(name!=='environment_evidence'){
      require('./observations').store(h,{id:start.id,name,result});
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
     if(candidate==='codex'&&business){const cards=await require('./approval-handoff').stage(client,ctx,goal,h);return {approvals:cards};}
    });
    await notifyApprovals(approvals);return result;
   }catch(error){
    await update((h,goal)=>{
     if(consequential&&error.effectMayHaveOccurred!==false){goal.status='BLOCKED';goal.answer='An operation was interrupted. Reconcile its canonical records before retrying.';}
     else {h.inflight=null;h.lastToolError={name,code:error.code||'TOOL_FAILED',
      message:error.code==='TOOL_CONTRACT_INVALID'?String(error.message).slice(0,1500):'Tool failed; inspect current state before trying again.'};}
    });throw error;
   }
  },
  async finish({answer,verified=false}){
   const access=await authority();return update(async(h,goal,client)=>{
    if(h.inflight)throw new Error('SESSION_OPERATION_UNRESOLVED');
    // Only a host verifier may set verified; SDK final text is not verification.
    goal.answer=String(answer||'').slice(0,20000);
    const waits=require('./waits');const refs=waits.dependencies(h);
    const current=await waits.current(client,ctx,goalId,refs);
    h.dependencies=refs;
    h.receipt=await require('./receipts').collect(client,ctx,goal,h,access?.catalogue);
    const canonicalVerified=!h.receipt.operations.some(op=>!op.verified);
    const classified=require('./outcome').classify({answer:goal.answer,verified,current,canonicalVerified,
     progress:h.admissionBlock?{...h.progress,finalReason:h.admissionBlock.code}:h.progress});
    goal.status=classified.status;goal.answer=classified.answer;
    h.failure=classified.failure||null;h.userQuestion=classified.question||null;
    h.completionSource=goal.status==='COMPLETED'?'host_verified_answer':'unverified_answer';
    h.finishedAt=new Date().toISOString();
   });
  },
  async completeIfVerified(){
   // The verifier is supplied by trusted host code, never by a tool argument.
   // It must cover the ORIGINAL request, not merely the agent's chosen plan.
   if(!verifyOutcome)return null;
   const access=await authority();return update(async(h,goal,client)=>{
    if(h.inflight)return null;
    const receipts=require('./receipts'),receipt=await receipts.collect(client,ctx,goal,h,access?.catalogue);
    if(receipt.dependencyState!=='READY'||receipt.operations.some(op=>!op.verified))return null;
    let verdict;try{verdict=await verifyOutcome(client,{goal:structuredClone(goal),receipt});}
    catch(error){throw Object.assign(new Error('WHOLE_GOAL_VERIFICATION_FAILED'),{code:'WHOLE_GOAL_VERIFICATION_FAILED',cause:error});}
    if(verdict?.complete!==true||!verdict.answer||!Array.isArray(verdict.evidence)||!verdict.evidence.length)return null;
    goal.answer=String(verdict.answer).slice(0,20000);goal.status='COMPLETED';
    h.receipt={...receipt,wholeGoalVerification:verdict.evidence};h.completionSource='host_verified_receipt';
    h.finishedAt=new Date().toISOString();return {answer:goal.answer,completionSource:h.completionSource};
   });
  },
  async stop({code='HARNESS_INTERRUPTED'}={}){
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
    h.interruption={code:String(code).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80),at:new Date().toISOString()};
    return {answer:goal.answer,status:goal.status,completionSource:h.completionSource||'interrupted'};
   },{cleanup:true});
  }
 };
}
module.exports={createSession};
