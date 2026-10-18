'use strict';
const prices=require('./postgres-service');
function describe(rule,options){const products=new Map(options.products.map(p=>[p.id,p.name+' · '+p.code])),customers=new Map(options.customers.map(c=>[c.id,c.name]));
 const rows=[['Name',rule.name],['Type',rule.kind.replaceAll('_',' ')],['Currency',rule.currency],['Status',rule.enabled===false?'Disabled':'Enabled'],['Priority',String(rule.priority||0)],['Customers',rule.scope?.customerIds?.length?rule.scope.customerIds.map(id=>customers.get(id)||id).join(', '):'All customers'],['Products',rule.scope?.skuIds?.length?rule.scope.skuIds.map(id=>products.get(id)||id).join(', '):'All eligible products'],['Categories',rule.scope?.categoryIds?.join(', ')||'All categories']];
 if(rule.startsAt)rows.push(['Starts',rule.startsAt]);if(rule.endsAt)rows.push(['Ends',rule.endsAt]);
 if(rule.entries)for(const e of rule.entries)rows.push([products.get(e.skuId)||e.skuId,`${e.minQuantity}+ units: ${prices.formatMinor(e.unitPriceMinor,rule.currency)} each`]);
 if(rule.discount){rows.push(['Discount',rule.discount.type==='percent'?`${rule.discount.value/100}%`:prices.formatMinor(rule.discount.value,rule.currency)+' · '+rule.discount.type.replaceAll('_',' ')]);rows.push(['Combination',rule.stacking||'exclusive']);if(rule.code)rows.push(['Code',rule.code]);if(rule.stackGroup)rows.push(['Only one from group',rule.stackGroup]);if(rule.excludes?.length)rows.push(['Excluded rules',rule.excludes.join(', ')]);}
 for(const[key,label]of [['minimumQuantity','Minimum units per line'],['minimumOrderMinor','Minimum order'],['maxRedemptions','Total uses'],['maxPerCustomer','Uses per customer'],['minimumMarginBps','Minimum gross margin'],['maximumDiscountBps','Maximum discount']])if(rule[key]!==undefined)rows.push([label,key==='minimumOrderMinor'?prices.formatMinor(rule[key],rule.currency):key.endsWith('Bps')?`${rule[key]/100}%`:String(rule[key])]);
 for(const item of rule.discount?.items||[])rows.push(['Bundle product',(products.get(item.skuId)||item.skuId)+' × '+item.quantity]);return rows;
}
module.exports={describe};
