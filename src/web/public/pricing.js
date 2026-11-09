'use strict';
(()=>{
  const dialogs=[...document.querySelectorAll('[data-plan-dialog]')];
  const normalize=value=>value.trim().toLocaleLowerCase();
  function filterPlan(dialog){
    const mode=dialog.querySelector('[data-filter-mode][aria-pressed="true"]').dataset.filterMode;
    const status=dialog.querySelector('[data-plan-status]').value,query=normalize(dialog.querySelector('[data-plan-search]').value);
    let count=0;
    for(const row of dialog.querySelectorAll('[data-plan-job]')){
      const matches=(mode==='all'||row.dataset.mode===mode)&&(status==='all'||(status==='pending'?row.dataset.status==='pending':row.dataset.status!=='pending'))&&normalize(row.querySelector('[data-job-label]').textContent).includes(query);
      row.hidden=!matches;if(matches)count++;
    }
    for(const group of dialog.querySelectorAll('[data-plan-group]'))group.hidden=![...group.querySelectorAll('[data-plan-job]')].some(row=>!row.hidden);
    dialog.querySelector('[data-plan-count]').textContent=count+' '+(count===1?'duty':'duties')+' shown'+(status==='working'?' · planned duties hidden':'');
    dialog.querySelector('[data-plan-empty]').hidden=count!==0;
  }
  for(const dialog of dialogs){
    dialog.querySelector('[data-plan-search]').addEventListener('input',()=>filterPlan(dialog));
    dialog.querySelector('[data-plan-status]').addEventListener('change',()=>filterPlan(dialog));
    for(const button of dialog.querySelectorAll('[data-filter-mode]'))button.addEventListener('click',()=>{
      for(const other of dialog.querySelectorAll('[data-filter-mode]'))other.setAttribute('aria-pressed',String(other===button));
      filterPlan(dialog);
    });
    dialog.addEventListener('click',event=>{
      if(event.target!==dialog)return;
      const bounds=dialog.getBoundingClientRect();
      if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();
    });
    // Search fields consume Escape to clear their value in some browsers.
    // In the modal, Escape consistently closes the detail view instead.
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();dialog.close();}});
    dialog.addEventListener('close',()=>{document.body.classList.remove('plan-dialog-open');dialog.returnFocus?.focus({preventScroll:true});});
    filterPlan(dialog);
  }
  function openPlan(dialog,mode,trigger){
    if(!dialog||typeof dialog.showModal!=='function')return false;
    dialog.querySelector('[data-plan-search]').value='';
    dialog.querySelector('[data-plan-status]').value='working';
    for(const button of dialog.querySelectorAll('[data-filter-mode]'))button.setAttribute('aria-pressed',String(button.dataset.filterMode===mode));
    filterPlan(dialog);dialog.returnFocus=trigger;dialog.showModal();
    dialog.querySelector('.plan-dialog-body').scrollTop=0;
    document.body.classList.add('plan-dialog-open');
    dialog.querySelector('.plan-dialog-close').focus();return true;
  }
  for(const link of document.querySelectorAll('[data-open-plan]'))link.addEventListener('click',event=>{
    const dialog=dialogs.find(dialog=>dialog.dataset.planDialog===link.dataset.openPlan);
    if(openPlan(dialog,link.dataset.openMode||'all',link))event.preventDefault();
  });
  const full=document.querySelector('[data-full-comparison]'),search=document.querySelector('[data-comparison-search]');
  if(full&&search){
    let savedOpen=null;
    search.addEventListener('input',()=>{
      const query=normalize(search.value),groups=[...full.querySelectorAll('[data-comparison-group]')];
      if(query&&savedOpen===null)savedOpen=groups.map(group=>group.open);
      let count=0,areas=0;
      groups.forEach((group,index)=>{
        let matches=0;
        for(const row of group.querySelectorAll('[data-agent-job]')){
          row.hidden=!normalize(row.querySelector('th>span').textContent).includes(query);
          if(!row.hidden)matches++;
        }
        group.hidden=matches===0;if(matches){count+=matches;areas++;}
        if(query)group.open=matches>0;else if(savedOpen)group.open=savedOpen[index];
      });
      if(!query)savedOpen=null;
      document.querySelector('[data-comparison-count]').textContent=count+' duties across '+areas+' areas';
    });
  }
  function followHash(){
    if(location.hash==='#compare-agent-plans'&&full)full.open=true;
    const dialog=dialogs.find(dialog=>'#'+dialog.id===location.hash);
    if(dialog&&!dialog.open)openPlan(dialog,'all',null);
  }
  window.addEventListener('hashchange',followHash);followHash();
})();
