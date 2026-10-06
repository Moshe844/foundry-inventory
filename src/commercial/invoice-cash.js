'use strict';

// Cash-basis commercial contribution, not GAAP revenue recognition or a tax
// return. Customer credits are not new cash; carried debit collection belongs
// to a prior receivable and overpayment is a customer liability.
function settlement(invoice,cashMinor,{creditNotes=[],overpaymentEvidence=false}={}){
 const integer=value=>Number.isSafeInteger(value)&&value>=0;
 const total=invoice.total;const paid=invoice.amount_paid;
 const taxes=invoice.total_taxes||invoice.total_tax_amounts;
 const taxMinor=Array.isArray(taxes)?taxes.reduce((sum,row)=>integer(row.amount)?sum+row.amount:NaN,0):invoice.tax??0;
 const preCredit=invoice.pre_payment_credit_notes_amount??0;
 const starting=invoice.starting_balance??0;const due=invoice.amount_due??total;
 const overpaid=invoice.amount_overpaid??0;
 const reasons=[];
 if(invoice.status!=='paid')reasons.push('INVOICE_NOT_FULLY_PAID');
 if(![cashMinor,total,paid,taxMinor,preCredit,due,overpaid].every(integer)||!Number.isSafeInteger(starting))reasons.push('INVALID_SETTLEMENT_AMOUNTS');
 if(cashMinor!==paid+overpaid)reasons.push('NON_STRIPE_OR_UNVERIFIED_PAYMENT');
 if(overpaid>0&&!overpaymentEvidence)reasons.push('UNVERIFIED_OVERPAYMENT_LIABILITY');
 const balanceCredit=Math.min(total-preCredit,Math.max(0,-starting));
 const debit=Math.max(0,starting);const afterNote=total-preCredit;
 const currentInvoiceCash=cashMinor-debit-overpaid;
 if(preCredit>total||taxMinor>total||due!==Math.max(0,afterNote+starting)||
   cashMinor!==due+overpaid||currentInvoiceCash!==afterNote-balanceCredit)
  reasons.push('UNRECONCILED_INVOICE_CREDITS');
 const preNotes=creditNotes.filter(note=>note.status!=='void'&&(note.pre_payment_amount??0)>0);
 const noteTotal=preNotes.reduce((sum,note)=>sum+Number(note.pre_payment_amount),0);
 const noteTax=preNotes.reduce((sum,note)=>{
  const lines=note.total_taxes||note.tax_amounts||[];
  return sum+lines.reduce((part,row)=>part+Number(row.amount),0);
 },0);
 if(preCredit>0&&(noteTotal!==preCredit||!preNotes.every(note=>integer(note.pre_payment_amount)&&
   Array.isArray(note.total_taxes||note.tax_amounts||[])&&
   (note.total_taxes||note.tax_amounts).every(row=>integer(row.amount)))))
  reasons.push('UNVERIFIED_CREDIT_NOTE_TAX');
 if(!integer(noteTax)||noteTax>taxMinor||noteTax>preCredit)reasons.push('INVALID_CREDIT_NOTE_TAX');
 // Stripe credit-note tax rows are authoritative. Customer-balance credits
 // have no tax rows, so allocate remaining tax pro rata over the receivable.
 const remainingTax=taxMinor-noteTax;
 const cashTaxMinor=afterNote>0?Math.round(remainingTax*currentInvoiceCash/afterNote):0;
 const netCashRevenueMinor=currentInvoiceCash-cashTaxMinor;
 if(!integer(cashTaxMinor)||cashTaxMinor>currentInvoiceCash||!integer(netCashRevenueMinor))reasons.push('INVALID_CASH_TAX_ALLOCATION');
 return {verified:reasons.length===0,cashMinor,taxMinor,creditNoteTaxMinor:noteTax,
  cashTaxMinor:reasons.length?null:cashTaxMinor,customerBalanceCreditMinor:balanceCredit,
  prePaymentCreditMinor:preCredit,carriedDebitCollectionMinor:debit,
  overpaymentLiabilityMinor:overpaid,currentInvoiceCashMinor:reasons.length?null:currentInvoiceCash,
  netCashRevenueMinor:reasons.length?null:netCashRevenueMinor,reasons};
}
module.exports={settlement};
