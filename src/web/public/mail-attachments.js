'use strict';
for(const panel of document.querySelectorAll('[data-mail-attachments]')){
 const progress=panel.querySelector('[data-attachment-progress]'),retry=panel.querySelector('[data-attachment-recheck]'),form=retry?.form;
 let timer=null,generation=0,submitting=false;
 const schedule=()=>{clearTimeout(timer);timer=setTimeout(poll,1500);};
 function apply(state){
  if(!Array.isArray(state.attachments)||!Number.isSafeInteger(state.ready)||!Number.isSafeInteger(state.total))throw Error('STATUS_UNAVAILABLE');
  for(const file of state.attachments){const label=panel.querySelector('[data-attachment-state="'+CSS.escape(file.id)+'"]');if(label)label.textContent=file.extraction_status==='READABLE'?'Ready to read':state.active?'Reading':'Needs review';}
  if(progress)progress.textContent=(state.active?'Reading attached documents. ':state.stopped?'Reading stopped. ':'')+state.ready+' of '+state.total+' documents ready.';
  if(retry)retry.disabled=submitting||state.active===true;
  if(state.active)schedule();else clearTimeout(timer);
 }
 async function poll(){
  if(document.hidden){schedule();return;}const current=generation;
  try{
   const response=await fetch(panel.dataset.statusUrl,{headers:{Accept:'application/json'},cache:'no-store'});
   if(!response.ok)throw Error('STATUS_UNAVAILABLE');const state=await response.json();if(current===generation)apply(state);
  }catch{if(current===generation&&progress)progress.textContent='Refresh this page to check the saved attachment status.';}
 }
 form?.addEventListener('submit',async event=>{
  event.preventDefault();if(submitting||retry.disabled)return;submitting=true;retry.disabled=true;generation++;clearTimeout(timer);
  try{
   const response=await fetch(form.action,{method:'POST',headers:{Accept:'application/json'},body:new URLSearchParams(new FormData(form))});
   if(!response.ok)throw Error('RECHECK_UNAVAILABLE');const state=await response.json();submitting=false;apply(state);
  }catch{submitting=false;if(progress)progress.textContent='The read could not be started. Refresh this page to check its saved status.';}
 });
 void poll();
}
