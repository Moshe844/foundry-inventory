'use strict';
// No browser/renderer/tenant-role setup for a goal that only needs governed
// records. One goal-local initialization, shared only by concurrent tool calls.
function lazyBrowser(create){
 let opening=null,pendingLinks=[];
 const get=input=>{
  if(opening)return opening;
  const attempt=(async()=>{
   const browser=await create(input);for(const links of pendingLinks)browser.observeReadLinks?.(links);pendingLinks=[];return browser;
  })();opening=attempt;
  attempt.catch(()=>{if(opening===attempt)opening=null;});
  return attempt;
 };
 return {prepare:()=>get(),act:async input=>(await get(input)).act(input),restore:async url=>(await get()).restore(url),
  observeReadLinks:async outcomes=>{if(opening)(await opening).observeReadLinks?.(outcomes);else pendingLinks.push(outcomes);}};
}
module.exports={lazyBrowser};
