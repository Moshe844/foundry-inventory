'use strict';
const databases=new WeakMap();
const MAX_ENTRIES=256,MAX_BYTES=16*1024*1024,MAX_VALUE_BYTES=256*1024,TTL_MS=10000;
function state(db){
 if(databases.has(db))return databases.get(db);
 const cache={entries:new Map(),bytes:0,hits:0,misses:0,coalesced:0,uncacheable:0,revisions:new Map(),sequence:0,subscription:null};
 databases.set(db,cache);
 const clear=()=>{cache.entries.clear();cache.revisions.clear();cache.bytes=0;};
 if(db.subscribe){cache.subscription=db.subscribe('stockchief_read_models',message=>{
  let notice;try{notice=JSON.parse(message.payload);}catch{return;}
  if(typeof notice.workspace!=='string'||notice.workspace.length>160||typeof notice.business!=='boolean')return;
  const affected=[];for(const [key,entry]of cache.entries)if(entry.workspace===notice.workspace&&(notice.business||entry.domain==='all'))affected.push(key);
  if(!affected.length)return;
  const prior=cache.revisions.get(notice.workspace)||{all:0,business:0};
  cache.revisions.set(notice.workspace,{all:++cache.sequence,business:notice.business?cache.sequence:prior.business});
  for(const key of affected)remove(cache,key);
  if(cache.revisions.size>MAX_ENTRIES)clear();
 },{onState:clear});
 // Same-process writes must be visible before the other socket delivers NOTIFY.
 // This hook runs only after successful implicit/explicit commit, never rollback.
 db.onCommittedWrite?.((workspaces,business=true)=>{if(!workspaces&&business)return clear();if(business)for(const id of workspaces)cache.revisions.delete(id);for(const [key,entry]of cache.entries)if((!workspaces||workspaces.has(entry.workspace))&&(business||entry.domain==='all'))remove(cache,key);});}
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
function status(db){const s=state(db);return {entries:s.entries.size,bytes:s.bytes,hits:s.hits,misses:s.misses,coalesced:s.coalesced,uncacheable:s.uncacheable,listenerConnected:s.subscription?.connected||false,listenerGeneration:s.subscription?.generation||0,maxEntries:MAX_ENTRIES,maxBytes:MAX_BYTES};}
module.exports={read,status};
