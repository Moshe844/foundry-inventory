'use strict';
(()=>{const notice=document.querySelector('[data-ask-health]');if(!notice)return;let timer;
 async function check(){try{const response=await fetch('/ask/health',{credentials:'same-origin',headers:{accept:'application/json'}});if(![200,503].includes(response.status))return;const health=await response.json();notice.hidden=health.ok;notice.textContent=health.message;
  const banner=document.querySelector('[data-ai-credit-notice]'),balance=health.creditBalance;
  if(banner&&balance){
   banner.hidden=!balance.low&&!balance.exhausted;
   banner.dataset.aiCreditNotice=balance.exhausted?'exhausted':'low';
   banner.querySelector('[data-credit-notice-title]').textContent=balance.exhausted?'Your AI credits are used up':'Your AI credits are running low';
   banner.querySelector('[data-credit-notice-detail]').textContent=balance.exhausted?'AI work pauses until credits are added or your allowance renews. Your saved work stays available.':Number(balance.remaining).toLocaleString('en-US')+' credits remain — 20% or less of your monthly included allowance.';
  }
 }catch{notice.hidden=false;notice.textContent='The Ask connection could not be checked. Your saved requests are still available.';}finally{timer=setTimeout(check,15000);}}
 window.addEventListener('pagehide',()=>clearTimeout(timer),{once:true});check();})();
