'use strict';
(()=>{const from=document.querySelector('[name=fromLocationId]'),to=document.querySelector('[name=toLocationId]'),sku=document.querySelector('[name=skuId]'),status=document.querySelector('#transfer-available');if(!status)return;let turn=0;
 async function update(){const current=++turn;if(from.value===to.value)to.value=[...to.options].find(o=>o.value!==from.value)?.value||'';
  status.textContent='Checking available stock…';try{const r=await fetch('/transfers/availability?skuId='+encodeURIComponent(sku.value)+'&locationId='+encodeURIComponent(from.value),{headers:{Accept:'application/json'}}),body=await r.json();if(!r.ok)throw Error();if(current===turn)status.textContent=body.available+' available at '+from.selectedOptions[0].text+' (after reservations).';}catch{if(current===turn)status.textContent='Availability could not be checked. Try again.';}}
 from.addEventListener('change',update);sku.addEventListener('change',update);update();})();
