'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const spec=require('../../src/assistant/postgres-workflow-capabilities').SPECS.find(s=>s.name==='customer_payment.link');
const registry=require('../../src/payments');
const dummy=Object.fromEntries(registry.REQUIRED.map(name=>[name,async()=>({})]));
function database(providers){return {query:async sql=>{
 if(sql.includes('accounting_customer_invoices'))return {rows:[{id:'invoice-a',invoice_number:'INV-A',balance_minor:2375,currency:'USD'}]};
 if(sql.includes('payment_connect_accounts'))return {rows:providers.map(provider=>({provider}))};
 throw Error('Unexpected query');
}};}
test('payment-link preparation resolves registered provider identifiers independent of casing and surrounding whitespace',async t=>{
 const remove=registry.register('alternate_gateway',dummy);t.after(remove);
 for(const [supplied,expected] of [['Stripe','stripe'],[' sTrIpE ','stripe'],[' ALTERNATE_GATEWAY ','alternate_gateway']]){
  const result=await spec.build(database(['stripe','alternate_gateway']),{workspaceId:'workspace-a'},{id:'order-a',order_number:'SO-A'},{paymentPurpose:'full',paymentProvider:supplied});
  assert.equal(result.payload.provider,expected);assert.equal(result.payload.expectedAmountMinor,2375);assert.equal(result.payload.invoiceId,'invoice-a');
 }
});
test('provider selection preserves a unique default and refuses unknown or ambiguous gateways',async()=>{
 const order={id:'order-a',order_number:'SO-A'},ctx={workspaceId:'workspace-a'};
 assert.equal((await spec.build(database(['stripe']),ctx,order,{})).payload.provider,'stripe');
 await assert.rejects(spec.build(database(['stripe']),ctx,order,{paymentProvider:'unknown'}),/Connect and activate/);
 await assert.rejects(spec.build(database([]),ctx,order,{paymentProvider:'Stripe'}),/Connect and activate/);
});
