'use strict';
(() => {
 const phases={READY:'Getting started',RUNNING:'Working on your request',WAITING_APPROVAL:'Ready for your approval',WAITING_EVENT:'Waiting for confirmation',WAITING_USER:'Your input is needed',COMPLETED:'Completed and verified',BLOCKED:'Could not finish',CANCELLED:'Stopped'};
 function activity(event){
  const d=event.detail||{};
  if(event.kind==='approval_ready')return 'Prepared a change for your approval';
  if(d.kind==='runtime_starting')return d.status==='Opening the isolated business browser'?'Opening your business screens':d.status==='Starting the Codex SDK session'?'Starting the investigation':'Checking access and spending limits';
  if(d.kind==='runtime_failed')return 'The agent stopped before finishing';
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
  let status=panel.dataset.goalStatus,updated=panel.dataset.goalUpdated,rows=[],disconnected=false;
  const phase=panel.querySelector('[data-goal-phase-text]'),hint=panel.querySelector('[data-goal-hint]');
  function elapsed(){
   const active=['READY','RUNNING','WAITING_EVENT'].includes(status);
   const start=new Date(panel.dataset.goalCreated).getTime(),end=active?Date.now():new Date(updated).getTime();
   const seconds=Math.max(0,Math.floor((end-start)/1000));
   panel.querySelector('[data-goal-elapsed]').textContent=seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;
   if(disconnected)hint.textContent='Connection lost. Current progress is unknown; your request is saved.';
   else if(['READY','RUNNING'].includes(status))hint.textContent=seconds>=60?'This is taking longer than usual. You can leave this page; I’ll keep working.':'You can leave this page. I’ll keep working and show any required approval here.';
   else hint.textContent='';
   panel.dataset.active=String(active);
   if(active)window.setTimeout(elapsed,1000);
  }
  elapsed();
  if(panel.dataset.goalLatest!=='true'&&!['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))continue;
  async function poll(){
   try{
    const result=await fetch(`/ask/goals/${encodeURIComponent(panel.dataset.adaptiveGoal)}`,{credentials:'same-origin',cache:'no-store'});
    if(!result.ok)throw Error('Progress unavailable');
    if(result.ok){
     const goal=await result.json();
     const changed=goal.status!==status;
     disconnected=false;
     status=goal.status;updated=goal.updatedAt;panel.dataset.goalStatus=status;
     rows=activities(goal.events||[]);phase.textContent=status==='RUNNING'?(rows.at(-1)?.label||phases.RUNNING):(phases[status]||'Checking progress');
     const answer=panel.querySelector('[data-goal-answer]');answer.textContent=goal.answer||'';answer.hidden=!goal.answer;
     const timeline=panel.querySelector('[data-goal-timeline]');
     if(timeline){timeline.replaceChildren();for(const row of rows){const li=document.createElement('li');li.textContent=row.label;timeline.append(li);}}
     if(['COMPLETED','BLOCKED','CANCELLED'].includes(status)){
      panel.dataset.active='false';hint.textContent='';
      const stop=panel.querySelector('form[action$="/cancel"]');if(stop)stop.hidden=true;
      const seconds=Math.max(0,Math.floor((new Date(updated)-new Date(panel.dataset.goalCreated))/1000));
      panel.querySelector('[data-goal-elapsed]').textContent=seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;
     }
     // Update terminal truth immediately; never depend on a page reload to
     // stop the spinner. Reload only to obtain authenticated decision forms.
     if(changed&&['WAITING_APPROVAL','WAITING_USER'].includes(status)){window.location.reload();return;}
    }
   }catch{disconnected=true;hint.textContent='Connection lost. Current progress is unknown; your request is saved.';}
   if(['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))window.setTimeout(poll,3000);
  }
  poll();
 }
})();
