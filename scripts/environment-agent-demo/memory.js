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
 // Pack one useful browser view and current business facts together before
 // spending spare space on older pages. The shared 5k allowance is unchanged.
 const observations=require('./observations'),evidence=require('./evidence');
 const essentialBrowser=observations.browserMemory(h,2400);
 const facts=evidence.consolidated(h,5000-bytes(essentialBrowser));
 const browser=observations.browserMemory(h,Math.min(4000,5000-bytes(facts)));
 const result={historical:true,untrusted:true,browser,facts,
  progress:h.progress?{stagnant:h.progress.stagnant,repetitions:h.progress.repetitions,warning:h.progress.warning,finalReason:h.progress.finalReason}:null,
  notebook:bounded(h.notebook,800),lastOperations:bounded(h.lastOperations,600),
  lastToolError:bounded(h.lastToolError,700),contracts:[],contractIndex:[],evidence:[]};
 // Most recently learned contracts first, with a pointer for every omitted one.
 const entries=Object.values(h.learned||{}).sort((a,b)=>{
  const source=c=>h.evidence?.[c.evidenceId];
  return (Date.parse(source(b)?.at)||0)-(Date.parse(source(a)?.at)||0);
 });
 for(const c of entries){const entry={name:c.name,evidenceId:c.evidenceId};
   if(bytes([...result.contractIndex,entry])>800)break;result.contractIndex.push(entry);}
 result.omittedContractIndexEntries=entries.length-result.contractIndex.length;
 for(const c of entries){if(bytes({...result,contracts:[...result.contracts,c]})>7000)continue;result.contracts.push(c);}
 for(const e of observations.ordered(Object.values(h.evidence||{})).reverse()){
  const entry={id:e.id,tool:e.name,at:e.at};
  if(bytes({...result,evidence:[...result.evidence,entry]})>8500)break;result.evidence.push(entry);
 }
 return result;
}
module.exports={observe,working};
