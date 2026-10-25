'use strict';
const {RateLimitError}=require('../domain/errors');
const states=new WeakMap(),TTL=5*60*1000,MAX_ENTRIES=100;
function state(database){let s=states.get(database);if(!s){s={entries:new Map(),active:0};states.set(database,s);}return s;}
function current(database,workspaceId){const e=state(database).entries.get(workspaceId);return e?{status:e.status,checkedAt:e.checkedAt||null,result:e.result||null}:{status:'NOT_CHECKED',checkedAt:null,result:null};}
async function run(database,workspaceId){const s=state(database),previous=s.entries.get(workspaceId);
 if(previous?.promise)return previous.promise;
 if(previous?.status==='READY'&&Date.now()-Date.parse(previous.checkedAt)<TTL)return current(database,workspaceId);
 if(s.active>=2)throw new RateLimitError('Two inventory checks are already running. Please try again when one finishes.');
 while(s.entries.size>=MAX_ENTRIES){const oldest=[...s.entries].find(([,e])=>!e.promise);if(!oldest)break;s.entries.delete(oldest[0]);}
 const entry={status:'CHECKING',checkedAt:previous?.checkedAt||null,result:previous?.result||null};s.entries.set(workspaceId,entry);s.active++;
 entry.promise=(async()=>{try{entry.result=await require('./postgres-readiness').reconciliation(database,workspaceId);entry.checkedAt=new Date().toISOString();entry.status='READY';return current(database,workspaceId);}
 catch(error){entry.status='ERROR';throw error;}finally{entry.promise=null;s.active--;}})();
 return entry.promise;
}
module.exports={current,run};
