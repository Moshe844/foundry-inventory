'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const ledger=require('../../src/accounting/postgres-ledger');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');
const inventory=require('../../src/domain/postgres-inventory-engine');
const {newId,nowIso}=require('../../src/lib/util');

function step(capability,args={}){return {capability,arguments:Object.entries(args).map(([name,value])=>
  ({name,value:String(value)})),dependsOn:[],continuesPending:false};}
async function ask(page,base,database,workspaceId,plans,message,contract){
  assert.ok(plans.has(message));
  await page.goto(`${base}/ask`);
  await page.getByLabel('Ask StockChief').fill(message);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
  const proposal=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId])).rows[0];
  assert.equal(proposal?.action_type,contract,`Missing ${contract}: ${(await page.locator('main').innerText()).slice(0,900)}`);
  assert.equal(proposal.status,'PENDING');
  await page.goto(`${base}/actions/${proposal.id}`);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
  const result=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
    WHERE workspace_id=$1 AND id=$2`,[workspaceId,proposal.id])).rows[0];
  assert.equal(result.status,'EXECUTED',`${contract}: ${(await page.locator('body').innerText()).slice(0,1100)}`);
  return result;
}

test('real Ask browser approves supplier return, warehouse scans and bank evidence through canonical PostgreSQL engines',
  {timeout:300000},async(t)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'ask-physical-financial-bridge'});
    await migratePostgres(database);
    const plans=new Map();
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      const message=JSON.parse(input.prompt).message;
      assert.ok(plans.has(message),`Unregistered fixture message: ${message}`);
      return {data:{steps:[plans.get(message)],clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-physical-financial-secret',aiProvider:provider});
    const server=await new Promise((resolve)=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
    const browser=await chromium.launch();
    t.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Ask Physical Financial');
    await page.getByLabel('Your name').fill('Ask Owner');
    await page.getByLabel('Work email').fill('ask-physical-financial@example.test');
    await page.locator('input[name="password"]').fill('ask-physical-financial-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('ask-physical-financial-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const ctx=(await database.query(`SELECT w.id AS "workspaceId",u.id AS "actorId" FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id
      WHERE a.email='ask-physical-financial@example.test'`)).rows[0];
    const other=await browser.newPage();
    await other.goto(`${base}/register`);
    await other.getByLabel('Business name').fill('Ask Isolated Business');
    await other.getByLabel('Your name').fill('Other Owner');
    await other.getByLabel('Work email').fill('ask-isolated@example.test');
    await other.locator('input[name="password"]').fill('ask-isolated-password');if(await other.locator('input[name="confirmPassword"]').count())await other.locator('input[name="confirmPassword"]').fill('ask-isolated-password');
    await Promise.all([other.waitForURL(`${base}/onboarding`),
      other.getByRole('button',{name:'Create account'}).click()]);
    const otherWorkspace=(await database.query(`SELECT w.id FROM workspaces w JOIN users u ON u.workspace_id=w.id
      JOIN accounts a ON a.id=u.account_id WHERE a.email='ask-isolated@example.test'`)).rows[0].id;
    const place=await locations.createLocation(database,ctx,{name:'Pick Warehouse',kind:'warehouse',barcode:'PICK-BIN'});
    const item=await catalog.createItem(database,ctx,{name:'Ask Widget',baseCode:'ASK-WIDGET',trackingMode:'quantity'});
    await database.query('UPDATE skus SET barcode=$3 WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,item.skuIds[0],'ASK-BARCODE']);
    await ledger.configure(database,ctx,{startDate:'2026-01-01',currency:'USD'});
    const supplier=await commerce.createSupplier(database,ctx,{name:'Ask Supplier',email:'supplier@example.test'});
    const po=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,
      destinationLocationId:place.id,orderDate:'2026-09-20',idempotencyKey:'ask-physical-po',
      lines:[{skuId:item.skuIds[0],quantityUnits:10,unitCost:8,destinationLocationId:place.id}]});
    await workflows.approvePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'ask-physical-po-approve'});
    await workflows.placePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'ask-physical-po-place'});
    await workflows.receivePurchaseOrder(database,ctx,po.purchaseOrderId,{idempotencyKey:'ask-physical-po-receive',
      reference:'ASK-RECEIPT',lines:[{lineId:po.lineIds[0],quantity:10,locationId:place.id}]});
    const bill=await workflows.recordSupplierInvoice(database,ctx,{supplierId:supplier.id,
      purchaseOrderId:po.purchaseOrderId,supplierInvoiceNumber:'ASK-SUP-1',issueDate:'2026-09-21',
      idempotencyKey:'ask-physical-bill',lines:[{purchaseOrderLineId:po.lineIds[0],
        skuId:item.skuIds[0],quantity:10,unitCostMinor:800,description:'Ask widgets'}]});
    const poNumber=po.poNumber;
    const request=`Request return of two ASK-WIDGET on ${poNumber}; supplier approved damaged goods`;
    plans.set(request,step('supplier_return.request',{recordReference:poNumber,sku:'ASK-WIDGET',quantity:2,
      reason:'Supplier approved damaged goods',amount:'16.00'}));
    const proposed=await ask(page,base,database,ctx.workspaceId,plans,request,'supplier_return.request');
    const returnId=proposed.result.supplierReturnId;
    const returnNumber=proposed.result.returnNumber;
    assert.equal((await database.query('SELECT status FROM supplier_returns WHERE id=$1',[returnId])).rows[0].status,'REQUESTED');
    const crossTenant=`Authorize supplier return ${returnId} from the other inventory`;
    plans.set(crossTenant,step('supplier_return.authorize',{recordReference:returnId}));
    await other.goto(`${base}/ask`);await other.getByLabel('Ask StockChief').fill(crossTenant);
    await Promise.all([other.waitForNavigation(),other.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await other.locator('main').innerText(),/could not find that supplier return/i);
    assert.equal((await database.query(`SELECT COUNT(*)::int AS count FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1`,[otherWorkspace])).rows[0].count,0);
    const authorize=`Authorize supplier return ${returnNumber}`;
    plans.set(authorize,step('supplier_return.authorize',{recordReference:returnNumber}));
    await ask(page,base,database,ctx.workspaceId,plans,authorize,'supplier_return.authorize');
    const ship=`Record physical shipment of supplier return ${returnNumber}`;
    plans.set(ship,step('supplier_return.ship',{recordReference:returnNumber}));
    await ask(page,base,database,ctx.workspaceId,plans,ship,'supplier_return.ship');
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2',
      [ctx.workspaceId,item.skuIds[0]])).rows[0].on_hand),8);
    const credit=`Reconcile credit memo ASK-CREDIT-1 for $16 on ${returnNumber}, dated 2026-09-22`;
    plans.set(credit,step('supplier_return.reconcile',{recordReference:returnNumber,amount:'16.00',
      creditNumber:'ASK-CREDIT-1',creditDate:'2026-09-22'}));
    await ask(page,base,database,ctx.workspaceId,plans,credit,'supplier_return.reconcile');
    assert.equal((await database.query('SELECT status FROM supplier_returns WHERE id=$1',[returnId])).rows[0].status,'RECONCILED');
    assert.equal(Number((await database.query('SELECT balance_minor FROM accounting_supplier_bills WHERE id=$1',
      [bill.billId])).rows[0].balance_minor),6400);
    const lotItem=await catalog.createItem(database,ctx,{name:'Ask Lot Material',baseCode:'ASK-LOT',trackingMode:'lot'});
    await inventory.receive(database,ctx,{skuId:lotItem.skuIds[0],locationId:place.id,quantity:3,
      lotCode:'ASK-LOT-BATCH',idempotencyKey:'ask-return-lot-opening'});
    const lotPo=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,
      destinationLocationId:place.id,orderDate:'2026-09-22',idempotencyKey:'ask-return-lot-po',
      lines:[{skuId:lotItem.skuIds[0],quantityUnits:3,unitCost:4,destinationLocationId:place.id}]});
    const lotRequest=`Request return of one ASK-LOT from ${lotPo.poNumber}, physical lot ASK-LOT-BATCH`;
    plans.set(lotRequest,step('supplier_return.request',{recordReference:lotPo.poNumber,sku:'ASK-LOT',
      quantity:1,reason:'Supplier accepted lot quality concern',lotBarcode:'ASK-LOT-BATCH'}));
    const lotReturn=await ask(page,base,database,ctx.workspaceId,plans,lotRequest,'supplier_return.request');
    assert.ok((await database.query(`SELECT lot_id FROM supplier_return_lines
      WHERE supplier_return_id=$1`,[lotReturn.result.supplierReturnId])).rows[0].lot_id);
    const serialItem=await catalog.createItem(database,ctx,{name:'Ask Serial Device',baseCode:'ASK-SERIAL',trackingMode:'serial'});
    await inventory.receive(database,ctx,{skuId:serialItem.skuIds[0],locationId:place.id,quantity:2,
      serials:['ASK-SERIAL-A','ASK-SERIAL-B'],idempotencyKey:'ask-return-serial-opening'});
    const serialPo=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,
      destinationLocationId:place.id,orderDate:'2026-09-22',idempotencyKey:'ask-return-serial-po',
      lines:[{skuId:serialItem.skuIds[0],quantityUnits:2,unitCost:30,destinationLocationId:place.id}]});
    const serialRequest=`Request return of two ASK-SERIAL from ${serialPo.poNumber}, serials ASK-SERIAL-A and ASK-SERIAL-B`;
    plans.set(serialRequest,step('supplier_return.request',{recordReference:serialPo.poNumber,sku:'ASK-SERIAL',
      quantity:2,reason:'Supplier accepted device defects',serialNumbers:'ASK-SERIAL-A, ASK-SERIAL-B'}));
    const serialReturn=await ask(page,base,database,ctx.workspaceId,plans,serialRequest,'supplier_return.request');
    const serialLine=(await database.query(`SELECT serial_unit_ids FROM supplier_return_lines
      WHERE supplier_return_id=$1`,[serialReturn.result.supplierReturnId])).rows[0];
    assert.equal((typeof serialLine.serial_unit_ids==='string'
      ?JSON.parse(serialLine.serial_unit_ids):serialLine.serial_unit_ids).length,2);
    const customer=await commerce.createCustomer(database,ctx,{name:'Ask Buyer',email:'buyer@example.test'});
    const order=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,orderDate:'2026-09-23',
      fulfillmentLocationId:place.id,deliveryMethod:'PICKUP',idempotencyKey:'ask-physical-order',
      lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:2500}]});
    await workflows.confirmSalesOrder(database,ctx,order.salesOrderId,{idempotencyKey:'ask-physical-confirm'});
    const waveMessage=`Release order ${order.orderNumber} as a warehouse pick wave`;
    plans.set(waveMessage,step('warehouse.wave.create',{
      recordReference:order.orderNumber,strategy:'pick_by_order'}));
    const waveResult=await ask(page,base,database,ctx.workspaceId,plans,waveMessage,'warehouse.wave.create');
    const waveId=waveResult.result.waveId;
    const wave=(await database.query('SELECT title FROM fulfillment_waves WHERE id=$1',[waveId])).rows[0];
    const scan=`Scan two ASK-BARCODE from PICK-BIN into ${wave.title}`;
    plans.set(scan,step('warehouse.wave.scan',{recordReference:wave.title,scanItem:'ASK-BARCODE',
      scanLocation:'PICK-BIN',quantity:2}));
    await ask(page,base,database,ctx.workspaceId,plans,scan,'warehouse.wave.scan');
    assert.equal(Number((await database.query('SELECT picked_quantity FROM fulfillment_wave_lines WHERE wave_id=$1',
      [waveId])).rows[0].picked_quantity),2);
    const pack=`Pack the scanned carton in ${wave.title}, measured at 900 grams`;
    plans.set(pack,step('warehouse.wave.pack',{recordReference:wave.title,weightGrams:900}));
    await ask(page,base,database,ctx.workspaceId,plans,pack,'warehouse.wave.pack');
    assert.equal((await database.query('SELECT status FROM fulfillment_waves WHERE id=$1',[waveId])).rows[0].status,'PACKED');
    const refresh=`Verify shipment outcomes for ${wave.title}`;
    plans.set(refresh,step('warehouse.wave.refresh',{recordReference:wave.title}));
    await ask(page,base,database,ctx.workspaceId,plans,refresh,'warehouse.wave.refresh');
    assert.equal((await database.query('SELECT status FROM fulfillment_waves WHERE id=$1',[waveId])).rows[0].status,'PACKED',
      'A packed carton cannot make the wave complete before physical shipment.');
    const shortOrder=await workflows.createSalesOrder(database,ctx,{customerId:customer.id,orderDate:'2026-09-23',
      fulfillmentLocationId:place.id,deliveryMethod:'PICKUP',idempotencyKey:'ask-physical-short-order',
      lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:2500}]});
    await workflows.confirmSalesOrder(database,ctx,shortOrder.salesOrderId,{idempotencyKey:'ask-physical-short-confirm'});
    const shortRelease=`Release ${shortOrder.orderNumber} to a separate pick wave`;
    plans.set(shortRelease,step('warehouse.wave.create',{recordReference:shortOrder.orderNumber}));
    const shortWaveId=(await ask(page,base,database,ctx.workspaceId,plans,shortRelease,'warehouse.wave.create'))
      .result.waveId;
    const shortWave=(await database.query('SELECT title FROM fulfillment_waves WHERE id=$1',[shortWaveId])).rows[0];
    const shortage=`Only zero ASK-WIDGET units are physically at the pick bin for ${shortWave.title}; block the wave`;
    plans.set(shortage,step('warehouse.wave.shortage',{recordReference:shortWave.title,sku:'ASK-WIDGET',
      foundQuantity:0,reason:'Physical bin was empty'}));
    await ask(page,base,database,ctx.workspaceId,plans,shortage,'warehouse.wave.shortage');
    assert.equal((await database.query('SELECT status FROM fulfillment_waves WHERE id=$1',[shortWaveId])).rows[0].status,'BLOCKED');
    const account=(await database.query(`SELECT id FROM accounting_accounts WHERE workspace_id=$1
      AND system_key='CASH' LIMIT 1`,[ctx.workspaceId])).rows[0];
    assert.ok(account);
    const bankId=newId('bank');
    await database.query(`INSERT INTO accounting_bank_accounts
      (id,workspace_id,name,account_kind,currency,ledger_account_id,active,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,'Ask Bank','BANK','USD',$3,1,$4,$5,$5)`,
    [bankId,ctx.workspaceId,account.id,ctx.actorId,nowIso()]);
    const bankImport=`Import October 1 bank line BANK-ASK-1 for $10 into Ask Bank`;
    plans.set(bankImport,step('accounting.bank_import',{recordReference:'Ask Bank',transactionDate:'2026-10-01',
      amount:'10.00',description:'Customer deposit',externalId:'BANK-ASK-1'}));
    await ask(page,base,database,ctx.workspaceId,plans,bankImport,'accounting.bank_import');
    assert.equal((await database.query('SELECT status FROM accounting_bank_transactions WHERE bank_account_id=$1',
      [bankId])).rows[0].status,'UNMATCHED');
    const reconcile=`Save Ask Bank reconciliation through 2026-10-01 with ending balance $10 for review`;
    plans.set(reconcile,step('accounting.reconcile',{recordReference:'Ask Bank',statementEndDate:'2026-10-01',
      statementEndingBalance:'10.00',enabled:'false'}));
    await ask(page,base,database,ctx.workspaceId,plans,reconcile,'accounting.reconcile');
    assert.equal((await database.query('SELECT status FROM accounting_reconciliations WHERE bank_account_id=$1',
      [bankId])).rows[0].status,'IN_PROGRESS');
    const deposit=await ledger.post(database,ctx,{postingDate:'2026-10-01',sourceKey:'ask-bank-match-evidence',
      description:'Verified bank deposit',sourceType:'manual_certification',createdByType:'USER',lines:[
        {accountKey:'CASH',debitMinor:1000},{accountKey:'OPERATING_EXPENSE',creditMinor:1000}]});
    const match=`Match bank line BANK-ASK-1 to posted journal ${deposit.entry.id}`;
    plans.set(match,step('accounting.bank_match',{recordReference:'BANK-ASK-1',mode:'journal',
      reference:deposit.entry.id}));
    await ask(page,base,database,ctx.workspaceId,plans,match,'accounting.bank_match');
    assert.equal((await database.query('SELECT status FROM accounting_bank_transactions WHERE bank_account_id=$1',
      [bankId])).rows[0].status,'MATCHED');
    const complete=`Complete Ask Bank statement through 2026-10-01 at $10 ending balance`;
    plans.set(complete,step('accounting.reconcile',{recordReference:'Ask Bank',statementEndDate:'2026-10-01',
      statementEndingBalance:'10.00',enabled:'true'}));
    await ask(page,base,database,ctx.workspaceId,plans,complete,'accounting.reconcile');
    assert.equal((await database.query('SELECT status FROM accounting_reconciliations WHERE bank_account_id=$1',
      [bankId])).rows[0].status,'COMPLETED');
    assert.equal((await database.query('SELECT status FROM accounting_bank_transactions WHERE bank_account_id=$1',
      [bankId])).rows[0].status,'RECONCILED');
    const unbalanced=(await database.query(`SELECT COUNT(*)::int AS count FROM accounting_journal_entries e
      JOIN accounting_journal_lines l ON l.entry_id=e.id WHERE e.workspace_id=$1
      GROUP BY e.id HAVING SUM(l.debit_minor)<>SUM(l.credit_minor)`,[ctx.workspaceId])).rows;
    assert.equal(unbalanced.length,0);
    assert.equal(Number((await database.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2',
      [ctx.workspaceId,item.skuIds[0]])).rows[0].on_hand),8,
    'Picking and packing must not silently move stock.');
  });
