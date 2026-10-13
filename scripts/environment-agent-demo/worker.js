'use strict';
// Demo worker lifecycle. Bookkeeping and final verification need no provider.
// Both SDK workers share this boundary. The adaptive baseline stays unchanged.
async function run(options){
 const {session,candidate}=options;
 try{
  const previous=await session.completed?.();if(previous)return previous;
  const handoff=await session.handoffApprovals?.();if(handoff)return handoff;
  const completed=await session.completeIfVerified();if(completed)return completed;
  // Native Codex owns context loading and restoration. Its prepared context
  // has already been freshly authorized; a second load/inspection duplicates
  // the same work before the SDK even starts. Other runtimes retain their path.
  if(candidate!=='codex'){
   const saved=await session.load();
   if(saved.native.browserUrl&&options.browser.restore)await session.execute('environment_browser',
    {action:'restore'},()=>options.browser.restore(saved.native.browserUrl));
  }
  const result=candidate==='codex'?await require('./codex-runtime').run(options):await require('./candidates')[candidate](options);
  // Also cover an SDK ending locally without a visible result. A success flag
  // or a private reasoning block is never a user-visible final answer.
  if(typeof result.answer!=='string'||!result.answer.trim())throw Object.assign(new Error(require('./finalization').EMPTY_MESSAGE),{code:'EMPTY_MODEL_FINAL'});
  return result;
 }
 catch(error){
  if(error instanceof require('./approval-handoff').ApprovalHandoff)return error.result;
  if(error instanceof require('./context').VerifiedCompletion)return error.result;
  const committed=await session.completed?.();if(committed)return committed;
  const gate=options.transport?.lastBlock?.();
  const code=gate?.code||error.code||(/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'HARNESS_INTERRUPTED');
  // A committed approval is a separate host stage, not a failed SDK turn.
  // Preserve the stop in diagnostics while handing off without another call.
  const handoff=await session.handoffApprovals?.().catch(()=>null);
  if(handoff)return {...handoff,reasoningStop:{code}};
  // Never retry an uncertain paid request or change a spending limit here.
  const verified=code==='WHOLE_GOAL_VERIFICATION_FAILED'?null:await session.completeIfVerified().catch(()=>null);
  if(verified)return {...verified,interruption:{code}};
  let stopped;try{stopped=await session.stop({code});}catch(stopError){
   options.audit?.({kind:'session_stop_failed',code:stopError.code||stopError.message});
   stopped={status:'BLOCKED',bookkeepingFailed:true,answer:'This worker stopped without final verification. It could not update the goal; its current canonical state must be checked before continuing.'};
  }
  return {...stopped,interruption:{code,limitKind:gate?.limitKind||error.limitKind||null,
   upstreamAttempted:gate?.upstreamAttempted??null,usageSettled:gate?.usageSettled??null,message:gate?.message||error.message}};
 }
}
module.exports={run};
