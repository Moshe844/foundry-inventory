'use strict';
(()=>{const from=document.querySelector('[name=fromLocationId]'),to=document.querySelector('[name=toLocationId]'),sku=document.querySelector('[name=skuId]'),status=document.querySelector('#transfer-available');if(!status)return;let turn=0;
 async function update(){const current=++turn;if(from.value===to.value)to.value=[...to.options].find(o=>o.value!==from.value)?.value||'';
  status.textContent='Checking available stock…';try{const r=await fetch('/transfers/availability?skuId='+encodeURIComponent(sku.value)+'&locationId='+encodeURIComponent(from.value),{headers:{Accept:'application/json'}}),body=await r.json();if(!r.ok)throw Error();if(current===turn)status.textContent=body.available+' available at '+from.selectedOptions[0].text+' (after reservations).';}catch{if(current===turn)status.textContent='Availability could not be checked. Try again.';}}
 const search=document.querySelector('#transfer-product-search'),searchStatus=document.querySelector('#transfer-search-status');let timer,searchTurn=0,request;
 search?.addEventListener('input',()=>{clearTimeout(timer);const current=++searchTurn;request?.abort();timer=setTimeout(async()=>{
  request=new AbortController();searchStatus.textContent='Finding products…';try{const response=await fetch('/transfers/products?q='+encodeURIComponent(search.value),{signal:request.signal,headers:{Accept:'application/json'}});
   if(!response.ok)throw Error();const result=await response.json();if(current!==searchTurn)return;
   const selected=sku.selectedOptions[0]?.cloneNode(true),selectedId=sku.value;sku.replaceChildren(...result.products.map(p=>new Option(p.label,p.id)));
   if(selected&&!result.products.some(p=>p.id===selectedId))sku.add(selected,0);if(selectedId)sku.value=selectedId;
   searchStatus.textContent=result.products.length?'Found '+result.products.length+' matches. Choose the product below.':'No matching quantity-tracked products.';update();
  }catch(error){if(error.name!=='AbortError'&&current===searchTurn)searchStatus.textContent='Product search could not finish. Try again.';}
 },250);});
 from.addEventListener('change',update);sku.addEventListener('change',update);update();})();
