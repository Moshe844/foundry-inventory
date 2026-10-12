'use strict';
const {bytes}=require('./context');
// Extract observed contracts/status only. This is not a generated summary or
// authority grant. Full records stay in the tenant-bound durable journal.
function observe(h,name,input,result,id){
 h.learned||={};
 if(name==='environment_interfaces')for(const item of [...(result.operations||[]),...(result.datasets||[])]){
  if(!item.fields&&!item.queryContract)continue;
  h.learned[item.name]={evidenceId:id,name:item.name,kind:item.kind,required:item.required,fields:item.fields,
   queryContract:item.queryContract,authority:item.authority};
 }
 if(name==='environment_notebook')h.notebook={note:input.note,evidenceIds:input.evidenceIds,evidenceId:id,updatedAt:new Date().toISOString()};
 if(name==='business_operations')h.lastOperations={evidenceId:id,outcomes:(result.outcomes||[]).map(o=>({capability:o.capability,
  status:o.result.status,reason:o.result.reason,proposalId:o.result.proposal?.id}))};
}
function working(h){
 const bounded=(value,limit)=>{if(!value||bytes(value)<=limit)return value||null;
  const fragment={fragment:JSON.stringify(value),truncated:true,evidenceId:value.evidenceId||null};
  while(bytes(fragment)>limit)fragment.fragment=fragment.fragment.slice(0,Math.floor(fragment.fragment.length*.85));return fragment;};
 const browser=require('./observations').browserMemory(h);
 const result={historical:true,untrusted:true,browser,facts:require('./evidence').consolidated(h,Math.max(1000,5000-bytes(browser))),
  progress:h.progress?{stagnant:h.progress.stagnant,repetitions:h.progress.repetitions,warning:h.progress.warning,finalReason:h.progress.finalReason}:null,
  notebook:bounded(h.notebook,800),lastOperations:bounded(h.lastOperations,600),
  lastToolError:bounded(h.lastToolError,700),contracts:[],contractIndex:[],evidence:[]};
 // Most recently learned contracts first, with a pointer for every omitted one.
 const entries=Object.values(h.learned||{}).reverse();
 for(const c of entries){const entry={name:c.name,evidenceId:c.evidenceId};
   if(bytes([...result.contractIndex,entry])>800)break;result.contractIndex.push(entry);}
 result.omittedContractIndexEntries=entries.length-result.contractIndex.length;
 for(const c of entries){if(bytes({...result,contracts:[...result.contracts,c]})>7000)continue;result.contracts.push(c);}
 for(const e of Object.values(h.evidence||{}).reverse()){
  const entry={id:e.id,tool:e.name,at:e.at};
  if(bytes({...result,evidence:[...result.evidence,entry]})>8500)break;result.evidence.push(entry);
 }
 return result;
}
module.exports={observe,working};
