'use strict';
(()=>{const input=document.querySelector('[autofocus]');if(input)input.focus({preventScroll:true});for(const form of document.querySelectorAll('form[data-owner-action]'))form.addEventListener('submit',()=>{const button=form.querySelector('button[type=submit],button:not([type])');if(button){button.disabled=true;button.textContent='Saving…';}});})();
