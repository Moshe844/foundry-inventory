'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),square=require('../../src/connections/providers/square'),facts=require('../../src/connections/commerce-facts'),calculator=require('../../src/pricing/calculator');
function order(){return {id:'order-A',version:2,state:'COMPLETED',location_id:'location-A',total_money:{amount:2310,currency:'USD'},total_tax_money:{amount:210,currency:'USD'},total_discount_money:{amount:200,currency:'USD'},line_items:[{uid:'line-A',catalog_object_id:'variation-A',quantity:'2',total_money:{amount:1980,currency:'USD'},total_discount_money:{amount:200,currency:'USD'},total_tax_money:{amount:180,currency:'USD'}}],service_charges:[{uid:'shipping-A',name:'Shipping',total_money:{amount:330,currency:'USD'},total_tax_money:{amount:30,currency:'USD'}}]};}
test('Square reconciles actual paid totals rather than multiplying current item prices',()=>{
 const f=facts.square(order()),q=calculator.quote({...f,at:new Date().toISOString(),lines:f.lines.map(l=>({...l,skuId:l.externalSku})),rules:[]});
 assert.equal(q.totalMinor,2310);assert.equal(q.discountMinor,200);assert.equal(q.taxMinor,210);assert.equal(q.chargesMinor,300);
 const bad=order();bad.total_money.amount++;assert.throws(()=>facts.square(bad),/reconcile/);
});
test('multiple tenders and interleaved observations share order identity and never treat payment as handoff',async()=>{
 const payment=id=>({merchant_id:'merchant-A',event_id:'delivery-'+id,type:'payment.updated',created_at:'2026-10-18T12:00:00Z',data:{object:{payment:{id,status:'COMPLETED',order_id:'order-A',location_id:'location-A',amount_money:{amount:1155,currency:'USD'}},order:order()}}});
 const a=await square.normalizeWebhook({body:payment('tender-A'),credentials:{}}),b=await square.normalizeWebhook({body:payment('tender-B'),credentials:{}});
 assert.equal(a[0].effectKey,b[0].effectKey);assert.equal(a[1].effectKey,b[1].effectKey);assert.notEqual(a[2].effectKey,b[2].effectKey);assert.equal(a[2].type,'payment.reported');assert.equal(a[0].data.deliveryMethod,'PICKUP');
 const open=payment('tender-A');open.data.object.order.state='OPEN';assert(!(await square.normalizeWebhook({body:open,credentials:{}})).some(e=>e.type==='sales_order.fulfilled'));
 const pending=payment('tender-B');pending.data.object.order.fulfillments=[{type:'PICKUP',state:'PREPARED'}];assert(!(await square.normalizeWebhook({body:pending,credentials:{}})).some(e=>e.type==='sales_order.fulfilled'));
 const wrong=payment('tender-A');wrong.data.object.payment.order_id='another-order';await assert.rejects(()=>square.normalizeWebhook({body:wrong,credentials:{}}),/identities disagree/);
});
