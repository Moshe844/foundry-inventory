'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');

function fields(overrides={}){
  return {intent:'lookup',view:'inventory',action:null,search:null,sku:null,location:null,fromLocation:null,toLocation:null,
    quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,reference:null,recipient:'',recipientKind:'',
    subject:'',body:'',mailbox:'',customer:'',supplier:'',deliveryMethod:'',shipToAddress:'',neededBy:'',purchaseOrder:'',
    supplierBill:'',receiptReference:'',paymentMethod:'',paymentDate:'',...overrides};
}

const provider={name:'fixture',model:'fixture',async complete(request){
  const message=JSON.parse(request.prompt).message;
  if(message==='Receive without evidence')return {data:fields({intent:'action',view:null,action:'receive_purchase_order',
    purchaseOrder:'PO-00001',supplier:'Safe Supply',sku:'SHOE-9',quantity:6,location:'Main Warehouse'}),usage:{}};
  if(message==='Receive the proven delivery')return {data:fields({intent:'action',view:null,action:'receive_purchase_order',
    purchaseOrder:'PO-00001',supplier:'Safe Supply',sku:'SHOE-9',quantity:6,location:'Main Warehouse',
    receiptReference:'DN-ASK-1'}),usage:{}};
  if(message==='Pay the supplier without naming the bill')return {data:fields({intent:'action',view:null,
    action:'record_supplier_payment',supplier:'Safe Supply',amount:18,currency:'USD',paymentMethod:'ACH',
    paymentDate:'2026-10-01'}),usage:{}};
  if(message==='Record the proven supplier payment')return {data:fields({intent:'action',view:null,
    action:'record_supplier_payment',supplier:'Safe Supply',supplierBill:'BILL-00001',amount:18,currency:'USD',
    paymentMethod:'ACH',paymentDate:'2026-10-01',reference:'BANK-77'}),usage:{}};
  return {data:fields(),usage:{}};
}};

async function register(page,base){
  await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Ask Receiving Business');
  await page.getByLabel('Your name').fill('Receiving Owner');await page.getByLabel('Work email').fill('ask-receiving@example.test');
  await page.getByLabel('Password').fill('ask-receiving-password');
  await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
}

