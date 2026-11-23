'use strict';
(()=>{
  const dialogs=[...document.querySelectorAll('[data-plan-dialog]')],configured=new WeakSet(),loads=new WeakMap();
  const normalize=value=>value.trim().toLocaleLowerCase();
  function filterPlan(root){
    const mode=root.querySelector('[data-filter-mode][aria-pressed="true"]').dataset.filterMode;
    const status=root.querySelector('[data-plan-status]').value,query=normalize(root.querySelector('[data-plan-search]').value);
    let count=0;
    for(const row of root.querySelectorAll('[data-plan-job]')){
      const matches=(mode==='all'||row.dataset.mode===mode)&&(status==='all'||(status==='pending'?row.dataset.status==='pending':row.dataset.status!=='pending'))&&normalize(row.querySelector('[data-job-label]').textContent).includes(query);
      row.hidden=!matches;if(matches)count++;
    }
    for(const group of root.querySelectorAll('[data-plan-group]'))group.hidden=![...group.querySelectorAll('[data-plan-job]')].some(row=>!row.hidden);
    root.querySelector('[data-plan-count]').textContent=count+' '+(count===1?'duty':'duties')+' shown'+(status==='working'?' · planned duties hidden':'');
    root.querySelector('[data-plan-empty]').hidden=count!==0;
  }
  function configurePlan(root){
    if(configured.has(root))return;
    configured.add(root);
    root.querySelector('[data-plan-search]').addEventListener('input',()=>filterPlan(root));
    root.querySelector('[data-plan-status]').addEventListener('change',()=>filterPlan(root));
    for(const button of root.querySelectorAll('[data-filter-mode]'))button.addEventListener('click',()=>{
      for(const other of root.querySelectorAll('[data-filter-mode]'))other.setAttribute('aria-pressed',String(other===button));
      filterPlan(root);
    });
    filterPlan(root);
  }
  function configureComparison(root){
    if(configured.has(root))return;
    configured.add(root);let savedOpen=null;
    const search=root.querySelector('[data-comparison-search]');
    search.addEventListener('input',()=>{
      const query=normalize(search.value),groups=[...root.querySelectorAll('[data-comparison-group]')];
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
      root.querySelector('[data-comparison-count]').textContent=count+' duties across '+areas+' areas';
    });
  }
  function loadDetails(container,url,selector,configure){
    const state=loads.get(container);
    if(state?.ready)return Promise.resolve();
    if(state?.pending)return state.pending;
    const message=container.querySelector('[role="status"]');
    message.textContent='Loading details…';container.querySelector('[data-load-retry]')?.remove();
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
    const pending=(async()=>{
      try{
        const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:controller.signal});
        if(!response.ok)throw new Error('Details unavailable');
        const source=new DOMParser().parseFromString(await response.text(),'text/html').querySelector(selector);
        if(!source)throw new Error('Details unavailable');
        container.replaceChildren(...[...source.childNodes].map(node=>document.importNode(node,true)));
        configure(container);loads.set(container,{ready:true});
      }catch(error){
        message.textContent='Details could not load. Open the full page or try again.';
        const retry=document.createElement('button');retry.type='button';retry.textContent='Try again';retry.dataset.loadRetry='';
        retry.addEventListener('click',()=>loadDetails(container,url,selector,configure).catch(()=>{}));
        container.append(retry);loads.delete(container);throw error;
      }finally{clearTimeout(timeout);}
    })();
    loads.set(container,{pending});return pending;
  }
  function setMode(dialog){
    const mode=dialog.requestedMode;
    dialog.querySelector('[data-plan-search]').value='';
    dialog.querySelector('[data-plan-status]').value=mode==='all'?'all':'working';
    for(const button of dialog.querySelectorAll('[data-filter-mode]'))button.setAttribute('aria-pressed',String(button.dataset.filterMode===mode));
    filterPlan(dialog);dialog.querySelector('.plan-dialog-body').scrollTop=0;
  }
  function openPlan(dialog,mode,trigger){
    if(!dialog||typeof dialog.showModal!=='function')return false;
    dialog.requestedMode=mode;dialog.returnFocus=trigger;
    if(!dialog.open)dialog.showModal();
    document.body.classList.add('plan-dialog-open');dialog.querySelector('.plan-dialog-close').focus();
    const container=dialog.querySelector('[data-plan-source]');
    loadDetails(container,container.dataset.planSource,'[data-plan-content]',()=>{configurePlan(dialog);if(dialog.open)setMode(dialog);})
      .then(()=>{if(dialog.open)setMode(dialog);}).catch(()=>{});
    return true;
  }
  for(const root of document.querySelectorAll('[data-plan-inline]'))configurePlan(root);
  for(const root of document.querySelectorAll('[data-comparison-fragment]'))configureComparison(root);
  for(const dialog of dialogs){
    dialog.addEventListener('click',event=>{
      if(event.target!==dialog)return;
      const bounds=dialog.getBoundingClientRect();
      if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();
    });
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();dialog.close();}});
    dialog.addEventListener('close',()=>{document.body.classList.remove('plan-dialog-open');dialog.returnFocus?.focus({preventScroll:true});});
  }
  for(const link of document.querySelectorAll('[data-open-plan]'))link.addEventListener('click',event=>{
    const dialog=dialogs.find(dialog=>dialog.dataset.planDialog===link.dataset.openPlan);
    if(openPlan(dialog,link.dataset.openMode||'all',link))event.preventDefault();
  });
  const full=document.querySelector('[data-full-comparison]'),comparison=document.querySelector('[data-comparison-loader]');
  function loadComparison(){if(comparison)loadDetails(comparison,comparison.dataset.comparisonSource,'[data-comparison-fragment]',configureComparison).catch(()=>{});}
  full?.addEventListener('toggle',()=>{if(full.open)loadComparison();});
  function followHash(){
    if(location.hash==='#compare-agent-plans'&&full){full.open=true;loadComparison();}
    const dialog=dialogs.find(dialog=>'#'+dialog.id===location.hash);
    if(dialog&&!dialog.open)openPlan(dialog,'all',null);
  }
  window.addEventListener('hashchange',followHash);followHash();
})();
