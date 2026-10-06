'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {settlement}=require('../../src/commercial/invoice-cash');
const invoice={status:'paid',total:1000,amount_paid:1000,amount_due:1000,starting_balance:0,total_taxes:[]};
test('cash settlement excludes verified tax and does not invent cash from credits',()=>{
 assert.equal(settlement({...invoice,total_taxes:[{amount:100}]},1000).netCashRevenueMinor,900);
 const credit=settlement({...invoice,amount_paid:700,amount_due:700,starting_balance:-300},700);
 assert.equal(credit.verified,true);assert.equal(credit.netCashRevenueMinor,700);assert.equal(credit.customerBalanceCreditMinor,300);
 const full=settlement({...invoice,amount_paid:0,amount_due:0,starting_balance:-1500},0);
 assert.equal(full.verified,true);assert.equal(full.netCashRevenueMinor,0);
 assert.equal(settlement({...invoice,amount_paid:800,amount_due:800,pre_payment_credit_notes_amount:200},800,
  {creditNotes:[{pre_payment_amount:200,total_taxes:[]}]}).verified,true);
 assert.equal(settlement({...invoice,amount_paid:0,amount_due:0,pre_payment_credit_notes_amount:1000},0,
  {creditNotes:[{pre_payment_amount:1000,total_taxes:[]}]}).verified,true);
});
test('unpaid, out-of-band, unproven credit note and invalid amounts remain unverified',()=>{
 for(const [patch,cash] of [[{status:'open',amount_paid:400},400],[{},900],
  [{total_taxes:[{amount:'100'}]},1000],[{amount_paid:null},0],[{amount_overpaid:100},1000],
  [{amount_paid:800,amount_due:1000,pre_payment_credit_notes_amount:200},800]]){
   const result=settlement({...invoice,...patch},cash);assert.equal(result.verified,false);assert.equal(result.netCashRevenueMinor,null);assert.ok(result.reasons.length);
 }
});
test('carried debit and overpayment are explicitly excluded from current-invoice revenue',()=>{
 const carried=settlement({...invoice,starting_balance:100,amount_due:1100,amount_paid:1100},1100);
 assert.equal(carried.verified,true);assert.equal(carried.netCashRevenueMinor,1000);
 assert.equal(carried.carriedDebitCollectionMinor,100);
 const overpaid=settlement({...invoice,amount_paid:1000,amount_overpaid:100},1100,
  {overpaymentEvidence:true});
 assert.equal(overpaid.verified,true);assert.equal(overpaid.netCashRevenueMinor,1000);
 assert.equal(overpaid.overpaymentLiabilityMinor,100);
 assert.equal(settlement({...invoice,amount_paid:1000,amount_overpaid:100},1100).verified,false);
 const taxCredit=settlement({...invoice,starting_balance:-300,amount_due:700,amount_paid:700,
   total_taxes:[{amount:100}]},700);
 assert.equal(taxCredit.verified,true);assert.equal(taxCredit.cashTaxMinor,70);
 assert.equal(taxCredit.netCashRevenueMinor,630);
 const note=settlement({...invoice,total_taxes:[{amount:100}],pre_payment_credit_notes_amount:220,
  amount_due:780,amount_paid:780},780,{creditNotes:[{pre_payment_amount:220,total_taxes:[{amount:20}]}]});
 assert.equal(note.verified,true);assert.equal(note.cashTaxMinor,80);assert.equal(note.netCashRevenueMinor,700);
 assert.equal(1100,carried.currentInvoiceCashMinor+carried.carriedDebitCollectionMinor+carried.overpaymentLiabilityMinor);
 assert.equal(1100,overpaid.currentInvoiceCashMinor+overpaid.carriedDebitCollectionMinor+overpaid.overpaymentLiabilityMinor);
});
