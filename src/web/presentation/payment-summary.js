'use strict';

// Existing presenters expose net invoiced/retained amounts after posted return
// credits. Show their original values alongside the separate credit/refund so
// the owner can read the full payment history without changing the books.
function present(money={}){
 const credit=Number(money.creditedMinor||0),refunded=Number(money.refundedMinor||0),netPaid=Number(money.paidMinor||0),balance=Number(money.outstandingMinor||0),netInvoiced=Number(money.totalMinor||0);
 const state=refunded>0?(netPaid===0&&balance===0?'Refunded':'Partly refunded'):credit>0&&netInvoiced===0?'Credited':balance===0&&money.invoiced?'Paid':netPaid>0?'Partly paid':'Unpaid';
 return {state,rows:[{label:'Invoiced',amountMinor:money.invoiced?netInvoiced+credit:0},{label:'Paid',amountMinor:netPaid+refunded},...(credit?[{label:'Credited',amountMinor:credit}]:[]),{label:'Refunded',amountMinor:refunded},{label:'Balance',amountMinor:balance}]};
}
module.exports={present};
