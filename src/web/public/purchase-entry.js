'use strict';
(()=>{const form=document.querySelector('[data-purchase-entry]');if(!form)return;
 const date=form.elements.namedItem('expectedDate'),auto=form.elements.namedItem('expectedDateAuto');
 const exponent=Number(form.dataset.currencyExponent||2),currency=form.dataset.currency||'USD';
 const minor=value=>{const m=String(value||'').trim().match(/^(\d+)(?:\.(\d*))?$/);if(!m||m[2]?.length>exponent)return null;return BigInt(m[1])*10n**BigInt(exponent)+BigInt((m[2]||'').padEnd(exponent,'0')||'0');};
 const format=n=>{const base=10n**BigInt(exponent),raw=(n/base).toString()+(exponent?'.'+(n%base).toString().padStart(exponent,'0'):'');const parts=raw.split('.');parts[0]=BigInt(parts[0]).toLocaleString('en-US');return (currency==='USD'?'$':currency+' ')+parts.join('.');};
 date?.addEventListener('input',()=>{if(auto)auto.value='0';});
 function update(){let total=0n,valid=true;const days=[];
  for(const row of form.querySelectorAll('[data-purchase-line]')){const quantity=row.querySelector('[name^="quantity["]'),cost=row.querySelector('[name^="unitCost["]'),out=row.querySelector('[data-line-total]'),q=String(quantity?.value||'').trim();
   if(!q||Number(q)===0){if(out)out.textContent=format(0n);continue;}
   const c=minor(cost?.value),pack=BigInt(row.dataset.packUnits||1);if(!/^\d+$/.test(q)||c===null){valid=false;if(out)out.textContent='Check quantity and cost';continue;}
   const amount=BigInt(q)*pack*c;total+=amount;if(out)out.textContent=format(amount);if(row.dataset.leadDays!=='')days.push(Number(row.dataset.leadDays));
  }
  const out=form.querySelector('[data-purchase-total]');if(out)out.textContent=valid?format(total):'Check the selected lines';
  if(date&&auto?.value==='1'&&days.length){const value=new Date(form.dataset.today+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+Math.max(...days));date.value=value.toISOString().slice(0,10);}
 }
 form.addEventListener('input',update);update();})();
