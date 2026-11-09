'use strict';
const {registry}=require('../assistant/postgres-capability-registry');
const label=key=>String(key).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[._]/g,' ').replace(/^./,c=>c.toUpperCase());
function contract(type){return registry.get(type)||registry.list('mutation').find(c=>c.legacyAction===type);}
function impact(type){
 const c=contract(type),name=c?.name||type||'',records=c?.resultingRecords||[];
 if(name==='settings.record_alias')return 'Changes a business nickname';
 if(name==='settings.ask_preferences')return 'Changes Ask preferences';
 if(name.startsWith('report.template.'))return name.endsWith('send_now')?'Sends a report':'Changes a saved report';
 if(records.some(r=>['movements','balances','serial_units','lot_balances'].includes(r)))return 'Changes stock';
 if(records.some(r=>r.startsWith('accounting_')))return 'Changes accounting';
 return 'Changes a business record';
}
function fields(payload){
 const result=[],hidden=new Set(['id','training','fingerprint','expectedState','input_hash','request_key','integrityHash','expectedHash','idempotencyKey','snapshotHash','contextHash','approvalHash','expectedSnapshot','skuId','locationId','expectedVersion','version','actorId','workspaceId','accountId','sourceEvidence','executionAuthority','needsInvoiceConfirmation','invoiceRoutineHold']);
 function walk(value,path,depth){
  if(result.length>=120||depth>5||value===null||value===undefined||value==='')return;
  if(typeof value==='string'&&/^[\[{]/.test(value.trim())){try{value=JSON.parse(value);}catch{}}
  if(Array.isArray(value)){value.forEach((v,i)=>walk(v,path+' · '+(i+1),depth+1));return;}
  if(typeof value==='object'){if(Object.hasOwn(value,'$step')){result.push({label:path,value:'Result of change '+(Number(value.$step)+1)});return;}
   for(const[k,v]of Object.entries(value)){if(hidden.has(k)||/Hash$|Snapshot$|Id$/.test(k))continue;const money=/Minor$/.test(k)&&Number.isSafeInteger(Number(v));const key=label(money?k.replace(/Minor$/,''):k);if(money)result.push({label:path?path+' · '+key:key,value:require('../domain/currency').format(Number(v),value.currency||payload.currency||'USD')});else walk(v,path?path+' · '+key:key,depth+1);}return;}
  result.push({label:path,value:typeof value==='boolean'?(value?'Yes':'No'):String(value)});
 }
 walk(payload,'',0);return result;
}
function summary(proposal){if(proposal.action_type==='settings.ask_preferences'){let p=proposal.payload||{};if(p.answerPreferences){try{p={...p,...JSON.parse(p.answerPreferences)};}catch{}}if(p.value&&typeof p.value==='object')p={...p,...p.value};return 'Update Ask preferences'+(p.answerStyle?': '+p.answerStyle:'.')+(p.answerLanguage?' · Language: '+p.answerLanguage:'')+(p.timeZone?' · Time zone: '+p.timeZone:'');}return proposal.summary;}
function present(proposal){
 if(proposal.action_type==='landed_cost.apply'){
  const p=proposal.payload.source;return {summary:proposal.summary,impact:'Updates recorded stock cost; quantities and supplier balances stay the same',fields:[{label:'Additional stock cost',value:require('../domain/currency').format(p.totalMinor,p.currency)},{label:'Allocation method',value:p.method},{label:'Expense evidence',value:p.charges.map(c=>c.billNumber+' · '+c.description).join(', ')},{label:'Received products',value:p.lines.map(l=>l.quantity+' × '+l.sku+' at '+l.location).join(', ')}]};
 }
 if(proposal.action_type==='warehouse.prepare_putaway'){
  const p=proposal.payload.source;return {summary:proposal.summary,impact:'Prepares instructions and labels for received goods',fields:[{label:'Purchase order',value:p.order},{label:'Product',value:p.product+' · '+p.sku},{label:'Received units',value:String(p.quantity)},{label:'Receiving location',value:p.from.name},{label:'Destination bin',value:p.to.name},{label:'Physical stock',value:'Staff must carry out and record the actual movement separately.'}]};
 }
 if(proposal.action_type==='warehouse.release_orders'){
  const p=proposal.payload;return {summary:proposal.summary,impact:'Releases picking work; stock remains on hand',fields:[{label:'Warehouse',value:p.locationName},{label:'Customer orders',value:p.orderNumbers.join(', ')},{label:'Picking strategy',value:p.strategy},{label:'Maximum orders in this release',value:String(p.limit)},{label:'Goods value',value:require('../domain/currency').format(p.training.amountMinor,p.training.currency)},{label:'Physical checks',value:'Staff must scan the pick and confirm actual handoff.'}]};
 }
 if(proposal.action_type==='warehouse.wave.create'){
  const p=proposal.payload;return {summary:proposal.summary,impact:'Releases picking work; stock remains on hand',fields:[{label:'Customer order',value:p.orderNumber||'The selected customer order'},{label:'Picking strategy',value:p.strategy},{label:'Physical checks',value:'Staff must scan the pick and confirm actual handoff.'}]};
 }
 if(proposal.action_type==='supplier_invoice.dispute'){
  const p=proposal.payload;return {summary:proposal.summary,impact:'Queues a supplier invoice review request',fields:[{label:'Supplier invoice',value:p.invoiceNumber},{label:'To',value:p.recipient},{label:'Original document',value:p.sourceEvidence.filename},{label:'Message',value:require('../purchasing/agent-invoice-disputes').compose(p).body},...(p.needsDisputeConfirmation?[{label:'Needs your review',value:'Check the original document and invoice differences individually before sending.'}]:[])]};
 }
 if(proposal.action_type==='sales_order.notify_stock_ready'){
  const p=proposal.payload;return {summary:proposal.summary,impact:'Queues one stock-ready customer update',fields:[{label:'Order',value:p.orderNumber},{label:'To',value:p.recipient},{label:'Message',value:require('../sales/agent-stock-ready').compose(p).body}]};
 }
 if(proposal.action_type==='sales_order.reserve_arrived'){
  const p=proposal.payload;return {summary:proposal.summary,impact:'Sets aside arrived stock for a waiting order',fields:[{label:'Order',value:p.orderNumber},{label:'Customer',value:p.customerName},{label:'Dispatch from',value:p.locationName},...p.quantities.map(q=>({label:q.code,value:q.quantity+' units'}))]};
 }
 if(proposal.action_type==='purchase_order.record_supplier_invoice'){
  const p=proposal.payload,money=require('../domain/currency');
  return {summary:proposal.summary,impact:p.expectedStatus==='DISPUTED'?'Records a disputed supplier document':'Records the supplier invoice owed',fields:[{label:'Supplier invoice',value:p.supplierInvoiceNumber},{label:'Invoice date',value:p.issueDate},{label:'Due date',value:p.dueDate||'Needs confirmation'},...(p.sourceEvidence?[{label:'Original document',value:p.sourceEvidence.filename}]:[]),...(p.lines||[]).map(l=>({label:l.description||'Invoice item',value:l.quantity+' units at '+money.format(l.unitCostMinor,p.currency)+' each'})),...(p.expectedTotalMinor!=null?[{label:'Invoice total',value:money.format(p.expectedTotalMinor,p.currency)}]:[]),...(p.invoiceRoutineHold?[{label:'Needs your review',value:p.invoiceRoutineHold}]:[])]};
 }
 if(proposal.action_type==='customer.statement'){
  const p=proposal.payload;return {summary:proposal.summary,impact:'Queues one requested customer account statement',fields:[{label:'Customer',value:p.customerName},{label:'To',value:p.recipient},{label:'As of',value:p.asOf},{label:'Account balance',value:require('../domain/currency').format(p.balanceMinor,p.currency)},{label:'Message',multiline:true,value:require('../accounting/agent-customer-statements').compose(p).body}]};
 }
 if(proposal.action_type==='sales_quote.followup'){
  const p=proposal.payload;return {summary:proposal.summary,impact:'Queues one quotation follow-up',fields:[{label:'Quote',value:p.quoteNumber},{label:'Customer',value:p.customerName},{label:'To',value:p.recipient},{label:'Quoted total',value:require('../domain/currency').format(p.totalMinor,p.currency)},{label:'Valid through',value:p.validUntil},{label:'Customer received it',value:p.presentedOn},{label:'Your delivery reference',value:p.presentationEvidence},{label:'Message',multiline:true,value:require('../sales/agent-quote-followups').compose(p).body}]};
 }
 if(proposal.action_type==='customer_invoice.remind'){
  const p=proposal.payload,words='Hello '+p.customerName+',\n\nOur records show '+require('../domain/currency').format(p.balanceMinor,p.currency)+' outstanding on invoice '+p.invoiceNumber+', due '+p.dueDate+'. Please let us know if you have already paid or have a question about this invoice.\n\nThank you.';
  return {summary:proposal.summary,impact:'Queues one invoice reminder',fields:[{label:'Invoice',value:p.invoiceNumber},{label:'To',value:p.recipient},{label:'Due',value:p.dueDate},{label:'Balance',value:require('../domain/currency').format(p.balanceMinor,p.currency)},{label:'Message',value:words}]};
 }
 if(proposal.action_type==='customer_payment.match_bank_line'){
  const p=proposal.payload,money=require('../domain/currency');
  return {summary:proposal.summary,impact:p.existing?'Reviews an existing bank match':'Records received money against an invoice',fields:[{label:'Invoice',value:p.invoiceNumber},{label:'Customer',value:p.customerName},{label:'Bank account',value:p.bankName},{label:'Bank credit',value:money.format(p.amountMinor,p.currency)},...(p.paymentDate?[{label:'Received on',value:p.paymentDate}]:[]),...(p.expectedBalanceMinor!=null?[{label:'Invoice balance before matching',value:money.format(p.expectedBalanceMinor,p.currency)},{label:'Invoice balance after matching',value:money.format(p.expectedBalanceMinor-p.amountMinor,p.currency)}]:[])]};
 }
 if(proposal.action_type==='document.save_product_facts'){
  const p=proposal.payload,labels=require('../documents/agent-product-facts').labels;
  return {summary:proposal.summary,impact:'Saves sourced product facts',fields:[{label:'Product',value:p.productName},{label:'Source',value:p.filename},...p.facts.flatMap(f=>[{label:labels[f.field],value:f.value},{label:'Source quote',value:f.quote}])]};
 }
 if(proposal.action_type?.startsWith('document.file_to_')){
  const p=proposal.payload;
  return {summary:proposal.summary,impact:'Files an original business document',fields:[{label:'Document',value:p.filename},{label:'File on',value:p.targetReference},{label:'Type',value:p.documentKind.replace(/_/g,' ')},{label:'Record match',value:p.needsTargetConfirmation?'Confirm the selected record':'Identified in the source'}]};
 }
 if(proposal.action_type==='purchase_order.receive_from_document'){
  const p=proposal.payload;
  return {summary:proposal.summary,impact:p.existing?'Reviews an existing receipt':'Records physically received goods',fields:[{label:'Purchase order',value:p.orderNumber},{label:'Delivery document',value:p.sourceName},
    ...(p.receiving||[]).flatMap(r=>[{label:r.code+' · '+r.name,value:r.quantity+' units at '+r.locationName+' · '+require('../domain/currency').format(r.unitCostMinor,p.currency)+' each'},
      ...(r.lotCode?[{label:'Batch',value:r.lotCode+(r.expiresAt?' · expires '+r.expiresAt:'')}]:[]),...(r.serials.length?[{label:'Received serials',value:r.serials.join(', ')}]:[])])]};
 }
 if(proposal.action_type==='catalog.supplier_price_list'){
  const p=proposal.payload;
  return {summary:proposal.summary,impact:'Updates purchase costs for future work',fields:[{label:'Supplier file',value:p.source.name},
   ...p.changes.map(c=>({label:c.code+' · '+c.name,value:(c.before?require('../domain/currency').format(c.before.amountMinor,c.before.currency):'No saved cost')+
    ' → '+require('../domain/currency').format(c.amountMinor,c.currency)+(c.overReviewThreshold?' · Separate approval required':' · Within 5%')}))]};
 }
 if(proposal.action_type==='catalog.fill_supplier_specs'){
  const labels=require('../domain/agent-supplier-specs').labels;
  return {summary:proposal.summary,impact:'Fills missing product details',fields:(proposal.payload?.changes||[]).map(r=>({label:r.code+' · '+labels[r.field],value:String(r.value)}))};
 }
 const p=proposal.payload||{},review=proposal.action_type==='customer_return.credit_receipt'?p.review:proposal.action_type==='customer_return.receive'?p.receiptCreditReview:null;let rows=fields(p);if(review){const amount=n=>require('../domain/currency').format(Number(n||0),review.currency),dates=review.batches?[...new Set(review.batches.map(b=>b.postingDate))].join(', '):null;rows=[{label:'Return',value:review.returnNumber||'Authorized received goods'},{label:'Credit note total',value:amount(review.totalMinor)},{label:'Included tax',value:amount(review.taxMinor)},{label:'Cash paid now',value:amount(0)},{label:'Physical stock',value:proposal.action_type==='customer_return.credit_receipt'?'Unchanged':'Only the physically received quantities'}];if(review.arCreditMinor!==undefined)rows.push({label:'Unpaid invoice reduction',value:amount(review.arCreditMinor)},{label:'Refund still owed to customer',value:amount(review.cashDueMinor)});if(dates)rows.push({label:'Posting dates',value:dates});if(review.pendingCostMinor)rows.push({label:'Deferred returned cost recognized',value:amount(review.pendingCostMinor)});}return {summary:summary(proposal),impact:impact(proposal.action_type),fields:rows};}
function cardPresentation(card){return present({action_type:card.action,payload:card.payload,summary:card.summary});}
// Display only: the immutable approval capsule and its digest stay intact.
function conversation(goal,cards=[]){const state=require('../assistant/agent-conversation').state(goal);if(goal.status!=='WAITING_APPROVAL'||!cards.length)return state;const message='Approval required. These changes are prepared, not executed:\n'+cards.map(c=>'- '+cardPresentation(c).summary).join('\n');return {...state,message,history:state.history.map(entry=>entry.role==='assistant'&&entry.phase==='approval'&&entry.text===goal.answer?{...entry,text:message}:entry)};}
module.exports={impact,fields,present,summary,cardPresentation,conversation};
