(()=>{'use strict';const kind=document.getElementById('pricing-kind');if(!kind)return;const form=kind.form;
 const update=()=>document.querySelectorAll('[data-pricing-kind]').forEach(section=>{const active=section.dataset.pricingKind===kind.value;section.hidden=!active;section.disabled=!active;});
 const fields=name=>[...form.querySelectorAll('[name="'+name+'"]')],set=(name,value)=>{const field=fields(name)[0];if(field)field.value=value??'';},multi=(name,values)=>{for(const option of fields(name)[0]?.options||[])option.selected=(values||[]).includes(option.value);};
 function addRow(name){const all=fields(name),last=all.at(-1)?.closest('div');if(!last)return;const copy=last.cloneNode(true);copy.classList.add('pricing-tier');for(const input of copy.querySelectorAll('input,select'))input.value=input.name.endsWith('Quantity')?'1':'';last.after(copy);}
 for(const[name,label,limit]of [['entrySku','Add another price tier',500],['bundleSku','Add another bundle product',50]]){const all=fields(name);for(const field of all)field.closest('div')?.classList.add('pricing-tier');const parent=all[0]?.closest(name==='entrySku'?'fieldset':'details');if(parent){const button=document.createElement('button');button.type='button';button.className='btn btn--ghost';button.textContent=label;button.addEventListener('click',()=>{if(fields(name).length<limit)addRow(name);});parent.append(button);}}
 const initial=document.getElementById('pricing-initial');if(initial){const rule=JSON.parse(initial.textContent);
  for(const name of ['name','currency','kind','priority','code','stacking','stackGroup','minimumQuantity','maxRedemptions','maxPerCustomer'])if(rule[name]!==undefined)set(name,rule[name]);
  fields('enabled')[0].checked=rule.enabled!==false;for(const name of ['startsAt','endsAt'])if(rule[name])set(name,new Date(rule[name]).toISOString().slice(0,16));
  for(const name of ['skuIds','customerIds','categoryIds'])multi(name,rule.scope?.[name]);multi('excludes',rule.excludes);
  if(rule.discount){set('discountType',rule.discount.type);set('discountValue',rule.discount.value/100);}
  for(const[name,key]of [['minimumOrder','minimumOrderMinor'],['minimumMargin','minimumMarginBps'],['maximumDiscount','maximumDiscountBps']])if(rule[key]!==undefined)set(name,rule[key]/100);
  for(const[name,rows,keys]of [['entrySku',rule.entries||[],['skuId','minQuantity','unitPriceMinor']],['bundleSku',rule.discount?.items||[],['skuId','quantity']]]){
   while(fields(name).length<rows.length)addRow(name);rows.forEach((row,index)=>{fields(name)[index].value=row.skuId;if(name==='entrySku'){fields('entryQuantity')[index].value=row[keys[1]];fields('entryAmount')[index].value=row[keys[2]]/100;}else fields('bundleQuantity')[index].value=row.quantity;});
  }
 }
 kind.addEventListener('change',update);update();})();
