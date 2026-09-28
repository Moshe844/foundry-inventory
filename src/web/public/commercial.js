(function(){'use strict';
  document.querySelectorAll('[data-demo]').forEach(function(root){var buttons=[].slice.call(root.querySelectorAll('[data-demo-tab]'));
    var panels=[].slice.call(root.querySelectorAll('[data-demo-panel]'));function select(name){buttons.forEach(function(button){button.classList.toggle('is-active',button.dataset.demoTab===name);});
      panels.forEach(function(panel){panel.hidden=panel.dataset.demoPanel!==name;});}buttons.forEach(function(button){button.addEventListener('click',function(){select(button.dataset.demoTab);});});
    root.querySelectorAll('[data-demo-decision]').forEach(function(button){button.addEventListener('click',function(){var result=root.querySelector('[data-demo-result]');
      if(!result)return;result.hidden=false;result.textContent=button.dataset.demoDecision==='approve'
        ?'Demo result: StockChief would place the approved PO, verify the supplier acknowledgement, and keep the linked orders current.'
        :'Demo result: StockChief would prepare a supplier reply asking for the reason, effective date and whether current PO pricing can be honored.';});});
    var requested=(location.hash||'').replace('#','');if(requested&&buttons.some(function(button){return button.dataset.demoTab===requested;}))select(requested);});
  var switcher=document.querySelector('[data-billing-switch]');if(switcher){var setInterval=function(interval){switcher.querySelectorAll('[data-interval]').forEach(function(button){button.classList.toggle('is-active',button.dataset.interval===interval);});
      document.querySelectorAll('.plan-price[data-monthly]').forEach(function(price){price.querySelector('strong').textContent=interval==='annual'?price.dataset.annual:price.dataset.monthly;
        price.querySelector('[data-price-note]').textContent=interval==='annual'?price.dataset.annualNote:'Billed monthly';});
      document.querySelectorAll('input[name="interval"]').forEach(function(input){input.value=interval;});document.querySelectorAll('[data-plan-link]').forEach(function(link){var url=new URL(link.href);url.searchParams.set('interval',interval);link.href=url.toString();});};
    switcher.addEventListener('click',function(event){var button=event.target.closest('[data-interval]');if(button)setInterval(button.dataset.interval);});}
  document.querySelectorAll('[data-password-toggle]').forEach(function(button){button.addEventListener('click',function(){var input=document.getElementById(button.dataset.passwordToggle);
    if(!input)return;input.type=input.type==='password'?'text':'password';button.textContent=input.type==='password'?'Show':'Hide';button.setAttribute('aria-pressed',input.type==='text'?'true':'false');});});
  document.querySelectorAll('form[data-loading]').forEach(function(form){form.addEventListener('submit',function(){var button=form.querySelector('button[type="submit"]');if(button){button.disabled=true;button.dataset.label=button.textContent;button.textContent=button.dataset.loadingLabel||'Working…';}});});
})();
