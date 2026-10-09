'use strict';

document.addEventListener('DOMContentLoaded',()=>{
  for(const row of document.querySelectorAll('[data-report-measure]')){
    const source=row.querySelector('[data-report-source]');
    const update=()=>{for(const select of row.querySelectorAll('[data-report-measure-field],[data-report-filter-field]')){
      for(const option of select.querySelectorAll('option[data-source]')){
        option.hidden=option.dataset.source!==source.value;
        option.disabled=option.dataset.source!==source.value;
      }
      if(select.selectedOptions[0]?.disabled)select.value='';
    }};
    source?.addEventListener('change',update);update();
  }
  const rows=[...document.querySelectorAll('[data-report-filter]')];
  const add=document.querySelector('[data-report-add-filter]');
  if(!add||!rows.length)return;
  const update=()=>{add.hidden=!rows.some((row)=>row.hidden);};
  add.addEventListener('click',()=>{
    const next=rows.find((row)=>row.hidden);
    if(!next)return;
    next.hidden=false;
    next.querySelector('select')?.focus();
    update();
  });
  update();
});
