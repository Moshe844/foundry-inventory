'use strict';
// Join the request ledger to canonical step results by durable IDs, never by
// matching the user's words. A delayed result stays with its original request.
function mergeGoalTranscript(transcript,goals,{focusedGoalId=null}={}){
 const byId=new Map(goals.map(goal=>[goal.id,{id:'agent-'+goal.id,message:goal.original_request,
  createdAt:goal.created_at,goals:[],agentGoal:goal,referents:[]}]));
 const turns=[];
 for(const turn of transcript){
  const batch=turn.understanding?.batchId;
  const parent=turn.understanding?.parentGoalId;
  const owner=goals.find(goal=>parent?parent===goal.id:batch===goal.id||typeof batch==='string'&&batch.startsWith(goal.id+':'));
  if(owner)byId.get(owner.id).goals.push(...turn.goals);
  // The database resolved this step to its owning tenant/actor's goal even
  // when that request is outside this conversation or the recent window.
  // A late internal result must never become a new customer request.
  else if(!parent)turns.push(turn);
 }
 const chronological=(a,b)=>new Date(a.createdAt)-new Date(b.createdAt)||String(a.id).localeCompare(String(b.id));
 const ordered=[...turns,...byId.values()].sort(chronological),recent=ordered.slice(-12);
 const focused=byId.get(focusedGoalId);
 // Legacy turns also consume the transcript window. Retain the explicitly
 // requested goal once, even when merging those turns pushes it outside it.
 if(focused&&!recent.includes(focused))recent.push(focused);
 return recent.sort(chronological);
}
module.exports={mergeGoalTranscript};
