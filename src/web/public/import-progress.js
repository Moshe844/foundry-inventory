'use strict';
(()=>{
 const format=iso=>new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short',...(document.documentElement.dataset.timeZone?{timeZone:document.documentElement.dataset.timeZone}:{})}).format(new Date(iso));
 document.querySelectorAll('[data-import-time]').forEach(time=>{if(Number.isFinite(Date.parse(time.dateTime))){time.textContent=format(time.dateTime);time.title=time.dateTime;}});
 document.querySelectorAll('[data-import-preview-revise]').forEach(form=>form.addEventListener('submit',event=>{
  if(form.dataset.submitting==='yes'){event.preventDefault();return;}form.dataset.submitting='yes';form.setAttribute('aria-busy','true');
  form.querySelectorAll('button[type="submit"]').forEach(button=>{button.disabled=true;button.textContent='Recalculating preview…';});
  const status=form.querySelector('[data-import-preview-status]');if(status){status.hidden=false;status.textContent='StockChief is checking your saved rows again. No stock or value is being imported.';}
 }));
 const groups=new Map();
 document.querySelectorAll('[data-import-progress]').forEach(panel=>{const url=new URL(panel.dataset.importProgress,window.location.origin);if(url.origin!==window.location.origin)return;const entry=groups.get(url.pathname)||{panels:[],finished:false};entry.panels.push(panel);groups.set(url.pathname,entry);});
 if(!groups.size)return;
 let pending=false,timer;
 function updateMeter(panel,state){
  const meter=panel.querySelector('[data-import-meter]');if(!meter)return;meter.dataset.state=state.state.toLowerCase();
  meter.querySelector('[data-import-stage]').textContent=state.stageLabel;
  meter.querySelector('[data-import-count]').textContent=state.processedRows===null?'':(state.attempt>1?'Attempt '+state.attempt+': ':'')+state.processedRows.toLocaleString()+' / '+state.readyRows.toLocaleString()+' rows processed';
  const bar=meter.querySelector('[data-import-bar]');bar.classList.toggle('is-indeterminate',state.progressPercent===null);
  if(state.progressPercent===null)bar.removeAttribute('aria-valuenow');else bar.setAttribute('aria-valuenow',String(state.progressPercent));
  bar.firstElementChild.style.width=(state.progressPercent===null?32:state.progressPercent)+'%';
  const stages=['preparing','processing','verifying','complete'],index=stages.indexOf(state.stage);
  meter.querySelectorAll('[data-import-step]').forEach(step=>{const n=stages.indexOf(step.dataset.importStep);step.classList.toggle('is-current',n===index);step.classList.toggle('is-done',index>n);});
  meter.querySelector('[data-import-summary]').textContent=state.verified?'Products, stock and accounting checks passed.':state.processedRows===null?'Exact row progress is not available for this run. Inventory appears after verification.':'Processed rows are being prepared; inventory is saved together after verification.';
  const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(state.lastUpdateAt))/1000));
  meter.querySelector('[data-import-live]').textContent=state.active?'Worker update '+(seconds<2?'just now':seconds+'s ago'):state.verified?'Verified '+format(state.completedAt):'Saved status';
 }
 async function refresh(){
  if(pending||document.hidden)return;pending=true;
  try{await Promise.all([...groups].filter(([,entry])=>!entry.finished).map(async([endpoint,entry])=>{
   try{const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('progress_unavailable');const state=await response.json();
    for(const panel of entry.panels){
     updateMeter(panel,state);
     const heading=panel.querySelector('[data-import-status]');if(heading)heading.textContent=state.label||(state.working?'Importing your inventory':'Import queued');
     const timing=panel.querySelector('[data-import-timing]'),at=state.completedAt||state.startedAt||state.queuedAt;
     if(timing&&at){const elapsed=Math.max(0,Math.floor((Date.now()-Date.parse(at))/1000)),minutes=Math.floor(elapsed/60);timing.textContent=(state.completedAt?'Finished ':state.startedAt?'Started ':'Queued ')+format(at)+(state.active?' · '+(minutes?minutes+'m ':'')+(elapsed%60)+'s elapsed':'');}
     if(state.finished){const note=panel.querySelector('[data-import-note]');if(note)note.textContent=state.verified?'The saved inventory and accounting checks passed.':state.state==='APPROVED'?'Your approval is saved. Open the import to start it.':'Open the saved import to review its current state.';const link=panel.querySelector('[data-import-result]');if(link)link.textContent=state.verified?'View verified result':'Review import';}
    }
    if(state.finished){entry.finished=true;if(entry.panels.some(panel=>panel.hasAttribute('data-import-detail')))window.location.reload();}
   }catch{for(const panel of entry.panels){const meter=panel.querySelector('[data-import-meter]');if(meter)meter.dataset.state='disconnected';const live=panel.querySelector('[data-import-live]');if(live)live.textContent='Reconnecting to progress… Refresh if this continues.';}}
  }));if([...groups.values()].every(entry=>entry.finished))window.clearInterval(timer);
  }finally{pending=false;}
 }
 timer=window.setInterval(refresh,5000);document.addEventListener('visibilitychange',refresh);refresh();
})();
