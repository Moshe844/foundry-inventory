'use strict';
(() => {
 const phases={READY:'Waiting to start',RUNNING:'Working on your request',WAITING_APPROVAL:'Ready for your approval',WAITING_EVENT:'Waiting for confirmation',WAITING_USER:'Your input is needed',COMPLETED:'Completed',BLOCKED:'Could not finish',CANCELLED:'Stopped'};
 function activity(event){
  const d=event.detail||{};
  if(event.kind==='approval_ready')return 'Prepared a change for your approval';
  if(d.kind==='runtime_starting')return d.status==='Opening the isolated business browser'?'Opening your business screens':d.status==='Starting the Codex SDK session'?'Starting the investigation':'Checking access and spending limits';
  if(d.kind==='runtime_failed')return 'The agent stopped before finishing';
  if(d.kind==='agent_tool_failed'||d.kind==='model_call_blocked')return 'A step needs attention';
  if(d.kind==='answer_scope_review_started')return 'Checking the answer against your request';
  if(d.kind==='host_final_verification')return 'Verifying the result';
  if(d.kind==='native_report_correction')return 'Rechecking the supporting information';
  if(d.kind!=='agent_tool_started')return null;
  return ({environment_browser:'Looking through your StockChief screens',environment_interfaces:'Checking available business actions',business_dataset:'Checking your business records',environment_dataset:'Checking your business records',business_operations:'Working with your business records',environment_evidence:'Reviewing collected evidence'})[d.tool]||'Checking the information needed for your request';
 }
 function activities(events){
  const rows=[];
  for(const event of [...events].sort((a,b)=>a.sequence-b.sequence)){const label=activity(event);if(label&&rows.at(-1)?.label!==label)rows.push({label,at:event.created_at});}
  return rows.slice(-6);
 }
 function approvalChange(current,next){
  if(!Array.isArray(next))return {removed:[],added:[]};
  return {removed:current.filter(id=>!next.includes(id)),added:next.filter(id=>!current.includes(id))};
 }
 if(typeof module!=='undefined'&&module.exports){module.exports={activity,activities,approvalChange};return;}
 function selectWork(goalId,deliveryId){
  const composer=document.getElementById('tell-foundry');if(!composer)return;
  for(const [name,value]of Object.entries({sourceGoalId:goalId,deliveryId,continueGoalId:'',questionId:''})){
   let field=composer.querySelector(`input[name="${name}"]`);
   if(!field){field=document.createElement('input');field.type='hidden';field.name=name;composer.append(field);}field.value=value;
  }
  let context=composer.querySelector('[data-agent-work-context]');
  if(!context){context=document.createElement('p');context.dataset.agentWorkContext='';context.className='rm-composer__context';composer.prepend(context);}
  context.replaceChildren(document.createTextNode('Your next request will include this saved work. '));
  const clear=document.createElement('button');clear.type='button';clear.className='rm-btn rm-btn--ghost rm-btn--sm';clear.textContent='Clear selection';
  clear.onclick=()=>{for(const name of ['sourceGoalId','deliveryId'])composer.querySelector(`input[name="${name}"]`).value='';context.remove();};
  context.append(clear);composer.querySelector('textarea[name="message"],input[name="message"]')?.focus();
 }
 for(const button of document.querySelectorAll('[data-work-continuation]'))button.onclick=()=>selectWork(button.dataset.sourceGoal,button.dataset.deliveryId);
 for(const panel of document.querySelectorAll('[data-adaptive-goal]')){
  let status=panel.dataset.goalStatus,updated=panel.dataset.goalUpdated,rows=[],disconnected=false,workerAvailable=panel.dataset.workerAvailable!=='false',elapsedTimer;
  const phase=panel.querySelector('[data-goal-phase-text]'),hint=panel.querySelector('[data-goal-hint]');
  function elapsed(){
   window.clearTimeout(elapsedTimer);
   const active=['READY','RUNNING'].includes(status);
   const timer=panel.querySelector('[data-goal-elapsed]');timer.hidden=!active;
   const start=new Date(status==='READY'?panel.dataset.goalCreated:timer.dataset.runStarted||panel.dataset.goalCreated).getTime(),end=Date.now();
   const seconds=Math.max(0,Math.floor((end-start)/1000));
   timer.textContent=(status==='READY'?'Waiting ':'')+(seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`);
   if(disconnected)hint.textContent='Connection lost. Current progress is unknown; your request is saved.';
   else if(['READY','RUNNING'].includes(status)&&!workerAvailable)hint.textContent='The agent is temporarily unavailable. Your request is saved and will wait for service to return.';
   else if(status==='READY')hint.textContent='You can leave this page. Your request will start when an agent is available.';
   else if(status==='RUNNING')hint.textContent=seconds>=60?'This is taking longer than usual. You can leave this page; I’ll keep working.':'You can leave this page. I’ll keep working and show any required approval here.';
   else hint.textContent='';
   panel.dataset.active=String(active);
   if(active)elapsedTimer=window.setTimeout(elapsed,1000);
  }
  elapsed();
  if(panel.dataset.goalLatest!=='true'&&!['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))continue;
  async function poll(){
   try{
    const result=await fetch(`/ask/goals/${encodeURIComponent(panel.dataset.adaptiveGoal)}`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
    if(!result.ok)throw Error('Progress unavailable');
    if(result.ok){
     const goal=await result.json();
     const conversation=goal.conversation;
     const changed=goal.status!==status;
     disconnected=false;
     status=goal.status;updated=goal.updatedAt;panel.dataset.goalStatus=status;
     if(typeof goal.workerAvailable==='boolean')workerAvailable=goal.workerAvailable;
     const resume=panel.querySelector('[data-goal-resume]');if(resume)resume.hidden=status!=='BLOCKED'||goal.continuation?.eligible!==true;
     const recovery=panel.querySelector('[data-goal-recovery-reason]');if(recovery){recovery.hidden=status!=='BLOCKED'||goal.continuation?.eligible!==false;recovery.textContent=goal.continuation?.eligible===false?goal.continuation.reason:'';}
     if(goal.runStartedAt)panel.querySelector('[data-goal-elapsed]').dataset.runStarted=goal.runStartedAt;
     elapsed();
     const prerequisites=panel.querySelector('[data-goal-prerequisites]');
     if(prerequisites){
      prerequisites.replaceChildren();
      for(const handoff of goal.prerequisiteHandoffs||[]){
       const link=document.createElement('a');link.className='rm-btn rm-btn--sm';
       link.href=handoff.href;link.textContent=handoff.label;prerequisites.append(link);
      }
     }
     const navigation=panel.querySelector('[data-goal-navigation]');
     if(navigation){
      navigation.hidden=!goal.navigation;
      if(goal.navigation){
       navigation.querySelector('[data-navigation-label]').textContent=`Open ${goal.navigation.label}`;
       phase.textContent='Opening the requested page';
       // Never navigate away with unsent input, from an older conversation, or
       // from a second tab after the durable delivery has already started.
       const hasDraft=[...document.querySelectorAll('textarea[name="message"],input[name="message"]')]
        .some(field=>!field.closest('[hidden]')&&(field.value||'').trim());
       const key=`stockchief-navigation:${goal.id}:${goal.navigation.id}`;
       if(goal.navigation.automatic&&goal.navigation.state==='PENDING'&&!hasDraft&&!sessionStorage.getItem(key)){
        sessionStorage.setItem(key,'1');navigation.elements.automatic.value='1';if(window.frameElement?.dataset.embeddedAsk==='true')navigation.target='_top';navigation.submit();return;
       }
      }
     }
     // A second tab can decide a proposal while this page keeps polling.
     // Remove obsolete decision forms immediately without losing draft text.
     if(status!=='WAITING_APPROVAL')for(const card of panel.querySelectorAll('[data-approval-id]'))card.remove();
     rows=activities(goal.events||[]);phase.textContent=status==='RUNNING'&&(!conversation||conversation.phase==='working')&&rows.length
      ?rows.at(-1).label:conversation?.label||(phases[status]||'Checking progress');
     const answer=panel.querySelector('[data-goal-answer]');
     const message=conversation?.message||'';
     if(window.StockChiefAnswer)answer.innerHTML=window.StockChiefAnswer.render(message);else answer.textContent=message;
     answer.hidden=!message;
     const deliveryPanel=panel.querySelector('[data-goal-delivery]');
     if(deliveryPanel&&deliveryPanel.dataset.revision!==(goal.delivery?.id||'')){
      deliveryPanel.dataset.revision=goal.delivery?.id||'';deliveryPanel.replaceChildren();
      const saved=goal.delivery;
      if(saved){
       const root=document.createElement('div');root.className='rm-agent__delivery';root.dataset.deliveryId=saved.id;
       for(const work of saved.workProducts){
        const card=document.createElement('article'),header=document.createElement('div'),title=document.createElement('h3'),stamp=document.createElement('span'),content=document.createElement('div'),save=document.createElement('a');
        card.className='rm-agent__work';card.setAttribute('aria-label',work.title);header.className='rm-agent__work-header';title.textContent=work.title;
        stamp.className='rm-agent__saved';stamp.textContent='';header.append(title,stamp);
        content.className='rm-agent__work-content rm-agent__answer';
        if(window.StockChiefAnswer)content.innerHTML=window.StockChiefAnswer.render(work.content);else content.textContent=work.content;
        save.className='rm-btn rm-btn--ghost rm-btn--sm';save.textContent='Download';save.href=`/ask/goals/${encodeURIComponent(goal.id)}/work/${encodeURIComponent(work.id)}`;save.download='';
        card.append(header,content,save);root.append(card);
       }
       if(saved.workProducts.length){const continueButton=document.createElement('button');continueButton.type='button';continueButton.className='rm-btn rm-btn--ghost rm-btn--sm';continueButton.textContent='Ask a follow-up';continueButton.onclick=()=>selectWork(goal.id,saved.id);root.append(continueButton);}
       if(saved.nextActions.length){
        const next=document.createElement('div'),heading=document.createElement('p'),buttons=document.createElement('div'),note=document.createElement('p');
        next.className='rm-agent__next';heading.textContent='What would you like to do next?';buttons.className='rm-agent__next-actions';
        for(const action of saved.nextActions){
         const row=document.createElement('div'),form=document.createElement('form'),button=document.createElement('button'),details=document.createElement('details'),summary=document.createElement('summary'),explanation=document.createElement('p');
         form.method='post';form.action=`/ask/goals/${encodeURIComponent(goal.id)}/next`;
         for(const [name,value]of Object.entries({_csrf:panel.querySelector('input[name="_csrf"]').value,deliveryId:saved.id,actionId:action.id})){
          const input=document.createElement('input');input.type='hidden';input.name=name;input.value=value;form.append(input);
         }
         button.type='submit';button.className='rm-btn rm-btn--sm';button.textContent=action.label;form.append(button);
         summary.textContent='Proposed change';explanation.textContent=action.instruction;details.append(summary,explanation);row.append(form,details);buttons.append(row);
        }
        note.className='rm-agent__next-note';note.textContent='Review any proposed changes before they run.';
        next.append(heading,buttons,note);root.append(next);
       }
       deliveryPanel.append(root);
      }
     }
     const reply=panel.querySelector('[data-goal-reply]');
     if(reply){reply.hidden=!conversation?.canReply||panel.dataset.goalLatest==='true';reply.elements.questionId.value=conversation?.input?.id||'';}
     if(panel.dataset.goalLatest==='true'){
      const composer=document.getElementById('tell-foundry');
      if(composer)for(const [name,value]of Object.entries({continueGoalId:conversation?.canReply?goal.id:'',questionId:conversation?.input?.id||''})){
       let input=composer.querySelector(`input[name="${name}"]`);
       if(!input){input=document.createElement('input');input.type='hidden';input.name=name;composer.append(input);}input.value=value;
      }
      if(composer){let context=composer.querySelector('[data-agent-reply-context]');
       if(!context){context=document.createElement('p');context.dataset.agentReplyContext='';context.className='rm-composer__context';composer.prepend(context);}
       context.hidden=!conversation?.canReply;context.textContent='Your answer';
      }
     }
     const history=document.querySelector(`[data-conversation-history-for="${CSS.escape(goal.id)}"]`);
     if(history&&conversation){
      const turns=conversation.history.filter((turn,index)=>!(index===conversation.history.length-1&&turn.role==='assistant'&&turn.text===message));
      history.replaceChildren();for(const turn of turns){const row=document.createElement('div'),label=document.createElement('p'),body=document.createElement('div');
       row.className='rm-agent__exchange rm-agent__exchange--'+(turn.role==='user'?'user':'assistant');label.className='rm-agent__speaker';label.textContent=turn.role==='user'?'You':'StockChief';body.className='rm-agent__bubble rm-agent__answer';
       if(window.StockChiefAnswer)body.innerHTML=window.StockChiefAnswer.render(turn.text);else body.textContent=turn.text;
       row.append(label,body);history.append(row);
      }
     }
     const timeline=panel.querySelector('[data-goal-timeline]');
     if(timeline){timeline.replaceChildren();for(const row of rows){const li=document.createElement('li');li.textContent=row.label;timeline.append(li);}}
     const stopControl=panel.querySelector('form[action$="/cancel"]');if(stopControl)stopControl.hidden=!['READY','RUNNING'].includes(status);
     if(['COMPLETED','BLOCKED','CANCELLED','WAITING_USER'].includes(status)){
      panel.dataset.active='false';hint.textContent='';if(changed&&panel.dataset.goalLatest==='true'){
       const input=document.querySelector('#tell-foundry textarea[name=message]'),active=document.activeElement;
       // Fragment navigation focuses a non-interactive answer marker. Treat
       // that like page focus, while preserving a field or control the user
       // deliberately selected elsewhere during the investigation.
       const otherControl=active?.matches('input,textarea,select,button,a[href],[contenteditable="true"]')&&!active.closest('#tell-foundry');
       if(input&&!input.disabled&&!document.querySelector('dialog[open]')&&!otherControl)input.focus({preventScroll:true});
      }
      const stop=panel.querySelector('form[action$="/cancel"]');if(stop)stop.hidden=true;
      panel.querySelector('[data-goal-elapsed]').hidden=true;
     }
     // Update terminal truth immediately; never depend on a page reload to
     // stop the spinner. Reload only to obtain authenticated decision forms.
     const approvalIds=Array.isArray(goal.approvalIds)?goal.approvalIds:null;
     const visibleApprovals=[...panel.querySelectorAll('[data-approval-id]')];
     const approvalDelta=approvalChange(visibleApprovals.map(card=>card.dataset.approvalId),approvalIds);
     for(const card of visibleApprovals)if(approvalDelta.removed.includes(card.dataset.approvalId))card.remove();
     const newApproval=approvalDelta.added.length>0;
     if((changed||newApproval)&&status==='WAITING_APPROVAL'){
      const draft=document.querySelector('#tell-foundry textarea[name="message"]');
      if(!(draft?.value||'').trim()){const current=new URL(window.location.href);if(current.pathname==='/ask'&&current.searchParams.get('goal')===goal.id)window.location.reload();else window.location.assign('/ask?goal='+encodeURIComponent(goal.id)+'#focused-goal');return;}
      hint.textContent='A change is ready for review. Your draft is preserved; reload when you are ready to review the approval.';
     }
    }
   }catch{disconnected=true;hint.textContent='Connection lost. Current progress is unknown; your request is saved.';}
   if(['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))window.setTimeout(poll,['READY','RUNNING'].includes(status)?1000:3000);
  }
  poll();
 }
})();
