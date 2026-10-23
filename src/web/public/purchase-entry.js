'use strict';
(()=>{const form=document.querySelector('[data-purchase-entry]');if(!form)return;const date=form.elements.expectedDate,auto=form.elements.expectedDateAuto;
 date.addEventListener('input',()=>auto.value='0');
 function update(){if(auto.value!=='1')return;const days=[...form.querySelectorAll('[data-purchase-line]')].filter(row=>Number(row.querySelector('[name^="quantity["]').value)>0).map(row=>row.dataset.leadDays).filter(v=>v!=='').map(Number);if(!days.length)return;const value=new Date(form.dataset.today+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+Math.max(...days));date.value=value.toISOString().slice(0,10);}
 form.addEventListener('input',event=>{if(event.target.name?.startsWith('quantity['))update();});update();})();
