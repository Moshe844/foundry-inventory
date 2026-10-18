'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('approved versioned pricing applies exact customer tiers and coupons without rewriting earlier quotes',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Pricing owner',businessName:'Pricing '+randomUUID(),email:randomUUID()+'@example.test',password:'Pricing!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const foreign=await auth.createBusiness(db,{name:'Other',businessName:'Other '+randomUUID(),email:randomUUID()+'@example.test',password:'Pricing!'+randomUUID()});
 const commerce=require('../../src/operations/postgres-commerce'),catalog=require('../../src/domain/postgres-catalog-service'),prices=require('../../src/pricing/postgres-service'),service=require('../../src/pricing/postgres-promotions'),workflows=require('../../src/operations/postgres-business-workflows');
 const product=await catalog.createItem(db,ctx,{name:'Negotiated product',baseCode:randomUUID(),trackingMode:'quantity'}),customer=await commerce.createCustomer(db,ctx,{name:'Trade buyer'});const skuId=product.skuIds[0];
 await prices.setPrice(db,ctx,{skuId,amountMinor:1001,currency:'USD'});
 const list={kind:'price_list',name:'Trade tiers',currency:'USD',scope:{customerIds:[customer.id]},entries:[{skuId,minQuantity:1,unitPriceMinor:900},{skuId,minQuantity:3,unitPriceMinor:800}]};
 const proposal=await service.propose(db,ctx,list);assert.equal((await service.list(db,ctx)).length,0,'A proposal cannot change current pricing');await assert.rejects(()=>service.decide(db,ctx,proposal.id,'wrong',true),/changed/);
 await service.decide(db,ctx,proposal.id,proposal.integrity_hash,true);assert((await service.decide(db,ctx,proposal.id,proposal.integrity_hash,true)).replayed);
 const offer=await service.propose(db,ctx,{kind:'promotion',name:'Trade campaign',currency:'USD',code:'TRADE',discount:{type:'fixed_order',value:101},stacking:'exclusive',maxRedemptions:1});await service.decide(db,ctx,offer.id,offer.integrity_hash,true);
 const input={customerId:customer.id,deliveryMethod:'PICKUP',currency:'USD',codes:['TRADE'],taxMinor:19,lines:[{skuId,quantity:3,unitPriceMinor:1001}]},quote=await service.prepareQuote(db,ctx,input);assert.equal(quote.subtotalMinor,2400);assert.equal(quote.discountMinor,101);assert.equal(quote.totalMinor,2318);
 const order=await workflows.createSalesOrder(db,ctx,{...input,idempotencyKey:'priced-order',pricingQuoteHash:service.quoteHash(quote)});assert.equal(order.pricing.totalMinor,2318);
 const frozen=(await db.query('SELECT quote,integrity_hash FROM stockchief_runtime.pricing_order_snapshots WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,order.salesOrderId])).rows[0];assert.equal(frozen.quote.totalMinor,2318);
 const revised=await service.propose(db,ctx,{...list,entries:[{skuId,minQuantity:1,unitPriceMinor:600}]},{ruleId:proposal.rule_id,expectedRevision:1});await service.decide(db,ctx,revised.id,revised.integrity_hash,true);
 assert.equal((await service.history(db,ctx,proposal.rule_id)).length,2);assert.equal((await service.prepareQuote(db,ctx,input)).discountMinor,0,'Reserved coupon use cannot be exceeded by another order');
 assert.equal((await db.query('SELECT quote FROM stockchief_runtime.pricing_order_snapshots WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,order.salesOrderId])).rows[0].quote.totalMinor,2318,'Rule edits do not rewrite the immutable order');
 await assert.rejects(()=>db.query("UPDATE stockchief_runtime.pricing_order_snapshots SET quote='{}'::jsonb WHERE sales_order_id=$1",[order.salesOrderId]),/immutable/);
 await assert.rejects(()=>service.propose(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},list),/belong/);
 await assert.rejects(()=>workflows.createSalesOrder(db,ctx,{...input,idempotencyKey:'stale-price',pricingQuoteHash:service.quoteHash(quote)}),/changed/);
 assert.equal((await db.query('SELECT count(*) AS n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'1');
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
 const invoiceOffer=await service.propose(db,ctx,{kind:'promotion',name:'Invoice-only code',currency:'USD',code:'INVOICE',discount:{type:'fixed_order',value:100},maxRedemptions:1});await service.decide(db,ctx,invoiceOffer.id,invoiceOffer.integrity_hash,true);
 const invoiceInput={customerId:customer.id,skuId,description:'Negotiated product',quantity:2,unitAmount:'10.01',tax:'0.19',issueDate:'2026-10-16',dueDate:'2026-11-15',codes:['INVOICE'],idempotencyKey:'priced-invoice'},invoiceQuote=await require('../../src/pricing/postgres-invoice-pricing').quote(db,ctx,invoiceInput);assert.equal(invoiceQuote.totalMinor,1119);
 const invoice=await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{...invoiceInput,pricingQuoteHash:service.quoteHash(invoiceQuote)}),storedInvoice=(await db.query('SELECT subtotal_minor,discount_minor,tax_minor,total_minor FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,invoice.id])).rows[0];assert.deepEqual(Object.fromEntries(Object.entries(storedInvoice).map(([k,v])=>[k,Number(v)])),{subtotal_minor:1200,discount_minor:100,tax_minor:19,total_minor:1119});
 assert.equal((await service.prepareQuote(db,ctx,{...input,codes:['INVOICE']})).discountMinor,0,'A code consumed by an invoice cannot be spent again on an order');assert((await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,invoiceInput)).replayed);
});

for(const splitFulfillment of [true,false])test('discounts and tax conserve historical pennies across '+(splitFulfillment?'split':'single')+' fulfillment and physical returns',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Money owner',businessName:'Money '+randomUUID(),email:randomUUID()+'@example.test',password:'Money!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
 const product=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Historical product',baseCode:randomUUID(),trackingMode:'quantity'}),skuId=product.skuIds[0],location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Receipts',kind:'warehouse'}),customer=await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'Buyer'});
 const inventory=require('../../src/domain/postgres-inventory-engine'),costing=require('../../src/accounting/postgres-costing'),workflows=require('../../src/operations/postgres-business-workflows'),returns=require('../../src/operations/postgres-returns');
 const quarantine=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Return inspection',kind:'warehouse'});
 const received=await inventory.receive(db,ctx,{skuId,locationId:location.id,quantity:3,reasonCode:'opening',idempotencyKey:'history:stock'});
 await db.transaction(c=>costing.receiveInTransaction(c,ctx,{movementId:received.movementId,totalCostMinor:300,sourceType:'opening_inventory',sourceRecordId:received.movementId}));
 const order=await workflows.createSalesOrder(db,ctx,{customerId:customer.id,deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,currency:'USD',discountMinor:101,taxMinor:19,idempotencyKey:'history:order',lines:[{skuId,quantity:3,unitPriceMinor:1001}]});
 await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'history:confirm',requireFullAllocation:true});
 const one=await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'history:first',lines:[{lineId:order.lineIds[0],quantity:splitFulfillment?1:3,locationId:location.id}]});
 const rest=splitFulfillment?await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'history:rest',lines:[{lineId:order.lineIds[0],quantity:2,locationId:location.id}]}):one;assert.equal(rest.invoiceId,one.invoiceId);
 const invoice=async()=> (await db.query('SELECT subtotal_minor,discount_minor,tax_minor,total_minor,balance_minor FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,one.invoiceId])).rows[0];
 assert.deepEqual(Object.fromEntries(Object.entries(await invoice()).map(([k,v])=>[k,Number(v)])),{subtotal_minor:3003,discount_minor:101,tax_minor:19,total_minor:2921,balance_minor:2921});
 let refunded=0;for(let i=0;i<3;i++){
  const rma=await returns.requestCustomerReturn(db,ctx,{salesOrderId:order.salesOrderId,quarantineLocationId:quarantine.id,resolution:'REFUND',idempotencyKey:'history:return:'+i,lines:[{salesOrderLineId:order.lineIds[0],quantity:1}]});
  await returns.authorizeCustomerReturn(db,ctx,rma.customerReturnId,{idempotencyKey:'history:authorize:'+i});const detail=await returns.getCustomerReturn(db,ctx.workspaceId,rma.customerReturnId);
  await returns.receiveCustomerReturn(db,ctx,rma.customerReturnId,{idempotencyKey:'history:receive:'+i,lines:[{lineId:detail.lines[0].id,quantity:1}]});
  await returns.inspectCustomerReturn(db,ctx,rma.customerReturnId,{idempotencyKey:'history:inspect:'+i,lines:[{lineId:detail.lines[0].id,restock:1,restockLocationId:location.id,scrap:0,repair:0}]});
  const result=await returns.refundCustomerReturn(db,ctx,rma.customerReturnId,{destination:'AR',idempotencyKey:'history:refund:'+i});refunded+=result.amountMinor;
  const intermediate=await invoice();assert.equal(Number(intermediate.subtotal_minor)-Number(intermediate.discount_minor)+Number(intermediate.tax_minor),Number(intermediate.total_minor),'Every partial refund must preserve the invoice accounting identity');assert.equal(Number(intermediate.total_minor),2921-refunded);
  const duplicate=await returns.refundCustomerReturn(db,ctx,rma.customerReturnId,{destination:'AR',idempotencyKey:'history:refund:'+i});assert(duplicate.replayed);assert.equal(duplicate.amountMinor,result.amountMinor);
 }
 assert.equal(refunded,2921);assert(Object.values(await invoice()).every(v=>Number(v)===0));assert.equal(Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuId,location.id])).rows[0].on_hand),3);
 const balances=(await db.query(`SELECT entry_id,sum(debit_minor-credit_minor) AS balance FROM accounting_journal_lines WHERE workspace_id=$1 GROUP BY entry_id`,[ctx.workspaceId])).rows;assert(balances.every(r=>Number(r.balance)===0));
});
