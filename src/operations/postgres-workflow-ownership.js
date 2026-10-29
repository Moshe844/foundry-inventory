'use strict';

// A projection and a durable next check over the existing business engines.
// This service cannot receive goods, change an order, post money or send mail.
const {newId}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const time=require('../lib/business-time');
const SOURCE='postgres_workflow_owner';
const kinds=Object.freeze({
 purchase:{table:'purchase_orders',number:'po_number',href:'/purchasing/orders/',title:'Receive and reconcile the supplier order',permission:'view_purchasing'},
 supplier_invoice:{table:'accounting_supplier_bills',number:'bill_number',href:'/accounting/payables/',title:'Resolve the supplier invoice and track its payable',permission:'view_accounting'},
 customer_order:{table:'sales_orders',number:'order_number',href:'/orders/',title:'Deliver the customer order and reconcile its payment',permission:'view_sales'},
});
const json=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value||'{}');}catch{return {};}};
const scoped=client=>({query:(sql,values)=>client.query(sql,values),transaction:work=>work(client)});
function kindOf(work){return work.source===SOURCE?json(work.recommended_action).type:json(work.outcome).kind==='purchase'?'purchase':json(work.outcome).kind==='transfer'?'transfer':null;}
function recordOf(work,kind){const result=json(work.outcome);return work.source===SOURCE?json(work.recommended_action).recordId:kind==='purchase'?result.purchaseOrderId:result.transferId;}
async function enqueue(client,workspaceId,workId,revision){
 return require('./postgres-job-queue').enqueue(scoped(client),{workspaceId,kind:'workflow.follow-through',
  idempotencyKey:'workflow-check:'+workId+':'+revision,payload:{workId},priority:45,maxAttempts:5});
}
async function capture(client,ctx,kind,recordId,operation){
 const definition=kinds[kind];if(!definition)throw new ValidationError('Choose a supported business workflow.');
 const record=(await client.query(`SELECT * FROM ${definition.table} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,recordId])).rows[0];
 if(!record)throw new NotFoundError('That workflow record is not in this business.');
 const parent=kind==='purchase'?json(record.source_detail).workItemId:null;
 if(parent){await enqueue(client,ctx.workspaceId,parent,operation.id);return parent;}
 const id=newId('wi'),at=new Date().toISOString(),action={type:kind,recordId,displayName:record[definition.number],title:definition.title,href:definition.href+recordId};
 const saved=await client.query(`INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,
  confidence,approval_requirement,execution_status,verification_status,idempotency_key,outcome,created_at,due_at)
  VALUES($1,$2,'business_follow_through',$3,$4,$5,$6,'high','NONE','EXECUTING','PENDING',$7,$8,$9,$9)
  ON CONFLICT(workspace_id,idempotency_key) DO UPDATE SET due_at=EXCLUDED.due_at,
   execution_status='EXECUTING',verification_status='PENDING',completed_at=NULL RETURNING id`,
 [id,ctx.workspaceId,SOURCE,JSON.stringify([{fact:'canonical_record',kind,id:recordId}]),JSON.stringify({kind,recordId}),JSON.stringify(action),
  'business-outcome:'+kind+':'+recordId,JSON.stringify({kind,recordId,ownerActorId:ctx.actorId,requestedOutcome:definition.title,phase:'CHECK_QUEUED',nextAction:'Check the saved business records',startedAt:at,nextCheckAt:at}),at]);
 const workId=saved.rows[0].id;
 await client.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,actor_user_id,created_at)
  VALUES($1,$2,$3,'business_record_saved',$4,$5,$6)`,[newId('wievt'),ctx.workspaceId,workId,JSON.stringify({operationId:operation.id,kind:operation.kind,recordId}),ctx.actorId,at]);
 await enqueue(client,ctx.workspaceId,workId,operation.id);return workId;
}
async function captureResult(client,operation,result){
 const ctx=operation.ctx;if(!ctx)return;
 if(result.purchaseOrderId)await capture(client,ctx,'purchase',result.purchaseOrderId,operation);
 if(result.billId)await capture(client,ctx,'supplier_invoice',result.billId,operation);
 let salesOrderId=result.salesOrderId;
 if(!salesOrderId&&result.customerReturnId)salesOrderId=(await client.query('SELECT sales_order_id FROM customer_returns WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,result.customerReturnId])).rows[0]?.sales_order_id;
 if(salesOrderId)await capture(client,ctx,'customer_order',salesOrderId,operation);
}
function decision(code,happened,impact,checked,recommendation,alternatives,required){return {code,happened,impact,checked,recommendation,alternatives,required};}
async function purchase(database,workspaceId,id,prior,clock){
 const po=(await database.query(`SELECT p.*,s.name AS supplier_name,s.follow_up_days FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id WHERE p.workspace_id=$1 AND p.id=$2`,[workspaceId,id])).rows[0];
 if(!po)return missing();
 const lines=(await database.query('SELECT id,sku_id,quantity_units,quantity_received_units FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number,id',[workspaceId,id])).rows;
 const documents=(await database.query(`SELECT d.id,d.status,d.document_type,d.facts,d.discrepancies,d.processed_at,d.message_id FROM supplier_documents d WHERE d.workspace_id=$1 AND d.purchase_order_id=$2 AND d.status<>'IGNORED' ORDER BY d.processed_at,d.id`,[workspaceId,id])).rows;
 const bills=(await database.query("SELECT id,status FROM accounting_supplier_bills WHERE workspace_id=$1 AND purchase_order_id=$2 AND status<>'VOID'",[workspaceId,id])).rows;
 const proof={purchaseOrderId:id,status:po.status,ordered:lines.reduce((n,l)=>n+Number(l.quantity_units),0),received:lines.reduce((n,l)=>n+Number(l.quantity_received_units),0),documentIds:documents.map(d=>d.id),billIds:bills.map(b=>b.id)};
 const base={recordId:id,reference:po.po_number,href:kinds.purchase.href+id,party:po.supplier_name,proof};
 if(po.status==='CANCELLED')return {...base,phase:'CANCELLED',cancelled:true,nextAction:'The unreceived remainder was cancelled; recorded receipts remain intact.'};
 const newestConfirmation=documents.filter(d=>d.document_type==='order_acknowledgement').at(-1),bad=documents.findLast(d=>d.status==='NEEDS_REVIEW'),disputed=bills.find(b=>b.status==='DISPUTED');
 if(bad||disputed)return {...base,phase:'PURCHASE_EXCEPTION',nextAction:'Review the supplier discrepancy',decision:decision('supplier_discrepancy','The supplier evidence differs from this purchase order.',`${proof.ordered-proof.received} units remain unreceived.`,['Saved purchase lines','Supplier documents','Recorded receipts and bills'],'Review the exact discrepancy before accepting changed terms.',['Keep the original commitment','Request a corrected supplier document'],'Accept a reviewed change or dispute it.'),reviewHref:disputed?'/accounting/payables/'+disputed.id+'/review':'/mail/'+bad.message_id};
 if(po.status==='RECEIVED'){
  const receipts=(await database.query(`SELECT l.purchase_order_line_id,sum(l.quantity_units)::bigint AS received FROM purchase_order_receipt_lines l JOIN purchase_order_receipts r ON r.id=l.receipt_id AND r.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND r.purchase_order_id=$2 GROUP BY l.purchase_order_line_id`,[workspaceId,id])).rows;
  const received=new Map(receipts.map(l=>[l.purchase_order_line_id,Number(l.received)]));
  if(lines.length&&lines.every(l=>Number(l.quantity_received_units)>=Number(l.quantity_units)&&received.get(l.id)===Number(l.quantity_received_units)))return {...base,phase:'RECEIVED_AND_RECONCILED',complete:true,nextAction:'Physical receipt is recorded and agrees with every order line.',completionProof:{...proof,receiptLines:receipts}};
  return {...base,phase:'RECEIPT_REVIEW',nextAction:'Reconcile the physical receipt records',decision:decision('receipt_evidence_missing','The order is marked received, but its receipt evidence does not reconcile.','StockChief cannot confirm completion.',['Order quantities','Canonical receipt lines'],'Review the receipt history.',['Investigate the recorded receiving event'],'Confirm the correct receiving evidence; never receive it twice.')};
 }
 if(['DRAFT','AWAITING_APPROVAL'].includes(po.status))return {...base,phase:'PURCHASE_PREPARATION',nextAction:'Review and approve the purchase order; no supplier commitment has been sent.'};
 const acknowledgment=newestConfirmation?.status==='MATCHED'?newestConfirmation:null;
 const communication=prior.communicationId?(await database.query('SELECT status,sent_at,external_message_id FROM supplier_communications WHERE workspace_id=$1 AND id=$2',[workspaceId,prior.communicationId])).rows[0]:null;
 const sentAt=communication?.status==='SENT'&&communication.external_message_id?communication.sent_at:po.ordered_at;
 const confirmationDue=sentAt?new Date(Date.parse(sentAt)+Math.max(1,Number(po.follow_up_days)||2)*86400000).toISOString():null;
 if(!acknowledgment&&confirmationDue&&confirmationDue<clock.instant)return {...base,phase:'CONFIRMATION_OVERDUE',deadline:confirmationDue,nextAction:'Request supplier acceptance and an expected date',decision:decision('supplier_confirmation_due',`${po.supplier_name} has not provided a matched acceptance for ${po.po_number}.`,`${proof.ordered-proof.received} units are expected; acceptance is unverified.`,['Sent-message receipt','Trusted supplier documents','Current purchase status'],'Prepare a supplier confirmation request.',['Wait with a revised deadline','Review an alternative supplier'],'Review the follow-up before sending unless a separate communication rule covers it.')};
 if(po.expected_date&&po.expected_date<clock.calendarDate)return {...base,phase:'DELIVERY_OVERDUE',deadline:time.dayBoundary(po.expected_date,clock.timeZone,{nextDay:true}),nextAction:'Check the overdue delivery and affected customer orders',decision:decision('supplier_delivery_late',`${po.supplier_name}'s delivery was expected on ${po.expected_date}.`,`${proof.ordered-proof.received} units remain outstanding.`,['Expected delivery date','Partial receipts','Supplier documents'],'Prepare a delivery update request and review existing-stock alternatives.',['Transfer available stock','Review another supplier'],'Approve only any changed cost or customer promise outside existing authority.')};
 if(acknowledgment&&!po.expected_date&&!json(acknowledgment.facts).expectedArrivalDate)return {...base,phase:'DELIVERY_DATE_NEEDED',nextAction:'Confirm the supplier’s expected delivery date',decision:decision('supplier_delivery_date_missing','The supplier accepted the order without a confirmed delivery date.',`${proof.ordered-proof.received} units are expected, but their arrival cannot yet be supervised.`,['Supplier acceptance','Order and per-line delivery expectations'],'Prepare a request for the supplier’s delivery date.',['Agree a revised promise with affected customers'],'Confirm the expected date from supplier evidence.')};
 const arrival=po.expected_date||json(acknowledgment?.facts).expectedArrivalDate;
 return {...base,phase:acknowledgment?'AWAITING_PHYSICAL_RECEIPT':'AWAITING_SUPPLIER_CONFIRMATION',deadline:acknowledgment&&arrival?time.dayBoundary(arrival,clock.timeZone,{nextDay:true}):confirmationDue,nextAction:acknowledgment?'Monitor the agreed delivery and wait for physical receiving confirmation.':'Check for the supplier’s explicit acceptance and delivery date.'};
}
function missing(){return {phase:'RECORD_UNAVAILABLE',nextAction:'Review the linked business record',decision:decision('record_unavailable','The linked business record is unavailable.','Completion cannot be verified.',['Business and record identity'],'Review access and record history.',[],'Restore access or investigate the missing record.')};}
async function supplierInvoice(database,workspaceId,id,_prior,clock){
 const b=(await database.query('SELECT b.*,s.name AS supplier_name FROM accounting_supplier_bills b JOIN suppliers s ON s.id=b.supplier_id AND s.workspace_id=b.workspace_id WHERE b.workspace_id=$1 AND b.id=$2',[workspaceId,id])).rows[0];if(!b)return missing();
 const base={recordId:id,reference:b.bill_number,href:kinds.supplier_invoice.href+id,party:b.supplier_name,proof:{billId:id,status:b.status,totalMinor:Number(b.total_minor),balanceMinor:Number(b.balance_minor),currency:b.currency,journalEntryId:b.journal_entry_id,dueDate:b.due_date}};
 if(b.status==='VOID')return {...base,phase:'CANCELLED',cancelled:true,nextAction:'The bill was voided through accounting.'};
 if(b.status==='DISPUTED'||!b.journal_entry_id)return {...base,phase:'INVOICE_REVIEW',nextAction:'Resolve the invoice comparison',reviewHref:base.href+'/review',decision:decision('supplier_invoice_review','The invoice is disputed or has not been posted.','An unapproved document is not a confirmed payable.',['Supplier identity','Invoice identity and duplicate checks','PO, receipts, charges and document total'],'Review the exact invoice differences before posting.',['Request a corrected invoice','Keep it disputed'],'Approve a matched bill or resolve each discrepancy.')};
 if(b.status==='PAID'&&Number(b.balance_minor)===0)return {...base,phase:'PAYABLE_RECONCILED',complete:true,nextAction:'The bill and its payment are reconciled.',completionProof:base.proof};
 if(!b.due_date)return {...base,phase:'PAYMENT_TERMS_NEEDED',nextAction:'Confirm the supplier’s payment due date',decision:decision('supplier_due_date_missing','The posted bill has no confirmed due date.','Payment timing cannot be supervised accurately.',['Invoice source','Saved payable'],'Confirm the date or supplier terms from the document.',[],'Provide the invoice due date; StockChief will not invent it.')};
 if(b.due_date<=clock.calendarDate)return {...base,phase:'PAYMENT_DUE',deadline:time.dayBoundary(b.due_date,clock.timeZone),nextAction:'Review payment under the supplier’s terms',decision:decision('supplier_payment_due',`${b.bill_number} is due ${b.due_date}.`,`${require('../domain/currency').format(Number(b.balance_minor),b.currency)} remains owed.`,['Posted bill','Recorded allocations and balance'],'Prepare the permitted payment or record payment evidence.',['Review a dispute','Agree a revised date with the supplier'],'Approve payment within the saved financial authority; no bank payment is inferred.')};
 return {...base,phase:'AWAITING_PAYMENT_DATE',deadline:time.dayBoundary(b.due_date,clock.timeZone),nextAction:'Monitor the due date and reconcile actual payments.'};
}
async function customerOrder(database,workspaceId,id,_prior,clock){
 const so=(await database.query('SELECT o.*,c.name AS customer_name FROM sales_orders o JOIN customers c ON c.id=o.customer_id AND c.workspace_id=o.workspace_id WHERE o.workspace_id=$1 AND o.id=$2',[workspaceId,id])).rows[0];if(!so)return missing();
 const lines=(await database.query(`SELECT l.*,COALESCE((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0) AS allocated,
  COALESCE((SELECT sum((e.metadata::jsonb->>'quantity')::numeric) FROM accounting_journal_entries e WHERE e.workspace_id=l.workspace_id AND e.source_type='sale_fulfillment' AND e.source_record_type='sales_order' AND e.source_record_id=l.sales_order_id AND e.status='POSTED' AND e.metadata::jsonb->>'salesOrderLineId'=l.id),0) AS posted_quantity
  FROM sales_order_lines l WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,[workspaceId,id])).rows;
 const shipments=(await database.query("SELECT id,status,handover,tracking_status,expected_delivery_date,delivered_at FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status<>'CANCELLED'",[workspaceId,id])).rows;
 const invoices=(await database.query("SELECT i.id,i.status,i.balance_minor,i.due_date,i.journal_entry_id,i.source_key,EXISTS(SELECT 1 FROM accounting_journal_entries e WHERE e.workspace_id=i.workspace_id AND e.id=i.journal_entry_id AND e.status='POSTED') AS header_posted FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND i.sales_order_id=$2 AND i.status<>'VOID'",[workspaceId,id])).rows;
 const remaining=lines.reduce((n,l)=>n+Number(l.quantity_ordered)-Number(l.quantity_fulfilled),0),allocated=lines.reduce((n,l)=>n+Number(l.allocated),0),fulfilled=lines.reduce((n,l)=>n+Number(l.quantity_fulfilled),0);
 const base={recordId:id,reference:so.order_number,href:kinds.customer_order.href+id,party:so.customer_name,proof:{salesOrderId:id,status:so.status,remaining,allocated,fulfilled,shipmentIds:shipments.map(s=>s.id),invoices:invoices.map(i=>({id:i.id,status:i.status,balanceMinor:Number(i.balance_minor),dueDate:i.due_date}))}};
 if(so.status==='CANCELLED'&&!fulfilled)return {...base,phase:'CANCELLED',cancelled:true,nextAction:'The unfulfilled order was cancelled.'};
 if(so.status==='DRAFT')return {...base,phase:'ORDER_REVIEW',nextAction:'Confirm the customer, prices, delivery and tax before reserving stock.'};
 const returns=(await database.query(`SELECT r.id,r.return_number,r.status,r.resolution,
  COALESCE((SELECT sum(c.cash_due_minor-c.cash_refunded_minor) FROM accounting_return_receipt_credits c WHERE c.workspace_id=r.workspace_id AND c.customer_return_id=r.id),0) AS cash_outstanding,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('lineId',l.sales_order_line_id,'received',l.quantity_received,'disposed',l.quantity_restocked+l.quantity_scrapped+l.quantity_repair)) FROM customer_return_lines l WHERE l.workspace_id=r.workspace_id AND l.customer_return_id=r.id),'[]'::jsonb) AS lines
  FROM customer_returns r WHERE r.workspace_id=$1 AND r.sales_order_id=$2 AND r.status<>'CANCELLED' ORDER BY r.created_at,r.id`,[workspaceId,id])).rows;
 base.proof.returns=returns.map(r=>({id:r.id,status:r.status,resolution:r.resolution,cashOutstanding:Number(r.cash_outstanding),lines:r.lines}));
 const pendingReturn=returns.find(r=>r.status!=='COMPLETED'||Number(r.cash_outstanding)>0);
 if(pendingReturn)return {...base,phase:'CUSTOMER_RETURN_IN_PROGRESS',reviewHref:'/returns/'+pendingReturn.id,nextAction:'Complete the recorded return, physical inspection and financial resolution before closing this order.'};
 const returned=new Map();for(const r of returns)for(const l of r.lines)if(Number(l.disposed)===Number(l.received))returned.set(l.lineId,(returned.get(l.lineId)||0)+Number(l.received));
 const fulfillmentPosted=fulfilled>0&&lines.every(l=>Number(l.posted_quantity)===Number(l.quantity_fulfilled));
 const financesClear=invoices.length>0&&invoices.every(i=>Number(i.balance_minor)===0&&(i.header_posted||i.source_key==='sales-order:'+id&&fulfillmentPosted));
 if(fulfilled>0&&(!remaining||so.status==='CANCELLED')&&lines.every(l=>Number(l.quantity_fulfilled)===Number(returned.get(l.id)||0))&&financesClear)return {...base,phase:'RETURNED_AND_RECONCILED',complete:true,nextAction:'All fulfilled units have completed returns and the recorded financial resolution agrees.',completionProof:base.proof};
 const failed=shipments.find(s=>['FAILURE','RETURNED'].includes(s.tracking_status));
 if(failed)return {...base,phase:'DELIVERY_EXCEPTION',nextAction:'Investigate the carrier exception',reviewHref:'/fulfilment/'+failed.id,decision:decision('customer_delivery_exception','A carrier reported a failed or returned shipment.',`${so.customer_name}'s delivery needs attention.`,['Shipment tracking','Order lines and invoices'],'Review the carrier evidence and prepare the customer update.',['Arrange redelivery','Prepare an authorized return'],'Choose the delivery remedy before changing stock or refunding.')};
 if(remaining>allocated&&so.status!=='CANCELLED')return {...base,phase:'STOCK_SHORTAGE',deadline:so.needed_by?time.dayBoundary(so.needed_by,clock.timeZone):null,nextAction:'Resolve the unallocated customer demand',decision:decision('customer_stock_shortage',`${so.order_number} has ${remaining} units left and ${allocated} reserved.`,`${remaining-allocated} units cannot yet be fulfilled.`,['Current allocations','Physical stock and incoming supply'],'Review safe transfers before an additional supplier purchase.',['Partially fulfill available units','Agree a revised delivery promise'],'Approve any additional commitment outside the current authority.')};
 const delivered=shipments.length>0&&shipments.every(s=>s.status==='DELIVERED'||s.tracking_status==='DELIVERED'||s.handover==='COLLECTED'&&s.status==='SHIPPED');
 if((!remaining||so.status==='CANCELLED')&&fulfilled>0&&delivered&&financesClear)return {...base,phase:'DELIVERED_AND_RECONCILED',complete:true,nextAction:'Delivery or collection and invoicing/payment agree.',completionProof:base.proof};
 const unpaid=invoices.find(i=>Number(i.balance_minor)>0&&i.due_date&&i.due_date<=clock.calendarDate);
 if(unpaid)return {...base,phase:'CUSTOMER_PAYMENT_DUE',deadline:time.dayBoundary(unpaid.due_date,clock.timeZone),nextAction:'Review the overdue customer payment',decision:decision('customer_payment_due',`${so.customer_name}'s invoice is due.`,`${require('../domain/currency').format(Number(unpaid.balance_minor),so.currency)} remains outstanding.`,['Posted invoice','Recorded payments'],'Prepare a payment reminder under the saved communication authority.',['Investigate a dispute','Record payment evidence'],'Approve the reminder or reconcile an actual payment.')};
 return {...base,phase:remaining>0&&so.status!=='CANCELLED'?'AWAITING_DISPATCH':!delivered?'AWAITING_DELIVERY':'AWAITING_CUSTOMER_PAYMENT',nextAction:remaining>0&&so.status!=='CANCELLED'?'Prepare warehouse work and wait for confirmed physical dispatch.':!delivered?'Monitor actual tracking or collection confirmation.':'Monitor the recorded customer invoice and payment.'};
}
async function transfer(database,workspaceId,id){
 const row=(await database.query('SELECT id,transfer_number,status FROM inventory_transfers WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];if(!row)return missing();
 return {recordId:id,reference:row.transfer_number,href:'/transfers/'+id,phase:row.status==='RECEIVED'?'TRANSFER_RECEIVED':'AWAITING_TRANSFER_RECEIPT',complete:row.status==='RECEIVED',cancelled:row.status==='CANCELLED',proof:{transferId:id,status:row.status},completionProof:row.status==='RECEIVED'?{transferId:id,status:row.status}:null,nextAction:row.status==='RECEIVED'?'The destination confirmed the physical receipt.':'Wait for the warehouse to dispatch and confirm receipt; approval alone moves no stock.'};
}
async function refreshInTransaction(client,workspaceId,workId,{now=new Date()}={}){
 const work=(await client.query('SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,workId])).rows[0];if(!work)throw new NotFoundError('That work is not in this business.');
 const kind=kindOf(work),recordId=recordOf(work,kind),prior=json(work.outcome);if(!kind||!recordId)return {skipped:'not_a_tracked_outcome'};
 // Provider acceptance must be reconciled by its own receipt handler first.
 if(prior.phase==='SUPPLIER_DELIVERY_PENDING'){
  await require('../autopilot/postgres-service').reconcileSupplierFollowThrough(scoped(client),workspaceId);
  const saved=(await client.query('SELECT execution_status,outcome FROM work_items WHERE workspace_id=$1 AND id=$2',[workspaceId,workId])).rows[0];
  if(saved.execution_status!=='EXECUTING')return {workId,status:saved.execution_status,phase:json(saved.outcome).phase};
  if(json(saved.outcome).phase!=='SUPPLIER_DELIVERY_PENDING')return refreshInTransaction(client,workspaceId,workId,{now});
  await client.query('UPDATE work_items SET due_at=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,workId,new Date(now.getTime()+15*60000).toISOString()]);return {skipped:'provider_receipt_pending'};
 }
 const clock=await time.forWorkspace(client,workspaceId,now);let snapshot=await ({purchase,supplier_invoice:supplierInvoice,customer_order:customerOrder,transfer}[kind])(client,workspaceId,recordId,prior,clock),followUps=prior.followUps||[];
 if(kind==='purchase'){
  if(!snapshot.decision){for(const follow of followUps.filter(f=>f.proposalId&&!f.effectId))await client.query("UPDATE stockchief_runtime.assistant_action_proposals SET status='CANCELLED',cancelled_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING'",[workspaceId,follow.proposalId]);}
  const prepared=await require('../purchasing/postgres-supplier-followups').prepare(client,workspaceId,work,snapshot,prior,clock);snapshot=prepared.snapshot;followUps=prepared.followUps;
 }
 const at=now.toISOString(),next=new Date(now.getTime()+15*60000).toISOString(),status=snapshot.cancelled?'CANCELLED':snapshot.complete?'COMPLETED':'EXECUTING';
 const result={...prior,...snapshot,kind,followUps,verified:Boolean(snapshot.complete),lastCheckedAt:at,nextCheckAt:status==='EXECUTING'?next:null,waitingSince:prior.phase===snapshot.phase?prior.waitingSince||at:at};
 if(snapshot.complete)delete result.decision;
 if(!snapshot.decision)delete result.decision;
 const changed=prior.phase!==snapshot.phase||JSON.stringify(prior.proof)!==JSON.stringify(snapshot.proof)||JSON.stringify(prior.decision)!==JSON.stringify(snapshot.decision);
 await client.query(`UPDATE work_items SET execution_status=$3,verification_status=$4,outcome=$5,error_message=$6,due_at=$7,completed_at=$8 WHERE workspace_id=$1 AND id=$2`,[workspaceId,workId,status,snapshot.complete?'VERIFIED':'PENDING',JSON.stringify(result),snapshot.decision?.happened||null,status==='EXECUTING'?next:null,status==='EXECUTING'?null:at]);
 if(changed)await client.query(`INSERT INTO work_item_events(id,workspace_id,work_item_id,event,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)`,[newId('wievt'),workspaceId,workId,snapshot.complete?'outcome_verified':snapshot.decision?'decision_required':'follow_through_updated',JSON.stringify(snapshot),at]);
 return {workId,status,phase:snapshot.phase,changed};
}
async function refresh(database,workspaceId,workId,options){return database.transaction(client=>refreshInTransaction(client,workspaceId,workId,options),{isolation:'SERIALIZABLE',retrySafe:true});}
async function scheduleDue(client,now=Date.now()){
 const due=(await client.query(`SELECT w.id,w.workspace_id FROM work_items w JOIN workspaces b ON b.id=w.workspace_id WHERE b.deletion_requested_at IS NULL AND w.execution_status='EXECUTING' AND (w.source=$1 OR w.source='postgres_autopilot') AND w.due_at IS NOT NULL AND w.due_at<=$2 ORDER BY w.due_at,w.id LIMIT 200`,[SOURCE,new Date(now).toISOString()])).rows;
 let count=0;for(const work of due){const queued=await enqueue(client,work.workspace_id,work.id,'due-'+Math.floor(now/60000));if(queued.created)count++;}return count;
}
module.exports={SOURCE,kinds,capture,captureResult,refresh,refreshInTransaction,scheduleDue,kindOf};
