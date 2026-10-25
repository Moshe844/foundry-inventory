'use strict';
(()=>{const form=document.querySelector('#cardknox-payment');if(!form)return;const button=form.querySelector('button'),status=document.querySelector('#payment-status');
 if(typeof setAccount!=='function'||typeof getTokens!=='function'){button.disabled=true;status.textContent='The secure payment fields could not load. Refresh the page or contact the business.';return;}
 setAccount(form.dataset.ifieldsKey,'StockChief','1.0.0');let sending=false;
 form.addEventListener('submit',event=>{event.preventDefault();if(sending||!form.reportValidity())return;sending=true;button.disabled=true;status.textContent='Securing your payment…';
  getTokens(()=>{status.textContent='Confirming payment. Please keep this page open.';HTMLFormElement.prototype.submit.call(form);},()=>{sending=false;button.disabled=false;status.textContent='Check the secure card fields and try again.';},30000);
 });})();
