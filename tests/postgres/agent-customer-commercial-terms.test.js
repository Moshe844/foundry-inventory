'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-workflow-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const prices=require('../../src/pricing/postgres-service');
const pricing=require('../../src/pricing/postgres-promotions');
const terms=require('../../src/sales/postgres-payment-terms');
const quotes=require('../../src/sales/postgres-quotes');
const commerce=require('../../src/operations/postgres-commerce');
const assistant=require('../../src/assistant/postgres-service');
const agreements=require('../../src/sales/customer-commercial-terms');

test('customer terms and exact measured prices carry from quote to order and invoice, and deposits use posted money',{timeout:240000},async t=>{
  const f=await fixture(t,{units:12,through:'385-agent-order-price-alerts.sql'}),{db,ctx,subscribe,browser,workflows}=f;
  await subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const measured=await catalog.createItem(db,ctx,{name:'Measured customer product',baseCode:'TERMS-KG',trackingMode:'quantity',
    unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const skuId=measured.skuIds[0],locationId=f.location.id;
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:locationId,
    idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:6,secondaryQuantity:9,unitCost:2}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:po.lineIds[0],locationId,quantity:6,secondaryQuantity:9}]});
  await prices.setPrice(db,ctx,{skuId,currency:'USD',amountMinor:700});
  const customerId='fixture-customer';
  const approve=async definition=>{const p=await pricing.propose(db,ctx,definition);return pricing.decide(db,ctx,p.id,p.integrity_hash,true);};
  const scope={customerIds:[customerId]};
  await approve({kind:'price_list',name:'Receiver kg terms',currency:'USD',scope,
    entries:[{skuId,minQuantity:0.5,unitPriceMinor:600},{skuId,minQuantity:2.5,unitPriceMinor:500}]});
  await approve({kind:'promotion',name:'Receiver measured break',currency:'USD',scope,minimumQuantity:2.5,minimumOrderMinor:1300,
    discount:{type:'percent',value:1000}});
  const setNet=netDays=>db.transaction(c=>terms.saveInTransaction(c,ctx,{customerId,kind:'ON_ACCOUNT',netDays,creditApproved:true}));
  await setNet(45);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const input={customerId,currency:'USD',orderDate:today,deliveryMethod:'PICKUP',fulfillmentLocationId:locationId,
    lines:[{skuId,quantity:2,secondaryQuantity:2.75}]};
  const exact=await pricing.prepareQuote(db,ctx,input);
  assert.equal(exact.subtotalMinor,1375);
  assert.equal(exact.discountMinor,138);
  assert.equal(exact.totalMinor,1237);
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const tooSmall=await pricing.prepareQuote(db,ctx,{...input,lines:[{skuId,quantity:2,secondaryQuantity:2.5}]});
  assert.equal(tooSmall.totalMinor,1250,'the amount threshold is still required at the quantity break');
  const other=await commerce.createCustomer(db,ctx,{name:'Different commercial terms'});
  assert.equal((await pricing.prepareQuote(db,ctx,{...input,customerId:other.id})).totalMinor,1925);
  const agentOrder=()=>assistant.prepareAction(db,ctx,'Draft two pieces and 2.75 kg at Receiver terms',
    {action:'create_sales_order',customer:'Receiver',currency:'USD',deliveryMethod:'PICKUP',location:f.location.name,
      orderLines:JSON.stringify([{sku:'TERMS-KG',quantity:2,secondaryQuantity:2.75}])});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    if(tier==='starter')await assert.rejects(agentOrder(),e=>e.code==='entitlement_required');
    else assert.match((await agentOrder()).proposal.summary,/\$12\.37/);
  }
  const old=await quotes.create(db,ctx,{...input,validUntil:today,requestKey:randomUUID()});
  assert.equal(old.pricing.customerTerms.net_days,45);
  const termsPage=await browser.get('/sales/customers/'+customerId).expect(200);
  const revision=/name="expectedUpdatedAt" value="([^"]+)"/.exec(termsPage.text)[1];
  await browser.post('/sales/customers/'+customerId+'/payment-terms').type('form').send({_csrf:f.csrf(termsPage.text),
    expectedUpdatedAt:revision,kind:'ON_ACCOUNT',netDays:60,creditApproved:'1'}).expect(303);
  await assert.rejects(quotes.decide(db,ctx,old.id,{accept:true,expectedHash:old.pricing_hash,today}),/pricing changed/);
  const current=await quotes.create(db,ctx,{...input,validUntil:today,supersedesId:old.id,requestKey:randomUUID()});
  const customerQuote=await browser.get('/quotes/'+current.id).expect(200);
  assert.match(customerQuote.text,/Net 60 days/);
  assert.match(customerQuote.text,/2.75 kg priced/);
  const order=await quotes.decide(db,ctx,current.id,{accept:true,expectedHash:current.pricing_hash,today});
  assert.equal((await quotes.decide(db,ctx,current.id,{accept:true,expectedHash:current.pricing_hash,today})).replayed,true);
  await setNet(10);
  await subscribe('starter');
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  const result=await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:order.lineIds[0],locationId,quantity:2,secondaryQuantity:2.75}]});
  const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE id=$1',[result.invoiceId])).rows[0];
  assert.equal(Number(invoice.total_minor),1237);
  assert.equal(invoice.due_date,agreements.dueFrom({net_days:60},invoice.issue_date));
  assert.equal((await require('../../src/accounting/postgres-invoice-document').load(db,ctx.workspaceId,invoice.id)).terms,'Net 60 days');
  assert.equal((await quotes.get(db,ctx.workspaceId,old.id)).pricing.customerTerms.net_days,45);

  await subscribe('growth');
  const saveDeposit=(deposit)=>db.transaction(c=>terms.saveInTransaction(c,ctx,{customerId:other.id,kind:'DEPOSIT',...deposit}));
  const confirm=async line=>{const draft=await workflows.createSalesOrder(db,ctx,{...input,customerId:other.id,lines:[line],idempotencyKey:randomUUID()});
    await workflows.confirmSalesOrder(db,ctx,draft.salesOrderId,{idempotencyKey:randomUUID()});return draft;};
  const fulfill=(draft,line)=>workflows.fulfillSalesOrder(db,ctx,draft.salesOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:draft.lineIds[0],locationId,quantity:line.quantity,secondaryQuantity:line.secondaryQuantity}]});
  const pay=(draft,amountMinor)=>workflows.recordCustomerDeposit(db,ctx,{salesOrderId:draft.salesOrderId,customerId:other.id,
    amountMinor,currency:'USD',idempotencyKey:randomUUID(),method:'cash'});
  await saveDeposit({depositPercent:12.5});
  const measuredLine={skuId,quantity:2,secondaryQuantity:2.75};
  const percent=await confirm(measuredLine);
  assert.equal((await commerce.salesOrder(db,ctx.workspaceId,percent.salesOrderId)).requiredDepositMinor,241);
  await assert.rejects(fulfill(percent,measuredLine),/\$2\.41.*still due/);
  await pay(percent,241);
  assert.ok((await fulfill(percent,measuredLine)).invoiceId);
  await saveDeposit({depositMinor:400,depositCurrency:'USD',holdShipping:true});
  const fixedLine={skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1000},fixed=await confirm(fixedLine);
  await pay(fixed,400);
  await assert.rejects(fulfill(fixed,fixedLine),/\$6\.00.*still due/);
  await pay(fixed,600);
  assert.ok((await fulfill(fixed,fixedLine)).invoiceId);
  await assert.rejects(pricing.prepareQuote(db,ctx,{...input,customerId:other.id,currency:'EUR',
    lines:[{...fixedLine,unitPriceMinor:1000}]}),/fixed deposit.*currency/);
});

