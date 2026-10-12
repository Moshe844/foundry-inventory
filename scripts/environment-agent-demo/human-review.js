'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
function publish({task,candidate,proposal,outputDirectory,deliveryId=null}){
 const id=deliveryId?createHash('sha256').update(deliveryId).digest('hex'):randomUUID();
 const request=path.join(outputDirectory,`review-${id}.json`),decisionFile=path.join(outputDirectory,`decision-${id}.json`);
 if(fs.existsSync(request)){
  const packet=JSON.parse(fs.readFileSync(request));
  if(packet.task!==task.id||packet.candidate!==candidate||packet.proposalId!==proposal.id||
   JSON.stringify(packet.payload)!==JSON.stringify(proposal.payload)||packet.deliveryId!==deliveryId)throw Error('APPROVAL_PRESENTATION_CHANGED');
  return {packet,request,decisionFile};
 }
 const packet={id,deliveryId,task:task.id,candidate,goal:task.prompt,proposalId:proposal.id,
  action:proposal.action_type,summary:proposal.summary,payload:proposal.payload,createdAt:new Date().toISOString()};
 packet.hash=createHash('sha256').update(JSON.stringify(packet)).digest('hex');
 fs.writeFileSync(request,JSON.stringify(packet,null,2),{flag:'wx'});
 console.log(JSON.stringify({event:'human_review_required',request,decisionFile,packet}));
 return {packet,request,decisionFile};
}
async function review(options){
 const {packet,decisionFile}=publish(options);
 const started=Date.now();
 while(Date.now()-started<20*60000){
  if(fs.existsSync(decisionFile)){
   const d=JSON.parse(fs.readFileSync(decisionFile,'utf8'));
   if(d.requestId!==packet.id||d.hash!==packet.hash||d.source!=='human_user'||typeof d.approved!=='boolean'||!d.responseReference)
    throw new Error('INVALID_HUMAN_REVIEW_DECISION');
   return {approved:d.approved,responded:true,responseReference:d.responseReference,waitMs:Date.now()-started};
  }
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 return {approved:false,responded:false,reason:'human_review_timeout',waitMs:Date.now()-started};
}
review.publish=publish;
module.exports={review,publish};
