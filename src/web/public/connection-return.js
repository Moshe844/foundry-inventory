'use strict';
(()=>{
 const root=document.querySelector('[data-connection-return]'),link=document.querySelector('[data-connection-return-link]');
 if(!root||!link)return;
 let destination;try{destination=new URL(link.href);if(destination.origin!==root.dataset.returnOrigin)return;}catch{return;}
 let parent;try{parent=window.opener&&!window.opener.closed?window.opener:null;}catch{}
 if(parent){try{parent.postMessage({type:'foundry:connection-return',connected:root.dataset.connected==='true',
  workspaceId:root.dataset.workspaceId||null,returnPath:root.dataset.returnPath},destination.origin);}catch{}}
 if(root.dataset.connected!=='true')return;
 window.setTimeout(()=>{
  if(parent){try{window.close();}catch{}}
  // Same-tab sign-in has no opener. A browser may also refuse popup closure.
  // Both return to the host-supplied destination without replaying OAuth.
  if(!window.closed)window.location.replace(destination.href);
 },650);
})();