test('a customer JPY price list supplies the exact price without converting the USD catalogue', {timeout:240000}, async t=>{
  const f=await fixture(t),{db,workflows}=f;
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'JPY owner',businessName:'JPY terms fixture',
    email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
  await require('../../src/accounting/postgres-ledger').configure(db,ctx,{currency:'JPY',startDate:'2026-01-01'});
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status)
    SELECT $1,$2,'growth',id,'ACTIVE' FROM commercial_plan_versions WHERE plan_id='growth' AND status='ACTIVE'`,[randomUUID(),owner.accountId]);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[owner.accountId]);
  const customer=await commerce.createCustomer(db,ctx,{name:'Yen agreement'});
  const supplier=await commerce.createSupplier(db,ctx,{name:'Yen source',currency:'JPY'});
  const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'JPY dispatch',kind:'warehouse'});
  const product=await catalog.createItem(db,ctx,{name:'Yen product',baseCode:'TERMS-JPY',trackingMode:'quantity'});
  const skuId=product.skuIds[0],locationId=location.id;
  await prices.setPrice(db,ctx,{skuId,currency:'USD',amountMinor:700});
  const priceRule=await pricing.propose(db,ctx,{kind:'price_list',name:'Yen agreement',currency:'JPY',
    scope:{customerIds:[customer.id]},entries:[{skuId,minQuantity:1,unitPriceMinor:800}]});
  await pricing.decide(db,ctx,priceRule.id,priceRule.integrity_hash,true);
  await db.transaction(c=>terms.saveInTransaction(c,ctx,{customerId:customer.id,kind:'DEPOSIT',depositMinor:250,depositCurrency:'JPY'}));
  const purchase=await workflows.createPurchaseOrder(db,ctx,{supplierId:supplier.id,destinationLocationId:locationId,currency:'JPY',
    idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:2,unitCost:200}]});
  await workflows.approvePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:purchase.lineIds[0],locationId,quantity:2}]});
  const draft=await workflows.createSalesOrder(db,ctx,{customerId:customer.id,currency:'JPY',deliveryMethod:'PICKUP',
    fulfillmentLocationId:locationId,lines:[{skuId,quantity:2}],idempotencyKey:randomUUID()});
  assert.equal(draft.pricing.totalMinor,1600);
  assert.equal((await commerce.salesOrder(db,ctx.workspaceId,draft.salesOrderId)).requiredDepositMinor,250);
  await workflows.confirmSalesOrder(db,ctx,draft.salesOrderId,{idempotencyKey:randomUUID()});
  const fulfill=()=>workflows.fulfillSalesOrder(db,ctx,draft.salesOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:draft.lineIds[0],locationId,quantity:2}]});
  await assert.rejects(fulfill(),/¥250.*still due/);
  await workflows.recordCustomerDeposit(db,ctx,{salesOrderId:draft.salesOrderId,customerId:customer.id,
    currency:'JPY',amountMinor:250,method:'cash',idempotencyKey:randomUUID()});
  const result=await fulfill();
  const invoice=(await db.query('SELECT currency,total_minor,balance_minor FROM accounting_customer_invoices WHERE id=$1',[result.invoiceId])).rows[0];
  assert.deepEqual([invoice.currency,Number(invoice.total_minor),Number(invoice.balance_minor)],['JPY',1600,1350]);
  assert.equal((await prices.currentPrice(db,ctx.workspaceId,skuId)).currency,'USD');
});
