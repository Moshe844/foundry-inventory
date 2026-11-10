'use strict';
// What an order comes to. One definition, so the order page, deposits and
// overpayment refunds can never disagree about it.
function orderTotalMinor(order,lines){
  if(order.pricing_total_minor!==null&&order.pricing_total_minor!==undefined)return Number(order.pricing_total_minor);
  return Math.max(0,lines.reduce((sum,row)=>sum+Number(row.quantity_ordered)*Number(row.unit_price_minor),0)
    -Number(order.discount_minor||0)+Number(order.tax_minor||0));
}
module.exports={orderTotalMinor};
