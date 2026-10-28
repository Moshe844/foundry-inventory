'use strict';
// Pure canonical read/operation delivery metadata. Shared by interaction
// persistence and fresh verification; never calls a model or writes records.
function present(message,outcome,{batchId=null,planId=null,index=0,count=1,pending=null,interactionId=null}={}){
 const {step,args,provenance}=outcome,contract=step?.contract,result={...outcome.result};
 result.intent={intent:contract?.kind==='mutation'?'action':contract?.kind==='policy'?'instruction':contract?.kind==='navigation'?'navigation':'lookup',
  view:contract?.view||null,action:contract?.legacyAction||null,...args,
  controlPlane:contract?{capability:contract.name,args,provenance,dependsOn:step.dependsOn,continuesPending:step.continuesPending,
   originalMessage:step.continuesPending&&pending?.capability===contract.name?pending.originalMessage||message:message,
   ...(planId?{planId}:{}),...(result.pendingProposalId?{pendingProposalId:result.pendingProposalId}:{})}:null,
  ...(batchId?{batchId,sourceMessage:message,requestIndex:index+1,requestCount:count}:{}),
  ...(result.reportConfig?{reportConfig:result.reportConfig,comparisonSafe:result.comparisonSafe!==false}:{}),
  ...(result.proposal?{proposalId:result.proposal.id,proposalHref:result.proposal.href||`/actions/${result.proposal.id}`}:{})};
 if(interactionId){result.interactionId=interactionId;if(result.reportConfig)result.handoff={href:`/reports/from-ask/${interactionId}`,label:'Edit this report'};}
 return result;
}
module.exports={present};
