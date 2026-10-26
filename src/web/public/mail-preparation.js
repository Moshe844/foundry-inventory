'use strict';
(()=>{
 const root=document.querySelector('[data-mail-preparation]');if(!root)return;
 let signature='',pending=false;
 async function refresh(){
  if(pending||document.hidden)return;pending=true;
  try{
   const response=await fetch(root.dataset.statusUrl,{headers:{accept:'application/json'},credentials:'same-origin',signal:AbortSignal.timeout(10000)});
   if(!response.ok)return;const state=await response.json(),next=JSON.stringify([state.label,state.entries]);if(next===signature)return;signature=next;
   root.querySelector('[data-mail-preparation-state]').textContent=state.label;
   const log=root.querySelector('[data-mail-preparation-log]'),nodes=[];
   for(const entry of state.entries){const p=document.createElement('p'),strong=document.createElement('strong'),a=document.createElement('a'),time=document.createElement('time');
    strong.textContent=entry.label;a.href='/mail/'+encodeURIComponent(entry.id);a.textContent=entry.subject;time.dateTime=new Date(entry.at).toISOString();time.dataset.localTime='';time.textContent=time.dateTime;
    p.append(strong,' · ',a,' · ',time);nodes.push(p);}
   if(!nodes.length){const p=document.createElement('p');p.textContent='No reply preparation recorded yet.';nodes.push(p);}
   log.replaceChildren(...nodes);
  }catch{/* Keep the last verified state. Polling never starts a model or sends mail. */}finally{pending=false;}
 }
 setInterval(refresh,5000);
})();
