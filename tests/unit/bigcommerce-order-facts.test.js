'use strict';const test=require('node:test'),assert=require('node:assert/strict'),adapter=require('../../src/connections/providers/bigcommerce');
const order={default_currency_code:'USD',currency_code:'EUR',total_inc_tax:'21.00',total_tax:'1.50',shipping_cost_ex_tax:'2.00',shipping_cost_tax:'0.00'};
const lines=[{id:2,product_id:4,variant_id:8,quantity:2,price_ex_tax:'10.00',total_ex_tax:'20.00',total_tax:'1.50',discounted_total_inc_tax:'19.00',type:'physical',sku:'CODE-8'}];
test('BigCommerce preserves transactional currency, final discounted amounts, tax and shipping exactly once',()=>{const f=adapter.orderFacts(order,lines);assert.equal(f.currency,'USD');assert.equal(f.sourceFinancials.totalMinor,2100);assert.equal(f.discountMinor,250);assert.equal(f.taxMinor,150);assert.equal(f.lines[0].externalLineId,'2');assert.equal(f.lines[0].externalSku,'8');});
test('BigCommerce zero prices are real and incomplete financial evidence never invents a discount',()=>{const z={...lines[0],price_ex_tax:'0',total_ex_tax:'0',total_tax:'0',discounted_total_inc_tax:'0'};assert.equal(adapter.orderFacts({...order,total_inc_tax:'0',total_tax:'0',shipping_cost_ex_tax:'0'},[z]).lines[0].unitPriceMinor,0);const incomplete={...lines[0]};delete incomplete.discounted_total_inc_tax;assert.throws(()=>adapter.orderFacts(order,[incomplete]),/discounted/);assert.throws(()=>adapter.orderFacts({...order,total_inc_tax:'900'},lines),/reconcile/);});
test('BigCommerce missing variants and mixed nonstock lines require review rather than disappearing from totals',()=>{assert.throws(()=>adapter.orderFacts(order,[{...lines[0],variant_id:null}]),/variant/);assert.throws(()=>adapter.orderFacts(order,[{...lines[0],type:'giftcertificate'}]),/physical/);});

test('unfinished BigCommerce checkouts do not become sales; completion and cancellation still normalize',async t=>{
 const credentials={storeHash:'fixture7',accessToken:'test-only-token'},body={producer:'stores/fixture7',scope:'store/order/created',hash:'checkout',created_at:1795715452,data:{id:100}};
 let status=0,paths=[];
 t.mock.method(global,'fetch',async url=>{const path=new URL(url).pathname;paths.push(path);
  const data=path.endsWith('/products')?lines:path.endsWith('/shipping_addresses')?[]:{...order,id:100,status_id:status,date_modified:'2026-11-26T17:50:52Z'};
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 });
 for(const unfinished of [0,1]){status=unfinished;paths=[];assert.deepEqual(await adapter.normalizeWebhook({body,credentials}),[]);assert.equal(paths.length,1,'unfinished checkout does not hydrate sale lines or addresses');}
 status=11;const completed=await adapter.normalizeWebhook({body:{...body,scope:'store/order/statusUpdated',hash:'completed'},credentials});
 assert.equal(completed.length,1);assert.equal(completed[0].type,'sales_order.snapshot');assert.equal(completed[0].data.sourceFinancials.totalMinor,2100);
 status=5;const cancelled=await adapter.normalizeWebhook({body:{...body,scope:'store/order/statusUpdated',hash:'cancelled'},credentials});assert.deepEqual(cancelled.map(e=>e.type),['sales_order.snapshot','sales_order.cancelled']);
 for(const invalid of [undefined,null,'',15]){status=invalid;await assert.rejects(adapter.normalizeWebhook({body,credentials}),/order status/);}
});
