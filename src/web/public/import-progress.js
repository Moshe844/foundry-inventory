'use strict';
(()=>{
 const panel=document.querySelector('[data-import-progress]');if(!panel)return;
 const endpoint=new URL(panel.dataset.importProgress,window.location.origin);if(endpoint.origin!==window.location.origin)return;
 let pending=false;
 async function refresh(){
  if(pending||document.hidden)return;pending=true;
  try{const response=await fetch(endpoint.pathname,{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok)return;
   const state=await response.json();if(state.finished){window.location.reload();return;}
   panel.querySelector('[data-import-status]').textContent=state.working?'Importing your inventory':'Import queued';
  }catch{/* Keep the durable job running through a temporary disconnection. */}finally{pending=false;}
 }
 window.setInterval(refresh,3000);document.addEventListener('visibilitychange',refresh);
})();
