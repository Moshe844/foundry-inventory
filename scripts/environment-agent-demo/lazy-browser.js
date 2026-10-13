'use strict';
// No browser/renderer/tenant-role setup for a goal that only needs governed
// records. One goal-local initialization, shared only by concurrent tool calls.
function lazyBrowser(create){
 let opening=null;
 const get=()=>opening||=(async()=>create())();
 return {act:async input=>(await get()).act(input),restore:async url=>(await get()).restore(url)};
}
module.exports={lazyBrowser};
