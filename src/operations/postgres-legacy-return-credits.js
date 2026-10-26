'use strict';
const {ValidationError}=require('../domain/errors');
const digest=require('../pricing/postgres-promotions').hash;
async function preview(db,ctx,returnId){
 const row=await require('./postgres-returns').getCustomerReturn(db,ctx.workspaceId,returnId);
 if(row.receipt_credit_policy||row.resolution!=='REFUND'||!['PARTIALLY_RECEIVED','RECEIVED','AWAITING_REFUND'].includes(row.status)||row.postedRefunds.length||row.receiptCredits.length)
  throw new ValidationError('Only received legacy refund returns without an existing credit or refund can be converted.');
 const invoice=(await db.query('SELECT id,total_minor,balance_minor,discount_minor,tax_minor,currency,status FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,row.sales_order_id])).rows[0];
 if(!invoice)throw new ValidationError('The original customer invoice is missing.');
 const batches=[];let totalMinor=0,taxMinor=0,pendingCostMinor=0;
 for(const line of row.lines){let quantity=0;for(const batch of line.trackingEvidence.receivedBatches||[]){
  if(!batch.returnMovementId||!batch.inventoryJournalEntryId||!batch.allocations?.length)throw new ValidationError('The received stock has incomplete original-cost evidence.');
  const source=(await db.query(`SELECT e.posting_date,coalesce(h.target_date,e.posting_date) AS effective_date FROM accounting_journal_entries e
   LEFT JOIN accounting_history_corrections h ON h.workspace_id=e.workspace_id AND h.source_entry_id=e.id AND h.kind='calendar'
   WHERE e.workspace_id=$1 AND e.id=$2 AND e.status='POSTED'`,[ctx.workspaceId,batch.inventoryJournalEntryId])).rows[0];
  if(!source)throw new ValidationError('The received stock journal is unavailable.');
  const adjusted={...batch,allocations:batch.allocations.map(a=>({...a,costRecognition:row.deferredReceiptIds.includes(a.inventoryJournalEntryId)?'ON_REFUND':a.costRecognition}))};
  const groups=require('./return-money').groups({lines:[{...line,trackingEvidence:{costAllocations:adjusted.allocations}}]});
  totalMinor+=groups.reduce((n,g)=>n+g.revenueMinor+g.taxMinor,0);taxMinor+=groups.reduce((n,g)=>n+g.taxMinor,0);pendingCostMinor+=groups.reduce((n,g)=>n+g.pendingCostMinor,0);
  batches.push({lineId:line.id,batch:adjusted,postingDate:source.effective_date});quantity+=Number(batch.quantity);
 }
 if(quantity!==Number(line.quantity_received))throw new ValidationError('The received quantities do not reconcile with their recorded receipt batches.');}
 if(!batches.length||totalMinor>Number(invoice.total_minor))throw new ValidationError('The receipt credit does not reconcile with the remaining invoice.');
 const review={returnId:row.id,returnNumber:row.return_number,salesOrderId:row.sales_order_id,status:row.status,currency:row.currency,invoice,batches,totalMinor,taxMinor,pendingCostMinor,arCreditMinor:Math.min(Number(invoice.balance_minor),totalMinor),cashDueMinor:Math.max(0,totalMinor-Number(invoice.balance_minor))};
 return {...review,integrity:digest(review)};
}
async function apply(client,ctx,review){
 const actor=(await client.query("SELECT role FROM users WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId])).rows[0];if(actor?.role!=='owner')throw new ValidationError('Only the owner can approve this historical financial conversion.');
 const exact={...review};delete exact.integrity;if(digest(exact)!==review.integrity)throw new ValidationError('The credit review changed. Prepare a new review.');
 await client.query('SELECT id FROM customer_returns WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,review.returnId]);
 const prior=(await client.query('SELECT review_hash,result FROM accounting_return_credit_conversions WHERE workspace_id=$1 AND customer_return_id=$2',[ctx.workspaceId,review.returnId])).rows[0];
 if(prior){if(prior.review_hash!==review.integrity)throw new ValidationError('A different credit conversion is already recorded.');return {...prior.result,replayed:true};}
 const current=await preview(client,ctx,review.returnId);if(current.integrity!==review.integrity)throw new ValidationError('The invoice or received-return evidence changed. Review it again before approval.');
 const row=await require('./postgres-returns').getCustomerReturn(client,ctx.workspaceId,review.returnId),creditIds=[];
 for(const b of review.batches){const line=row.lines.find(l=>l.id===b.lineId),result=await require('./postgres-return-credits').receive(client,ctx,row,line,b.batch,'legacy:'+row.id+':'+b.batch.returnMovementId,{postingDate:b.postingDate,releasePendingCost:true});creditIds.push(...result.creditIds);}
 await client.query("UPDATE customer_returns SET receipt_credit_policy='RECEIPT_CREDIT_V1' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,row.id]);
 const result={customerReturnId:row.id,totalMinor:review.totalMinor,taxMinor:review.taxMinor,releasedCostMinor:review.pendingCostMinor,creditIds,physicalStockChanged:false,cashPaidMinor:0};
 await client.query('INSERT INTO accounting_return_credit_conversions(workspace_id,customer_return_id,review_hash,result,actor_user_id) VALUES($1,$2,$3,$4::jsonb,$5)',[ctx.workspaceId,row.id,review.integrity,JSON.stringify(result),ctx.actorId]);return result;
}
module.exports={preview,apply};
