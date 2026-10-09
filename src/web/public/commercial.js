(function(){
  'use strict';

  var nav=document.querySelector('[data-public-nav]');
  var navToggle=document.querySelector('[data-nav-toggle]');
  if(nav&&navToggle){
    navToggle.addEventListener('click',function(){
      var open=nav.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded',open?'true':'false');
    });
    document.addEventListener('click',function(event){
      if(nav.classList.contains('is-open')&&!nav.contains(event.target)){
        nav.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded','false');
      }
    });
  }

  document.querySelectorAll('[data-operation-map]').forEach(function(map){
    var nodes=[].slice.call(map.querySelectorAll('[data-flow-node]'));
    nodes.forEach(function(node,index){node.style.setProperty('--flow-delay',String(index*0.16)+'s');});
  });

  document.querySelectorAll('[data-story-player]').forEach(function(root){
    var steps=[].slice.call(root.querySelectorAll('[data-story-step]'));
    var scenes=[].slice.call(root.querySelectorAll('[data-story-scene]'));
    var progress=root.querySelector('[data-story-progress]');
    var clock=root.querySelector('[data-story-clock]');
    var counter=root.querySelector('[data-story-counter]');
    var play=root.querySelector('[data-story-play]');
    var playLabel=root.querySelector('[data-play-label]');
    var restart=root.querySelector('[data-story-restart]');
    var index=0;
    var playing=!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var timer=null;

    function render(nextIndex,options){
      index=Math.max(0,Math.min(scenes.length-1,nextIndex));
      steps.forEach(function(step,stepIndex){
        step.classList.toggle('is-active',stepIndex===index);
        step.classList.toggle('is-complete',stepIndex<index);
        step.setAttribute('aria-current',stepIndex===index?'step':'false');
      });
      scenes.forEach(function(scene,sceneIndex){
        var active=sceneIndex===index;
        scene.hidden=!active;
        scene.classList.toggle('is-active',active);
      });
      if(progress)progress.style.width=String(((index+1)/scenes.length)*100)+'%';
      if(clock)clock.textContent=scenes[index].dataset.clock||'';
      if(counter)counter.textContent=String(index+1)+' / '+String(scenes.length);
      schedule();
    }

    function schedule(){
      if(timer)window.clearTimeout(timer);
      if(!playing||index>=scenes.length-1)return;
      timer=window.setTimeout(function(){render(index+1);},9000);
    }

    function setPlaying(next){
      playing=next;
      if(play){play.setAttribute('aria-pressed',playing?'false':'true');}
      if(playLabel)playLabel.textContent=playing?'Pause':'Play';
      schedule();
    }

    steps.forEach(function(step){step.addEventListener('click',function(){render(Number(step.dataset.storyStep),{updateHash:true});});});
    if(play)play.addEventListener('click',function(){setPlaying(!playing);});
    if(restart)restart.addEventListener('click',function(){setPlaying(true);render(0,{updateHash:true});});
    root.querySelectorAll('[data-demo-decision]').forEach(function(button){
      button.addEventListener('click',function(){
        var result=root.querySelector('[data-demo-result]');
        if(!result)return;
        result.hidden=false;
        result.textContent=button.dataset.demoDecision==='approve'
          ?'Approved in the demo: StockChief would record the decision, send the exact approved PO change, verify acknowledgement and keep linked orders current.'
          :'Draft prepared: StockChief would ask ABC Apparel to explain the increase and honor the current PO price. Nothing is sent without the required authority.';
        setPlaying(false);
      });
    });
    render(0);
    setPlaying(playing);
  });

  var switcher=document.querySelector('[data-billing-switch]');
  if(switcher){
    var setBillingInterval=function(interval){
      switcher.querySelectorAll('[data-interval]').forEach(function(button){button.classList.toggle('is-active',button.dataset.interval===interval);});
      document.querySelectorAll('.plan-price[data-monthly]').forEach(function(price){
        price.querySelector('strong').textContent=interval==='annual'?price.dataset.annual:price.dataset.monthly;
        price.querySelector('[data-price-note]').textContent=interval==='annual'?price.dataset.annualNote:'Billed monthly';
      });
      document.querySelectorAll('input[name="interval"]').forEach(function(input){input.value=interval;});
      document.querySelectorAll('[data-plan-link]').forEach(function(link){
        var url=new URL(link.href);
        url.searchParams.set('interval',interval);
        link.href=url.toString();
      });
    };
    switcher.addEventListener('click',function(event){
      var button=event.target.closest('[data-interval]');
      if(button)setBillingInterval(button.dataset.interval);
    });
  }

  document.querySelectorAll('[data-password-toggle]').forEach(function(button){
    button.addEventListener('click',function(){
      var input=document.getElementById(button.dataset.passwordToggle);
      if(!input)return;
      input.type=input.type==='password'?'text':'password';
      button.textContent=input.type==='password'?'Show':'Hide';
      button.setAttribute('aria-pressed',input.type==='text'?'true':'false');
    });
  });

  document.querySelectorAll('form[data-loading]').forEach(function(form){
    var confirmation=form.querySelector('[data-confirm-password]');
    if(confirmation){
      var original=document.getElementById(confirmation.dataset.confirmPassword);
      var check=function(){confirmation.setCustomValidity(original&&confirmation.value!==original.value?'Passwords do not match.':'');};
      confirmation.addEventListener('input',check);
      if(original)original.addEventListener('input',check);
      form.addEventListener('submit',check);
    }
    form.addEventListener('submit',function(){
      var button=form.querySelector('button[type="submit"]');
      if(button){button.disabled=true;button.dataset.label=button.textContent;button.textContent=button.dataset.loadingLabel||'Working…';}
    });
  });
})();
