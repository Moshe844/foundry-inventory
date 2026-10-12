'use strict';
// Join the request ledger to canonical step results by durable IDs, never by
// matching the user's words. A delayed result stays with its original request.
function mergeGoalTranscript(transcript,goals){
 const byId=new Map(goals.map(goal=>[goal.id,{id:'agent-'+goal.id,message:goal.original_request,
  createdAt:goal.created_at,goals:[],agentGoal:goal,referents:[]}]));
 const turns=[];
 for(const turn of transcript){
  const batch=turn.understanding?.batchId;
  const owner=goals.find(goal=>batch===goal.id||typeof batch==='string'&&batch.startsWith(goal.id+':'));
  if(owner)byId.get(owner.id).goals.push(...turn.goals);
  else turns.push(turn);
 }
 return [...turns,...byId.values()].sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt)||String(a.id).localeCompare(String(b.id))).slice(-12);
}
module.exports={mergeGoalTranscript};
