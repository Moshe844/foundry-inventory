'use strict';
(() => {
 const panel=document.querySelector('[data-adaptive-goal]');if(!panel)return;
 const initial=panel.dataset.goalStatus;
 if(!['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(initial))return;
 async function poll(){
  try{const result=await fetch(`/ask/goals/${encodeURIComponent(panel.dataset.adaptiveGoal)}`,{credentials:'same-origin'});
   if(!result.ok)return;const goal=await result.json();
   if(goal.status!==initial){window.location.reload();return;}
   panel.querySelector('[data-goal-answer]').textContent=goal.answer||'Investigating your goal…';
   const timeline=panel.querySelector('[data-goal-timeline]');
   if(timeline&&goal.events){timeline.replaceChildren();for(const event of [...goal.events].reverse()){
    const row=document.createElement('li'),d=event.detail||{};
    row.textContent=event.kind==='approval_ready'?'Prepared an operation for your approval':
     d.kind==='agent_tool_started'?`Investigating with ${(d.tool||'a tool').replaceAll('_',' ')}`:
     d.kind==='agent_tool_completed'?`Completed ${(d.tool||'a step').replaceAll('_',' ')}`:
     d.kind==='browser_action'?`Browser: ${d.action}`:d.kind==='model_call'?'Reasoning step completed':
     d.kind==='agent_tool_failed'||d.kind==='model_call_blocked'?'A step stopped safely; checking recovery':null;
    if(row.textContent)timeline.append(row);
   }}
  }catch{}
  window.setTimeout(poll,3000);
 }
 window.setTimeout(poll,3000);
})();
