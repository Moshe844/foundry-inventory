(function(){
  'use strict';
  try{if(window.frameElement?.dataset.embeddedAsk==='true')document.body.classList.add('sc-embedded-chat');}catch{/* An unrelated embedding page cannot supply application context. */}
  const toggle=document.querySelector('[data-sidebar-toggle]');
  function closeNavigation(){document.body.classList.remove('sc-sidebar-open');toggle?.setAttribute('aria-expanded','false');toggle?.setAttribute('aria-label','Open navigation');}
  document.querySelector('[data-sidebar-close]')?.addEventListener('click',()=>{closeNavigation();toggle?.focus();});
  toggle?.addEventListener('click',()=>{const open=document.body.classList.toggle('sc-sidebar-open');toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close navigation':'Open navigation');});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.sc-sidebar,[data-sidebar-toggle]'))closeNavigation();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeNavigation();});
  function revealFragment(){let id;try{id=decodeURIComponent(location.hash.slice(1));}catch{return;}const target=id&&document.getElementById(id);if(!target)return;for(let p=target;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;if(target.tagName==='DIALOG'&&!target.open)target.showModal();requestAnimationFrame(()=>{target.scrollIntoView({block:'start'});const field=target.querySelector('input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)');field?.focus({preventScroll:true});});}
  window.addEventListener('hashchange',revealFragment);if(location.hash)revealFragment();
  document.addEventListener('submit',async event=>{const form=event.target.closest('form[data-dismiss-suggestion]');if(!form||event.defaultPrevented)return;event.preventDefault();const button=form.querySelector('button'),label=button.textContent;button.disabled=true;button.textContent='Dismissing…';try{const response=await fetch(form.action,{method:'POST',body:new URLSearchParams(new FormData(form)),headers:{accept:'application/json'},credentials:'same-origin'});const result=await response.json();if(!response.ok||result.dismissed!==true)throw Error('This suggestion could not be dismissed. Review its current state.');const card=form.closest('[data-home-suggestion]'),grid=card.parentElement;card.remove();if(!grid.children.length){const section=grid.closest('[data-home-section=suggestions]');if(section)section.remove();else grid.remove();}}catch(error){button.disabled=false;button.textContent=label;let status=form.querySelector('[role=alert]');if(!status){status=document.createElement('p');status.setAttribute('role','alert');form.append(status);}status.textContent=error.message;}});
  const bulk=document.querySelector('[data-bulk-toolbar]');
  if(bulk){const update=()=>{bulk.hidden=!document.querySelector('[data-product-selection]:checked');};document.addEventListener('change',event=>{if(event.target.matches('[data-product-selection],[data-select-all-products]'))update();});update();}
  for(const table of document.querySelectorAll('main table:not([data-preserve-grid])')){const header=table.tHead;if(!header||header.rows.length!==1)continue;const labels=Array.from(header.rows[0].cells).map(cell=>cell.textContent.trim());const rows=Array.from(table.tBodies).flatMap(body=>Array.from(body.rows));if(!labels.length||!rows.length||rows.some(row=>row.cells.length!==labels.length||Array.from(row.cells).some(cell=>cell.colSpan!==1)))continue;table.classList.add('sc-mobile-table');table.setAttribute('role','table');for(const row of rows){row.setAttribute('role','row');Array.from(row.cells).forEach((cell,index)=>{cell.dataset.cellLabel=labels[index];cell.setAttribute('role','cell');});}}
  const composer=document.getElementById('tell-foundry');if(composer){const input=composer.querySelector('[name=message]');if(input){
    const focusInput=()=>{const active=document.activeElement;if(input.disabled||document.querySelector('dialog[open]')||active!==input&&active?.matches('input,textarea,select,button,a[href],[contenteditable="true"]')&&!active.closest('#tell-foundry'))return;input.focus({preventScroll:true});};
    requestAnimationFrame(focusInput);window.addEventListener('pageshow',()=>requestAnimationFrame(focusInput));
    // Some browsers focus the response's fragment after deferred scripts ran.
    // Restore the composer on that event, preserving deliberately chosen fields.
    document.addEventListener('focusin',event=>{const target=event.target;if(target?.id&&'#'+target.id===location.hash&&target.closest('[data-chat-scroll]')&&!target.matches('input,textarea,select,button,a[href],[contenteditable="true"]'))requestAnimationFrame(focusInput);});
  }}
  const chat=document.querySelector('[data-chat-scroll]');
  if(chat){
    let follow=true;
    chat.addEventListener('scroll',()=>{follow=chat.scrollHeight-chat.scrollTop-chat.clientHeight<100;},{passive:true});
    const latest=()=>{if(!window.StockChiefNavigation?.wasRestored()&&follow)chat.scrollTop=chat.scrollHeight;};
    requestAnimationFrame(latest);
    new MutationObserver(()=>{if(follow)requestAnimationFrame(latest);}).observe(chat,{childList:true,subtree:true});
    new ResizeObserver(()=>{if(follow)requestAnimationFrame(latest);}).observe(chat);
  }
  function parentNavigation(href){try{const url=new URL(href,location.href);if(url.origin!==location.origin||url.pathname==='/ask'||url.pathname.startsWith('/ask/'))return false;if(window.frameElement?.dataset.embeddedAsk==='true'){window.parent.postMessage({type:'stockchief:ask-navigate',href:url.pathname+url.search+url.hash},location.origin);return true;}}catch{}return false;}
  if(window.frameElement?.dataset.embeddedAsk==='true'){
    window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='stockchief:ask-submit')return;const form=document.getElementById('tell-foundry'),input=form?.querySelector('[name=message]');if(!input||typeof event.data.message!=='string'||event.data.message.length>2000)return;input.value=event.data.message;input.dispatchEvent(new Event('input',{bubbles:true}));form.requestSubmit();});
    document.addEventListener('submit',async event=>{const form=event.target;if(form.id!=='tell-foundry'||event.defaultPrevented)return;event.preventDefault();const button=form.querySelector('button[type=submit]');if(button)button.disabled=true;try{const response=await fetch(form.action,{method:'POST',credentials:'same-origin',body:new FormData(form),headers:{accept:'application/json'}});if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Your request did not finish. Your message is kept below.');const result=await response.json();if(!result.destination)throw Error('Your request did not finish. Your message is kept below.');if(result.navigation)parentNavigation(result.destination);else location.assign(result.destination);}catch(error){let note=form.querySelector('[role=alert]');if(!note){note=document.createElement('p');note.setAttribute('role','alert');form.prepend(note);}note.textContent=error.message;if(button)button.disabled=false;}},true);

    if(location.pathname!=='/ask'&&!location.pathname.startsWith('/ask/'))parentNavigation(location.href);
    document.addEventListener('click',event=>{const link=event.target.closest('a[href]');if(!link||link.hasAttribute('download')||event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey)return;if(parentNavigation(link.href))event.preventDefault();});
    document.addEventListener('submit',event=>{const form=event.target;if(!form.matches('form[data-goal-navigation]'))return;event.preventDefault();form.target='_top';HTMLFormElement.prototype.submit.call(form);});
  }
  if(window.frameElement?.dataset.embeddedAsk==='true'&&location.pathname==='/ask')window.parent.postMessage({type:'stockchief:ask-ready',fresh:new URL(location.href).searchParams.get('fresh')},location.origin);
})();
