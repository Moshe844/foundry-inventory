'use strict';
const {ValidationError}=require('../domain/errors'),money=require('../domain/currency'),exact=require('../domain/exact-quantity');
const fx=require('./fx-reference'),{hash}=require('../pricing/postgres-promotions');
function compare(a,b){const d=exact.subtract(String(a),String(b));return d==='0'?0:d.startsWith('-')?-1:1;}
function percent(value,{recoverable=false}={}){const text=exact.canonical(value),[whole,fraction='']=text.split('.');if(recoverable&&compare(text,'100')>0)throw new ValidationError('Recoverable tax must be between 0 and 100 percent.');return {text,n:BigInt(whole+fraction),d:100n*10n**BigInt(fraction.length)};}
function rounded(n,d){const value=Number((n*2n+d)/(d*2n));if(!Number.isSafeInteger(value)||value<0)throw new ValidationError('The supplier comparison exceeds the exact monetary range.');return value;}
function taxParts(amount,value,basis){amount=money.integer(amount);const rate=percent(value);if(!['net','gross'].includes(basis))throw new ValidationError('Confirm whether the recorded price includes tax.');const tax=rounded(BigInt(amount)*rate.n,basis==='gross'?rate.d+rate.n:rate.d);return {net:basis==='gross'?amount-tax:amount,tax,gross:basis==='gross'?amount:money.sum([amount,tax])};}
function offerFingerprint(o){return hash([o.id,o.supplier_id,o.sku_id,o.currency,String(o.last_unit_cost),String(o.units_per_purchase_unit),o.purchase_unit,String(o.minimum_order_quantity),String(o.order_multiple),o.minimum_order_amount,o.payment_terms,o.freight_terms_currency,o.free_freight_threshold_minor,o.ordinary_freight_minor]);}
function current(row,{today,ownerAccountId},label){if(!row||row.confirmed_owner_account_id!==ownerAccountId||!row.source_reference||row.valid_from>today||row.valid_until<today)throw new ValidationError('Record current owner-checked '+label+' with its original source and validity before comparing suppliers.');}
function convert(minor,currency,target,rate,context){
 if(currency===target)return {minor:money.integer(minor),rate:null};current(rate,context,'exchange-rate evidence');const r=fx.decimal(rate.comparison_per_foreign),inverse=rate.foreign_currency===target&&rate.comparison_currency===currency;
 if(!inverse&&(rate.foreign_currency!==currency||rate.comparison_currency!==target))throw new ValidationError('The checked exchange rate does not cover this supplier comparison.');
 const value=rounded(BigInt(money.integer(minor))*(inverse?r.d:r.n)*10n**BigInt(money.exponent(target)),(inverse?r.n:r.d)*10n**BigInt(money.exponent(currency)));
 return {minor:value,rate:{foreign:rate.foreign_currency,comparison:rate.comparison_currency,comparisonPerForeign:rate.comparison_per_foreign,inverse,source:rate.source_reference,validFrom:rate.valid_from,validUntil:rate.valid_until,revision:rate.revision}};
}
function calculate(offer,quote,term,target,rate,context){
 current(term,context,'delivery and tax terms');if(term.offer_fingerprint!==offerFingerprint(offer))throw new ValidationError('Supplier prices, packs, minimums, payment or freight terms changed. Check the original delivery and tax evidence again.');
 if(compare(quote.quantity,term.minimum_quantity)<0||compare(quote.quantity,term.maximum_quantity)>0)throw new ValidationError('The purchase quantity is outside the checked delivery and tax quote range.');
 if(quote.secondaryQuantity!=null&&(term.minimum_secondary_quantity==null||term.maximum_secondary_quantity==null||compare(quote.secondaryQuantity,term.minimum_secondary_quantity)<0||compare(quote.secondaryQuantity,term.maximum_secondary_quantity)>0))throw new ValidationError('The independent requested weight is outside the checked delivery and tax quote range.');
 const goods=taxParts(quote.totalMinor,term.goods_tax_percent,term.goods_price_basis);let freight;
 if(term.freight_mode==='included')freight=0;
 else if(term.freight_mode==='fixed'&&term.fixed_freight_minor!=null)freight=money.integer(term.fixed_freight_minor);
 else if(term.freight_mode==='saved'){
  if(offer.freight_terms_currency!==offer.currency||offer.ordinary_freight_minor==null||!['net_goods','recorded_goods'].includes(term.freight_threshold_basis))throw new ValidationError('Confirm applicable saved shipping charges, currency and the free-shipping threshold basis.');
  const threshold=offer.free_freight_threshold_minor,base=term.freight_threshold_basis==='net_goods'?goods.net:quote.totalMinor;freight=threshold!=null&&base>=money.integer(threshold)?0:money.integer(offer.ordinary_freight_minor);
 }else throw new ValidationError('Confirm the applicable delivery charge; missing freight is never zero.');
 if(term.other_charges_minor==null)throw new ValidationError('Confirm all other nonrecoverable delivery, duty and handling costs, including an explicit zero when none apply.');
 const delivery=taxParts(freight,term.freight_tax_percent,term.freight_price_basis),goodsRecovery=percent(term.goods_recoverable_tax_percent,{recoverable:true}),freightRecovery=percent(term.freight_recoverable_tax_percent,{recoverable:true}),recoverable=money.sum([rounded(BigInt(goods.tax)*goodsRecovery.n,goodsRecovery.d),rounded(BigInt(delivery.tax)*freightRecovery.n,freightRecovery.d)]),payable=money.sum([goods.gross,delivery.gross,money.integer(term.other_charges_minor)]),economic=payable-recoverable,converted=convert(economic,offer.currency,target,rate,context);
 return {currency:offer.currency,recordedGoodsMinor:quote.totalMinor,netGoodsMinor:goods.net,goodsTaxMinor:goods.tax,freightMinor:freight,freightTaxMinor:delivery.tax,otherChargesMinor:money.integer(term.other_charges_minor),recoverableTaxMinor:recoverable,payableMinor:payable,economicMinor:economic,comparisonCurrency:target,comparisonMinor:converted.minor,rate:converted.rate,source:term.source_reference,validFrom:term.valid_from,validUntil:term.valid_until,revision:term.revision};
}
module.exports={compare,percent,taxParts,offerFingerprint,current,convert,calculate};
