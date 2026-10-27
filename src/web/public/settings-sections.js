'use strict';
(()=>{
 const oldSections=JSON.parse(document.querySelector('[data-settings-hashes]')?.dataset.settingsHashes||'{}');
 if(!new URLSearchParams(location.search).has('section')&&oldSections[location.hash.slice(1)]){
  location.replace('/settings?section='+oldSections[location.hash.slice(1)]+location.hash);return;
 }
 for(const form of document.querySelectorAll('form[data-settings-form]')){
  const button=form.querySelector('button[type=submit]');if(!button)continue;
  const snapshot=()=>JSON.stringify(Array.from(new FormData(form)).filter(([name])=>name!=='_csrf'));
  const initial=snapshot();button.disabled=true;const update=()=>button.disabled=snapshot()===initial;
  form.addEventListener('input',update);form.addEventListener('change',update);form.addEventListener('reset',()=>requestAnimationFrame(update));
 }
})();
