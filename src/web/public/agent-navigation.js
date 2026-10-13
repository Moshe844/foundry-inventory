'use strict';
// This script is emitted only by the destination's successful page renderer.
(() => {
 const arrival=document.querySelector('[data-agent-arrival]');if(!arrival)return;
 let attempts=0;
 async function acknowledge(){
  try{const response=await fetch('/ask/navigation/arrived',{method:'POST',credentials:'same-origin',
   redirect:'error',headers:{accept:'application/json','content-type':'application/json','x-csrf-token':arrival.dataset.csrf},body:JSON.stringify({token:arrival.dataset.token})});
   if(response.ok&&(await response.json()).delivered===true){arrival.dataset.confirmed='true';return;}
   if(response.status<500)return;
  }catch{/* Arrival remains durable and can be acknowledged after reconnection. */}
  if(++attempts<3)window.setTimeout(acknowledge,1000*attempts);
 }
 acknowledge();
})();
