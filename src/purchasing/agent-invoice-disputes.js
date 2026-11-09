'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),money=require('../domain/currency'),{hash}=require('../pricing/postgres-promotions');
const action='supplier_invoice.dispute',kind='invoice_dispute';
async function owner(db,ctx){if(!(await db.query(`SELECT 1 FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner'
 AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows.length)throw new AuthorizationError('Only the inventory owner can authorize supplier invoice disputes.');}
async function facts(db,ctx,id,connectorId){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,100,'draft');
 const scoped=typeof db.transaction==='function'?db:{query:(...args)=>db.query(...args),transaction:fn=>fn(db)};
 const preview=await require('./postgres-invoice-review').preview(scoped,ctx,id),b=preview.bill;
 if(b.status!=='DISPUTED'||b.journal_entry_id||preview.status!=='DISPUTED'||!preview.differences.length||!b.purchase_order_id||!b.supplier_invoice_number)throw new ValidationError('Use an unposted supplier invoice with its supplier invoice number and a current purchase-order or receipt difference.');
 if([...b.supplier_invoice_number].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new ValidationError('Record a single-line supplier invoice number without control characters before preparing its message.');
 const supplier=(await db.query('SELECT * FROM suppliers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,b.supplier_id])).rows[0];
 if(supplier?.status!=='active'||!/^\S+@\S+\.\S+$/.test(supplier.email||''))throw new ValidationError('Confirm the active supplier and its email before preparing a dispute.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
 const source=await require('./agent-invoice-source').readOriginal(db,ctx,b.invoice_input);
 const lines=(await db.query(`SELECT p.id,p.sku_id,p.supplier_sku,p.units_per_purchase_unit,p.quantity_received_units,s.code,po.currency purchase_currency FROM purchase_order_lines p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN purchase_orders po ON po.workspace_id=p.workspace_id AND po.id=p.purchase_order_id WHERE p.workspace_id=$1 AND p.purchase_order_id=$2`,[ctx.workspaceId,b.purchase_order_id])).rows;
 let exactDocument=false;
 try{
  const d=require('./agent-invoice-source').parse(source.s.extracted_text),input=b.invoice_input,used=new Set(),book=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
  const sender=(String(source.s.sender||'').match(/<([^<>]+)>/)?.[1]||String(source.s.sender||'')).trim().toLowerCase();
  exactDocument=source.s.supplier_id===b.supplier_id&&source.s.trust_status==='TRUSTED'&&source.row.status==='connected'&&!source.row.paused_at&&Boolean(source.row.provider_account_id)&&sender===supplier.email.toLowerCase()
   &&book===b.currency&&d.currency===b.currency&&d.invoiceNumber===b.supplier_invoice_number&&d.purchaseOrder===b.po_number&&d.issueDate===b.issue_date&&d.dueDate===b.due_date&&d.total===Number(b.document_total_minor)&&d.tax===0&&Number(b.tax_minor)===0&&!(b.charges||[]).length&&d.rows.length===input.lines.length
   &&b.issue_date<=await require('../lib/business-time').today(db,ctx.workspaceId)&&lines.some(l=>Number(l.quantity_received_units)>0)
   &&preview.differences.every(d=>d.kind==='invoice_ahead_of_receipt'||d.kind==='price_outside_approved_cost'&&Number.isSafeInteger(d.approvedUnitCostMinor)&&d.billedUnitCostMinor>d.approvedUnitCostMinor);
  for(const r of d.rows){const l=require('./supplier-line-match').matchLine(lines,{sku:r.code}),p=l&&input.lines.filter(i=>i.purchaseOrderLineId===l.id);if(!l||used.has(l.id)||Number(l.units_per_purchase_unit)!==1||p.length!==1||p[0].skuId!==l.sku_id||Number(p[0].quantity)!==r.quantity||Number(p[0].unitCostMinor)!==r.unitCostMinor)exactDocument=false;if(l)used.add(l.id);}
 }catch(error){exactDocument=false;if(!(error instanceof ValidationError))throw error;}
 const differences=preview.differences.map(d=>{const line=d.line?preview.lines[d.line-1]:null,code=line?lines.find(l=>l.sku_id===line.skuId)?.code:null;
  if(d.kind==='price_outside_approved_cost')return {kind:d.kind,text:(code||'Invoice line '+d.line)+': '+(d.approvedUnitCostMinor==null?'our purchase order has no confirmed unit price':'our approved purchase-order price is '+money.format(d.approvedUnitCostMinor,lines[0]?.purchase_currency||b.currency)+' per stock unit')+'; the invoice shows '+money.format(d.billedUnitCostMinor,b.currency)+' per stock unit.'};
  if(d.kind==='invoice_ahead_of_receipt')return {kind:d.kind,text:(code||'Invoice line '+d.line)+': our records show '+d.received+' stock units received and '+d.previouslyBilled+' stock units already billed. The saved invoice line uses '+d.billed+' stock units.'};
  if(d.kind==='document_total_differs')return {kind:d.kind,text:'Our saved document total is '+money.format(d.documentTotalMinor,b.currency)+'; the saved lines, charges and tax calculate to '+money.format(d.calculatedTotalMinor,b.currency)+'. Please confirm the original invoice total.'};
  if(d.kind==='invoice_currency_differs')return {kind:d.kind,text:'The purchase order is in '+d.approvedCurrency+'; this invoice is in '+d.billedCurrency+'. Please confirm the agreed currency.'};
  return {kind:d.kind,text:require('./postgres-invoice-review').differenceLabel(d.kind)};
 });
 const training=require('../autopilot/draft-authority').scope(supplier.id,b.currency,Number(b.total_minor),['invoice-dispute',box.id,box.provider_account_id,box.provider_type,supplier.email,...[...new Set(differences.map(d=>d.kind))].sort(),...preview.lines.map(l=>l.skuId).sort()],supplier.name+' · invoice difference review');
 const p={recordId:b.id,billNumber:b.bill_number,invoiceNumber:b.supplier_invoice_number,supplierId:supplier.id,supplierName:supplier.name,recipient:supplier.email,currency:b.currency,totalMinor:Number(b.total_minor),billRevision:preview.billRevision,matchFingerprint:preview.matchFingerprint,sourceEvidence:source.evidence,sourceSender:source.s.sender,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type,differences,needsDisputeConfirmation:!exactDocument,training};
 return {...p,sourceFingerprint:hash(p)};
}
function compose(p){return {subject:'Please review invoice '+p.invoiceNumber,body:'Hello '+p.supplierName+',\n\nPlease help us reconcile invoice '+p.invoiceNumber+' (recorded total '+money.format(p.totalMinor,p.currency)+') with our purchase-order and receipt records:\n\n'+p.differences.map(d=>d.text).join('\n')+'\n\nPlease confirm these details or send a corrected invoice if needed. This message does not agree to a changed price or payment term.\n\nThank you.'};}
async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);const state=await policy.requireWorkspaceJob(db,workspaceId,100,'draft'),stop=await policy.stopped(db,workspaceId,state,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const fresh=await facts(db,ctx,p.recordId,p.connectorId);if(fresh.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The original invoice, purchase order, receipt, supplier or mailbox changed. Review a fresh dispute.');
 if(!p.automatic)return fresh;
 if(fresh.needsDisputeConfirmation)throw new ValidationError('Review this invoice and original document individually before sending its dispute.');
 const trained=state.plan!=='pro'||await require('../autopilot/draft-authority').trained(db,workspaceId,action,fresh);policy.requireJob(state.plan,100,'automatic',{trained});
 const rule=(await db.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',[workspaceId,action,fresh.training.key,fresh.currency])).rows[0];
 if(rule&&Number(rule.maximum_minor)<fresh.totalMinor)throw new ValidationError('This invoice is above the owner’s taught dispute limit. Review it individually.');return fresh;
}
async function build(db,ctx,row,args){const box=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);if(!box.row)throw new ValidationError('Choose the exact connected sending mailbox.');const p=await facts(db,ctx,row.id,box.row.id);return {payload:p,summary:'Ask '+p.supplierName+' ('+p.recipient+') to review invoice '+p.invoiceNumber+': '+p.differences.map(d=>d.text).join(' ')+' This leaves the invoice, stock and money records in place.'};}
async function execute(db,ctx,p){
 const authorityPayload={...p,kind,actorId:ctx.actorId,automatic:ctx.agentInvoiceDisputeScope==='automatic'};await authority(db,ctx.workspaceId,authorityPayload);const key='invoice-dispute:'+p.recordId,words=compose(p),existing=(await db.query(`SELECT m.*,e.id effect_id,e.payload FROM supplier_communications m LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND m.idempotency_key=$2`,[ctx.workspaceId,key])).rows[0];
 if(existing&&(existing.recipient!==p.recipient||existing.subject!==words.subject||existing.body!==words.body||existing.connector_id!==p.connectorId))throw new ValidationError('An earlier dispute already uses this invoice. Review its delivery before sending changed details.');
 if(existing?.status==='FAILED')throw new ValidationError('Review the earlier dispute and its delivery before trying again.');
 if(existing?.status==='SENT')return {communicationId:existing.id,billId:p.recordId,status:'SENT',alreadySent:true,replayed:true,effectId:existing.effect_id};
 if(existing){
  const previous=existing.payload?.standingAuthority;
  if(!existing.effect_id||previous?.kind!==kind||previous.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('Review the earlier dispute and its delivery before trying again.');
  if(existing.status==='QUEUED')await authority(db,ctx.workspaceId,previous);
  return {communicationId:existing.id,billId:p.recordId,status:existing.status,effectId:existing.effect_id,replayed:true};
 }
 const r=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'supplier',recipientId:p.supplierId,recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:authorityPayload},key,{agentRequested:true,agentJob:100});
 await db.query('UPDATE supplier_communications SET invoice_dispute_bill_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.communicationId,p.recordId]);return {...r,billId:p.recordId,replayed:Boolean(existing)};
}
async function confirmedExample(db,workspaceId,p){if(p.payload.needsDisputeConfirmation!==false)return false;return Boolean((await db.query(`SELECT 1 FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
 WHERE m.workspace_id=$1 AND m.id=$2 AND m.invoice_dispute_bill_id=$3 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'='invoice_dispute'
  AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=$4`,[workspaceId,p.result?.communicationId||'',p.payload.recordId,p.payload.sourceFingerprint])).rows.length);}
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT b.bill_number "Bill",b.supplier_invoice_number "Supplier invoice",s.name "Supplier",b.total_minor,b.currency,'/accounting/payables/'||b.id||'/review' link,
  CASE m.status WHEN 'SENT' THEN 'Sent' WHEN 'QUEUED' THEN 'Queued' WHEN 'FAILED' THEN 'Needs review: '||coalesce(m.error_message,'Delivery could not be confirmed') ELSE 'Review the invoice difference' END "Supplier message"
  FROM accounting_supplier_bills b JOIN suppliers s ON s.workspace_id=b.workspace_id AND s.id=b.supplier_id LEFT JOIN LATERAL(SELECT status,error_message FROM supplier_communications m WHERE m.workspace_id=b.workspace_id AND m.invoice_dispute_bill_id=b.id ORDER BY m.created_at DESC LIMIT 1)m ON true
  WHERE b.workspace_id=$1 AND b.status='DISPUTED' AND ($2='' OR lower(b.bill_number)=lower($2) OR lower(b.supplier_invoice_number)=lower($2) OR lower(s.name)=lower($2)) ORDER BY b.created_at DESC,b.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const state=await policy.accountState(db,ctx.workspaceId);return {summary:'Prepare a supplier message using the actual invoice, purchase-order and receipt differences. Pro can learn a supplier, product, mailbox and invoice-value limit after an individually approved message is confirmed sent. StockChief asks about unclear originals or differences outside that scope.',rows:rows.slice(0,100).map(({total_minor,currency,...r})=>({...r,Total:money.format(total_minor,currency)})),more:rows.length>100,invoiceDisputeForm:{mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),blocked:await policy.stopped(db,ctx.workspaceId,state,action,false)}};
}
module.exports={compose,authority,confirmedExample,definition:{id:100,key:'supplier-invoice-disputes',label:'Ask suppliers to review invoice differences',filterLabel:'Bill, supplier invoice or supplier',readPage:review},spec:{name:action,agentJob:100,description:'Prepare a supplier invoice dispute from its original readable supplier document and current purchase-order/receipt differences. Sends a factual review request only; never changes a price, payable, stock, payment or supplier terms.',record:'supplier_bill',fields:['recordReference','mailbox'],permission:require('../actions/permissions').MANAGE_ACCOUNTING,ownerOnly:true,capability:'connection.email',completionGate:'provider_effect_succeeded',resultingRecords:['supplier_communications','stockchief_runtime.provider_effects'],build,execute,
 verify:async(db,ctx,r,p)=>Boolean((await db.query("SELECT 1 FROM supplier_communications WHERE workspace_id=$1 AND id=$2 AND invoice_dispute_bill_id=$3 AND status IN ('QUEUED','SENDING','SENT')",[ctx.workspaceId,r.communicationId,p.recordId])).rows.length)}};
