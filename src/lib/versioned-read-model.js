'use strict';
const databases=new WeakMap();
const MAX_ENTRIES=256,MAX_BYTES=16*1024*1024,MAX_VALUE_BYTES=256*1024,TTL_MS=10000;
function state(db){
 if(databases.has(db))return databases.get(db);
 const cache={entries:new Map(),bytes:0,hits:0,misses:0,coalesced:0,uncacheable:0,revisions:new Map(),sequence:0,subscription:null,slots:new Map(),slotBytes:0,stale:0};
 databases.set(db,cache);
 const clear=()=>{cache.entries.clear();cache.revisions.clear();cache.bytes=0;outdate(cache,null,true);};
 if(db.subscribe){cache.subscription=db.subscribe('stockchief_read_models',message=>{
  let notice;try{notice=JSON.parse(message.payload);}catch{return;}
  if(typeof notice.workspace!=='string'||notice.workspace.length>160||typeof notice.business!=='boolean')return;
  outdate(cache,notice.workspace,notice.business);
  const affected=[];for(const [key,entry]of cache.entries)if(entry.workspace===notice.workspace&&(notice.business||entry.domain==='all'))affected.push(key);
  if(!affected.length)return;
  const prior=cache.revisions.get(notice.workspace)||{all:0,business:0};
  cache.revisions.set(notice.workspace,{all:++cache.sequence,business:notice.business?cache.sequence:prior.business});
  for(const key of affected)remove(cache,key);
  if(cache.revisions.size>MAX_ENTRIES)clear();
 },{onState:clear});
 // Same-process writes must be visible before the other socket delivers NOTIFY.
 // This hook runs only after successful implicit/explicit commit, never rollback.
 db.onCommittedWrite?.((workspaces,business=true)=>{if(!workspaces&&business)return clear();if(workspaces)for(const id of workspaces)outdate(cache,id,business);else outdate(cache,null,business);if(business)for(const id of workspaces)cache.revisions.delete(id);for(const [key,entry]of cache.entries)if((!workspaces||workspaces.has(entry.workspace))&&(business||entry.domain==='all'))remove(cache,key);});}
 return cache;
}
function remove(cache,key){const previous=cache.entries.get(key);if(previous){cache.bytes-=previous.bytes||0;cache.entries.delete(key);}}
async function read(db,workspaceId,key,operation,{domain='all'}={}){
 if(!['all','business'].includes(domain))throw new TypeError('Choose a supported read-model revision.');
 const cache=state(db);
 // A transaction-scoped wrapper cannot own a subscription or its lifetime.
 if(!cache.subscription)return operation();
 await cache.subscription.ready;
 const revision=cache.revisions.get(workspaceId)?.[domain]||0;
 const identity=JSON.stringify([workspaceId,domain,revision,key]),now=Date.now();let entry=cache.entries.get(identity);
 if(entry&&entry.expiresAt<=now){remove(cache,identity);entry=null;}
 if(entry){cache.hits++;if(entry.expiresAt===Infinity)cache.coalesced++;cache.entries.delete(identity);cache.entries.set(identity,entry);return structuredClone(await entry.promise);}
 while(cache.entries.size>=MAX_ENTRIES||cache.bytes>MAX_BYTES)remove(cache,cache.entries.keys().next().value);
 cache.misses++;entry={workspace:workspaceId,domain,expiresAt:Infinity,bytes:0};entry.promise=Promise.resolve().then(operation).then(value=>{
  const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>MAX_VALUE_BYTES){cache.uncacheable++;if(cache.entries.get(identity)===entry)remove(cache,identity);return value;}
  if(cache.entries.get(identity)===entry){entry.bytes=bytes;cache.bytes+=bytes;entry.expiresAt=Date.now()+(domain==='business'?60000:TTL_MS);while(cache.bytes>MAX_BYTES)remove(cache,cache.entries.keys().next().value);}
  return value;
 }).catch(error=>{if(cache.entries.get(identity)===entry)remove(cache,identity);throw error;});cache.entries.set(identity,entry);return structuredClone(await entry.promise);
}
// A whole-business figure that a page shows (low stock, report cards). Its last
// good value is kept across invalidations. When the figure has changed, one fresh
// count runs per figure; the page waits for it up to `waitMs`, and while it is
// still running (a large import is rewriting the same tables) the page gets the
// last good value with the time it was counted, and `current` is false. With no
// earlier value, or one older than MAX_STALE_MS, the page waits for the count.
const WAIT_MS=2000,MAX_STALE_MS=60*60*1000;
function outdate(cache,workspace,business){for(const slot of cache.slots.values())if((workspace===null||slot.workspace===workspace)&&(business||slot.domain==='all'))slot.version++;}
function dropSlot(cache,id){const slot=cache.slots.get(id);if(slot){cache.slotBytes-=slot.last?.bytes||0;cache.slots.delete(id);}}
async function settled(db,workspaceId,key,operation,{domain='all',waitMs=WAIT_MS,keep=()=>true}={}){
 if(!['all','business'].includes(domain))throw new TypeError('Choose a supported read-model revision.');
 const cache=state(db);
 if(!cache.subscription){const asOf=new Date();return {value:await operation(),asOf,current:true};}
 await cache.subscription.ready;
 const id=JSON.stringify([workspaceId,domain,key]),now=Date.now();let slot=cache.slots.get(id);
 if(slot){cache.slots.delete(id);cache.slots.set(id,slot);}
 else{while(cache.slots.size>=MAX_ENTRIES)dropSlot(cache,cache.slots.keys().next().value);slot={workspace:workspaceId,domain,version:0,inflight:null,last:null};cache.slots.set(id,slot);}
 if(slot.last&&slot.last.version===slot.version&&slot.last.expiresAt>now){cache.hits++;return {value:structuredClone(slot.last.value),asOf:slot.last.asOf,current:true};}
 const wanted=slot.version;
 if(!slot.inflight){cache.misses++;const run={version:slot.version,asOf:new Date()};
  run.promise=Promise.resolve().then(operation).then(value=>{const bytes=Buffer.byteLength(JSON.stringify(value));
   if(bytes<=MAX_VALUE_BYTES&&keep(value)&&cache.slots.get(id)===slot){cache.slotBytes+=bytes-(slot.last?.bytes||0);slot.last={value,asOf:run.asOf,version:run.version,bytes,expiresAt:Date.now()+(domain==='business'?60000:TTL_MS)};
    while(cache.slotBytes>MAX_BYTES)dropSlot(cache,cache.slots.keys().next().value);}
   return value;}).finally(()=>{if(slot.inflight===run)slot.inflight=null;});
  run.promise.catch(()=>{});slot.inflight=run;}
 const run=slot.inflight,earlier=slot.last&&now-slot.last.asOf.getTime()<=MAX_STALE_MS?slot.last:null;
 if(!earlier){const value=await run.promise;return {value:structuredClone(value),asOf:run.asOf,current:run.version===wanted};}
 let timer;const outcome=await Promise.race([run.promise.then(value=>({value}),error=>({error})),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),waitMs);timer.unref?.();})]);clearTimeout(timer);
 if(outcome&&'value' in outcome)return {value:structuredClone(outcome.value),asOf:run.asOf,current:run.version===wanted};
 cache.stale++;return {value:structuredClone(earlier.value),asOf:earlier.asOf,current:false};
}
function status(db){const s=state(db);return {entries:s.entries.size,bytes:s.bytes,hits:s.hits,misses:s.misses,coalesced:s.coalesced,uncacheable:s.uncacheable,settledFigures:s.slots.size,settledBytes:s.slotBytes,servedEarlier:s.stale,listenerConnected:s.subscription?.connected||false,listenerGeneration:s.subscription?.generation||0,maxEntries:MAX_ENTRIES,maxBytes:MAX_BYTES};}
module.exports={read,settled,status};
