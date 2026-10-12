'use strict';
// Unverified work is not a request for human input. A wait needs a concrete,
// structured question; pending business approvals remain canonical dependencies.
function classify({answer,verified,current='READY',canonicalVerified=true,progress={}}){
 if(current!=='READY')return {status:current,answer};
 if(verified&&canonicalVerified)return {status:'COMPLETED',answer};
 let request;try{request=JSON.parse(answer);}catch{}
 if(!progress.finalReason&&request?.status==='needs_user'&&
  typeof request.question==='string'&&request.question.trim()&&
  typeof request.missingInformation==='string'&&request.missingInformation.trim())
  return {status:'WAITING_USER',answer:request.question.trim(),question:{question:request.question.trim(),missingInformation:request.missingInformation.trim()}};
 return {status:'BLOCKED',answer:'Outcome not fully verified. Agent report:\n'+answer,
  failure:{code:progress.finalReason||'OUTCOME_UNVERIFIED',requiresUserInput:false}};
}
function failed(result){return Boolean(result&&(result.error||result.failure||['BLOCKED','INFRASTRUCTURE_FAILURE'].includes(result.status)));}
module.exports={classify,failed};
