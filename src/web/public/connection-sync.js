'use strict';
(()=>{
 const root=document.querySelector('[data-connection-synchronization]');if(!root)return;
 const status=root.querySelector('[data-connection-sync-progress]'),updated=root.querySelector('[data-connection-sync-updated]');
 const format=value=>new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'medium'}).format(new Date(value));
 let pending=false;
 async function check(){
  if(pending||document.hidden)return;pending=true;
  try{
   const response=await fetch('/settings/connections/'+encodeURIComponent(root.dataset.connectionSynchronization)+'/synchronization-state',
    {credentials:'same-origin',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});
   if(!response.ok)return;const state=await response.json();
   if(state.mode!=='active')status.textContent=state.mode==='off'?'Automatic updates are off.':state.mode==='paused'?'Automatic updates are temporarily paused.':'Sign in to start automatic updates.';
   else if(state.retryAt)status.textContent='Waiting for the provider. Next retry: '+format(state.retryAt)+'.';
   else if(state.jobState==='RUNNING')status.textContent='Checking the provider and processing its latest records…';
   else if(state.jobState)status.textContent=state.jobState==='RETRY'?'The check will retry automatically.':'The next provider check is queued.';
   else status.textContent=(state.lastCheckAt?'Last completed: '+format(state.lastCheckAt)+'. ':'Waiting for the first completed check. ')+
     (state.nextCheckAt?'Next check: '+format(state.nextCheckAt)+'.':'');
   if(state.lastCheckAt&&state.lastCheckAt!==root.dataset.lastCheck){
    updated.hidden=false;updated.textContent='View updated products and matches ('+state.productsMapped+' products, '+state.locationsMapped+' locations)';
   }
  }catch{/* Keep the last confirmed status; a page refresh never retries a provider write. */}
  finally{pending=false;}
 }
 check();window.setInterval(check,10000);
})();
