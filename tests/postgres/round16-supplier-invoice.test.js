'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
test('one supplier invoice bills every received variant and only remaining quantities are offered',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),flows=f.workflows,issueDate=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const product=await catalog.createItem(db,ctx,{name:'Lotion delivery',baseCode:'LOTION-BILL',hasVariants:true,trackingMode:'quantity',options:[{name:'Scent',values:'Rose,Plain,Citrus'}]});
 const quantities=[3,5,2],costs=[10,20,30],po=await flows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:'multi-invoice-po',lines:product.skuIds.map((skuId,i)=>({skuId,quantityUnits:quantities[i],unitCost:costs[i]}))});
 await flows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'multi-invoice-approve'});await flows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'multi-invoice-place'});await flows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'multi-invoice-receive',reference:'Delivery',lines:po.lineIds.map((lineId,i)=>({lineId,quantity:quantities[i],locationId:f.location.id}))});
 await flows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:po.purchaseOrderId,supplierInvoiceNumber:'PARTIAL-1',issueDate,currency:'USD',idempotencyKey:'partial-first-line',lines:[{purchaseOrderLineId:po.lineIds[0],skuId:product.skuIds[0],quantity:1,unitCostMinor:1000}]});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'multi-supplier-invoice'});f.cleanup(()=>app.locals.sessionStore.close());const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password});
 const path='/purchasing/orders/'+po.purchaseOrderId,page=await agent.get(path);assert.equal(page.status,200);
 for(let i=0;i<3;i++){assert(page.text.includes('name="invoiceQuantity['+po.lineIds[i]+']"'));assert(page.text.includes('name="invoiceUnitCost['+po.lineIds[i]+']"'));}
 assert(page.text.includes('value="2"'),'The already-billed first unit is excluded');
 const stockBefore=await f.balance(),form={_csrf:csrf(page.text),idempotencyKey:'whole-delivery-invoice',supplierInvoiceNumber:'DELIVERY-2',issueDate,tax:'0.00',invoiceQuantity:Object.fromEntries(po.lineIds.map((id,i)=>[id,String(quantities[i]-(i===0?1:0))])),invoiceUnitCost:Object.fromEntries(po.lineIds.map((id,i)=>[id,String(costs[i])]))};
 await agent.post(path+'/invoices').type('form').send(form).expect(303);await agent.post(path+'/invoices').type('form').send(form).expect(303);
 const bill=(await db.query("SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND supplier_invoice_number='DELIVERY-2'",[ctx.workspaceId])).rows[0];assert.equal(bill.status,'OPEN');assert.equal(Number(bill.total_minor),18000);
 const lines=(await db.query('SELECT * FROM accounting_supplier_bill_lines WHERE workspace_id=$1 AND bill_id=$2',[ctx.workspaceId,bill.id])).rows;assert.equal(lines.length,3);assert.equal(lines.reduce((n,l)=>n+Number(l.quantity),0),9);
 const after=await agent.get(path);assert.equal(after.status,200);assert(!after.text.includes('name="invoiceQuantity['),'Fully billed variants must not be offered again');assert.equal(await f.balance(),stockBefore);
 const receivedUnbilled=await require('../../src/accounting/customer-money').snapshot(db,ctx.workspaceId);assert.equal(receivedUnbilled.receivedNotBilledMinor,400,'Only the separate fixture delivery remains unbilled');
});
