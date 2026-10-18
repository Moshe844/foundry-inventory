'use strict';
(()=>{
 const host=document.querySelector('[data-connection-host]');
 const root=document.querySelector('[data-connection-return]');
 const workspaceId=(host||root)?.dataset.workspaceId;
 const channelName='foundry:connection-return:'+workspaceId;
 let channel;
 try{if(workspaceId)channel=new BroadcastChannel(channelName);}catch{}
 if(host){
  const origins=new Set([window.location.origin]);
  try{if(host.dataset.publicOrigin)origins.add(new URL(host.dataset.publicOrigin).origin);}catch{}
  let returning=false;
  function receive(message,reply){
   if(returning||!message||message.type!=='foundry:connection-return'||message.connected!==true
       ||!workspaceId||message.workspaceId!==workspaceId)return;
   // This is navigation only. The destination independently authorizes the
   // signed-in actor and tenant; no credentials or OAuth codes cross windows.
   const path=message.returnPath;
   if(typeof path!=='string'||!/^\/settings\/connections(?:\/[a-zA-Z0-9_-]+)?(?:#[a-zA-Z0-9_-]+)?$/.test(path))return;
   returning=true;
   reply({type:'foundry:connection-return-ack',eventId:message.eventId});
   try{window.focus();}catch{}
   window.setTimeout(()=>window.location.replace(path),100);
  }
  if(channel)channel.onmessage=event=>receive(event.data,reply=>channel.postMessage(reply));
  window.addEventListener('message',event=>{
   if(!origins.has(event.origin)||!event.source)return;
   receive(event.data,reply=>{try{event.source.postMessage(reply,event.origin);}catch{}});
  });
  return;
 }
 const link=document.querySelector('[data-connection-return-link]');
 if(!root||!link){channel?.close();return;}
 let destination;
 try{destination=new URL(link.href);if(destination.origin!==root.dataset.returnOrigin)return;}catch{return;}
 if(root.dataset.connected!=='true'){channel?.close();return;}
 let parent;try{parent=window.opener&&!window.opener.closed?window.opener:null;}catch{}
 const popup=root.dataset.popup==='true'||Boolean(parent);
 if(!popup){channel?.close();window.setTimeout(()=>window.location.replace(destination.href),650);return;}
 const eventId=window.crypto.randomUUID();
 const message={type:'foundry:connection-return',eventId,connected:true,
  workspaceId:workspaceId||null,returnPath:root.dataset.returnPath};
 function closePopup(){
  try{window.close();}catch{}
  const status=root.querySelector('[data-connection-return-status]');
  if(status)status.textContent='Connected. You can close this window and continue in StockChief.';
 }
 function acknowledge(reply){
  if(reply?.type!=='foundry:connection-return-ack'||reply.eventId!==eventId)return;
  closePopup();
 }
 if(channel)channel.onmessage=event=>acknowledge(event.data);
 window.addEventListener('message',event=>{
  if(event.origin===destination.origin&&event.source===parent)acknowledge(event.data);
 });
 const closeButton=root.querySelector('[data-connection-return-close]');
 if(closeButton){closeButton.hidden=false;closeButton.addEventListener('click',closePopup);}
 function notify(){
  try{channel?.postMessage(message);}catch{}
  try{parent?.postMessage(message,destination.origin);}catch{}
 }
 notify();
 // A provider may sever opener or briefly overlap the main page's reload.
 // Retry only this local UI notification; never replay provider authorization.
 let notifications=1;
 const timer=window.setInterval(()=>{
  notify();
  if(++notifications>=5){window.clearInterval(timer);closePopup();channel?.close();}
 },400);
})();
