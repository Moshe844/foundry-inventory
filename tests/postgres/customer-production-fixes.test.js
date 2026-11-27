'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('SKU searches cover the full tenant catalogue and customer credit terms persist exactly',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,csrf}=f;await f.subscribe('growth');
 await db.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,created_at,updated_at)
  SELECT 'picker-item-'||n,$1,'Search product '||lpad(n::text,4,'0'),'PICKER-'||n,'quantity',$2,$2 FROM generate_series(1,520)n`,[ctx.workspaceId,new Date().toISOString()]);
 await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,barcode,is_default,created_at)
  SELECT 'picker-sku-'||n,$1,'picker-item-'||n,'PICKER-'||n,'SCAN-'||n,1,$2 FROM generate_series(1,520)n`,[ctx.workspaceId,new Date().toISOString()]);
 const catalog=require('../../src/domain/postgres-catalog-service'),foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other',email:randomUUID()+'@example.test',password:f.password});
 await catalog.createItem(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},{name:'Foreign secret',baseCode:'PICKER-FOREIGN',trackingMode:'quantity'});
 for(const path of ['/sales/pricing/products/search','/suppliers/fixture-supplier/catalogue/search']){
  const initial=await browser.get(path);assert.equal(initial.status,200,initial.text);assert(initial.body.products.length<=50);
  const found=await browser.get(path).query({q:'PICKER-520'});assert.equal(found.status,200,found.text);assert.deepEqual(found.body.products.map(p=>p.id),['picker-sku-520']);
  const scanned=await browser.get(path).query({q:'SCAN-520'});assert.deepEqual(scanned.body.products.map(p=>p.id),['picker-sku-520']);
  assert.equal((await browser.get(path).query({q:'FOREIGN'})).body.products.length,0);
 }
 const pricing=await browser.get('/sales/pricing/rules/new');assert.equal(pricing.status,200);assert.equal((pricing.text.match(/data-async-sku/g)||[]).length,14);assert(!pricing.text.includes('PICKER-520'),'No full catalogue repeated in HTML');
 const promotions=require('../../src/pricing/postgres-promotions');
 const proposal=await promotions.propose(db,ctx,{kind:'promotion',name:'Saved product scope',currency:'USD',scope:{skuIds:['picker-sku-520']},discount:{type:'percent',value:1000}});
 await promotions.decide(db,ctx,proposal.id,proposal.integrity_hash,true);
 await db.query("UPDATE items SET is_active=0 WHERE workspace_id=$1 AND id='picker-item-520'",[ctx.workspaceId]);
 const edit=await browser.get('/sales/pricing/rules/'+proposal.rule_id+'/edit');assert.equal(edit.status,200);assert(edit.text.includes('<option value="picker-sku-520">'),'An archived saved selection must not disappear and broaden the rule to every product');
 const supplier=await browser.get('/suppliers/fixture-supplier');assert.equal(supplier.status,200);assert(supplier.text.includes('data-async-sku'));assert(!supplier.text.includes('PICKER-520'));
 const commerce=require('../../src/operations/postgres-commerce');
 const firstPage=await browser.get('/sales/customers/fixture-customer');assert.equal(firstPage.status,200);
 const firstSave=await browser.post('/sales/customers/fixture-customer/payment-terms').type('form').send({_csrf:csrf(firstPage.text),kind:'ON_ACCOUNT',netDays:'30',creditLimit:'1234.56',expectedUpdatedAt:''});assert.equal(firstSave.status,303,firstSave.text);
 const firstTerms=await require('../../src/sales/customer-commercial-terms').current(db,ctx.workspaceId,'fixture-customer');assert.equal(Number(firstTerms.credit_limit_minor),123456);assert.equal(Number(firstTerms.net_days),30);
 const firstAudit=(await db.query("SELECT before_state,after_state FROM security_event_history WHERE workspace_id=$1 AND action='Saved customer payment terms' AND reference='fixture-customer'",[ctx.workspaceId])).rows;assert.equal(firstAudit.length,1);assert.deepEqual(firstAudit[0].before_state,{});assert.equal(Number(firstAudit[0].after_state.credit_limit_minor),123456);
 const created=await commerce.createCustomer(db,ctx,{name:'Credit buyer',termsKind:'ON_ACCOUNT',netDays:'45',creditLimit:'1234.56'});
 let terms=await require('../../src/sales/customer-commercial-terms').current(db,ctx.workspaceId,created.id);assert.equal(Number(terms.credit_limit_minor),123456);assert.equal(Number(terms.net_days),45);
 let page=await browser.get('/sales/customers/'+created.id);assert.equal(page.status,200);assert.match(page.text,/name="creditLimit"[^>]*value="1234.56"/);
 const saved=await browser.post('/sales/customers/'+created.id+'/payment-terms').type('form').send({_csrf:csrf(page.text),kind:'ON_ACCOUNT',netDays:'60',creditLimit:'0',creditApproved:'1',expectedUpdatedAt:terms.updated_at});assert.equal(saved.status,303,saved.text);
 terms=await require('../../src/sales/customer-commercial-terms').current(db,ctx.workspaceId,created.id);assert.equal(Number(terms.credit_limit_minor),0);assert.equal(Number(terms.net_days),60);
 const list=await browser.get('/sales/customers');assert.equal(list.status,200);assert(list.text.includes('Net 60 days'));assert(list.text.includes('Credit limit'));
 const workflow=await require('../../src/operations/postgres-business-workflows').createSalesOrder(db,ctx,{customerId:created.id,deliveryMethod:'PICKUP',currency:'USD',idempotencyKey:'credit-display',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:100}]});
 page=await browser.get('/orders/'+workflow.salesOrderId);assert.equal(page.status,200,page.text.slice(0,200));assert(page.text.includes('Net 60 days'));assert(page.text.includes('Customer credit limit:'));
 const orders=await browser.get('/orders');assert.equal(orders.status,200);assert(orders.text.includes('Customer terms: Net 60 days'));
 await db.query(`INSERT INTO work_items(id,workspace_id,category,source,recommended_action,execution_status,approval_requirement,idempotency_key,created_at,completed_at) VALUES('shared-history',$1,'customer_order','postgres_workflow_owner','{"type":"customer_order","displayName":"Customer order review"}','COMPLETED','REQUIRED','shared-history',$2,$2)`,[ctx.workspaceId,new Date().toISOString()]);
 const history=await browser.get('/autopilot/history?days=7');assert.equal(history.status,200,history.text.slice(0,300));assert(history.text.includes('Completed Customer order review'));assert(history.text.includes('1 resolved after approval'));
 const historyService=require('../../src/autopilot/postgres-service');
 assert(!(await historyService.workHistory(db,ctx.workspaceId,null,{days:7})).recent.some(row=>row.id==='shared-history'),'Existing staff history does not gain unrelated workflow details');
 assert((await historyService.workHistory(db,ctx.workspaceId,null,{days:7,includeAll:true})).recent.some(row=>row.id==='shared-history'),'Owner history includes the work counted on Home');
 await assert.rejects(()=>commerce.createCustomer(db,ctx,{name:'Negative limit',creditLimit:'-1'}),/non-negative|negative/);
 const summary=await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'inventory_summary'},{question:'What are the total on-hand units across all products?'});assert(summary.answer.includes('units on hand'));assert.equal(summary.rows[0].onHand,4);
});
