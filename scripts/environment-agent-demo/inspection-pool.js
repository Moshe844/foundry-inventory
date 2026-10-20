'use strict';
const {createHash}=require('node:crypto');
// Reuse only the governed read-only renderer for an identical host-bound
// database/tenant/actor. Every goal still gets a fresh browser context, SDK
// thread and evidence journal. Authority is rechecked on acquire and HTTP read.
function createPool({idleMs=4*60000,maxEntries=4}={}){
 const entries=new Map();let closed=false,usageSequence=0;
 function keyFor({ctx,connectionString}){let address=connectionString;try{address=new URL(connectionString).toString();}catch{/* Fixture transports may use a non-URL identity. */}
  return createHash('sha256').update(JSON.stringify([address,ctx.workspaceId,ctx.actorId])).digest('hex');}
 async function retire(key,entry){
  if(entry.leases)return;
  if(entries.get(key)!==entry)return;
  entries.delete(key);clearTimeout(entry.expiry);
  const server=await entry.promise.catch(()=>null);if(server)await server.close();
 }
 async function acquire({database,ctx,connectionString,warmOnly=false}){
   if(closed)throw Error('INSPECTION_POOL_CLOSED');
   const pilot=require('../../src/assistant/postgres-codex-pilot');
   await pilot.access(database,ctx,{enabled:true});
   const key=keyFor({ctx,connectionString});
   let entry=entries.get(key);
   if(!entry){
    let retirement=null;
    if(entries.size>=maxEntries){
     if(warmOnly)return null;
     const idle=[...entries].filter(([,value])=>!value.leases).sort((a,b)=>a[1].lastUsed-b[1].lastUsed)[0];
     if(!idle)throw Error('INSPECTION_POOL_CAPACITY');
     retirement=retire(...idle);
    }
    const promise=(async()=>{
     // Reserve the replacement entry synchronously before awaiting cleanup.
     // Otherwise background warm-up can take its freed slot mid-retirement.
     if(retirement)await retirement;
     const token=await pilot.readAuthorization(database,ctx,connectionString);
     return require('./inspection').createInspectionServer({cluster:{connectionString},database,ctx,stagingAuthorization:token});
    })();
    entry={promise,leases:0,expiry:null,lastUsed:0};entries.set(key,entry);
    promise.catch(()=>{if(entries.get(key)===entry)entries.delete(key);});
   }
   clearTimeout(entry.expiry);entry.leases++;if(!warmOnly)entry.lastUsed=++usageSequence;
   let server;try{server=await entry.promise;await server.renewLease?.();}catch(error){entry.leases--;throw error;}
   if(closed){entry.leases--;await retire(key,entry);throw Error('INSPECTION_POOL_CLOSED');}
   let released=false;
   return {server,async release(){
    if(released)return;released=true;entry.leases--;
    if(!entry.leases){
     if(closed)return retire(key,entry);
     entry.expiry=setTimeout(()=>retire(key,entry).catch(()=>{}),idleMs);entry.expiry.unref();
    }
   }};
 }
 return {
  acquire,
  // Retention grants no browser, credentials or authority. A running goal may
  // use canonical reads for several minutes before needing its existing
  // renderer; do not retire it merely because no browser lease was taken yet.
  retain(options){if(closed)return null;const key=keyFor(options),entry=entries.get(key);if(!entry)return null;
   clearTimeout(entry.expiry);entry.leases++;entry.lastUsed=++usageSequence;let released=false;
   return {async release(){if(released)return;released=true;entry.leases--;if(!entry.leases){if(closed)return retire(key,entry);entry.expiry=setTimeout(()=>retire(key,entry).catch(()=>{}),idleMs);entry.expiry.unref();}}};
  },
  async warm(options){const lease=await acquire({...options,warmOnly:true});if(!lease)return false;await lease.release();return true;},
  async close(){
   closed=true;
   await Promise.allSettled([...entries].map(([key,entry])=>retire(key,entry)));
  }
 };
}
module.exports={createPool};
