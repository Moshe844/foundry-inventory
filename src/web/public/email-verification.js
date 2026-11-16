'use strict';
(() => {
  const expected=document.querySelector('[data-verification-pending]')?.dataset.verificationPending;
  if (!expected) return;
  let running=false,timer;
  async function check(){
    clearTimeout(timer);
    if(document.hidden||running)return;
    running=true;
    try{
      const response=await fetch('/verify-email/status',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
      if(response.ok){const result=await response.json();if(result.accountId===expected&&result.verified&&['/complete-signup','/','/inventories'].includes(result.next)){location.replace(result.next);return;}}
    }catch{/* A transient connection failure must not lose the pending signup. */}
    finally{running=false;timer=setTimeout(check,4000);}
  }
  addEventListener('focus',check);addEventListener('pageshow',check);
  document.addEventListener('visibilitychange',check);check();
})();
