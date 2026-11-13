'use strict';
// Job 173: "Turn on push on this device". Asks the browser for permission,
// subscribes through the service worker with the server's push key, and
// sends the subscription with the form. Nothing is sent without a tap.
(function(){
  var form=document.querySelector('[data-push-subscribe]');if(!form)return;
  var status=document.querySelector('[data-push-status]');
  var appleMobile=/iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  var installed=navigator.standalone===true||window.matchMedia('(display-mode: standalone)').matches;
  var installHelp=document.querySelector('[data-ios-push-help]');
  if(installHelp&&appleMobile&&!installed)installHelp.hidden=false;
  function say(text){if(status)status.textContent=text;}
  function key(value){var padded=(value+'===='.slice((value.length+3)%4)).replace(/-/g,'+').replace(/_/g,'/'),raw=atob(padded),out=new Uint8Array(raw.length);
    for(var i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}
  function encode(buffer){var bytes=new Uint8Array(buffer),text='';for(var i=0;i<bytes.length;i++)text+=String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
  form.addEventListener('submit',function(event){
    if(form.elements.endpoint.value)return;
    event.preventDefault();
    if(appleMobile&&!installed){say('Open StockChief from the Home Screen to turn on push.');return;}
    if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)||!window.isSecureContext){
      say('This browser cannot get push notifications. Use text messages instead.');return;}
    var button=form.querySelector('button');button.disabled=true;say('Asking your browser…');
    Notification.requestPermission().then(function(answer){
      if(answer!=='granted')throw new Error('Notifications are blocked for StockChief in this browser. Allow them in the browser settings, then try again.');
      return navigator.serviceWorker.register('/edge-error-worker.js',{scope:'/',updateViaCache:'none'}).then(function(){return navigator.serviceWorker.ready;});
    }).then(function(registration){
      return registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key(form.dataset.key)});
    }).then(function(subscription){
      form.elements.endpoint.value=subscription.endpoint;
      form.elements.p256dh.value=encode(subscription.getKey('p256dh'));
      form.elements.auth.value=encode(subscription.getKey('auth'));
      form.submit();
    }).catch(function(error){button.disabled=false;say(error&&error.message||'Push could not be turned on in this browser.');});
  });
})();
