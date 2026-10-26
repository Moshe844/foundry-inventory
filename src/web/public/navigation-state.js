/* Per-tab page position, scoped to the signed-in account and inventory.
   Only URL, scroll and disclosure state are saved. Never save form values. */
(function(){'use strict';
 const root=document.documentElement,scope=(root.dataset.accountId||'public')+':'+(root.dataset.workspaceId||'none'),storageKey='stockchief:navigation:'+scope,maxEntries=50,maxAge=30*60*1000;
 const href=()=>location.pathname+location.search+location.hash;
 let state={},entryId=null,restored=false,restoredUrl=null;
 try{state=JSON.parse(sessionStorage.getItem(storageKey)||'{}');}catch{state={};}
 if(!state||typeof state!=='object'||Array.isArray(state))state={};
 const persist=()=>{try{sessionStorage.setItem(storageKey,JSON.stringify(state));}catch{/* Navigation still works without storage. */}};
 const valid=s=>s&&s.scope===scope&&typeof s.url==='string'&&s.url===href()&&Number.isFinite(s.at)&&Date.now()-s.at<maxAge;
 function identify(){const prior=history.state?.stockchiefNavigation;if(prior&&prior.scope===scope&&prior.url===href())entryId=prior.id;else{entryId=crypto.randomUUID?crypto.randomUUID():String(Date.now())+':'+Math.random();history.replaceState({...history.state,stockchiefNavigation:{id:entryId,url:href(),scope}},'');}}
 function containers(){return Array.from(document.querySelectorAll('main,[data-navigation-scroll],.table-scroll')).filter(e=>e!==document.scrollingElement);}
 function snapshot(){if(!entryId)return;const scroll=document.scrollingElement;const value={scope,url:href(),at:Date.now(),x:scroll?.scrollLeft||0,y:scroll?.scrollTop||0,
  containers:containers().map((e,index)=>({key:e.id?'#'+e.id:'index:'+index,x:e.scrollLeft,y:e.scrollTop})),details:Array.from(document.querySelectorAll('main details')).map((e,index)=>({key:e.id?'#'+e.id:'index:'+index,open:e.open}))};
  state.entries=state.entries&&typeof state.entries==='object'?state.entries:{};state.entries[entryId]=value;state.latest=state.latest&&typeof state.latest==='object'?state.latest:{};state.latest[value.url]=entryId;
  const keys=Object.keys(state.entries).sort((a,b)=>state.entries[a].at-state.entries[b].at);while(keys.length>maxEntries){const key=keys.shift();delete state.entries[key];}
  for(const [url,key]of Object.entries(state.latest))if(!state.entries[key])delete state.latest[url];persist();
 }
 function apply(saved){if(!valid(saved))return false;const disclosure=Array.from(document.querySelectorAll('main details'));for(const d of saved.details||[]){const e=d.key.startsWith('#')?document.getElementById(d.key.slice(1)):disclosure[Number(d.key.slice(6))];if(e?.tagName==='DETAILS')e.open=Boolean(d.open);}
  const targets=containers();for(const s of saved.containers||[]){const e=s.key.startsWith('#')?document.getElementById(s.key.slice(1)):targets[Number(s.key.slice(6))];if(e){e.scrollLeft=Number(s.x)||0;e.scrollTop=Number(s.y)||0;}}
  window.scrollTo({left:Number(saved.x)||0,top:Number(saved.y)||0,behavior:'instant'});restored=true;restoredUrl=href();return true;
 }
 function restore(event){identify();const type=performance.getEntriesByType('navigation')[0]?.type,historyReturn=event?.persisted||type==='back_forward'||type==='reload',pending=state.pending;
  const explicitReturn=pending&&pending.to===href()&&pending.scope===scope&&Date.now()-pending.at<maxAge;
  const saved=historyReturn?state.entries?.[entryId]:explicitReturn?state.entries?.[pending.id]||state.entries?.[state.latest?.[href()]]:null;
  const samePageSave=state.savedForm&&state.savedForm.url===href()&&state.savedForm.scope===scope&&Date.now()-state.savedForm.at<5*60*1000;
  const candidate=saved||(samePageSave?state.entries?.[state.savedForm.id]:null);if(explicitReturn)delete state.pending;if(samePageSave)delete state.savedForm;
  persist();if(candidate&&(!location.hash||historyReturn)){apply(candidate);requestAnimationFrame(()=>apply(candidate));return true;}return false;
 }
 function init(){identify();document.addEventListener('click',event=>{const link=event.target.closest('a[href]');if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;let target;try{target=new URL(link.href,location.href);}catch{return;}if(target.origin!==location.origin)return;snapshot();
   if(link.matches('[data-return-to],.page-back,.back-link')&&target.pathname+target.search+target.hash!==href()){const to=target.pathname+target.search+target.hash,id=state.latest?.[to];if(id)state.pending={scope,to,id,at:Date.now()};persist();}
  },true);
  document.addEventListener('submit',event=>{if(event.defaultPrevented||event.target.method.toLowerCase()!=='post')return;snapshot();state.savedForm={scope,url:href(),id:entryId,at:Date.now()};persist();},true);
  window.addEventListener('pagehide',snapshot);document.addEventListener('visibilitychange',()=>{if(document.hidden)snapshot();});
  window.addEventListener('hashchange',identify);window.addEventListener('popstate',()=>restore({persisted:true}));restore();
 }
 window.StockChiefNavigation={restore,wasRestored:()=>restored&&restoredUrl===href(),snapshot};
 if('scrollRestoration' in history)history.scrollRestoration='manual';
 window.addEventListener('pageshow',event=>{if(event.persisted)restored=false;restore(event);});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
