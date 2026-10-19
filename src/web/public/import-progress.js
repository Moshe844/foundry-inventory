'use strict';
(()=>{
 const format=iso=>new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'}).format(new Date(iso));
 document.querySelectorAll('[data-import-time]').forEach(time=>{if(Number.isFinite(Date.parse(time.dateTime))){time.textContent=format(time.dateTime);time.title=time.dateTime;}});
 const groups=new Map();
 document.querySelectorAll('[data-import-progress]').forEach(panel=>{const url=new URL(panel.dataset.importProgress,window.location.origin);if(url.origin!==window.location.origin)return;const entry=groups.get(url.pathname)||{panels:[],finished:false};entry.panels.push(panel);groups.set(url.pathname,entry);});
 if(!groups.size)return;
 let pending=false,timer;
 async function refresh(){
  if(pending||document.hidden)return;pending=true;
  try{await Promise.all([...groups].filter(([,entry])=>!entry.finished).map(async([endpoint,entry])=>{
   try{const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok)return;const state=await response.json();
    for(const panel of entry.panels){
     const heading=panel.querySelector('[data-import-status]');if(heading)heading.textContent=state.label||(state.working?'Importing your inventory':'Import queued');
     const timing=panel.querySelector('[data-import-timing]'),at=state.completedAt||state.startedAt||state.queuedAt;
     if(timing&&at){const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(at))/1000)),minutes=Math.floor(elapsed/60);timing.textContent=(state.completedAt?'Finished ':state.startedAt?'Started ':'Queued ')+format(at)+(state.active?' · '+(minutes?minutes+'m ':'')+(elapsed%60)+'s elapsed':'');}
     if(state.finished){const note=panel.querySelector('[data-import-note]');if(note)note.textContent=state.verified?'The saved inventory and accounting checks passed.':state.state==='APPROVED'?'Your approval is saved. Open the import to start it.':'Open the saved import to review its current state.';const link=panel.querySelector('[data-import-result]');if(link)link.textContent=state.verified?'View verified result':'Review import';}
    }
    if(state.finished){entry.finished=true;if(entry.panels.some(panel=>panel.hasAttribute('data-import-detail')))window.location.reload();}
   }catch{/* A transient disconnection does not interrupt the durable import. */}
  }));if([...groups.values()].every(entry=>entry.finished))window.clearInterval(timer);
  }finally{pending=false;}
 }
 timer=window.setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);refresh();
})();
