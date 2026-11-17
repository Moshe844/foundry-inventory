'use strict';
(()=>{
 const nav=document.querySelector('.sc-billing-tabs');if(!nav)return;
 const links=[...nav.querySelectorAll('[data-billing-link]')],panels=[...document.querySelectorAll('[data-billing-panel]')];
 function selected(){
  const hash=location.hash.slice(1),target=document.getElementById(hash),panel=target?.closest('[data-billing-panel]');
  if(panel)return panel.dataset.billingPanel;
  if(new URLSearchParams(location.search).has('add'))return 'capacity';
  return 'overview';
 }
 function show(name){
  if(!links.some(link=>link.dataset.billingLink===name))name='overview';
  for(const panel of panels)panel.hidden=panel.dataset.billingPanel!==name;
  for(const link of links){if(link.dataset.billingLink===name)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
  if(name==='capacity'){const extra=document.getElementById('extra-capacity');if(extra)extra.open=true;}
 }
 nav.addEventListener('click',event=>{
  const link=event.target.closest('[data-billing-link]');if(!link||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  event.preventDefault();show(link.dataset.billingLink);history.replaceState(null,'',link.getAttribute('href'));
 });
 window.addEventListener('hashchange',()=>show(selected()));show(selected());
})();
