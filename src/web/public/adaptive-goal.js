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
  let status=panel.dataset.goalStatus,updated=panel.dataset.goalUpdated,rows=[],disconnected=false,elapsedTimer;
  const phase=panel.querySelector('[data-goal-phase-text]'),hint=panel.querySelector('[data-goal-hint]');
  function elapsed(){
   window.clearTimeout(elapsedTimer);
   const active=['READY','RUNNING'].includes(status);
   const timer=panel.querySelector('[data-goal-elapsed]');timer.hidden=status!=='RUNNING';
   const start=new Date(timer.dataset.runStarted||panel.dataset.goalCreated).getTime(),end=Date.now();
   const seconds=Math.max(0,Math.floor((end-start)/1000));
   panel.querySelector('[data-goal-elapsed]').textContent=seconds>=60?`${Math.floor(seconds/60)}m ${seconds%60}s`:`${seconds}s`;
   if(disconnected)hint.textContent='Connection lost. Current progress is unknown; your request is saved.';
   else if(['READY','RUNNING'].includes(status))hint.textContent=seconds>=60?'This is taking longer than usual. You can leave this page; I’ll keep working.':'You can leave this page. I’ll keep working and show any required approval here.';
   else hint.textContent='';
   panel.dataset.active=String(active);
   if(active)elapsedTimer=window.setTimeout(elapsed,1000);
  }
  elapsed();
  if(panel.dataset.goalLatest!=='true'&&!['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))continue;
  async function poll(){
   try{
    const result=await fetch(`/ask/goals/${encodeURIComponent(panel.dataset.adaptiveGoal)}`,{credentials:'same-origin',cache:'no-store'});
    if(!result.ok)throw Error('Progress unavailable');
    if(result.ok){
     const goal=await result.json();
     const conversation=goal.conversation;
     const changed=goal.status!==status;
     disconnected=false;
     status=goal.status;updated=goal.updatedAt;panel.dataset.goalStatus=status;
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
        sessionStorage.setItem(key,'1');navigation.elements.automatic.value='1';navigation.submit();return;
       }
      }
     }
     // A second tab can decide a proposal while this page keeps polling.
     // Remove obsolete decision forms immediately without losing draft text.
     if(status!=='WAITING_APPROVAL')for(const card of panel.querySelectorAll('[data-approval-id]'))card.remove();
     rows=activities(goal.events||[]);phase.textContent=conversation?.label||(phases[status]||'Checking progress');
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
        stamp.className='rm-agent__saved';stamp.textContent='Saved in this conversation';header.append(title,stamp);
        content.className='rm-agent__work-content';content.textContent=work.content;
        save.className='rm-btn rm-btn--ghost rm-btn--sm';save.textContent='Save a copy';save.href=`/ask/goals/${encodeURIComponent(goal.id)}/work/${encodeURIComponent(work.id)}`;save.download='';
        card.append(header,content,save);root.append(card);
       }
       if(saved.workProducts.length){const continueButton=document.createElement('button');continueButton.type='button';continueButton.className='rm-btn rm-btn--ghost rm-btn--sm';continueButton.textContent='Continue with this work';continueButton.onclick=()=>selectWork(goal.id,saved.id);root.append(continueButton);}
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
         summary.textContent='What this does';explanation.textContent=action.instruction;details.append(summary,explanation);row.append(form,details);buttons.append(row);
        }
        note.className='rm-agent__next-note';note.textContent='Next steps continue with StockChief. Any consequential action still requires its usual authorization and approval.';
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
       context.hidden=!conversation?.canReply;context.textContent='Reply to StockChief’s question to continue this request.';
      }
     }
     const history=document.querySelector(`[data-conversation-history-for="${CSS.escape(goal.id)}"]`);
     if(history&&conversation){
      const turns=conversation.history.filter((turn,index)=>!(index===conversation.history.length-1&&turn.role==='assistant'&&turn.text===message));
      history.replaceChildren();for(const turn of turns){const row=document.createElement('div'),label=document.createElement('p'),body=document.createElement('div');
       row.className='rm-agent__exchange';label.className='rm-stamp';label.textContent=turn.role==='user'?'You':'StockChief';
       if(window.StockChiefAnswer)body.innerHTML=window.StockChiefAnswer.render(turn.text);else body.textContent=turn.text;
       row.append(label,body);history.append(row);
      }
     }
     const timeline=panel.querySelector('[data-goal-timeline]');
     if(timeline){timeline.replaceChildren();for(const row of rows){const li=document.createElement('li');li.textContent=row.label;timeline.append(li);}}
     if(['COMPLETED','BLOCKED','CANCELLED'].includes(status)){
      panel.dataset.active='false';hint.textContent='';
      const stop=panel.querySelector('form[action$="/cancel"]');if(stop)stop.hidden=true;
      panel.querySelector('[data-goal-elapsed]').hidden=true;
     }
     // Update terminal truth immediately; never depend on a page reload to
     // stop the spinner. Reload only to obtain authenticated decision forms.
     if(changed&&status==='WAITING_APPROVAL'){
      const draft=document.querySelector('#tell-foundry textarea[name="message"]');
      if(!(draft?.value||'').trim()){window.location.reload();return;}
      hint.textContent='A change is ready for review. Your draft is preserved; reload when you are ready to review the approval.';
     }
    }
   }catch{disconnected=true;hint.textContent='Connection lost. Current progress is unknown; your request is saved.';}
   if(['READY','RUNNING','WAITING_EVENT','WAITING_APPROVAL'].includes(status))window.setTimeout(poll,['READY','RUNNING'].includes(status)?1000:3000);
  }
  poll();
 }
})();
