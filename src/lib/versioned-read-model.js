'use strict';
const requestCache=require('./request-read-cache'),databases=new WeakMap();let sequence=0;
const MAX_ENTRIES=256,MAX_BYTES=16*1024*1024,MAX_VALUE_BYTES=256*1024,TTL_MS=10000;
function state(db){if(!databases.has(db))databases.set(db,{id:++sequence,entries:new Map(),bytes:0});return databases.get(db);}
async function read(db,workspaceId,key,operation){
 const cache=state(db),revision=await requestCache.read(JSON.stringify(['read-model-version',cache.id,workspaceId]),async()=>String((await db.query('SELECT revision::text FROM stockchief_runtime.read_model_versions WHERE workspace_id=$1',[workspaceId])).rows[0]?.revision||'0'));
 const identity=JSON.stringify([workspaceId,revision,key]),now=Date.now();let entry=cache.entries.get(identity);
 const remove=k=>{const previous=cache.entries.get(k);if(previous){cache.bytes-=previous.bytes||0;cache.entries.delete(k);}};
 if(entry&&entry.expiresAt<=now){remove(identity);entry=null;}
 if(entry){cache.entries.delete(identity);cache.entries.set(identity,entry);return structuredClone(await entry.promise);}
 while(cache.entries.size>=MAX_ENTRIES||cache.bytes>MAX_BYTES)remove(cache.entries.keys().next().value);
 entry={expiresAt:Infinity,bytes:0};entry.promise=Promise.resolve().then(operation).then(value=>{
  const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>MAX_VALUE_BYTES){remove(identity);return value;}
  if(cache.entries.get(identity)===entry){entry.bytes=bytes;cache.bytes+=bytes;entry.expiresAt=Date.now()+TTL_MS;while(cache.bytes>MAX_BYTES)remove(cache.entries.keys().next().value);}
  return value;
 }).catch(error=>{remove(identity);throw error;});cache.entries.set(identity,entry);return structuredClone(await entry.promise);
}
module.exports={read};
