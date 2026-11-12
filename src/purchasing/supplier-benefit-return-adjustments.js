'use strict';
const {hash}=require('../pricing/postgres-promotions');
function scaled(value){const text=String(value),match=/^(\d+)(?:\.(\d{1,6}))?$/.exec(text);if(!match)return null;return BigInt(match[1])*1000000n+BigInt((match[2]||'').padEnd(6,'0'));}
function exact(value){const text=String(value??'');return /^\d+$/.test(text)?BigInt(text):null;}
function group(rows,key){const groups=new Map();for(const row of rows){const value=row[key];if(!groups.has(value))groups.set(value,[]);groups.get(value).push(row);}return groups;}
function returnCreditAmounts(credits, r, bill, program, today) {
  const total = { amount: 0n, tax: 0n };
  for (const credit of credits) {
    const meta = credit.metadata || {};
    const amount = exact(credit.amount_minor), tax = exact(meta.taxCreditMinor);
    const sourceMatches = credit.supplier_return_id === r.id
      ? credit.source_key === 'agent-supplier-credit:'+credit.approval_fingerprint
        && meta.originalBillId === bill.id && exact(credit.source_tax_minor) === tax
      : credit.source_key === 'supplier-return:'+r.id && credit.target_bill_id === bill.id;
    if (!sourceMatches || credit.supplier_id !== program.supplier_id || credit.journal_status !== 'POSTED'
        || credit.reversed || credit.currency_count !== 1 || credit.currency !== program.currency || credit.credit_date > today
        || credit.source_type !== 'supplier_credit' || credit.source_record_type !== 'supplier_return'
        || credit.source_record_id !== r.id || meta.supplierReturnId !== r.id || meta.supplierBillId !== credit.target_bill_id
        || amount === null || exact(meta.amountMinor) !== amount || tax === null || tax > amount) return null;
    total.amount += amount;
    total.tax += tax;
  }
  return total;
}

async function adjustments(db,ctx,p,rows,today){
 const affected=rows.filter(row=>row.credit_count||row.return_count);if(!affected.length)return new Map();const ids=affected.map(row=>row.id);
 const returns=(await db.query(`SELECT r.id,r.supplier_bill_id,r.supplier_id,r.status,r.actual_credit_minor::text,r.supplier_credit_id,
  l.id AS line_id,l.sku_id,l.quantity::text,l.movement_ids FROM supplier_returns r
  LEFT JOIN supplier_return_lines l ON l.workspace_id=r.workspace_id AND l.supplier_return_id=r.id
  WHERE r.workspace_id=$1 AND r.supplier_bill_id=ANY($2::text[]) AND r.status<>'CANCELLED' ORDER BY r.id,l.id`,[ctx.workspaceId,ids])).rows;
 const credits=(await db.query(`SELECT c.id,coalesce(a.evidence->>'originalBillId',c.supplier_bill_id) AS supplier_bill_id,c.supplier_bill_id AS target_bill_id,
  c.supplier_id,c.amount_minor::text,c.credit_date::text,c.journal_entry_id,c.source_key,
  a.supplier_return_id,a.approval_fingerprint,a.tax_minor::text AS source_tax_minor,j.status AS journal_status,
  EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_benefit_claim_credits rebate WHERE rebate.credit_id=c.id) AS rebate_recovery,lines.currency,lines.currency_count,j.source_type,j.source_record_type,j.source_record_id,j.metadata::jsonb AS metadata,
  EXISTS(SELECT 1 FROM accounting_journal_entries reversed WHERE reversed.workspace_id=c.workspace_id AND reversed.reversal_of_entry_id=c.journal_entry_id AND reversed.status='POSTED') AS reversed
  FROM accounting_supplier_credits c LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
  LEFT JOIN stockchief_runtime.agent_supplier_credit_applications a ON a.workspace_id=c.workspace_id AND a.credit_id=c.id
  LEFT JOIN LATERAL(SELECT min(currency) AS currency,count(DISTINCT currency)::int AS currency_count FROM accounting_journal_lines l WHERE l.workspace_id=c.workspace_id AND l.entry_id=c.journal_entry_id) lines ON true
  WHERE c.workspace_id=$1 AND coalesce(a.evidence->>'originalBillId',c.supplier_bill_id)=ANY($2::text[]) ORDER BY c.id`,[ctx.workspaceId,ids])).rows;
 const selected=new Set(p.scope.products.map(product=>product.skuId)),result=new Map(),returnsByBill=group(returns,'supplier_bill_id'),creditsByBill=group(credits,'supplier_bill_id');
 for(const bill of affected){
  const billReturns=returnsByBill.get(bill.id)||[],billCredits=creditsByBill.get(bill.id)||[],returnsById=group(billReturns,'id'),creditsById=group(billCredits,'id'),creditsByReturn=group(billCredits,'supplier_return_id'),sourceSkus=new Set(bill.source_skus||[]),reasons=[],seen=new Set();let net=0n,units=0n;
  for(const [id,lines] of returnsById){
   const r=lines[0],sourced=creditsByReturn.get(id)||[],matches=sourced.length?sourced:(creditsById.get(r.supplier_credit_id)||[]);
   const posted=returnCreditAmounts(matches,r,bill,p,today);
   if(r.status!=='RECONCILED'||r.supplier_id!==p.supplier_id||!matches.some(credit=>credit.id===r.supplier_credit_id)
       ||matches.some(credit=>seen.has(credit.id))||!posted||exact(r.actual_credit_minor)!==posted.amount){
     reasons.push('A supplier return or its posted credit still needs reconciliation');continue;
   }
   for(const credit of matches)seen.add(credit.id);
   const eligible=lines.filter(line=>p.scope.allProducts||selected.has(line.sku_id));
   if(lines.some(line=>!line.line_id||!line.sku_id||!sourceSkus.has(line.sku_id)||scaled(line.quantity)===null||scaled(line.quantity)<=0n)){reasons.push('A reconciled return needs its exact original product quantities checked');continue;}
   if(eligible.length&&eligible.length!==lines.length){reasons.push('A mixed-product return needs the supplier credit allocated to this agreement’s exact products');continue;}
   if(eligible.length){net+=posted.amount-posted.tax;for(const line of eligible)units+=scaled(line.quantity);}
  }
  // Job 97: a credit matched to a rebate claim is the rebate being paid, not a
  // change to what was bought, so it neither reduces nor holds eligible spend.
  for(const credit of billCredits)if(credit.rebate_recovery)seen.add(credit.id);
  if(billCredits.some(credit=>!seen.has(credit.id)))reasons.push('A supplier credit needs its purchase adjustment or rebate recovery classified');
  if(net>BigInt(bill.net_minor)||units>(scaled(bill.quantity)??-1n))reasons.push('Returned purchases exceed the original eligible invoice amount or stock quantity');
  result.set(bill.id,{netMinor:net.toString(),quantityScaled:units.toString(),reasons:[...new Set(reasons)],sourceFingerprint:hash({returns:billReturns,credits:billCredits})});
 }
 return result;
}
module.exports={adjustments};
