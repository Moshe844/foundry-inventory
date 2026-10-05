'use strict';

// Cash-basis commercial reporting, not GAAP revenue recognition or a tax return.
// Unsupported settlements remain visibly unverified instead of inventing cash.
function settlement(invoice,cashMinor){
 const integer=value=>Number.isSafeInteger(value)&&value>=0;
 const total=invoice.total;const paid=invoice.amount_paid;
 const taxes=invoice.total_taxes||invoice.total_tax_amounts;
 const taxMinor=Array.isArray(taxes)?taxes.reduce((sum,row)=>integer(row.amount)?sum+row.amount:NaN,0):invoice.tax??0;
 const preCredit=invoice.pre_payment_credit_notes_amount??0;
 const starting=invoice.starting_balance??0;const due=invoice.amount_due??total;
 const reasons=[];
 if(invoice.status!=='paid')reasons.push('INVOICE_NOT_FULLY_PAID');
 if(![cashMinor,total,paid,taxMinor,preCredit,due].every(integer)||!Number.isSafeInteger(starting))reasons.push('INVALID_SETTLEMENT_AMOUNTS');
 if(cashMinor!==paid)reasons.push('NON_STRIPE_OR_UNVERIFIED_PAYMENT');
 if((invoice.amount_overpaid??0)!==0||starting>0)reasons.push('CARRIED_DEBIT_OR_OVERPAYMENT_REQUIRES_REVIEW');
 const balanceCredit=Math.min(total,Math.max(0,-starting));
 // Stripe already reduces amount_due by a pre-payment credit note. Do not
 // subtract that credit a second time from the amount actually collected.
 if(preCredit>total||due!==Math.max(0,total-balanceCredit-preCredit)||cashMinor!==due)reasons.push('UNRECONCILED_INVOICE_CREDITS');
 // Credits that change taxable consideration need line-level credit-note tax
 // evidence. Do not guess its allocation to cash or generate negative revenue.
 if(taxMinor>total||taxMinor>0&&(balanceCredit>0||preCredit>0))reasons.push('CREDIT_TAX_ALLOCATION_REQUIRES_REVIEW');
 return {verified:reasons.length===0,cashMinor,taxMinor,customerBalanceCreditMinor:balanceCredit,
   prePaymentCreditMinor:preCredit,netCashRevenueMinor:reasons.length?null:cashMinor-taxMinor,reasons};
}
module.exports={settlement};
