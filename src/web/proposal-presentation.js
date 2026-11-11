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
 if(proposal.action_type==='sales_order.reserve_rotation'){const s=proposal.payload.rotationSummary;return {summary:'Review '+s.strategy+' reservations for '+s.order,impact:'Binds exact stock identities to existing quantity commitments. Physical picking, dispatch, stock and money remain separate.',fields:[{label:'Order',value:s.order},{label:'Rotation',value:s.strategy},{label:'Exact reserved goods',value:s.selections,multiline:true},...(proposal.payload.needsHistoricalFifoConfirmation?[{label:'Historical fact requiring individual confirmation',value:proposal.payload.historicalEvidence,multiline:true}]:[])]};}
 if(['purchase_order.reorder_drafts','purchasing.select_supplier'].includes(proposal.action_type)){const p=proposal.payload,select=proposal.action_type==='purchasing.select_supplier';return {summary:select?'Review the buying supplier selection':'Review '+p.output.length+' supplier purchase draft'+(p.output.length===1?'':'s'),impact:select?'Changes the saved reorder supplier. Purchase orders, stock and money stay separate.':'Creates unsent purchase drafts. Approval, sending, physical receipt and payments stay separate.',fields:[{label:'Exact supplier and product terms',value:proposal.summary,multiline:true},...(p.needsPurchaseTermsConfirmation?[{label:'Your decision',value:'Individually review these first or changed supplier terms before routine work can use them.'}]:[])]};}
 if(proposal.action_type==='shipping.prepare_export_papers'){const p=proposal.payload.snapshot;return {summary:proposal.summary,impact:'Prepares a private invoice draft and packing list. The owner separately reviews it; no shipment, receivable, payment or customs filing is created.',fields:[{label:'Shipment',value:p.shipmentNumber},{label:'Exporter',value:p.exporter.name},{label:'Dispatch',value:p.from.name+' · '+p.from.country},{label:'Consignee',value:p.to.name+' · '+p.to.country},{label:'Destination',value:p.to.address},{label:'Product lines',value:String(p.lines.length)},{label:'Measured parcels',value:String(p.boxes.length)},{label:'Recorded net goods value',value:require('../domain/currency').format(p.totals.goodsNetMinor,p.currency)},{label:'Agreed delivery terms',value:p.deliveryTerms}]};}
 if(proposal.action_type==='customer_return.send_label'){const p=proposal.payload;return {summary:proposal.summary,impact:'Emails the carrier’s purchased label link and authorized return instructions. No new postage, receipt, stock, credit or refund change.',fields:[{label:'Return',value:p.returnNumber},{label:'Customer',value:p.customerName},{label:'Recipient',value:p.recipient},{label:'Return destination',value:p.returnLocation+' · '+p.returnAddress},{label:'Returned goods value',value:require('../domain/currency').format(p.goodsValueMinor,p.currency)},{label:'Subject',value:p.subject},{label:'Message',value:p.body,multiline:true}]};}
 if(proposal.action_type==='warehouse.release_partial_order'&&proposal.payload.partialSummary){const s=proposal.payload.partialSummary;return {summary:proposal.summary,impact:'Prepares picking for committed stock. Physical scanning, packing and handoff remain separate; the shortage stays on this order.',fields:[{label:'Order',value:s.order},{label:'Customer',value:s.customer},{label:'Dispatch from',value:s.location},{label:'Deliver to',value:s.delivery},{label:'Open order goods value',value:require('../domain/currency').format(s.goodsValueMinor,s.currency)},{label:'Units ready for picking',value:String(s.ready)},{label:'Units still waiting',value:String(s.waiting)},{label:'Products',value:s.lines.map(l=>l.sku+' · '+l.name+': '+l.ready+' ready, '+l.waiting+' waiting').join('\n'),multiline:true}]};}
 if(proposal.action_type==='inventory.plan_annual_stocktake'&&proposal.payload.annualSummary){const s=proposal.payload.annualSummary;return {summary:proposal.summary,impact:'Prepares a private count plan. The owner separately approves freezing stock, count differences and final sign-off.',fields:[{label:'Stocktake',value:s.title},{label:'Year',value:String(s.year)},{label:'Recorded stock positions',value:String(s.positions)},{label:'Stock locations to freeze after approval',value:s.locations.join('\n'),multiline:true},{label:'Proposed count teams',value:s.teams.join('\n'),multiline:true}]};}
 if(['sales_order.reserve_all','sales_order.allocation_priority'].includes(proposal.action_type)&&proposal.payload.reservationSummary){const p=proposal.payload,s=p.reservationSummary,priority=proposal.action_type==='sales_order.allocation_priority';return {summary:proposal.summary,impact:priority?'Changes this order’s scheduling preference; existing commitments stay in place':'Reserves available stock; physical quantities, invoices and payments stay in place',fields:[{label:'Order',value:s.order},{label:'Customer',value:s.customer},{label:'Dispatch from',value:s.location},{label:'Delivery',value:s.delivery},{label:'Open order goods value',value:require('../domain/currency').format(s.goodsValueMinor,s.currency)},...(priority?[{label:'Allocation priority',value:p.priority+' (lower numbers go first)'},{label:'Needed by',value:p.neededBy||'No date specified'}]:[{label:'Units to reserve now',value:s.lines.map(l=>l.toReserve+' '+l.unit+' · '+l.sku+' · '+l.name+(l.alreadyReserved?' ('+l.alreadyReserved+' already reserved)':'')).join('\n'),multiline:true}])]};}
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
  const p=proposal.payload;return {summary:proposal.summary,impact:'Queues one quotation follow-up',fields:[{label:'Quote',value:p.quoteNumber},{label:'Customer',value:p.customerName},{label:'To',value:p.recipient},{label:'Quoted total',value:require('../domain/currency').format(p.totalMinor,p.currency)},{label:'Valid through',value:p.validUntil},{label:p.presentationBasis==='mailbox_accepted'?'Quotation emailed':'Customer received it',value:p.presentedOn},{label:p.presentationBasis==='mailbox_accepted'?'Sending confirmation':'Your delivery reference',value:p.presentationEvidence},{label:'Message',multiline:true,value:require('../sales/agent-quote-followups').compose(p).body}]};
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
  return {summary:proposal.summary,impact:p.queueReading?'Queues the complete source reading':'Saves sourced product facts',fields:[{label:'Product',value:p.productName},{label:'Source',value:p.filename},...(p.facts||[]).flatMap(f=>[{label:labels[f.field],value:f.value},{label:'Source quote',value:f.quote}])]};
 }
 if(proposal.action_type?.startsWith('document.file_to_')){
  const p=proposal.payload;
  return {summary:proposal.summary,impact:'Files an original business document',fields:[{label:'Document',value:p.filename},{label:'File on',value:p.targetReference},{label:'Type',value:p.documentKind.replace(/_/g,' ')},{label:'Record match',value:p.needsTargetConfirmation?'Confirm the selected record':'Identified in the source'}]};
 }
 if(proposal.action_type==='purchase_order.receive_from_document'){
  const p=proposal.payload;
  return {summary:proposal.summary,impact:p.existing?'Reviews an existing receipt':'Records physically received goods',fields:[{label:'Purchase order',value:p.orderNumber},{label:'Delivery document',value:p.sourceName},
    ...(p.receiving||[]).flatMap(r=>[{label:r.code+' · '+r.name+(r.variantLabel?' / '+r.variantLabel:''),
      value:r.quantity+' '+(r.unit&&r.unit!=='unit'?r.unit:'units')+' at '+r.locationName+
        (r.secondaryQuantity==null?'':' · actual '+r.secondaryQuantity+' '+r.secondaryUnit)+' · '+
        require('../domain/currency').format(r.unitCostMinor,p.currency)+(r.secondaryUnit?' per '+r.secondaryUnit:' each')},
      ...(r.lotCode?[{label:'Batch',value:r.lotCode+(r.expiresAt?' · expires '+r.expiresAt:'')}]:[]),
      ...(r.serials.length?[{label:'Received serials',value:r.serials.map(serial=>r.serialWeights&&Object.hasOwn(r.serialWeights,serial)?
        serial+' · '+r.serialWeights[serial]+' '+r.secondaryUnit:serial).join(', ')}]:[])])]};
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
