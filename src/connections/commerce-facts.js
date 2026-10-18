'use strict';
// This is an import contract, not a second pricing engine. Preserve provider
// facts; the canonical quote engine owns allocations, posting and refunds.
const money=require('../domain/currency');
const {ValidationError}=require('../domain/errors');
const {createHash}=require('node:crypto');
function canonical(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';}
function hash(value){return createHash('sha256').update(canonical(value)).digest('hex');}
function effectKey(provider,...identity){if(identity.some(v=>v===null||v===undefined||v===''))throw new ValidationError('The provider event is missing a durable business identity.');return provider+':'+hash(identity);}
function minor(value,currency,optional=false){return money.toMinor(value,currency,{optional});}
function sum(values){return money.sum(values);}
function count(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new ValidationError('The provider quantity must be a positive whole number.');return n;}
function unitFromGross(gross,quantity){const q=BigInt(count(quantity)),n=BigInt(money.integer(gross));return Number((n+q/2n)/q);}
function order({currency,lines,charges=[],totalMinor=null,sourceDiscountMinor=null,taxesIncluded=false}){
 currency=money.code(currency);
 if(!Array.isArray(lines)||!lines.length)throw new ValidationError('The provider order needs at least one supported line.');
 const ids=new Set();
 for(const line of lines){
  line.quantity=count(line.quantity);money.integer(line.unitPriceMinor,'Provider unit price');
  for(const f of ['grossMinor','discountMinor','taxMinor'])line[f]=money.integer(line[f]??0,'Provider '+f);
  if(line.discountMinor>line.grossMinor)throw new ValidationError('A provider discount exceeds its line value.');
  if(line.externalLineId){if(ids.has(line.externalLineId))throw new ValidationError('A provider order repeats an external line identity.');ids.add(line.externalLineId);}
 }
 for(const c of charges){c.amountMinor=money.integer(c.amountMinor,'Provider charge',{signed:true});c.taxMinor=money.integer(c.taxMinor??0,'Provider charge tax');}
 const subtotalMinor=sum(lines.map(l=>l.grossMinor)),discountMinor=sum(lines.map(l=>l.discountMinor)),taxMinor=sum([...lines.map(l=>l.taxMinor),...charges.map(c=>c.taxMinor)]),chargesMinor=sum(charges.map(c=>c.amountMinor)),calculated=sum([subtotalMinor,-discountMinor,taxMinor,chargesMinor]);
 if(calculated<0)throw new ValidationError('The provider order has a negative payable amount.');
 if(totalMinor!==null&&money.integer(totalMinor,'Provider total')!==calculated)throw new ValidationError('The provider order total does not reconcile with its products, discounts, taxes and charges.');
 return {currency,lines,discountMinor,taxMinor,orderCharges:charges,recordedAmounts:true,sourceFinancials:{version:1,currency,taxesIncluded,subtotalMinor,discountMinor,sourceDiscountMinor,chargesMinor,taxMinor,totalMinor:calculated,lines:lines.map(l=>({...l})),charges}};
}
function shopify(body){
 const currency=money.code(body.currency),taxesIncluded=body.taxes_included===true;
 const lines=(body.line_items||[]).filter(l=>Number(l.quantity)>0).map((l,index)=>{
  const quantity=count(l.quantity),unitPriceMinor=minor(l.price,currency),taxMinor=sum((l.tax_lines||[]).map(t=>minor(t.price,currency))),discountMinor=l.discount_allocations?.length?sum(l.discount_allocations.map(d=>minor(d.amount,currency))):minor(l.total_discount??'0',currency),grossMinor=sum([Number(BigInt(unitPriceMinor)*BigInt(quantity)),taxesIncluded?-taxMinor:0]);
  money.integer(grossMinor,'Provider line gross');
  return {externalLineId:String(l.id??'variant:'+l.variant_id+':'+index),externalSku:l.variant_id?'gid://shopify/ProductVariant/'+l.variant_id:'gid://shopify/Product/'+l.product_id,skuCode:l.sku||undefined,quantity,unitPriceMinor,grossMinor,discountMinor,taxMinor};
 });
 const charges=(body.shipping_lines||[]).map(l=>{const taxMinor=sum((l.tax_lines||[]).map(t=>minor(t.price,currency))),gross=minor(l.price??'0',currency),net=minor(l.discounted_price??l.price??'0',currency);return {kind:'shipping',externalId:l.id==null?null:String(l.id),description:l.title||'Shipping',amountMinor:sum([net,taxesIncluded?-taxMinor:0]),taxMinor,discountMinor:gross-net};});
 if(body.total_tip_received!=null&&minor(body.total_tip_received,currency))charges.push({kind:'tip',amountMinor:minor(body.total_tip_received,currency),taxMinor:0});
 if(body.total_duties!=null&&minor(body.total_duties,currency))charges.push({kind:'duty',amountMinor:minor(body.total_duties,currency),taxMinor:0});
 const result=order({currency,lines,charges,totalMinor:minor(body.total_price,currency,true),sourceDiscountMinor:minor(body.total_discounts,currency,true),taxesIncluded});
 if(body.total_tax!=null&&minor(body.total_tax,currency)!==result.taxMinor)throw new ValidationError('The provider order tax does not reconcile with its line and shipping taxes.');
 return result;
}
function woocommerce(body){
 const currency=money.code(body.currency);
 const lines=(body.line_items||[]).filter(l=>Number(l.quantity)>0).map((l,index)=>{
  const quantity=count(l.quantity),fallback=l.subtotal==null?minor(l.price,currency,true):null,grossMinor=l.subtotal!=null?minor(l.subtotal,currency):fallback===null?null:Number(BigInt(fallback)*BigInt(quantity));
  if(grossMinor===null)throw new ValidationError('A provider line is missing its actual selling amount.');
  const net=l.total!=null?minor(l.total,currency):grossMinor,discountMinor=grossMinor-net,taxMinor=minor(l.total_tax??'0',currency);
  return {externalLineId:String(l.id??'product:'+(l.variation_id||l.product_id)+':'+index),externalSku:String(l.variation_id||l.product_id),skuCode:l.sku||undefined,quantity,unitPriceMinor:unitFromGross(grossMinor,quantity),grossMinor,discountMinor,taxMinor};
 });
 const charges=[];
 if(body.shipping_total!=null||body.shipping_tax!=null)charges.push({kind:'shipping',amountMinor:minor(body.shipping_total??'0',currency),taxMinor:minor(body.shipping_tax??'0',currency)});
 for(const fee of body.fee_lines||[])charges.push({kind:'fee',externalId:String(fee.id),description:fee.name,amountMinor:money.toMinor(fee.total,currency,{signed:true}),taxMinor:minor(fee.total_tax??'0',currency)});
 const result=order({currency,lines,charges,totalMinor:minor(body.total,currency,true),sourceDiscountMinor:minor(body.discount_total,currency,true),taxesIncluded:body.prices_include_tax===true});
 if(body.total_tax!=null&&minor(body.total_tax,currency)!==result.taxMinor)throw new ValidationError('The provider order tax does not reconcile with its line and shipping taxes.');
 return result;
}
function square(body){
 const currency=money.code(body.total_money?.currency);
 const amount=(value,label,{optional=false}={})=>{
  if(value==null&&optional)return 0;
  if(!value||value.currency!==currency)throw new ValidationError('The Square '+label+' currency is missing or inconsistent.');
  return money.integer(value.amount,'Square '+label);
 };
 const charges=(body.service_charges||[]).map(c=>{const total=amount(c.total_money,'service total'),tax=amount(c.total_tax_money,'service tax',{optional:true});return {kind:'fee',externalId:c.uid,description:c.name,amountMinor:total-tax,taxMinor:tax};});
 const lines=(body.line_items||[]).map(l=>{
  if(!l.uid||!l.catalog_object_id)throw new ValidationError('A Square order line needs a stable line and catalog identity before inventory can be posted.');
  const quantity=count(l.quantity),total=amount(l.total_money,'line total'),tax=amount(l.total_tax_money,'line tax',{optional:true}),discount=amount(l.total_discount_money,'line discount',{optional:true});
  // total_service_charge_money contains inclusive but not additive tax. Remove
  // its net and its separately applied tax from the product before allocating
  // all service charges once through canonical order charges.
  const service=amount(l.total_service_charge_money,'allocated service charge',{optional:true});
  if(service!==0)throw new ValidationError('Square apportioned service charges require explicit allocation reconciliation before posting this order.');
  const gross=sum([total,-tax,discount]);
  return {externalLineId:String(l.uid),externalSku:l.catalog_object_id,quantity,unitPriceMinor:unitFromGross(gross,quantity),grossMinor:gross,discountMinor:discount,taxMinor:tax};
 });
 const tip=amount(body.total_tip_money,'tip',{optional:true});if(tip)charges.push({kind:'tip',amountMinor:tip,taxMinor:0});
 const rounding=body.rounding_adjustment?.amount_money;if(rounding)charges.push({kind:'rounding',amountMinor:amount(rounding,'rounding'),taxMinor:0});
 const result=order({currency,lines,charges,totalMinor:amount(body.total_money,'order total')});
 if(body.total_tax_money&&amount(body.total_tax_money,'order tax')!==result.taxMinor)throw new ValidationError('Square order tax does not reconcile with line and service taxes.');
 if(body.total_discount_money&&amount(body.total_discount_money,'order discount')!==result.discountMinor)throw new ValidationError('Square order discounts do not reconcile with line allocations.');
 return result;
}
module.exports={canonical,hash,effectKey,minor,sum,count,order,shopify,woocommerce,square,unitFromGross};
