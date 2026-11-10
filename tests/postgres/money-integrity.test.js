'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// The books must always equal the records that keep them, through every money
// path an owner can take, and the 15-minute check must notice when they do not.
test('payments, deposits, hand-made entries and counts keep the books equal to their records, and the check notices damage',{timeout:420000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Integrity shop',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},w=ctx.workspaceId,at=new Date().toISOString();
 const wf=require('../../src/operations/postgres-business-workflows'),ledger=require('../../src/accounting/postgres-ledger'),deposits=require('../../src/sales/postgres-deposit-refunds');
 const recon=require('../../src/operations/postgres-reconciliation'),count=require('../../src/accounting/postgres-physical-count'),commerce=require('../../src/operations/postgres-commerce');
 await db.query("UPDATE accounting_settings SET accounting_start_date='2020-01-01' WHERE workspace_id=$1",[w]);
 const main=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Main',kind:'warehouse'});
 const catalog=require('../../src/domain/postgres-catalog-service'),mk=async name=>(await catalog.createItem(db,ctx,{name,baseCode:name.toUpperCase(),trackingMode:'quantity'})).skuIds[0];
 const W=await mk('Widget'),G=await mk('Gadget'),N=await mk('Novel');
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('sup',$1,'Supply','active','USD',$2,$2)",[w,at]);
 const cust=await commerce.createCustomer(db,ctx,{name:'Carol'});
 const po=await wf.createPurchaseOrder(db,ctx,{supplierId:'sup',destinationLocationId:main.id,idempotencyKey:'po',lines:[{skuId:W,quantityUnits:40,unitCost:10},{skuId:G,quantityUnits:10,unitCost:4}]});
 await wf.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'poa'});await wf.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'pop'});
 await wf.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'por',lines:[{lineId:po.lineIds[0],quantity:40,locationId:main.id},{lineId:po.lineIds[1],quantity:10,locationId:main.id}]});
 let k=0;
 const order=async(quantity=1,price=1000)=>{const key='so'+(++k),so=await wf.createSalesOrder(db,ctx,{customerId:cust.id,deliveryMethod:'PICKUP',fulfillmentLocationId:main.id,idempotencyKey:key,lines:[{skuId:W,quantity,unitPriceMinor:price}]});
  await wf.confirmSalesOrder(db,ctx,so.salesOrderId,{idempotencyKey:key+'c'});return so;};
 const ship=(so,quantity)=>wf.fulfillSalesOrder(db,ctx,so.salesOrderId,{idempotencyKey:'f'+(++k),lines:[{lineId:so.lineIds[0],quantity,locationId:main.id}]});
 const invoices=async so=>(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2 ORDER BY created_at,id',[w,so.salesOrderId])).rows;
 const checks=async()=>{let state=await db.transaction(c=>recon.runBatch(c,w));while(state.partial)state=await db.transaction(c=>recon.runBatch(c,w,{runId:state.id}));
  return {state,failed:state.checks.filter(c=>c.status==='FAIL').map(c=>c.key)};};
 const clean=async label=>{const {failed}=await checks();assert.deepEqual(failed,[],label+': the books and the records should agree');};

 await t.test('every check passes on a healthy business and covers the new tie-outs',async()=>{
  const {state}=await checks();assert.equal(state.checks.length,recon.INVARIANTS.length);
  for(const key of ['accounting.inventory_ledger_matches_stock_value','accounting.receivables_ledger_matches_invoices','accounting.payables_ledger_matches_bills',
   'accounting.deposits_ledger_matches_held_payments','accounting.payments_match_their_entries','accounting.payment_entries_have_payments',
   'inventory.no_negative_stock','inventory.costed_units_within_stock','sales.shipped_quantity_matches_invoices','accounting.invoice_total_matches_parts'])
   assert(state.checks.some(c=>c.key===key&&c.status==='PASS'),key);
 });

 await t.test('the same payment submitted twice records one receipt',async()=>{
  const so=await order(2);await ship(so,2);const [invoice]=await invoices(so);
  const pay=()=>wf.recordCustomerPayment(db,ctx,{customerId:cust.id,customerInvoiceId:invoice.id,salesOrderId:so.salesOrderId,amountMinor:500,idempotencyKey:'form-key-1'});
  const first=await pay(),second=await pay();
  assert.equal(second.replayed,true);assert.equal(second.paymentId,first.paymentId);
  assert.equal(Number((await db.query("SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1 AND sales_order_id=$2",[w,so.salesOrderId])).rows[0].n),1);
  assert.equal(Number((await invoices(so))[0].balance_minor),1500);
  await clean('after a repeated payment');
 });

 await t.test('a payment recorded by mistake is voided: the invoice opens again and the books follow',async()=>{
  const so=await order(1);await ship(so,1);const [invoice]=await invoices(so);
  const paid=await wf.recordCustomerPayment(db,ctx,{customerId:cust.id,customerInvoiceId:invoice.id,salesOrderId:so.salesOrderId,amountMinor:1000,idempotencyKey:'pay-void-1'});
  assert.equal((await invoices(so))[0].status,'PAID');
  await assert.rejects(wf.voidPayment(db,ctx,paid.paymentId,{}),/Say why/);
  const voided=await wf.voidPayment(db,ctx,paid.paymentId,{reason:'Recorded twice'});
  assert.deepEqual(voided.reopened.map(r=>r.number),[invoice.invoice_number]);
  const after=(await invoices(so))[0];assert.equal(Number(after.balance_minor),1000);assert.equal(after.status,'OPEN');assert.equal(after.paid_at,null);
  const payment=(await db.query('SELECT status,voided_at FROM accounting_payments WHERE id=$1',[paid.paymentId])).rows[0];assert.equal(payment.status,'VOID');assert(payment.voided_at);
  assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_payment_allocations WHERE payment_id=$1',[paid.paymentId])).rows[0].n),0);
  assert.equal((await wf.voidPayment(db,ctx,paid.paymentId,{reason:'again'})).replayed,true,'voiding twice replays the first void');
  await assert.rejects(wf.voidPayment(db,ctx,paid.paymentId,{reason:'again',idempotencyKey:'other-form'}),/already void/);
  await wf.recordCustomerPayment(db,ctx,{customerId:cust.id,customerInvoiceId:invoice.id,salesOrderId:so.salesOrderId,amountMinor:1000,idempotencyKey:'pay-void-2'});
  assert.equal((await invoices(so))[0].status,'PAID');
  await clean('after voiding and paying again');
 });

 await t.test('a supplier payment is voided the same way and the bill opens again',async()=>{
  const recorded=await wf.recordSupplierInvoice(db,ctx,{supplierId:'sup',purchaseOrderId:po.purchaseOrderId,supplierInvoiceNumber:'SUP-1',idempotencyKey:'bill-1',
   lines:[{purchaseOrderLineId:po.lineIds[0],quantity:40,unitCostMinor:1000},{purchaseOrderLineId:po.lineIds[1],quantity:10,unitCostMinor:400}]});
  const bill=(await db.query('SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2',[w,recorded.billId||recorded.supplierBillId||recorded.id])).rows[0];
  assert(bill&&bill.journal_entry_id,'the bill reached the books: '+JSON.stringify(recorded));
  const paid=await wf.recordSupplierPayment(db,ctx,{supplierId:'sup',supplierBillId:bill.id,amountMinor:100,idempotencyKey:'sup-pay-void'});
  await wf.voidPayment(db,ctx,paid.paymentId,{reason:'Wrong bill'});
  assert.equal(Number((await db.query('SELECT balance_minor FROM accounting_supplier_bills WHERE id=$1',[bill.id])).rows[0].balance_minor),Number(bill.balance_minor));
  await clean('after voiding a supplier payment');
 });

 await t.test('hand-made entries cannot touch accounts kept by records, and record entries are corrected on the record',async()=>{
  const accounts=Object.fromEntries((await db.query('SELECT system_key,id FROM accounting_accounts WHERE workspace_id=$1',[w])).rows.map(r=>[r.system_key,r.id]));
  const expense=(await db.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND account_type='EXPENSE' AND system_key IS DISTINCT FROM 'COST_OF_GOODS_SOLD' ORDER BY code LIMIT 1",[w])).rows[0].id;
  const adjust=(debit,credit,key)=>ledger.post(db,ctx,{postingDate:at.slice(0,10),description:'Hand-made',sourceType:'manual_adjustment',sourceRecordType:'manual_adjustment',sourceKey:'manual:'+key,createdByType:'USER',
   lines:[{accountId:debit,debitMinor:2000},{accountId:credit,creditMinor:2000}]});
  await assert.rejects(adjust(accounts.ACCOUNTS_RECEIVABLE,accounts.CASH,'ar'),/Accounts receivable is kept in step with your customer invoices and payments/);
  await assert.rejects(adjust(expense,accounts.INVENTORY_ASSET,'inv'),/kept in step with your stock records/);
  await assert.rejects(adjust(accounts.ACCOUNTS_PAYABLE,accounts.CASH,'ap'),/supplier bills and payments/);
  const fee=await adjust(expense,accounts.CASH,'fee');assert(fee.entry.id,'an ordinary expense is still allowed');
  const payEntry=(await db.query("SELECT * FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='customer_payment' ORDER BY created_at DESC LIMIT 1",[w])).rows[0];
  const reverse=entry=>ledger.post(db,ctx,{postingDate:at.slice(0,10),description:'Reversal',sourceType:'journal_reversal',sourceRecordType:'journal_entry',sourceRecordId:entry.id,
   sourceKey:'journal-reversal:'+entry.id,createdByType:'USER',reversalOfEntryId:entry.id,lines:[{accountKey:'CASH',creditMinor:1},{accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:1}]});
  await assert.rejects(reverse(payEntry),/belongs to a payment\. Void the payment instead/);
  const feeEntry=(await db.query('SELECT * FROM accounting_journal_entries WHERE id=$1',[fee.entry.id])).rows[0];
  await ledger.post(db,ctx,{postingDate:at.slice(0,10),description:'Reversal of fee',sourceType:'journal_reversal',sourceRecordType:'journal_entry',sourceRecordId:feeEntry.id,
   sourceKey:'journal-reversal:'+feeEntry.id,createdByType:'USER',reversalOfEntryId:feeEntry.id,lines:[{accountId:expense,creditMinor:2000},{accountId:accounts.CASH,debitMinor:2000}]});
  await clean('after refused hand-made entries');
 });

 await t.test('deposits are held to what the order still owes; a deposit after invoicing pays the invoice',async()=>{
  const so=await order(2);
  await assert.rejects(wf.recordCustomerDeposit(db,ctx,{customerId:cust.id,salesOrderId:so.salesOrderId,amountMinor:2001,idempotencyKey:'dep-over'}),/more than this order still owes \(\$20\.00\)/);
  await wf.recordCustomerDeposit(db,ctx,{customerId:cust.id,salesOrderId:so.salesOrderId,amountMinor:1500,idempotencyKey:'dep-1'});
  await assert.rejects(wf.recordCustomerDeposit(db,ctx,{customerId:cust.id,salesOrderId:so.salesOrderId,amountMinor:501,idempotencyKey:'dep-over-2'}),/still owes \(\$5\.00\)/);
  await ship(so,1);let [invoice]=await invoices(so);assert.equal(invoice.status,'PAID','the deposit pays the first shipment');
  await ship(so,1);invoice=(await invoices(so))[0];assert.equal(Number(invoice.balance_minor),500,'the second shipment joins the invoice and takes the rest of the deposit');
  const late=await wf.recordCustomerDeposit(db,ctx,{customerId:cust.id,salesOrderId:so.salesOrderId,amountMinor:500,idempotencyKey:'dep-late'});
  assert.equal(late.appliedToInvoicesMinor,500);assert.equal((await invoices(so))[0].status,'PAID','a deposit taken after invoicing goes onto the invoice');
  await assert.rejects(wf.recordCustomerDeposit(db,ctx,{customerId:cust.id,salesOrderId:so.salesOrderId,amountMinor:1,idempotencyKey:'dep-paid'}),/already paid in full/);
  const cancelled=await order(1);await wf.cancelSalesOrder(db,ctx,cancelled.salesOrderId,{idempotencyKey:'cx'});
  await assert.rejects(wf.recordCustomerDeposit(db,ctx,{customerId:cust.id,salesOrderId:cancelled.salesOrderId,amountMinor:100,idempotencyKey:'dep-cx'}),/cancelled/);
  await clean('after deposits');
 });

 await t.test('money a provider took beyond what the order came to is listed to refund once the order is complete, and refunds',async()=>{
  const so=await order(1);
  await db.query(`INSERT INTO payment_requests(id,workspace_id,sales_order_id,customer_id,provider,purpose,amount_minor,currency,status,paid_minor,created_at,updated_at)
   VALUES('preq-over',$1,$2,$3,'stripe','DEPOSIT',1500,'USD','OPEN',0,$4,$4)`,[w,so.salesOrderId,cust.id,at]);
  await db.query(`INSERT INTO payment_provider_events(id,workspace_id,provider,external_event_id,event_type,payload,request_id,external_payment_id,received_at)
   VALUES('pevt-over',$1,'stripe','evt-over','payment.succeeded','{}','preq-over','pi_over',$2)`,[w,at]);
  const collection=require('../../src/payments/postgres-collection');
  const receipt=await wf.recordCustomerDeposit(db,{workspaceId:w,actorId:null,systemSource:'payment_provider',providerEventId:'pevt-over',providerRequestId:'preq-over'},
   {customerId:cust.id,salesOrderId:so.salesOrderId,amountMinor:1500,currency:'USD',sourceKey:collection.providerReceiptKey('stripe','preq-over',1500),idempotencyKey:'provider-over'});
  assert.equal((await deposits.forOrder(db,w,so.salesOrderId)),null,'an open order is still waiting for its goods');
  await ship(so,1);
  const position=await deposits.forOrder(db,w,so.salesOrderId);assert.equal(position.toRefundMinor,500);assert.equal(position.cancelled,false);
  assert((await deposits.due(db,w)).some(r=>r.orderId===so.salesOrderId));
  const needs=await require('../../src/projections/postgres-service').needs(db,w,ctx.actorId);
  assert(needs.some(item=>/^Overpayment to refund: \$5\.00 to Carol/.test(item.title)),'Needs you lists the overpayment');
  await assert.rejects(wf.voidPayment(db,ctx,receipt.paymentId,{reason:'x'}),/payment provider/,'online money is refunded at the provider');
  await assert.rejects(wf.refundCustomerDeposit(db,ctx,{salesOrderId:so.salesOrderId,amountMinor:501,idempotencyKey:'over-refund-x'}),/more than this order has left/);
  await wf.refundCustomerDeposit(db,ctx,{salesOrderId:so.salesOrderId,amountMinor:500,idempotencyKey:'over-refund'});
  assert.equal((await deposits.forOrder(db,w,so.salesOrderId)).toRefundMinor,0);
  await clean('after an overpayment refund');
 });

 await t.test('a count that finds more stock values it at the known cost, and asks when none is known',async()=>{
  const value=async sku=>Number((await db.query('SELECT COALESCE(SUM(total_cost_minor),0) v FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[w,sku])).rows[0].v);
  const before=await value(G);
  const found=await count.apply(db,ctx,{skuId:G,locationId:main.id,countedQuantity:12,reasonCode:'found',idempotencyKey:'count-g'});
  assert.equal(found.costDeltaMinor,800,'two found units at the gadget cost of $4.00');assert.equal(await value(G),before+800);
  await assert.rejects(count.apply(db,ctx,{skuId:N,locationId:main.id,countedQuantity:3,reasonCode:'found',idempotencyKey:'count-n'}),/Enter what the added units cost/);
  const priced=await count.apply(db,ctx,{skuId:N,locationId:main.id,countedQuantity:3,unitCost:'2.50',reasonCode:'found',idempotencyKey:'count-n2'});
  assert.equal(priced.costDeltaMinor,750);
  await clean('after counts');
 });

 await t.test('a sale or count synced from a connected channel takes the value out of the books with the stock',async()=>{
  const connections=require('../../src/connections/postgres-service'),ingestion=require('../../src/connections/postgres-event-ingestion');
  const feed=await connections.createFeed(db,ctx,{displayName:'Shop feed',expectedIntervalMinutes:60});
  const auth=await connections.authenticate(db,'Bearer '+feed.token);
  const value=async()=>(await db.query('SELECT c.quantity_units::int units,c.total_cost_minor::int value,b.on_hand::int shelf FROM accounting_inventory_cost_balances c JOIN balances b USING(workspace_id,sku_id,location_id) WHERE c.workspace_id=$1 AND c.sku_id=$2 AND c.location_id=$3',[w,W,main.id])).rows[0];
  const before=await value();assert.equal(before.units,before.shelf,'the widget position starts fully costed');
  const sold=await ingestion.ingest(db,auth,{eventId:'shop-sale-1',type:'sale.completed',version:'1',occurredAt:at,
   data:{externalSku:'shop-widget',skuCode:'WIDGET',externalLocationId:'shop-main',locationName:'Main',quantity:2}});
  assert.equal(sold.accepted,true,JSON.stringify(sold));
  let after=await value();assert.equal(after.shelf,before.shelf-2);assert.equal(after.units,after.shelf,'value left with the sold units');
  assert.equal(after.value,before.value-2000);
  const cogs=(await db.query("SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='connector_stock_removal'",[w])).rows[0].n;assert.equal(cogs,1);
  const counted=await ingestion.ingest(db,auth,{eventId:'shop-count-1',type:'inventory.adjust',version:'1',occurredAt:new Date(Date.now()+1000).toISOString(),
   data:{externalSku:'shop-widget',skuCode:'WIDGET',externalLocationId:'shop-main',locationName:'Main',countedQuantity:after.shelf-1}});
  assert.equal(counted.accepted,true,JSON.stringify(counted));
  const recount=await value();assert.equal(recount.units,recount.shelf,'a synced count that finds less takes the value too');
  await clean('after connector sales and counts');
 });

 await t.test('the check notices damage to records or books, and Needs you says what disagrees in words',async()=>{
  const so=await order(1);await ship(so,1);const [invoice]=await invoices(so);
  await db.query("UPDATE accounting_customer_invoices SET balance_minor=0,status='PAID' WHERE id=$1",[invoice.id]);
  let {failed}=await checks();assert.deepEqual(failed,['accounting.receivables_ledger_matches_invoices']);
  const items=await recon.failures(db,w);assert.equal(items.length,1);
  assert.match(items[0].happened,/^Money owed to you in your books is \$[\d.,]+; your records add up to \$[\d.,]+\.$/);
  const needs=await require('../../src/projections/postgres-service').needs(db,w,ctx.actorId);
  const item=needs.find(n=>n.sourceId==='books-check:accounting.receivables_ledger_matches_invoices');
  assert(item,'Needs you shows the failed check');assert.equal(item.importance,'Urgent');assert.equal(item.title,'Money owed to you in your books does not match your open invoices');
  await db.query("UPDATE accounting_customer_invoices SET balance_minor=$2,status='OPEN' WHERE id=$1",[invoice.id,invoice.balance_minor]);
  const paid=await wf.recordCustomerPayment(db,ctx,{customerId:cust.id,customerInvoiceId:invoice.id,amountMinor:400,idempotencyKey:'tamper-pay'});
  await db.query('UPDATE accounting_payments SET amount_minor=amount_minor+100 WHERE id=$1',[paid.paymentId]);
  ({failed}=await checks());assert(failed.includes('accounting.payments_match_their_entries'),failed.join());
  await db.query('UPDATE accounting_payments SET amount_minor=amount_minor-100 WHERE id=$1',[paid.paymentId]);
  await db.query('DELETE FROM accounting_payment_allocations WHERE payment_id=$1',[paid.paymentId]);await db.query('DELETE FROM accounting_payments WHERE id=$1',[paid.paymentId]);
  ({failed}=await checks());assert(failed.includes('accounting.payment_entries_have_payments'),failed.join());
  await db.query('UPDATE accounting_inventory_cost_balances SET total_cost_minor=total_cost_minor+1 WHERE workspace_id=$1 AND sku_id=$2',[w,W]);
  ({failed}=await checks());assert(failed.includes('accounting.inventory_ledger_matches_stock_value'),failed.join());
  await db.query('UPDATE accounting_inventory_cost_balances SET quantity_units=quantity_units+500 WHERE workspace_id=$1 AND sku_id=$2',[w,W]);
  ({failed}=await checks());assert(failed.includes('inventory.costed_units_within_stock'),failed.join());
  await db.query('UPDATE sales_order_lines SET quantity_fulfilled=quantity_fulfilled-1 WHERE workspace_id=$1 AND sales_order_id=$2',[w,so.salesOrderId]);
  await db.query('UPDATE accounting_customer_invoices SET total_minor=total_minor+7 WHERE id=$1',[invoice.id]);
  await db.query("UPDATE accounting_supplier_bills SET balance_minor=balance_minor+3 WHERE workspace_id=$1 AND journal_entry_id IS NOT NULL",[w]);
  ({failed}=await checks());
  for(const key of ['sales.shipped_quantity_matches_invoices','accounting.invoice_total_matches_parts','accounting.payables_ledger_matches_bills'])assert(failed.includes(key),key+' in '+failed.join());
  assert.equal(Number((await db.query('SELECT suspended FROM workspace_autopilot WHERE workspace_id=$1',[w])).rows[0].suspended),1,'automatic work pauses');
 });
});
