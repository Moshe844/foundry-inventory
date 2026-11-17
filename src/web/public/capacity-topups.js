'use strict';
(()=>{
 for(const form of document.querySelectorAll('[data-capacity-form]')){
  const input=form.querySelector('[name=quantity]'),total=form.querySelector('[data-capacity-total]');
  input.addEventListener('input',()=>{
   const quantity=Number(input.value);
   total.textContent=Number.isSafeInteger(quantity)&&quantity>=1&&quantity<=1000
    ?'Total: '+new Intl.NumberFormat('en-US',{style:'currency',currency:form.dataset.packCurrency||'USD'}).format(Number(form.dataset.packPrice)*quantity/100)+' / month'
    :'Enter a whole number from 1 to 1,000.';
  });
 }
})();
