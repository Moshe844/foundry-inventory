'use strict';
const hubs=new WeakMap();
function hub(db){
 if(hubs.has(db))return hubs.get(db);
 const listeners=new Map();let stop=null,queue=Promise.resolve(),count=0;
 const key=c=>JSON.stringify([c.workspaceId,c.actorId,c.goalId]);
 const serial=operation=>{const result=queue.then(operation);queue=result.catch(()=>{});return result;};
 const api={subscribe:(ctx,listener)=>serial(async()=>{
  if(count>=200)throw Error('ASK_STREAM_CAPACITY');
  if(!stop)stop=await db.listen('stockchief_ask_answers',message=>{
   let event;try{event=JSON.parse(message.payload);}catch{return;}
   if(!event||!['goal','workspace','actor'].every(k=>typeof event[k]==='string'))return;
   for(const fn of listeners.get(key({workspaceId:event.workspace,actorId:event.actor,goalId:event.goal}))||[])fn();
  });
  const id=key(ctx);if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id).add(listener);count++;
  let closed=false;return ()=>serial(async()=>{
   if(closed)return;closed=true;listeners.get(id)?.delete(listener);if(!listeners.get(id)?.size)listeners.delete(id);count--;
   if(!count&&stop){const close=stop;stop=null;await close();}
  });
 })};hubs.set(db,api);return api;
}
module.exports={hub};
