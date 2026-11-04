'use strict';
const requestCache=require('./request-read-cache'),databases=new WeakMap();let sequence=0;
const MAX_ENTRIES=256,MAX_BYTES=16*1024*1024,MAX_VALUE_BYTES=256*1024,TTL_MS=10000;
function state(db){if(!databases.has(db))databases.set(db,{id:++sequence,entries:new Map(),bytes:0,hits:0,misses:0,coalesced:0,uncacheable:0});return databases.get(db);}
async function read(db,workspaceId,key,operation,{domain='all'}={}){
 if(!['all','business'].includes(domain))throw new TypeError('Choose a supported read-model revision.');
 const cache=state(db),versions=await requestCache.read(JSON.stringify(['read-model-version',cache.id,workspaceId]),async()=>(await db.query(`SELECT
  coalesce(v.revision,0)::text||':'||pending.all_changes AS revision,
  coalesce(v.business_revision,0)::text||':'||pending.business_changes AS business_revision
  FROM (SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) AS all_changes,
   md5(coalesce(string_agg(id::text,',' ORDER BY id) FILTER(WHERE business),'')) AS business_changes
   FROM stockchief_runtime.read_model_changes WHERE workspace_id=$1) pending
  LEFT JOIN stockchief_runtime.read_model_versions v ON v.workspace_id=$1`,[workspaceId])).rows[0]||{}),revision=String(versions[domain==='business'?'business_revision':'revision']||'0');
 const identity=JSON.stringify([workspaceId,domain,revision,key]),now=Date.now();let entry=cache.entries.get(identity);
 const remove=k=>{const previous=cache.entries.get(k);if(previous){cache.bytes-=previous.bytes||0;cache.entries.delete(k);}};
 if(entry&&entry.expiresAt<=now){remove(identity);entry=null;}
 if(entry){cache.hits++;if(entry.expiresAt===Infinity)cache.coalesced++;cache.entries.delete(identity);cache.entries.set(identity,entry);return structuredClone(await entry.promise);}
 while(cache.entries.size>=MAX_ENTRIES||cache.bytes>MAX_BYTES)remove(cache.entries.keys().next().value);
 cache.misses++;entry={expiresAt:Infinity,bytes:0};entry.promise=Promise.resolve().then(operation).then(value=>{
  const bytes=Buffer.byteLength(JSON.stringify(value));if(bytes>MAX_VALUE_BYTES){cache.uncacheable++;remove(identity);return value;}
  if(cache.entries.get(identity)===entry){entry.bytes=bytes;cache.bytes+=bytes;entry.expiresAt=Date.now()+(domain==='business'?60000:TTL_MS);while(cache.bytes>MAX_BYTES)remove(cache.entries.keys().next().value);}
  return value;
 }).catch(error=>{remove(identity);throw error;});cache.entries.set(identity,entry);return structuredClone(await entry.promise);
}
function status(db){const s=state(db);return {entries:s.entries.size,bytes:s.bytes,hits:s.hits,misses:s.misses,coalesced:s.coalesced,uncacheable:s.uncacheable,maxEntries:MAX_ENTRIES,maxBytes:MAX_BYTES};}
async function foldChanges(db,{limit=5000}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new TypeError('Read invalidation batches must contain 1 to 10,000 entries.');
 // Delete only rows visible and locked in THIS snapshot. A sequence maximum
 // is unsafe: an older ID may commit after a newer transaction was folded.
 return db.query(`WITH chosen AS MATERIALIZED (
  SELECT id FROM stockchief_runtime.read_model_changes ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
 ), folded AS (
  DELETE FROM stockchief_runtime.read_model_changes c USING chosen WHERE c.id=chosen.id RETURNING c.workspace_id,c.business
 ) INSERT INTO stockchief_runtime.read_model_versions AS v(workspace_id,revision,business_revision)
 SELECT workspace_id,count(*),count(*) FILTER(WHERE business) FROM folded GROUP BY workspace_id ORDER BY workspace_id
 ON CONFLICT(workspace_id) DO UPDATE SET revision=v.revision+EXCLUDED.revision,
 business_revision=v.business_revision+EXCLUDED.business_revision RETURNING workspace_id`,[limit]);
}
module.exports={read,status,foldChanges};
