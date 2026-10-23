'use strict';
(()=>{
 const form=document.querySelector('#sales-entry');if(!form)return;
 const lines=form.querySelector('#order-lines'),customer=form.elements.customerId,location=form.elements.fulfillmentLocationId,
 catalogue=new Map(JSON.parse(document.querySelector('#order-catalogue').textContent).map(s=>[s.id,s])),currency=form.elements.currency.value,
 format=n=>new Intl.NumberFormat(undefined,{style:'currency',currency}).format(n/10**new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits),
 decimal=n=>(n/10**new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits).toFixed(new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits);
 let timer,sequence=0,controller,locationManual=false;
 const fields=[...form.querySelectorAll('[data-customer-field]')];
 fields.forEach(field=>{const key=field.dataset.customerField,hidden=form.querySelector('[data-contact-manual='+key+']'),saved=customer.selectedOptions[0]?.dataset[key]||'';field.dataset.manual=hidden.value||((field.value!==''||form.elements.editOrderId)&&field.value!==saved?'1':'0');hidden.value=field.dataset.manual;field.addEventListener('input',()=>{field.dataset.manual='1';hidden.value='1';});});
 function customerDefaults(){const option=customer.selectedOptions[0];fields.forEach(field=>{if(field.dataset.manual!=='1')field.value=option?.dataset[field.dataset.customerField]||'';});}
 function delivery(){const pickup=form.elements.deliveryMethod.value==='PICKUP';form.querySelector('#order-destination').hidden=pickup;form.elements.customerShippingAddress.required=!pickup;const complete=form.querySelector('#order-complete-button');if(complete)complete.hidden=!pickup;}
 function stock(){let requested=0,short=0,weight=0,missing=false;const needs=new Map();
  lines.querySelectorAll('[data-order-line]').forEach(row=>{const id=row.querySelector('[name=skuId]').value,q=Number(row.querySelector('[name=quantity]').value)||0;if(id)needs.set(id,(needs.get(id)||0)+q);});
  for(const[id,q]of needs){const s=catalogue.get(id);if(!s)continue;const available=location.value?s.positions.find(p=>p.location_id===location.value)?.available||0:s.available;requested+=q;short+=Math.max(0,q-available);if(s.weight_grams)weight+=q*Number(s.weight_grams);else missing=true;}
  form.querySelector('#order-stock-check').textContent=requested?requested+' units requested'+(short?' · '+short+' will wait for stock.':' · available to reserve.'):'Choose products to see available stock.';
  form.querySelector('#order-weight').textContent=needs.size?(missing?'Product weight is missing on one or more lines.':'Product weight: '+weight+' g · packaging is measured separately.') : '';
 }
 async function quote(){const turn=++sequence;controller?.abort();controller=new AbortController();const status=form.querySelector('#order-quote-status');
  if(!customer.value||[...lines.querySelectorAll('[name=skuId]')].some(s=>!s.value)){status.textContent='Choose a customer and product to calculate totals.';return;}
  status.textContent='Calculating totals…';form.querySelectorAll('[data-total],[data-line-total]').forEach(el=>el.textContent='…');
  try{const response=await fetch('/sales/orders/quote',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams(new FormData(form)),signal:controller.signal}),body=await response.json();if(turn!==sequence)return;if(!response.ok)throw Error(body.error||'Could not calculate pricing.');const q=body.quote;
   form.querySelectorAll('[data-total]').forEach(el=>el.textContent=format(q[el.dataset.total]));
   [...lines.querySelectorAll('[data-order-line]')].forEach((row,i)=>{const line=q.lines[i];row.querySelector('[data-line-total]').textContent=format(line.totalMinor);if(row.querySelector('[name=priceOverride]').value!=='1'){row.querySelector('[name=unitPrice]').value=decimal(line.unitPriceMinor);row.querySelector('[data-price-source]').textContent='Saved selling price / pricing rules';}});
   status.textContent=q.violations.length?'Pricing needs review: '+q.violations.map(v=>v.kind.replaceAll('_',' ')).join(', '):'Current totals · '+currency;
  }catch(error){if(error.name!=='AbortError'&&turn===sequence)status.textContent=error.message;}
 }
 function schedule(){clearTimeout(timer);++sequence;controller?.abort();stock();timer=setTimeout(quote,160);}
 customer.addEventListener('change',()=>{customerDefaults();schedule();});
 location.addEventListener('change',()=>{locationManual=true;stock();});
 form.addEventListener('change',event=>{delivery();if(event.target.name==='skuId'){const row=event.target.closest('[data-order-line]');row.querySelector('[name=priceOverride]').value='0';row.querySelector('[name=unitPrice]').value='';const s=catalogue.get(event.target.value);if(s&&!locationManual&&lines.querySelectorAll('[data-order-line]').length===1){const current=s.positions.find(p=>p.location_id===location.value);if(!current||current.available<=0){const best=[...s.positions].sort((a,b)=>b.available-a.available)[0];if(best?.available>0)location.value=best.location_id;}}}if(event.target.name==='taxRateId')form.elements.tax.disabled=Boolean(form.elements.taxRateId.value);schedule();});
 form.addEventListener('input',event=>{if(event.target.name==='unitPrice')event.target.closest('[data-order-line]').querySelector('[name=priceOverride]').value=event.target.value.trim()===''?'0':'1';if(!event.target.matches('[data-product-search]'))schedule();});
 function bind(row){let searchTimer,searchController,searchVersion=0;row.querySelector('[data-product-search]').addEventListener('input',event=>{clearTimeout(searchTimer);const term=event.target.value,version=++searchVersion;searchController?.abort();searchTimer=setTimeout(async()=>{searchController=new AbortController();const status=row.querySelector('[data-search-status]');status.textContent='Searching…';try{const response=await fetch('/sales/catalogue/search?q='+encodeURIComponent(term),{signal:searchController.signal,headers:{Accept:'application/json'}}),data=await response.json();if(!response.ok)throw Error('Search unavailable.');if(version!==searchVersion)return;const select=row.querySelector('[name=skuId]'),chosen=catalogue.get(select.value),found=data.products;found.forEach(s=>catalogue.set(s.id,s));select.replaceChildren(new Option('Choose a product',''));if(chosen&&!found.some(s=>s.id===chosen.id))found.unshift(chosen);found.forEach(s=>select.add(new Option(s.display_name+' · '+s.code,s.id,false,s.id===chosen?.id)));status.textContent=data.products.length>=50?'Showing 50 matches. Refine your search.':data.products.length+' matches';}catch(e){if(e.name!=='AbortError')status.textContent='Search failed. Please try again.';}},200);});}
 lines.querySelectorAll('[data-order-line]').forEach(bind);
 form.querySelector('#add-order-line').addEventListener('click',()=>{const fragment=document.querySelector('#order-line-template').content.cloneNode(true);bind(fragment.querySelector('[data-order-line]'));lines.append(fragment);schedule();});
 lines.addEventListener('click',event=>{if(event.target.closest('[data-remove-order-line]')&&lines.children.length>1){event.target.closest('[data-order-line]').remove();schedule();}});
 customerDefaults();fields.forEach(field=>field.dataset.auto=field.value);delivery();form.elements.tax.disabled=Boolean(form.elements.taxRateId.value);schedule();
})();
