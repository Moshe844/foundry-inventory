'use strict';

const money=require('../domain/currency');

function assess(orders,lines,charges,vendor){
  const currency=orders[0].currency;
  const siteIds=new Set(lines.map(line=>line.destination_location_id));
  const site=siteIds.size===1?[...siteIds][0]:null;
  const recorded=charges.map(({kind,label,amount_minor,source})=>({kind,label,amountMinor:money.integer(amount_minor),source}));
  const ordinary=vendor.ordinary_freight_minor,threshold=vendor.free_freight_threshold_minor;
  const unproven={site,charges:recorded,before:null,after:null,saving:null};
  if(!site||vendor.freight_terms_currency!==currency||ordinary==null||charges.some(c=>c.kind==='tax'))return unproven;
  const cost=goods=>threshold!=null&&goods>=money.integer(threshold)?0:money.integer(ordinary);
  const subtotal=order=>money.sum(lines.filter(line=>line.purchase_order_id===order.id).map(line=>money.toMinor(String(line.line_total),currency)));
  const subtotals=orders.map(subtotal);
  const separate=orders.map((order,index)=>{
    const saved=charges.filter(c=>c.purchase_order_id===order.id&&c.kind==='freight');
    const expected=cost(subtotals[index]);
    return saved.length&&money.sum(saved.map(c=>money.integer(c.amount_minor)))!==expected?null:expected;
  });
  if(separate.some(amount=>amount===null))return unproven;
  const before=money.sum(separate),after=cost(money.sum(subtotals)),saving=before-after;
  if(saving<=0)return {...unproven,before,after,saving};
  const replacements=recorded.filter(c=>c.kind!=='freight');
  if(after)replacements.push({kind:'freight',label:'Supplier freight',amountMinor:after,source:'saved-supplier-terms'});
  return {site,charges:replacements,before,after,saving};
}

module.exports={assess};
