'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),facts=require('../../src/connections/commerce-facts'),calculator=require('../../src/pricing/calculator'),shopify=require('../../src/connections/providers/shopify'),woo=require('../../src/connections/providers/woocommerce');
const at='2026-10-18T12:00:00.000Z';
function quote(f){return calculator.quote({...f,at,lines:f.lines.map(l=>({...l,skuId:'sku-'+l.externalSku})),rules:[]});}
test('Shopify webhook money retains currency exponent, actual discounts, shipping and tax',()=>{
 const raw={id:41,currency:'USD',total_price:'20.84',total_discounts:'4.00',total_tax:'1.84',updated_at:at,
  line_items:[{id:61,variant_id:71,quantity:2,price:'10.00',discount_allocations:[{amount:'4.00'}],tax_lines:[{price:'1.60'}]}],
  shipping_lines:[{id:81,title:'Carrier shipping',price:'3.00',tax_lines:[{price:'0.24'}]}]};
 const f=shopify.normalizeWebhook({headers:{'x-shopify-topic':'orders/create','x-shopify-webhook-id':'delivery-A'},body:raw})[0],q=quote(f.data);
 assert.equal(q.totalMinor,2084);assert.equal(q.discountMinor,400);assert.equal(q.taxMinor,184);assert.equal(q.chargesMinor,300);assert.equal(q.lines[0].chargeTaxMinor,24);
 const again=shopify.normalizeWebhook({headers:{'x-shopify-topic':'orders/create','x-shopify-webhook-id':'delivery-B'},body:raw})[0];assert.equal(f.effectKey,again.effectKey);assert.notEqual(f.eventId,again.eventId);
 const jpy=facts.shopify({currency:'JPY',line_items:[{id:1,variant_id:1,quantity:1,price:'123'}],total_price:'123'});assert.equal(quote(jpy).totalMinor,123);
});
test('inclusive source tax is separated once and inconsistent provider totals fail closed',()=>{
 const f=facts.shopify({currency:'EUR',taxes_included:true,total_price:'120',total_tax:'20',line_items:[{id:1,variant_id:1,quantity:1,price:'120',tax_lines:[{price:'20'}]}]});
 assert.equal(quote(f).lines[0].netMinor,10000);assert.equal(quote(f).totalMinor,12000);
 assert.throws(()=>facts.shopify({currency:'USD',total_price:'2',line_items:[{id:1,quantity:1,price:'1'}]}),/reconcile/);
});
test('Woo zero price stays zero and exact extended amounts survive fractional unit display prices',()=>{
 const zero=woo.normalizeWebhook({headers:{'x-wc-webhook-topic':'order.created','x-wc-webhook-delivery-id':'free-delivery'},connection:{config:{storeUrl:'https://store.example.test'}},body:{id:1,currency:'USD',status:'pending',line_items:[{id:2,product_id:3,quantity:1,price:0}]}})[0];
 assert.equal(zero.data.lines[0].unitPriceMinor,0);assert.equal(quote(zero.data).totalMinor,0);
 const thirds=facts.woocommerce({currency:'USD',total:'1.00',line_items:[{id:4,product_id:3,quantity:3,price:'0.333333',subtotal:'1.00',total:'1.00',total_tax:'0'}]});
 assert.equal(thirds.lines[0].unitPriceMinor,33);assert.equal(quote(thirds).totalMinor,100);
 const discounted=facts.woocommerce({currency:'BHD',total:'1.357',discount_total:'0.100',total_tax:'0.057',shipping_total:'0.200',shipping_tax:'0.007',line_items:[{id:1,product_id:3,quantity:1,subtotal:'1.200',total:'1.100',total_tax:'0.050'}]});assert.equal(quote(discounted).totalMinor,1357);
 assert.throws(()=>facts.woocommerce({currency:'USD',line_items:[{id:1,quantity:1}]}),/missing/);
});
test('distinct same-SKU lines, discounts and tax remain distinct in canonical pricing',()=>{
 const f=facts.woocommerce({currency:'USD',total:'29.00',line_items:[{id:1,product_id:3,quantity:1,subtotal:'10',total:'9',total_tax:'1'},{id:2,product_id:3,quantity:2,subtotal:'20',total:'18',total_tax:'1'}]});
 const q=quote(f);assert.equal(q.lines.length,2);assert.deepEqual(q.lines.map(l=>l.externalLineId),['1','2']);assert.deepEqual(q.lines.map(l=>l.discountMinor),[100,200]);assert.equal(q.totalMinor,2900);
});
test('refund cancellation, no-restock and financial-only refunds never become physical receipts',()=>{
 for(const restock_type of ['cancel','no_restock','return']){
  const out=shopify.normalizeWebhook({headers:{'x-shopify-topic':'refunds/create','x-shopify-webhook-id':restock_type},body:{id:1,order_id:2,refund_line_items:[{id:3,restock_type,quantity:1,line_item:{id:4,variant_id:5}}]}});
  assert.equal(out[0].type,'return.reported');assert.equal(out[0].data.restockType,restock_type);
 }
 assert.equal(shopify.normalizeWebhook({headers:{'x-shopify-topic':'refunds/create'},body:{id:9,refund_line_items:[]}})[0].type,'return.reported');
});
test('recorded amounts cannot be repriced or escape existing margin guards',()=>{
 const f=facts.woocommerce({currency:'USD',total:'8',line_items:[{id:1,product_id:1,quantity:1,subtotal:'10',total:'8'}]});
 const base={...f,at,lines:f.lines.map(l=>({...l,skuId:'sku',costUnitMinor:900})),rules:[{id:'guard',version:1,kind:'guard',name:'Minimum margin',currency:'USD',minimumMarginBps:1000}]};
 assert.equal(calculator.quote(base).violations[0].kind,'minimum_margin');
 assert.throws(()=>calculator.quote({...base,discountMinor:0}),/allocations/);
 const negative=quote(facts.woocommerce({currency:'USD',total:'7',line_items:[{id:1,product_id:1,quantity:1,subtotal:'10',total:'8'}],fee_lines:[{id:2,name:'Order credit',total:'-1',total_tax:'0'}]}));assert.equal(negative.totalMinor,700);assert.equal(negative.chargesMinor,-100);
});
test('every partial economic amount stays non-negative while gross, discounts, charge credits and taxes conserve exact totals',()=>{
 // Independent floor(gross*q/Q)-floor(discount*q/Q) can be negative.
 assert.equal(calculator.portion(3,5,2,1)-calculator.portion(2,5,2,1),-1);
 for(let n=1;n<=1000;n++){
  const quantity=n%19+1,gross=n%29,discount=Math.min(gross,n%23),net=gross-discount,charges=n%2?0-(n%(net+1)):n%13,tax=n%17,chargeTax=Math.min(tax,n%7),snapshot={grossMinor:gross,discountMinor:discount,chargesMinor:charges,taxMinor:tax,chargeTaxMinor:chargeTax};
  const parts=Array.from({length:quantity},(_,before)=>calculator.monetaryPortion(snapshot,quantity,before,1));
  for(const p of parts){for(const key of ['grossMinor','discountMinor','taxMinor','goodsTaxMinor','revenueMinor','totalMinor'])assert(p[key]>=0);assert.equal(p.grossMinor-p.discountMinor+p.chargesMinor,p.revenueMinor);assert.equal(p.goodsTaxMinor+p.chargeTaxMinor,p.taxMinor);}
  for(const [key,total]of Object.entries({...snapshot,revenueMinor:net+charges,totalMinor:net+charges+tax}))assert.equal(parts.reduce((a,p)=>a+p[key],0),total,key);
 }
});
