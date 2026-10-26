'use strict';
(()=>{
  const root=document.querySelector('[data-maintenance-progress]');
  if(!root||root.dataset.active!=='true')return;
  async function update(){
    if(document.hidden){setTimeout(update,4000);return;}
    try{
      const response=await fetch('/autopilot/progress',{headers:{Accept:'application/json'}});
      if(!response.ok)throw new Error('Progress unavailable');
      const state=await response.json();
      const text=state.active?state.checks.map(c=>c.text).join(' '):state.message;
      if(root.textContent!==text)root.textContent=text;
      if(!state.active)return;
    }catch{root.textContent='The background check is saved. Reopen this page to see its latest progress.';}
    setTimeout(update,4000);
  }
  setTimeout(update,4000);
})();
