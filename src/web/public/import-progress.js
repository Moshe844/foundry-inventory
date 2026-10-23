'use strict';
(()=>{
 function nextStep(){
  const query=new URL(location.href).searchParams;if(query.has('page')||query.has('rows'))return;
  const active=document.querySelector('[data-preview-revision][data-revision-active="yes"]')||document.querySelector('[data-import-current-step] [data-import-detail]');
  const approved=document.querySelector('[data-import-current-step] form[action$="/run"], [data-import-current-step] form[action$="/retry"]');
  const result=document.querySelector('[data-import-current-step] .badge--ok');
  const target=active||((approved||result)?document.querySelector('[data-import-current-step]'):null)||document.querySelector('#import-approval-review a[href^="#"]');
  if(!target)return;
  const step=target.matches('a')?document.querySelector(target.getAttribute('href')):target;
  if(!step)return;
  if(approved||result||active){
   document.querySelectorAll('[data-import-source-details]').forEach(details=>details.open=false);
   const current=active?.closest('[id]')||document.querySelector('[data-import-current-step]');
   if(current?.id)history.replaceState(history.state,'',location.pathname+location.search+'#'+current.id);
  }
  // A former question's hash must not keep a completed or running import
  // scrolled to an obsolete step after a redirect or progress refresh.
  if(step.closest('details'))step.closest('details').open=true;
  step.setAttribute('tabindex','-1');step.focus({preventScroll:true});step.scrollIntoView({block:'start',behavior:'instant'});
 }
 const advance=()=>requestAnimationFrame(()=>requestAnimationFrame(nextStep));
 if(document.readyState==='complete')advance();else window.addEventListener('load',advance,{once:true});
 const format=iso=>new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short',...(document.documentElement.dataset.timeZone?{timeZone:document.documentElement.dataset.timeZone}:{})}).format(new Date(iso));
 document.querySelectorAll('[data-import-time]').forEach(time=>{if(Number.isFinite(Date.parse(time.dateTime))){time.textContent=format(time.dateTime);time.title=time.dateTime;}});
 document.querySelectorAll('[data-import-file-upload]').forEach(form=>form.querySelector('[type=file]')?.addEventListener('change',()=>{const key=form.querySelector('[name=uploadKey]');if(key)key.value=crypto.randomUUID();}));
 const sourceGroups=new Map();
 document.querySelectorAll('[data-source-upload][data-source-active="yes"]').forEach(panel=>{const url=new URL(panel.dataset.sourceUpload,location.origin);if(url.origin!==location.origin)return;const entry=sourceGroups.get(url.pathname)||{panels:[],finished:false};entry.panels.push(panel);sourceGroups.set(url.pathname,entry);});
 if(sourceGroups.size){let pending=false;
  const refresh=async()=>{if(pending||document.hidden)return;pending=true;
   try{await Promise.all([...sourceGroups].filter(([,entry])=>!entry.finished).map(async([endpoint,entry])=>{
    try{const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('unavailable');const state=await response.json();
     for(const panel of entry.panels){panel.querySelector('[data-source-label]').textContent=state.label;
      panel.querySelector('[data-source-rows]').textContent=(state.worksheets?state.worksheets+' worksheets read · ':'')+(state.totalRows===null?'The file is saved. Row totals appear after its tables are read.':(state.processedRows??0).toLocaleString()+' / '+state.totalRows.toLocaleString()+' rows checked and prepared');
      const meter=panel.querySelector('[data-source-meter]');meter.max=state.totalRows||1;if(state.processedRows===null)meter.removeAttribute('value');else meter.value=state.processedRows;
      const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(state.createdAt))/1000));panel.querySelector('[data-source-timing]').textContent='Uploaded '+format(state.createdAt)+(state.active?' · '+Math.floor(seconds/60)+'m '+seconds%60+'s elapsed':'');
      panel.querySelector('[data-source-live]').textContent='Last worker update '+format(state.lastUpdateAt);panel.querySelector('[data-source-reason]').textContent=state.reason||'';
      const link=panel.querySelector('[data-source-result]');link.href=state.previewHref||state.href;link.textContent=state.ready?'Review preview':'Open saved progress';const retry=panel.querySelector('[data-source-retry]');if(retry)retry.hidden=!state.canRetry;
     }
     if(!state.active){entry.finished=true;if(state.ready&&entry.panels.some(panel=>panel.hasAttribute('data-source-detail'))&&/^\/imports\/imp_[a-z0-9]+$/.test(state.previewHref))location.assign(state.previewHref);}
    }catch{for(const panel of entry.panels)panel.querySelector('[data-source-live]').textContent='Progress connection interrupted. Your file is saved; refresh this page to reconnect.';}
   }));if([...sourceGroups.values()].every(entry=>entry.finished))clearInterval(timer);}finally{pending=false;}
  };
  const timer=setInterval(refresh,2500);document.addEventListener('visibilitychange',refresh);refresh();
 }
 document.querySelectorAll('[data-tracking-review]').forEach(form=>form.addEventListener('invalid',()=>{const error=form.querySelector('[data-tracking-answer-error]');if(error)error.hidden=false;},true));
 document.querySelectorAll('[data-import-preview-revise]').forEach(form=>form.addEventListener('submit',event=>{
  if(form.dataset.submitting==='yes'){event.preventDefault();return;}form.dataset.submitting='yes';form.setAttribute('aria-busy','true');
  // Disabled submitters are omitted from the browser's form payload. Preserve
  // the exact named decision before showing its busy state, including the
  // explicit confirmation; never infer a choice from merely opening the form.
  if(event.submitter?.name){const decision=document.createElement('input');decision.type='hidden';decision.name=event.submitter.name;decision.value=event.submitter.value;form.appendChild(decision);}
  form.querySelectorAll('button[type="submit"]').forEach(button=>{button.disabled=true;button.textContent=button.dataset.busyLabel||'Updating saved preview…';});
  const status=form.querySelector('[data-import-preview-status]');if(status){status.hidden=false;status.textContent='StockChief is checking your saved rows again. No stock or value is being imported.';}
 }));
 document.querySelectorAll('[data-preview-revision][data-revision-active="yes"]').forEach(panel=>{
  const endpoint=new URL(panel.dataset.previewRevision,location.origin);if(endpoint.origin!==location.origin)return;
  document.querySelectorAll('form').forEach(form=>{if(/\/imports\/[^/]+\/(?:revise|approve)$/.test(new URL(form.action,location.origin).pathname))form.querySelectorAll('button,input,select,textarea').forEach(field=>field.disabled=true);});
  let pending=false;
  const refresh=async()=>{if(pending||document.hidden)return;pending=true;
   try{const response=await fetch(endpoint.pathname,{credentials:'same-origin',cache:'no-store',headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('unavailable');const state=await response.json();if(!state)throw new Error('missing');
    panel.querySelector('[data-revision-label]').textContent=state.label;
    panel.querySelector('[data-revision-count]').textContent=(state.attempt>1?'Attempt '+state.attempt+' · ':'')+state.processedRows.toLocaleString()+(state.totalRows===null?'':' / '+state.totalRows.toLocaleString())+' rows checked';
    const meter=panel.querySelector('[data-revision-meter]');meter.max=state.totalRows||1;meter.value=state.processedRows;
    panel.querySelector('[data-revision-live]').textContent='Last update '+format(state.lastUpdateAt)+' · You can leave and return to this saved update.';
    panel.querySelector('[data-revision-reason]').textContent=state.reason||'';
    if(!state.active){clearInterval(timer);location.reload();}
   }catch{panel.querySelector('[data-revision-live]').textContent='Connection to progress interrupted. This update is saved; refresh this page to reconnect.';}
   finally{pending=false;}
  };
  const timer=setInterval(refresh,2500);document.addEventListener('visibilitychange',refresh);refresh();
 });
 const groups=new Map();
 document.querySelectorAll('[data-import-progress]').forEach(panel=>{const url=new URL(panel.dataset.importProgress,window.location.origin);if(url.origin!==window.location.origin)return;const entry=groups.get(url.pathname)||{panels:[],finished:false};entry.panels.push(panel);groups.set(url.pathname,entry);});
 if(!groups.size)return;
 let pending=false,timer;
 function updateMeter(panel,state){
  const meter=panel.querySelector('[data-import-meter]');if(!meter)return;meter.dataset.state=state.state.toLowerCase();
  meter.querySelector('[data-import-stage]').textContent=state.stageLabel;
  meter.querySelector('[data-import-count]').textContent=state.stage==='preparing'&&state.preparedRows!==null&&state.preparedRows!==undefined?state.preparedRows.toLocaleString()+' / '+state.readyRows.toLocaleString()+' approved rows prepared':state.processedRows===null?'':(state.attempt>1?'Attempt '+state.attempt+': ':'')+state.processedRows.toLocaleString()+' / '+state.readyRows.toLocaleString()+(state.durable?' rows saved':' rows processed');
  const bar=meter.querySelector('[data-import-bar]');bar.classList.toggle('is-indeterminate',state.progressPercent===null);
  if(state.progressPercent===null)bar.removeAttribute('aria-valuenow');else bar.setAttribute('aria-valuenow',String(state.progressPercent));
  bar.firstElementChild.style.width=(state.progressPercent===null?32:state.progressPercent)+'%';
  const stages=['preparing','processing','verifying','complete'],index=stages.indexOf(state.stage);
  meter.querySelectorAll('[data-import-step]').forEach(step=>{const n=stages.indexOf(step.dataset.importStep);step.classList.toggle('is-current',n===index);step.classList.toggle('is-done',index>n);});
  meter.querySelector('[data-import-summary]').textContent=state.state==='UPDATING_PREVIEW'?'Checking preview choices only. No stock or Money is being imported.':state.verified?'Products, stock and accounting checks passed.':state.durable?state.savedRows.toLocaleString()+' approved rows saved with stock, accounting and extra fields. You can leave and return; saved batches will not be repeated.':state.detailsPending?'Stock rows are prepared. Extra fields and reorder settings are still being applied before final verification. Inventory is not saved yet.':state.processedRows===null?'Exact row progress is not available for this run. Inventory appears after verification.':'Processed rows are being prepared; inventory is saved together after verification.';
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
