'use strict';
/*
 * New order / edit draft / new quote.
 *
 * The behaviour is the earlier sales-entry.js, unchanged in substance:
 * customer defaults with manual-edit flags, the delivery switch, the stock
 * check by location, the server pricing quote for every total, measured
 * (weight) lines, server product search and the variant grid. What is new is
 * presentation: a customer search and a product search in front of the
 * native fields, line rows that show the product, and the Summary card.
 */
(()=>{
 const form=document.querySelector('#sales-entry');if(!form)return;
 const $=(sel,root=document)=>root.querySelector(sel),$$=(sel,root=document)=>[...root.querySelectorAll(sel)];
 const esc=text=>String(text??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const initials=name=>String(name||'?').replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0].toUpperCase()).join('')||'?';
 const lines=$('#order-lines'),customer=form.elements.customerId,location=form.elements.fulfillmentLocationId,
  catalogue=new Map(JSON.parse($('#order-catalogue').textContent).map(s=>[s.id,s])),currency=form.elements.currency.value,
  digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits,
  format=n=>new Intl.NumberFormat(undefined,{style:'currency',currency}).format(n/10**digits),
  decimal=n=>(n/10**digits).toFixed(digits);
 let timer,sequence=0,controller;
 const rows=()=>$$('[data-order-line]',lines);

 /* Customer contact defaults: a field follows the chosen customer until somebody types in it. */
 const fields=$$('[data-customer-field]',form);
 fields.forEach(field=>{const key=field.dataset.customerField,hidden=form.querySelector('[data-contact-manual='+key+']'),saved=customer.selectedOptions[0]?.dataset[key]||'';
  field.dataset.manual=hidden.value||((field.value!==''||form.elements.editOrderId)&&field.value!==saved?'1':'0');hidden.value=field.dataset.manual;
  field.addEventListener('input',()=>{field.dataset.manual='1';hidden.value='1';});});
 function customerDefaults(){const option=customer.selectedOptions[0];fields.forEach(field=>{if(field.dataset.manual!=='1')field.value=option?.dataset[field.dataset.customerField]||'';});}

 /* Combobox: opens on focus, arrows move, Enter picks, Esc closes. */
 function combobox(input,list,options){let items=[],active=-1;
  function render(found){items=found;list.innerHTML='';
   if(!items.length)list.innerHTML='<li class="ox-opt__none" role="presentation">'+esc(options.empty)+'</li>';
   items.forEach((item,i)=>{const li=document.createElement('li');li.className='ox-opt'+(item.add?' ox-opt--add':'');li.id=list.id+'-'+i;li.setAttribute('role','option');li.innerHTML=item.html;
    li.addEventListener('mousedown',event=>{event.preventDefault();pick(i);});list.appendChild(li);});
   list.hidden=false;input.setAttribute('aria-expanded','true');move(items.length?0:-1);}
  function open(){render(options.items(input.value.trim()));}
  function close(){list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;}
  function move(i){const nodes=$$('[role=option]',list);nodes.forEach(n=>{n.classList.remove('is-active');n.setAttribute('aria-selected','false');});active=i;
   if(i<0||!nodes[i]){input.removeAttribute('aria-activedescendant');return;}nodes[i].classList.add('is-active');nodes[i].setAttribute('aria-selected','true');
   input.setAttribute('aria-activedescendant',nodes[i].id);nodes[i].scrollIntoView({block:'nearest'});}
  function pick(i){const item=items[i];if(!item)return;close();options.pick(item);}
  input.addEventListener('focus',open);
  input.addEventListener('input',()=>{input.setCustomValidity('');open();options.typed?.(input.value.trim(),render,()=>document.activeElement===input);});
  input.addEventListener('blur',()=>setTimeout(close,120));
  input.addEventListener('keydown',event=>{
   if(event.key==='ArrowDown'){event.preventDefault();if(list.hidden)open();else move(Math.min(items.length-1,active+1));}
   else if(event.key==='ArrowUp'){event.preventDefault();move(Math.max(0,active-1));}
   else if(event.key==='Enter'){event.preventDefault();if(list.hidden){open();return;}const exact=options.exact?options.exact(input.value.trim(),items):-1;pick(exact>=0?exact:active);}
   else if(event.key==='Escape'&&!list.hidden){event.preventDefault();close();}});
  return {open,close,render};}

 /* Customer search in front of the native customer select. */
 const search=$('[data-ox-customer-search]'),combo=$('[data-ox-customer-combo]'),chip=$('[data-ox-customer-chip]');
 function customers(){return [...customer.options].filter(o=>o.value).map(o=>({id:o.value,name:o.textContent,email:o.dataset.email||'',phone:o.dataset.phone||'',address:o.dataset.address||'',orders:Number(o.dataset.orders||0)}));}
 function showCustomer(){const c=customers().find(x=>x.id===customer.value);combo.hidden=Boolean(c);chip.hidden=!c;if(!c)return;
  $('[data-ox-chip-initials]').textContent=initials(c.name);$('[data-ox-chip-name]').textContent=c.name;
  $('[data-ox-chip-contact]').textContent=[c.email,c.phone].filter(Boolean).join(' · ')||'No email or phone on file';
  $('[data-ox-chip-address]').textContent=c.address||'No saved address';
  const help=$('[data-ox-address-help]');if(help)help.textContent=c.address?'From '+String(c.name).split(/\s+/)[0]+'’s saved address. Changes apply to this order only.':'Saved with this order. The customer’s saved address stays as it is.';}
 combobox(search,$('#ox-customer-list'),{empty:'No customer matches',
  items:q=>{const needle=q.toLowerCase();const found=customers().filter(c=>!needle||[c.name,c.email,c.phone].join(' ').toLowerCase().includes(needle)).slice(0,8).map(c=>({customer:c,
   html:'<span class="ox-avatar" aria-hidden="true">'+esc(initials(c.name))+'</span><span class="ox-opt__main"><span class="ox-opt__t">'+esc(c.name)+'</span><span class="ox-opt__s">'+esc([c.email||c.phone,c.orders+' order'+(c.orders===1?'':'s')].filter(Boolean).join(' · '))+'</span></span>'}));
   found.push({add:true,html:'<span aria-hidden="true">+</span> Add new customer'});return found;},
  pick:item=>{if(item.add){const dialog=$('#new-order-customer');dialog.querySelector('[name=name]').value=search.value.trim();dialog.showModal();dialog.querySelector('[name=name]').focus();return;}
   customer.value=item.customer.id;customer.dispatchEvent(new Event('change',{bubbles:true}));}});
 $('[data-ox-customer-change]').addEventListener('click',()=>{chip.hidden=true;combo.hidden=false;search.value='';search.focus();});
 customer.addEventListener('invalid',event=>{event.preventDefault();combo.hidden=false;search.setCustomValidity('Choose a customer for this order.');search.reportValidity();});

 /* Products: the search shows local matches at once, then the server's. */
 const productSearch=$('[data-product-search]');
 const stockText=units=>units<=0?{cls:'ox-stock--out',text:'Out of stock'}:units<=3?{cls:'ox-stock--low',text:units+' left'}:{cls:'ox-stock--ok',text:units+' in stock'};
 const availableAt=s=>location.value?(s.positions||[]).find(p=>p.location_id===location.value)?.available||0:Number(s.available||0);
 function productItem(p){const stock=stockText(availableAt(p));
  return {product:p,html:'<span class="ox-thumb" aria-hidden="true">'+esc(initials(p.item_name||p.display_name))+'</span><span class="ox-opt__main"><span class="ox-opt__t">'+esc(p.display_name)+'</span><span class="ox-opt__s">'+esc(p.code)+'</span></span>'
   +'<span class="ox-opt__r"><span class="ox-num">'+(p.amount_minor==null?'No price':esc(format(p.amount_minor)))+'</span><span class="ox-opt__s '+stock.cls+'">'+esc(stock.text)+'</span></span>'};}
 function localProducts(q){const needle=q.toLowerCase();return [...catalogue.values()].filter(p=>!needle||[p.display_name,p.code,p.barcode].join(' ').toLowerCase().includes(needle)).slice(0,12).map(productItem);}
 let searchTimer,searchController,searchVersion=0;
 const productCombo=combobox(productSearch,$('#ox-product-list'),{empty:'No product matches',items:localProducts,
  exact:(q,items)=>items.findIndex(i=>[i.product.code,i.product.barcode].some(v=>v&&String(v).toLowerCase()===q.toLowerCase())),
  pick:item=>{addProduct(item.product);productSearch.value='';},
  typed:(term,render,focused)=>{clearTimeout(searchTimer);searchController?.abort();const version=++searchVersion;
   searchTimer=setTimeout(async()=>{searchController=new AbortController();try{
    const response=await fetch('/sales/catalogue/search?q='+encodeURIComponent(term),{signal:searchController.signal,headers:{Accept:'application/json'}}),data=await response.json();
    if(!response.ok)throw Error('Search unavailable.');if(version!==searchVersion)return;data.products.forEach(s=>catalogue.set(s.id,s));
    // The line selects list what the search found, as they always did.
    rows().forEach(row=>{const select=row.querySelector('[name=skuId]'),chosen=catalogue.get(select.value),found=[...data.products];
     if(chosen&&!found.some(s=>s.id===chosen.id))found.unshift(chosen);select.replaceChildren(new Option('Choose a product',''));
     found.forEach(s=>select.add(new Option(s.display_name+' · '+s.code,s.id,false,s.id===chosen?.id)));});
    if(focused()&&productSearch.value.trim()===term)render(data.products.slice(0,12).map(productItem));
   }catch(error){if(error.name!=='AbortError')productSearch.setAttribute('aria-description','Search failed. Please try again.');}},200);}});
 lines.addEventListener('invalid',event=>{if(event.target.name!=='skuId')return;event.preventDefault();
  productSearch.setCustomValidity(rows().length>1?'Choose a product for every line, or remove the empty one.':'Add at least one product.');productSearch.reportValidity();},true);
 productSearch.addEventListener('input',()=>productSearch.setCustomValidity(''));
 function emptyRow(){return rows().find(r=>!r.querySelector('[name=skuId]').value);}
 function newRow(){const fragment=$('#order-line-template').content.cloneNode(true),row=fragment.querySelector('[data-order-line]');lines.append(fragment);return row;}
 function setProduct(row,product){const select=row.querySelector('[name=skuId]');
  if(![...select.options].some(o=>o.value===product.id))select.add(new Option(product.display_name+' · '+product.code,product.id));
  select.value=product.id;select.dispatchEvent(new Event('change',{bubbles:true}));}
 function addProduct(product){catalogue.set(product.id,product);
  const existing=rows().find(r=>r.querySelector('[name=skuId]').value===product.id);
  if(existing){const q=existing.querySelector('[name=quantity]'),step=Number(product.quantity_increment)||1;q.value=String((Number(q.value)||0)+step);schedule();return;}
  setProduct(emptyRow()||newRow(),product);}

 /* A line shows its product; a line without one says so. */
 function measurement(row){const product=catalogue.get(row.querySelector('[name=skuId]').value),field=row.querySelector('[data-secondary-field]'),weight=row.querySelector('[name=secondaryQuantity]'),quantity=row.querySelector('[name=quantity]');
  quantity.step=product?.quantity_increment||'any';quantity.min=product?.quantity_increment||'0.000001';if(!field)return;
  field.hidden=!product?.secondary_unit_label;if(!product?.secondary_unit_label)weight.value='';weight.required=Boolean(product?.secondary_unit_label);
  row.querySelector('[data-secondary-label]').textContent='Actual '+(product?.secondary_unit_label||'weight');}
 function paint(row){const product=catalogue.get(row.querySelector('[name=skuId]').value);row.classList.toggle('is-empty',!product);
  row.querySelector('[data-line-thumb]').textContent=product?initials(product.item_name||product.display_name):'';
  row.querySelector('[data-line-name]').textContent=product?product.display_name:'No product yet';
  const meta=row.querySelector('[data-line-meta]');
  if(!product){meta.textContent='Search above to choose one';return;}
  const stock=stockText(availableAt(product));
  meta.innerHTML=esc(product.code)+' · <span class="'+stock.cls+'">'+esc(stock.text)+'</span>'+(product.weight_grams?'':' <span class="ox-tag">No weight</span>');
  const label=product.display_name;row.querySelector('[data-ox-dec]').setAttribute('aria-label','One fewer '+label);row.querySelector('[data-ox-inc]').setAttribute('aria-label','One more '+label);
  row.querySelector('[data-remove-order-line]').setAttribute('aria-label','Remove '+label);}

 /* Delivery: pickup hides the address and offers completing the pickup. */
 function delivery(){const pickup=form.elements.deliveryMethod.value==='PICKUP';$('#order-destination').hidden=pickup;form.elements.customerShippingAddress.required=!pickup;
  const complete=$('#order-complete-button');if(complete)complete.hidden=!pickup;
  $('[data-ox-from-label]').textContent=pickup?'Pick up at':'Ship from';
  $('[data-ox-from-help]').textContent=pickup?'Where the customer collects it.':'We pick the location that has it all in stock.';}

 /* Stock line and item count, from the same availability as before. */
 function stock(){const needs=new Map();let units=0;
  rows().forEach(row=>{const id=row.querySelector('[name=skuId]').value,q=Number(row.querySelector('[name=quantity]').value)||0;if(id){needs.set(id,(needs.get(id)||0)+q);units+=q;}paint(row);});
  let short=0;for(const[id,q]of needs){const s=catalogue.get(id);if(s&&q>availableAt(s))short+=1;}
  $('[data-ox-count]').textContent=units+' item'+(units===1?'':'s');
  const where=location.value?' at '+location.selectedOptions[0].text:'';let dot='grey',text='Pick a customer and add items';
  if(needs.size&&!short){dot='green';text='All in stock'+where+'.'+(customer.value?' Ready to create.':' Pick a customer to continue.');}
  else if(short){dot='amber';text=short+' of '+needs.size+' item'+(needs.size===1?'':'s')+' short'+(where||' across locations')+'. The rest can still be held.';}
  else if(customer.value)text='Add items to this order';
  $('#order-stock-check').innerHTML='<span class="ox-dot ox-dot--'+dot+'" aria-hidden="true"></span><span>'+esc(text)+'</span>';}

 /* Totals come from the server's pricing quote. */
 async function quote(){const turn=++sequence;controller?.abort();controller=new AbortController();const status=$('#order-quote-status');
  if(!customer.value||rows().some(r=>!r.querySelector('[name=skuId]').value)){status.textContent='Choose a customer and product to calculate totals.';return;}
  status.textContent='Calculating totals…';
  try{const response=await fetch('/sales/orders/quote',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:new URLSearchParams(new FormData(form)),signal:controller.signal}),body=await response.json();
   if(turn!==sequence)return;if(!response.ok)throw Error(body.error||'Could not calculate pricing.');const q=body.quote;
   $$('[data-total]',form).forEach(el=>el.textContent=format(q[el.dataset.total]));
   $('[data-ox-mbar-total]').textContent=format(q.totalMinor);
   rows().forEach((row,i)=>{const line=q.lines[i];if(!line)return;row.querySelector('[data-line-total]').textContent=format(line.totalMinor);
    if(row.querySelector('[name=priceOverride]').value!=='1'){row.querySelector('[name=unitPrice]').value=decimal(line.unitPriceMinor);row.querySelector('[data-price-source]').textContent='Saved selling price / pricing rules';}});
   status.textContent=q.violations.length?'Pricing needs review: '+q.violations.map(v=>v.kind.replaceAll('_',' ')).join(', '):'';
  }catch(error){if(error.name!=='AbortError'&&turn===sequence)status.textContent=error.message;}}
 function schedule(){clearTimeout(timer);++sequence;controller?.abort();stock();timer=setTimeout(quote,160);}

 customer.addEventListener('change',()=>{customerDefaults();showCustomer();schedule();});
 location.addEventListener('change',()=>{stock();productCombo.close();});
 form.addEventListener('change',event=>{delivery();
  if(event.target.name==='skuId'){const row=event.target.closest('[data-order-line]');row.querySelector('[name=priceOverride]').value='0';row.querySelector('[name=unitPrice]').value='';measurement(row);}
  if(event.target.name==='taxRateId'&&form.elements.tax)form.elements.tax.disabled=Boolean(form.elements.taxRateId.value);
  if(event.target!==customer)schedule();});
 form.addEventListener('input',event=>{if(event.target.name==='unitPrice')event.target.closest('[data-order-line]').querySelector('[name=priceOverride]').value=event.target.value.trim()===''?'0':'1';
  if(!event.target.matches('[data-product-search],[data-ox-customer-search]'))schedule();});
 lines.addEventListener('click',event=>{const row=event.target.closest('[data-order-line]');if(!row)return;const q=row.querySelector('[name=quantity]'),step=Number(catalogue.get(row.querySelector('[name=skuId]').value)?.quantity_increment)||1;
  if(event.target.closest('[data-ox-inc]'))q.value=String(+((Number(q.value)||0)+step).toFixed(6));
  else if(event.target.closest('[data-ox-dec]'))q.value=String(Math.max(step,+((Number(q.value)||step)-step).toFixed(6)));
  else if(event.target.closest('[data-remove-order-line]')){if(rows().length>1)row.remove();else{row.querySelector('[name=skuId]').value='';q.value='1';row.querySelector('[name=unitPrice]').value='';row.querySelector('[name=priceOverride]').value='0';}productSearch.focus();}
  else return;schedule();});
 $('#add-order-line').addEventListener('click',()=>{newRow();schedule();productSearch.focus();});

 /* Variant grid: fill the lines it names, reusing an empty one first. */
 form.addEventListener('stockchief:variant-quantities',event=>{if(event.detail.kind!=='sale')return;const entries=event.detail.rows;
  if(new Set(rows().map(r=>r.querySelector('[name=skuId]').value).filter(Boolean).concat(entries.filter(e=>Number(e.quantity)>0).map(e=>e.product.id))).size>500){event.detail.error='An order supports up to 500 lines. Choose fewer variants.';return;}
  for(const {product,quantity} of entries){catalogue.set(product.id,product);let row=rows().find(r=>r.querySelector('[name=skuId]').value===product.id);
   if(Number(quantity)===0){if(row){if(rows().length>1)row.remove();else{row.querySelector('[name=skuId]').value='';row.querySelector('[name=quantity]').value='1';}}continue;}
   if(!row){row=emptyRow()||newRow();setProduct(row,product);}
   row.querySelector('[name=quantity]').value=quantity;measurement(row);}
  schedule();event.preventDefault();});

 /* After create: remember what to say on the order page. */
 form.addEventListener('submit',event=>{if(form.action.indexOf('/sales/orders')<0)return;
  try{const count=rows().reduce((s,r)=>s+(r.querySelector('[name=skuId]').value?Number(r.querySelector('[name=quantity]').value)||0:0),0);
   const pay=document.querySelector('input[name=oxPayment]:checked')?.value||'later';
   sessionStorage.setItem('ox-created',JSON.stringify({next:event.submitter?.value||'confirm',count,pay,where:location.value?location.selectedOptions[0].text:''}));}catch{}});

 rows().forEach(measurement);customerDefaults();fields.forEach(field=>field.dataset.auto=field.value);showCustomer();delivery();
 if(form.elements.tax&&form.elements.taxRateId)form.elements.tax.disabled=Boolean(form.elements.taxRateId.value);schedule();
})();
