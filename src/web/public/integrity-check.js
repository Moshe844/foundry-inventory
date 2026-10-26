'use strict';
(()=>{const form=document.querySelector('#integrity-check-form'),result=document.querySelector('#integrity-check-result'),badge=document.querySelector('#integrity-check-badge');if(!form||!result)return;
 form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;if(badge)badge.textContent='checking';result.textContent='Checking stock, tracked units and journal totals… You can keep using the rest of Settings.';
  try{const response=await fetch(form.action,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(form))}),body=await response.json();
   if(!response.ok||body.status!=='READY')throw Error();
   const counts=Object.entries(body.result).filter(([key,value])=>key!=='ok'&&Number(value)>0);
   result.textContent=body.result.ok?'Stock, tracked units and journal totals balanced at this check.':counts.map(([key,value])=>value+' '+key.replaceAll('_',' ')).join('; ');
   if(badge){badge.textContent=body.result.ok?'balanced at last check':counts.length+' to check';badge.classList.toggle('is-ok',body.result.ok);badge.classList.toggle('is-warn',!body.result.ok);}
   const time=document.createElement('p');time.className='rm-quiet';time.textContent='Checked '+window.StockChiefFormat.create(document.documentElement.dataset.timeZone).dateTime(body.checkedAt)+'. Later changes are not included.';result.append(time);
  }catch{if(badge){badge.textContent='check interrupted';badge.classList.remove('is-ok');badge.classList.add('is-warn');}result.textContent='This check could not finish. Your stock and books were not changed. Try again shortly.';}
  finally{button.disabled=false;}
 });
})();
