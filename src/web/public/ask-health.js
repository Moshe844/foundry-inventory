'use strict';
(()=>{const notice=document.querySelector('[data-ask-health]');if(!notice)return;let timer;
 async function check(){try{const response=await fetch('/ask/health',{credentials:'same-origin',headers:{accept:'application/json'}});if(![200,503].includes(response.status))return;const health=await response.json();notice.hidden=health.ok;notice.textContent=health.message;}catch{notice.hidden=false;notice.textContent='The Ask connection could not be checked. Your saved requests are still available.';}finally{timer=setTimeout(check,15000);}}
 window.addEventListener('pagehide',()=>clearTimeout(timer),{once:true});check();})();
