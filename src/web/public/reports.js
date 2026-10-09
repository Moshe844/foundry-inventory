'use strict';

document.addEventListener('DOMContentLoaded',()=>{
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
