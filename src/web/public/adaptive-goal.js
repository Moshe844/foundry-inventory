'use strict';
(() => {
 const phases={READY:'Getting started',RUNNING:'Working on your request',WAITING_APPROVAL:'Ready for your approval',WAITING_EVENT:'Waiting for confirmation',WAITING_USER:'Your input is needed',COMPLETED:'Completed and verified',BLOCKED:'Could not finish',CANCELLED:'Stopped'};
 function activity(event){
  const d=event.detail||{};
  if(event.kind==='approval_ready')return 'Prepared a change for your approval';
  if(d.kind==='runtime_starting')return d.status==='Opening the isolated business browser'?'Opening your business screens':d.status==='Starting the Codex SDK session'?'Starting the investigation':'Checking access and spending limits';
  if(d.kind==='runtime_failed')return 'Could not start the investigation';
  if(d.kind==='agent_tool_failed'||d.kind==='model_call_blocked')return 'A step needs attention';
  if(d.kind!=='agent_tool_started')return null;
  return ({environment_browser:'Looking through your StockChief screens',environment_interfaces:'Checking available business actions',business_dataset:'Checking your business records',business_operations:'Preparing an authorized business operation',environment_evidence:'Reviewing collected evidence'})[d.tool]||'Checking the information needed for your request';
 }
 function activities(events){
  const rows=[];
  for(const event of [...events].sort((a,b)=>a.sequence-b.sequence)){const label=activity(event);if(label&&rows.at(-1)?.label!==label)rows.push({label,at:event.created_at});}
  return rows.slice(-6);
 }
 if(typeof module!=='undefined'&&module.exports){module.exports={activity,activities};return;}
 for(const panel of document.querySelectorAll('[data-adaptive-goal]')){
  let status=panel.dataset.goalStatus,updated=panel.dataset.goalUpdated,rows=[];
  const phase=panel.querySelector('[data-goal-phase-text]'),hint=panel.querySelector('[data-goal-hint]');
  function elapsed(){
   const active=['READY','RUNNING','WAITING_EVENT'].includes(status);
   const start=new Date(panel.dataset.goalCreated).getTime(),end=active?Date.now():new Date(updated).getTime();
   const seconds=Math.max(0,Math.floor((end-start)/1000));
   panel.querySelector('[data-goal-elapsed]').textContent=seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;
   if(['READY','RUNNING'].includes(status))hint.textContent=seconds>=60?'This is taking longer than usual. You can leave this page; I’ll keep working.':'You can leave this page. I’ll keep working and show any required approval here.';
   panel.dataset.active=String(active);
   if(active)window.setTimeout(elapsed,1000);
  }
  elapsed();
  if(panel.dataset.goalLatest!=='true'&&!['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))continue;
  async function poll(){
   try{
    const result=await fetch(`/ask/goals/${encodeURIComponent(panel.dataset.adaptiveGoal)}`,{credentials:'same-origin'});
    if(result.ok){
     const goal=await result.json();
     if(goal.status!==status&&goal.status!=='RUNNING'){window.location.reload();return;}
     status=goal.status;updated=goal.updatedAt;panel.dataset.goalStatus=status;
     rows=activities(goal.events||[]);phase.textContent=status==='RUNNING'?(rows.at(-1)?.label||phases.RUNNING):(phases[status]||'Checking progress');
     const answer=panel.querySelector('[data-goal-answer]');answer.textContent=goal.answer||'';answer.hidden=!goal.answer;
     const timeline=panel.querySelector('[data-goal-timeline]');
     if(timeline){timeline.replaceChildren();for(const row of rows){const li=document.createElement('li');li.textContent=row.label;timeline.append(li);}}
    }
   }catch{hint.textContent='The connection was interrupted. Your request stays saved; reconnect to check its progress.';}
   if(['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))window.setTimeout(poll,3000);
  }
  poll();
 }
})();
