'use strict';
(()=>{const form=document.querySelector('form[action="/transfers"]');if(!form)return;
 const region=form.querySelector('[data-transfer-grid-lines]'),rows=region?.querySelector('[data-transfer-grid-rows]'),single=form.elements.namedItem('skuId'),singlePanel=single?.closest('.rm-step-panel'),singleQuantity=form.elements.namedItem('quantity'),singleWeight=form.elements.namedItem('secondaryQuantity');
 form.addEventListener('stockchief:variant-quantities',event=>{if(event.detail.kind!=='transfer'||!rows)return;
  if(event.detail.rows.some(r=>r.product.tracking_mode!=='quantity')){event.detail.error='Choose exact lot or serial identities from the product page before moving tracked stock.';return;}
  if(event.detail.rows.length>500){event.detail.error='Prepare at most 500 transfer lines at once.';return;}
  if(single){single.disabled=true;singleQuantity.disabled=true;if(singleWeight)singleWeight.disabled=true;if(singlePanel)singlePanel.hidden=true;}
  let index=Math.max(-1,...[...form.querySelectorAll('[name]')].map(el=>Number(/^lines\[(\d+)\]/.exec(el.name)?.[1]??-1)))+1;
  for(const {product,quantity} of event.detail.rows){const existing=[...form.querySelectorAll('input[name$="[skuId]"]')].find(el=>el.value===product.id);if(existing){if(Number(quantity)===0){existing.closest('div.field').remove();continue;}const input=form.elements.namedItem(existing.name.replace('[skuId]','[quantity]'));input.value=quantity;input.disabled=false;existing.disabled=false;continue;}
   if(Number(quantity)===0)continue;const row=document.createElement('div'),label=document.createElement('label'),sku=document.createElement('input'),count=document.createElement('input');row.className='field';label.textContent=product.display_name+' · '+product.code;sku.type='hidden';sku.name='lines['+index+'][skuId]';sku.value=product.id;count.name='lines['+index+'][quantity]';count.type='number';count.min=product.quantity_increment||'0.000001';count.step=product.quantity_increment||'any';count.value=quantity;count.required=true;count.setAttribute('aria-label','Transfer quantity for '+product.display_name);label.append(sku,count);row.append(label);
   if(product.secondary_unit_label){const weightLabel=document.createElement('label'),weight=document.createElement('input');weightLabel.textContent='Actual '+product.secondary_unit_label+' for '+product.display_name;weight.name='lines['+index+'][secondaryQuantity]';weight.inputMode='decimal';weight.required=true;weightLabel.append(weight);row.append(weightLabel);}rows.append(row);index++;
  }region.hidden=false;event.preventDefault();
 });
 form.querySelector('[data-transfer-single]')?.addEventListener('click',()=>{if(!single)return;single.disabled=false;singleQuantity.disabled=false;if(singleWeight)singleWeight.disabled=false;if(singlePanel)singlePanel.hidden=false;for(const input of rows.querySelectorAll('input'))input.disabled=true;region.hidden=true;});
})();
