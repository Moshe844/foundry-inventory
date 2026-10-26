(function(){
  'use strict';
  try{if(window.frameElement?.dataset.embeddedAsk==='true')document.body.classList.add('sc-embedded-chat');}catch{/* An unrelated embedding page cannot supply application context. */}
  const toggle=document.querySelector('[data-sidebar-toggle]');
  function closeNavigation(){document.body.classList.remove('sc-sidebar-open');toggle?.setAttribute('aria-expanded','false');toggle?.setAttribute('aria-label','Open navigation');}
  document.querySelector('[data-sidebar-close]')?.addEventListener('click',()=>{closeNavigation();toggle?.focus();});
  toggle?.addEventListener('click',()=>{const open=document.body.classList.toggle('sc-sidebar-open');toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close navigation':'Open navigation');});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.sc-sidebar,[data-sidebar-toggle]'))closeNavigation();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')closeNavigation();});
  const bulk=document.querySelector('[data-bulk-toolbar]');
  if(bulk){const update=()=>{bulk.hidden=!document.querySelector('[data-product-selection]:checked');};document.addEventListener('change',event=>{if(event.target.matches('[data-product-selection],[data-select-all-products]'))update();});update();}
  for(const table of document.querySelectorAll('main table:not([data-preserve-grid])')){const header=table.tHead;if(!header||header.rows.length!==1)continue;const labels=Array.from(header.rows[0].cells).map(cell=>cell.textContent.trim());const rows=Array.from(table.tBodies).flatMap(body=>Array.from(body.rows));if(!labels.length||!rows.length||rows.some(row=>row.cells.length!==labels.length||Array.from(row.cells).some(cell=>cell.colSpan!==1)))continue;table.classList.add('sc-mobile-table');table.setAttribute('role','table');for(const row of rows){row.setAttribute('role','row');Array.from(row.cells).forEach((cell,index)=>{cell.dataset.cellLabel=labels[index];cell.setAttribute('role','cell');});}}
  const chat=document.querySelector('[data-chat-scroll]');
  if(chat){
    let follow=true;
    chat.addEventListener('scroll',()=>{follow=chat.scrollHeight-chat.scrollTop-chat.clientHeight<100;},{passive:true});
    const latest=()=>{if(!window.StockChiefNavigation?.wasRestored()&&follow)chat.scrollTop=chat.scrollHeight;};
    requestAnimationFrame(latest);
    new MutationObserver(()=>{if(follow)requestAnimationFrame(latest);}).observe(chat,{childList:true,subtree:true});
    new ResizeObserver(()=>{if(follow)requestAnimationFrame(latest);}).observe(chat);
  }
  const panel=document.querySelector('[data-ask-panel]');
  if(panel){
    const frame=panel.querySelector('iframe');let previousFocus;
    document.addEventListener('click',event=>{
      const link=event.target.closest('a[href]');if(!link||event.defaultPrevented||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button!==0)return;
      const url=new URL(link.href,location.href);
      if(url.origin!==location.origin||url.pathname!=='/ask'||location.pathname==='/ask')return;
      event.preventDefault();previousFocus=link;url.searchParams.set('panel','1');url.searchParams.set('from',location.pathname+location.search);
      frame.src=url.pathname+url.search+url.hash;panel.showModal();panel.querySelector('button').focus();
    });
    function close(){panel.close();frame.removeAttribute('src');previousFocus?.focus({preventScroll:true});}
    panel.querySelector('[data-close-ask]').addEventListener('click',close);
    panel.addEventListener('cancel',event=>{event.preventDefault();close();});
  }
})();