async function ask(page,base,message){
  await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(message);
  await Promise.all([page.waitForURL(/\/ask#latest$/),page.getByRole('button',{name:'Continue'}).click()]);
  return page.locator('main').innerText();
}

test('real Chromium Ask StockChief safely receives a PO and records one supplier payment',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,
      {applicationName:'stockchief-ask-receiving-payments-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',
      sessionSecret:'ask-receiving-secret',aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();const browserContext=await browser.newContext();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;const page=await browserContext.newPage();
    await register(page,base);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name='Ask Receiving Business'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Main Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Safety Shoe',baseCode:'SHOE',trackingMode:'quantity',
      hasVariants:true,options:[{name:'Size',values:'9'}]});
    const skuId=item.skuIds[0];
    const supplier=await commerce.createSupplier(database,ctx,{name:'Safe Supply',email:'safe@supplier.example',currency:'USD'});
    const purchase=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,destinationLocationId:location.id,
      idempotencyKey:'ask-receiving:po',lines:[{skuId,quantityUnits:10,unitCost:8,destinationLocationId:location.id}]});
    assert.equal(purchase.poNumber,'PO-00001');
    await workflows.approvePurchaseOrder(database,ctx,purchase.purchaseOrderId,{idempotencyKey:'ask-receiving:approve'});
    await workflows.placePurchaseOrder(database,ctx,purchase.purchaseOrderId,{idempotencyKey:'ask-receiving:place'});

    let text=await ask(page,base,'Receive without evidence');
    assert.match(text,/What delivery note, packing slip, or receipt reference proves this arrival/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].count,'0');

    text=await ask(page,base,'Receive the proven delivery');
    assert.match(text,/Receive 6 × Safety Shoe · 9 on PO-00001 into Main Warehouse, supported by DN-ASK-1/);
    assert.match(text,/Nothing has changed yet/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].count,'0');
    let proposalHref=await page.locator('a',{hasText:'Review prepared change'}).last().getAttribute('href');
    await page.goto(`${base}${proposalHref}`);assert.match(await page.locator('main').innerText(),/purchase_order\.receive/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,skuId,location.id])).rows[0].on_hand),6);
    assert.equal((await database.query(`SELECT status FROM purchase_orders WHERE id=$1`,[purchase.purchaseOrderId])).rows[0].status,
      'PARTIALLY_RECEIVED');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM purchase_order_receipts WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].count,'1');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_journal_entries
      WHERE workspace_id=$1 AND source_type='purchase_receipt'`,[ctx.workspaceId])).rows[0].count,'1');
    const receiptCsrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    assert.equal((await page.request.post(`${base}${proposalHref}/approve`,{form:{_csrf:receiptCsrf},maxRedirects:0})).status(),303);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].count,'1');
    assert.equal(await page.getByRole('link',{name:'Continue purchase order'}).count(),1);

    const bill=await workflows.recordSupplierInvoice(database,ctx,{supplierId:supplier.id,purchaseOrderId:purchase.purchaseOrderId,
      supplierInvoiceNumber:'SUP-ASK-1',issueDate:'2026-10-01',idempotencyKey:'ask-receiving:bill',
      lines:[{purchaseOrderLineId:purchase.lineIds[0],skuId,quantity:6,unitCostMinor:800,description:'Safety shoes'}]});
    assert.equal(bill.billNumber,'BILL-00001');assert.equal(bill.balanceMinor,4800);
    const onHandBeforePayment=Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2
      AND location_id=$3`,[ctx.workspaceId,skuId,location.id])).rows[0].on_hand);

    text=await ask(page,base,'Pay the supplier without naming the bill');
    assert.match(text,/Which exact supplier bill or supplier invoice number was paid/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_payments WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].count,'0');

    text=await ask(page,base,'Record the proven supplier payment');
    assert.match(text,/Record \$18\.00 paid to Safe Supply against BILL-00001 on 2026-10-01 by ACH/);
    assert.match(text,/Inventory will not change/);assert.match(text,/Nothing has changed yet/);
    proposalHref=await page.locator('a',{hasText:'Review prepared change'}).last().getAttribute('href');
    await page.goto(`${base}${proposalHref}`);assert.match(await page.locator('main').innerText(),/supplier_payment\.record/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and execute'}).click()]);
    const payment=(await database.query(`SELECT * FROM accounting_payments WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.deepEqual({supplier:payment.supplier_id,amount:Number(payment.amount_minor),method:payment.method,
      reference:payment.reference,status:payment.status},{supplier:supplier.id,amount:1800,method:'ACH',reference:'BANK-77',status:'POSTED'});
    const paidBill=(await database.query(`SELECT status,balance_minor FROM accounting_supplier_bills WHERE id=$1`,[bill.billId])).rows[0];
    assert.deepEqual({status:paidBill.status,balance:Number(paidBill.balance_minor)},{status:'PARTIALLY_PAID',balance:3000});
    assert.equal(Number((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
      [ctx.workspaceId,skuId,location.id])).rows[0].on_hand),onHandBeforePayment);
    assert.equal(await page.getByRole('link',{name:'View accounting proof'}).count(),1);
    const paymentCsrf=await page.locator('input[name="_csrf"]').first().getAttribute('value');
    assert.equal((await page.request.post(`${base}${proposalHref}/approve`,{form:{_csrf:paymentCsrf},maxRedirects:0})).status(),303);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM accounting_payments WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].count,'1');
    await page.getByRole('link',{name:'View accounting proof'}).click();await page.waitForURL(/\/accounting\/entries\//);
    assert.match(await page.locator('main').innerText(),/Supplier payment/);
  });
