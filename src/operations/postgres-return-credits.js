'use strict';
const {newId}=require('../lib/util'),{ValidationError}=require('../domain/errors'),ledger=require('../accounting/postgres-ledger');
async function read(db,workspaceId,returnId){return (await db.query('SELECT * FROM accounting_return_receipt_credits WHERE workspace_id=$1 AND customer_return_id=$2 ORDER BY created_at,id',[workspaceId,returnId])).rows;}
async function receive(client,ctx,row,line,batch,key,{postingDate=null,releasePendingCost=false}={}){
 const groups=require('./return-money').groups({lines:[{...line,trackingEvidence:{costAllocations:batch.allocations}}]});
 const invoice=(await client.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2 FOR UPDATE',[ctx.workspaceId,row.sales_order_id])).rows[0];
 if(!invoice)throw new ValidationError('The fulfilled sale needs its original invoice before a return credit can be posted.');
 const amount=groups.reduce((n,g)=>n+g.revenueMinor+g.taxMinor,0);
 if(amount>Number(invoice.total_minor))throw new ValidationError('This return credit exceeds the remaining invoice value.');
 if(!amount&&!groups.some(g=>releasePendingCost&&g.pendingCostMinor))return {creditIds:[],amountMinor:0,arCreditMinor:0};
 let balance=Number(invoice.balance_minor),arTotal=0;const ids=[];
 for(const [i,g]of groups.entries()){
  const total=g.revenueMinor+g.taxMinor,ar=Math.min(balance,total),cash=total-ar;balance-=ar;arTotal+=ar;
  if(cash)await ledger.ensureSystemAccountInTransaction(client,ctx,'CUSTOMER_REFUNDS_PAYABLE');
  const pending=releasePendingCost?g.pendingCostMinor:0;
  const posted=await ledger.postInTransaction(client,ctx,{postingDate,sourceKey:`return-receipt-credit:${key}:${i}`,
   description:`Credit received goods on ${row.return_number}`,sourceType:'customer_return_credit',sourceRecordType:'customer_return',sourceRecordId:row.id,currency:row.currency,
   metadata:{customerReturnId:row.id,originalJournalEntryId:g.originalJournalEntryId,returnMovementId:batch.returnMovementId,revenueMinor:g.revenueMinor,taxMinor:g.taxMinor,arCreditMinor:ar,cashDueMinor:cash},
   lines:[{accountKey:'SALES_RETURNS',debitMinor:g.revenueMinor,customerId:row.customer_id,itemId:g.itemId,skuId:g.skuId},
    {accountKey:'SALES_TAX_PAYABLE',debitMinor:g.taxMinor,customerId:row.customer_id},
    {accountKey:'ACCOUNTS_RECEIVABLE',creditMinor:ar,customerId:row.customer_id},
    {accountKey:'CUSTOMER_REFUNDS_PAYABLE',creditMinor:cash,customerId:row.customer_id},
    {accountKey:'CUSTOMER_RETURN_COST_PENDING',debitMinor:pending,customerId:row.customer_id},
    {accountKey:'COST_OF_GOODS_SOLD',creditMinor:pending,customerId:row.customer_id}].filter(l=>(l.debitMinor||l.creditMinor)>0)});
  const id=newId('returncredit');await client.query(`INSERT INTO accounting_return_receipt_credits
   (id,workspace_id,customer_return_id,return_movement_id,original_journal_entry_id,journal_entry_id,revenue_minor,tax_minor,ar_credit_minor,cash_due_minor,source_key,cogs_minor)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,ctx.workspaceId,row.id,batch.returnMovementId,g.originalJournalEntryId,posted.entry.id,g.revenueMinor,g.taxMinor,ar,cash,key+':'+i,g.costMinor]);ids.push(id);
 }
 const sum=field=>groups.reduce((n,g)=>n+g[field],0),total=Number(invoice.total_minor)-amount;
 await client.query(`UPDATE accounting_customer_invoices SET subtotal_minor=subtotal_minor-$3,discount_minor=discount_minor-$4,
  tax_minor=tax_minor-$5,charges_minor=charges_minor-$6,total_minor=$7,balance_minor=$8,status=$9,updated_at=$10 WHERE workspace_id=$1 AND id=$2`,
 [ctx.workspaceId,invoice.id,sum('grossMinor'),sum('discountMinor'),sum('taxMinor'),sum('chargesMinor'),total,balance,balance===0?'PAID':balance<total?'PARTIALLY_PAID':'OPEN',new Date().toISOString()]);
 return {creditIds:ids,amountMinor:amount,arCreditMinor:arTotal};
}
async function settle(client,ctx,row,input,operation){
 const credits=await read(client,ctx.workspaceId,row.id),amount=credits.reduce((n,c)=>n+Number(c.revenue_minor)+Number(c.tax_minor),0),cash=credits.reduce((n,c)=>n+Number(c.cash_due_minor)-Number(c.cash_refunded_minor),0);
 if(!credits.length&&require('./return-money').summary(row).totalMinor)throw new ValidationError('The receipt credit evidence is missing. No refund was recorded.');
 if(input.destination==='AR'&&cash)throw new ValidationError('The invoice was already credited. Refund the remaining paid amount to the original paid funds.');
 let journalEntryId=null;
 if(cash){const posted=await ledger.postInTransaction(client,ctx,{postingDate:input.refundDate||null,sourceKey:'return-credit-payout:'+row.id,description:'Repay credited goods on '+row.return_number,
  sourceType:'customer_return_credit_payout',sourceRecordType:'customer_return',sourceRecordId:row.id,currency:row.currency,metadata:{customerReturnId:row.id,cashMinor:cash},
  lines:[{accountKey:'CUSTOMER_REFUNDS_PAYABLE',debitMinor:cash,customerId:row.customer_id},{accountKey:'CASH',creditMinor:cash,customerId:row.customer_id}]});journalEntryId=posted.entry.id;
  await client.query('UPDATE accounting_return_receipt_credits SET cash_refunded_minor=cash_due_minor WHERE workspace_id=$1 AND customer_return_id=$2',[ctx.workspaceId,row.id]);
 }
 const refundIds=[],refundDate=input.refundDate||await require('../lib/business-time').today(client,ctx.workspaceId);
 for(const credit of credits){
  const inventoryEntry=(await client.query("SELECT id FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='customer_return_receipt' AND metadata::jsonb->>'movementId'=$2",[ctx.workspaceId,credit.return_movement_id])).rows[0];
  const id=newId('refund');await client.query(`INSERT INTO accounting_sale_refunds
   (id,workspace_id,original_journal_entry_id,refund_reference,refund_date,revenue_minor,tax_minor,cogs_minor,physical_return,destination,
    journal_entry_id,inventory_journal_entry_id,source_key,created_by_user_id,created_at,recognition_stage,payment_journal_entry_id,settled_amount_minor)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,'ON_RECEIPT',$15,$16)`,
  [id,ctx.workspaceId,credit.original_journal_entry_id,row.return_number,refundDate,Number(credit.revenue_minor),Number(credit.tax_minor),Number(credit.cogs_minor),input.destination,
   credit.journal_entry_id,inventoryEntry?.id||null,'receipt-credit-settlement:'+credit.id,ctx.actorId,new Date().toISOString(),journalEntryId,Number(credit.cash_due_minor)]);refundIds.push(id);
 }
 await client.query("UPDATE customer_returns SET status='COMPLETED',refund_id=$4,completed_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,row.id,new Date().toISOString(),refundIds[0]||null]);
 const result={customerReturnId:row.id,status:'COMPLETED',destination:input.destination,amountMinor:cash,creditedMinor:amount,refundIds,journalEntryId};
 return result;
}
module.exports={read,receive,settle};
