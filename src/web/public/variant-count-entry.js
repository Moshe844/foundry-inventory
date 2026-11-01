'use strict';
(()=>{const form=document.querySelector('[data-count-entry]');if(!form)return;const region=form.querySelector('[data-count-lines]');
 form.addEventListener('stockchief:variant-quantities',event=>{if(event.detail.kind!=='count')return;
  if(event.detail.rows.some(r=>r.product.tracking_mode!=='quantity'||r.product.secondary_unit_label)){event.detail.error='Use the product page to count exact lots, serials or measured weight.';return;}
  if(event.detail.rows.length>500){event.detail.error='Review at most 500 variants in one count.';return;}
  for(const {product,quantity} of event.detail.rows){let input=[...region.querySelectorAll('[data-count-sku]')].find(e=>e.dataset.countSku===product.id);if(input){input.value=quantity;continue;}
   const index=Math.max(-1,...[...region.querySelectorAll('[name]')].map(el=>Number(/^lines\[(\d+)\]/.exec(el.name)?.[1]??-1)))+1,row=document.createElement('p'),label=document.createElement('label'),sku=document.createElement('input');label.textContent=product.display_name+' · '+product.code+' ';sku.type='hidden';sku.name='lines['+index+'][skuId]';sku.value=product.id;input=document.createElement('input');input.name='lines['+index+'][quantity]';input.type='number';input.min='0';input.step=product.quantity_increment||'any';input.dataset.countSku=product.id;input.value=quantity;input.required=true;input.setAttribute('aria-label','Counted quantity for '+product.display_name);label.append(sku,input);row.append(label);region.append(row);
  }event.preventDefault();
 });
})();
