'use strict';
const {registry}=require('../assistant/postgres-capability-registry');
const label=key=>String(key).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[._]/g,' ').replace(/^./,c=>c.toUpperCase());
function contract(type){return registry.get(type)||registry.list('mutation').find(c=>c.legacyAction===type);}
function impact(type){
 const c=contract(type),name=c?.name||type||'',records=c?.resultingRecords||[];
 if(name==='settings.ask_preferences')return 'Changes Ask preferences';
 if(name.startsWith('report.template.'))return name.endsWith('send_now')?'Sends a report':'Changes a saved report';
 if(records.some(r=>['movements','balances','serial_units','lot_balances'].includes(r)))return 'Changes stock';
 if(records.some(r=>r.startsWith('accounting_')))return 'Changes accounting';
 return 'Changes a business record';
}
function fields(payload){
 const result=[],hidden=new Set(['integrityHash','expectedHash','idempotencyKey','snapshotHash','contextHash','approvalHash']);
 function walk(value,path,depth){
  if(result.length>=120||depth>5||value===null||value===undefined||value==='')return;
  if(typeof value==='string'&&/^[\[{]/.test(value.trim())){try{value=JSON.parse(value);}catch{}}
  if(Array.isArray(value)){value.forEach((v,i)=>walk(v,path+' · '+(i+1),depth+1));return;}
  if(typeof value==='object'){if(Object.hasOwn(value,'$step')){result.push({label:path,value:'Result of change '+(Number(value.$step)+1)});return;}
   for(const[k,v]of Object.entries(value))if(!hidden.has(k))walk(v,path?path+' · '+label(k):label(k),depth+1);return;}
  result.push({label:path,value:typeof value==='boolean'?(value?'Yes':'No'):String(value)});
 }
 walk(payload,'',0);return result;
}
function summary(proposal){if(proposal.action_type==='settings.ask_preferences'){const p=proposal.payload||{};return 'Update Ask preferences'+(p.answerStyle?': '+p.answerStyle:'.')+(p.answerLanguage?' · Language: '+p.answerLanguage:'')+(p.timeZone?' · Time zone: '+p.timeZone:'');}return proposal.summary;}
function present(proposal){const p=proposal.payload||{},review=proposal.action_type==='customer_return.credit_receipt'?p.review:proposal.action_type==='customer_return.receive'?p.receiptCreditReview:null;let rows=fields(p);if(review){const amount=n=>require('../domain/currency').format(Number(n||0),review.currency),dates=review.batches?[...new Set(review.batches.map(b=>b.postingDate))].join(', '):null;rows=[{label:'Return',value:review.returnNumber||'Authorized received goods'},{label:'Credit note total',value:amount(review.totalMinor)},{label:'Included tax',value:amount(review.taxMinor)},{label:'Cash paid now',value:amount(0)},{label:'Physical stock',value:proposal.action_type==='customer_return.credit_receipt'?'Unchanged':'Only the physically received quantities'}];if(review.arCreditMinor!==undefined)rows.push({label:'Unpaid invoice reduction',value:amount(review.arCreditMinor)},{label:'Refund still owed to customer',value:amount(review.cashDueMinor)});if(dates)rows.push({label:'Posting dates',value:dates});if(review.pendingCostMinor)rows.push({label:'Deferred returned cost recognized',value:amount(review.pendingCostMinor)});}return {summary:summary(proposal),impact:impact(proposal.action_type),fields:rows};}
function cardPresentation(card){return present({action_type:card.action,payload:card.payload,summary:card.summary});}
// Display only: the immutable approval capsule and its digest stay intact.
function conversation(goal,cards=[]){const state=require('../assistant/agent-conversation').state(goal);if(goal.status!=='WAITING_APPROVAL'||!cards.length)return state;const message='Approval required. These changes are prepared, not executed:\n'+cards.map(c=>'- '+cardPresentation(c).summary).join('\n');return {...state,message,history:state.history.map(entry=>entry.role==='assistant'&&entry.phase==='approval'&&entry.text===goal.answer?{...entry,text:message}:entry)};}
module.exports={impact,fields,present,summary,cardPresentation,conversation};
