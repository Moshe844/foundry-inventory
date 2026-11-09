'use strict';
const {hash}=require('../pricing/postgres-promotions');
function scaled(value){const text=String(value),match=/^(\d+)(?:\.(\d{1,6}))?$/.exec(text);if(!match)return null;return BigInt(match[1])*1000000n+BigInt((match[2]||'').padEnd(6,'0'));}
function exact(value){const text=String(value??'');return /^\d+$/.test(text)?BigInt(text):null;}
function group(rows,key){const groups=new Map();for(const row of rows){const value=row[key];if(!groups.has(value))groups.set(value,[]);groups.get(value).push(row);}return groups;}
async function adjustments(db,ctx,p,rows,today){
 const affected=rows.filter(row=>row.credit_count||row.return_count);if(!affected.length)return new Map();const ids=affected.map(row=>row.id);
 const returns=(await db.query(`SELECT r.id,r.supplier_bill_id,r.supplier_id,r.status,r.actual_credit_minor::text,r.supplier_credit_id,
  l.id AS line_id,l.sku_id,l.quantity::text,l.movement_ids FROM supplier_returns r
  LEFT JOIN supplier_return_lines l ON l.workspace_id=r.workspace_id AND l.supplier_return_id=r.id
  WHERE r.workspace_id=$1 AND r.supplier_bill_id=ANY($2::text[]) AND r.status<>'CANCELLED' ORDER BY r.id,l.id`,[ctx.workspaceId,ids])).rows;
 const credits=(await db.query(`SELECT c.id,c.supplier_bill_id,c.supplier_id,c.amount_minor::text,c.credit_date::text,c.journal_entry_id,c.source_key,
  j.status AS journal_status,lines.currency,lines.currency_count,j.source_type,j.source_record_type,j.source_record_id,j.metadata::jsonb AS metadata,
  EXISTS(SELECT 1 FROM accounting_journal_entries reversed WHERE reversed.workspace_id=c.workspace_id AND reversed.reversal_of_entry_id=c.journal_entry_id AND reversed.status='POSTED') AS reversed
  FROM accounting_supplier_credits c LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
  LEFT JOIN LATERAL(SELECT min(currency) AS currency,count(DISTINCT currency)::int AS currency_count FROM accounting_journal_lines l WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id) lines ON true
  WHERE c.workspace_id=$1 AND c.supplier_bill_id=ANY($2::text[]) ORDER BY c.id`,[ctx.workspaceId,ids])).rows;
 const selected=new Set(p.scope.products.map(product=>product.skuId)),result=new Map(),returnsByBill=group(returns,'supplier_bill_id'),creditsByBill=group(credits,'supplier_bill_id');
 for(const bill of affected){
  const billReturns=returnsByBill.get(bill.id)||[],billCredits=creditsByBill.get(bill.id)||[],returnsById=group(billReturns,'id'),creditsById=group(billCredits,'id'),sourceSkus=new Set(bill.source_skus||[]),reasons=[],seen=new Set();let net=0n,units=0n;
  for(const [id,lines] of returnsById){
   const r=lines[0],matches=creditsById.get(r.supplier_credit_id)||[],credit=matches[0],meta=credit?.metadata||{},amount=exact(credit?.amount_minor),tax=exact(meta.taxCreditMinor),actual=exact(r.actual_credit_minor);
   if(r.status!=='RECONCILED'||r.supplier_id!==p.supplier_id||matches.length!==1||seen.has(credit?.id)||!credit||credit.supplier_id!==p.supplier_id||credit.journal_status!=='POSTED'||credit.reversed||credit.currency_count!==1||credit.currency!==p.currency||credit.credit_date>today||credit.source_type!=='supplier_credit'||credit.source_record_type!=='supplier_return'||credit.source_record_id!==id||credit.source_key!=='supplier-return:'+id||meta.supplierReturnId!==id||meta.supplierBillId!==bill.id||amount===null||actual!==amount||exact(meta.amountMinor)!==amount||tax===null||tax>amount){reasons.push('A supplier return or its posted credit still needs reconciliation');continue;}
   seen.add(credit.id);const eligible=lines.filter(line=>p.scope.allProducts||selected.has(line.sku_id));
   if(lines.some(line=>!line.line_id||!line.sku_id||!sourceSkus.has(line.sku_id)||scaled(line.quantity)===null||scaled(line.quantity)<=0n)){reasons.push('A reconciled return needs its exact original product quantities checked');continue;}
   if(eligible.length&&eligible.length!==lines.length){reasons.push('A mixed-product return needs the supplier credit allocated to this agreement’s exact products');continue;}
   if(eligible.length){net+=amount-tax;for(const line of eligible)units+=scaled(line.quantity);}
  }
  if(billCredits.some(credit=>!seen.has(credit.id)))reasons.push('A supplier credit needs its purchase adjustment or rebate recovery classified');
  if(net>BigInt(bill.net_minor)||units>(scaled(bill.quantity)??-1n))reasons.push('Returned purchases exceed the original eligible invoice amount or stock quantity');
  result.set(bill.id,{netMinor:net.toString(),quantityScaled:units.toString(),reasons:[...new Set(reasons)],sourceFingerprint:hash({returns:billReturns,credits:billCredits})});
 }
 return result;
}
module.exports={adjustments};
