'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('packing-slip quantities fill one physical receiving approval with PO costs and duplicate-source protection',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser,workflows}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const assistant=require('../../src/assistant/postgres-service'),imports=require('../../src/imports/postgres-service'),sku=f.item.skuIds[0],item=(await db.query('SELECT s.code,i.name FROM skus s JOIN items i ON i.id=s.item_id WHERE s.id=$1',[sku])).rows[0];
 const makePO=async()=>{const p=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:12,quantityPurchaseUnits:4,unitsPerPurchaseUnit:3,unitCost:2}]});await workflows.approvePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});return {...p,number:(await db.query('SELECT po_number FROM purchase_orders WHERE id=$1',[p.purchaseOrderId])).rows[0].po_number};};
 const po=await makePO(),text='Product,SKU,Delivered qty,PO\n'+item.name+','+item.code+',2,'+po.number;
 const source=await imports.analyse(db,ctx,{filename:'Packing slip.csv',text,allowModel:false,mappings:{name:0,code:1,quantity:2}});
 const request={action:'purchase_order.receive_from_document',recordReference:po.number,sourceImport:source.id,receivingBasis:'purchase'},prepare=()=>assistant.prepareAction(db,ctx,'Fill receiving from the packing slip',request);
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);if(tier==='starter'){await assert.rejects(prepare(),e=>e.code==='entitlement_required');await browser.get('/autopilot/reviews/receiving-forms').expect(402);continue;}
  const p=await prepare();assert.match(p.proposal.summary,/6 ×/);assert.match(p.proposal.summary,/\$2.00 each/);
  await browser.get('/autopilot/reviews/receiving-forms').expect(200);
 }
 const p=await prepare(),page=await browser.get('/actions/'+p.proposal.id).expect(200);assert.match(page.text,/6 units at/);assert(!page.text.includes('<dt>Fingerprint</dt>'));
 const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 await plans.save(db,ctx,'Receive the recorded delivery then inspect stock',randomUUID(),[
  {contract:registry.get(request.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}
 ],[{result:p},{result:{status:'CLARIFY'}}]);await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),/own confirmation/);
 await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),e=>e.code==='entitlement_required');
 await subscribe('growth');assert.equal(await f.balance(),4);
 const held=await db.withSessionLock('catalog:'+ctx.workspaceId,async()=>{await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),/import or product update/);return true;});assert(held);
 const received=await assistant.executeProposal(db,ctx,p.proposal.id);await assistant.executeProposal(db,ctx,p.proposal.id);assert(received.result.receiptId);
 assert((await require('../../src/autopilot/job-reviews').run(db,ctx,'receiving-forms')).rows.every(r=>r.Status==='Goods received'));
 assert.equal(await f.balance(),10);assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].total_cost_minor,'1600');
 assert.equal(Number((await db.query('SELECT quantity_received_units FROM purchase_order_lines WHERE id=$1',[po.lineIds[0]])).rows[0].quantity_received_units),6);
 const clone=await imports.analyse(db,ctx,{filename:'Same slip renamed.csv',text,allowModel:false,mappings:{name:0,code:1,quantity:2}});assert.equal(clone.sourceHash,source.sourceHash);
 await assert.rejects(imports.approve(db,ctx,clone.id,clone.integrityHash),/purchase receipt/);
 const clonePage=await browser.get('/imports/'+clone.id).expect(200);assert.match(clonePage.text,/Delivery recorded against a purchase order/);
 assert(!clonePage.text.includes('/revise"'));await assert.rejects(imports.revise(db,ctx,source.id,{expectedHash:source.integrityHash,importMode:'add'}),/purchase receipt/);
 const again=await assistant.prepareAction(db,ctx,'Review the same slip',{...request,sourceImport:clone.id});await assistant.executeProposal(db,ctx,again.proposal.id);assert.equal(await f.balance(),10);
 const other=await makePO();await assert.rejects(assistant.prepareAction(db,ctx,'Use this slip again',{...request,recordReference:other.number,sourceImport:clone.id}),/another recorded receipt/);
 const changed=await imports.analyse(db,ctx,{filename:'Too many cases.csv',text:text.replace(',2,',',5,'),allowModel:false,mappings:{name:0,code:1,quantity:2}});
 await assert.rejects(assistant.prepareAction(db,ctx,'Review an excessive quantity',{...request,sourceImport:changed.id}),/exceeds the units still due/);
 assert.equal(await f.balance(),10);
 const pdf=new (require('pdfkit'))({size:'A4',margin:0,compress:false}),chunks=[];pdf.on('data',b=>chunks.push(b));const finished=new Promise((resolve,reject)=>{pdf.on('end',resolve);pdf.on('error',reject);});
 pdf.fontSize(10);for(const [value,x]of [['Product',40],['SKU',200],['Delivered qty',350],['PO',455]])pdf.text(value,x,50,{width:135});
 for(const [value,x]of [[item.name,40],[item.code,200],['3',350],[other.number,455]])pdf.text(value,x,80,{width:135});pdf.end();await finished;
 const pdfSource=await imports.analyse(db,ctx,{filename:'Delivery note.pdf',buffer:Buffer.concat(chunks),allowModel:false,mappings:{name:0,code:1,quantity:2}});
 const pdfReceipt=await assistant.prepareAction(db,ctx,'Fill receiving from this PDF',{...request,recordReference:other.number,sourceImport:pdfSource.id,receivingBasis:'stock'});
 assert.match(pdfReceipt.proposal.summary,/3 ×/);await assistant.executeProposal(db,ctx,pdfReceipt.proposal.id);await assistant.executeProposal(db,ctx,pdfReceipt.proposal.id);
 assert.equal(await f.balance(),13);assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].total_cost_minor,'2200');
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_supplier_bills WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 const editable=await imports.analyse(db,ctx,{filename:'Next delivery.csv',text:text.replace(',2,',',1,'),allowModel:false,mappings:{name:0,code:1,quantity:2}});
 const stale=await assistant.prepareAction(db,ctx,'Review the next delivery',{...request,sourceImport:editable.id,receivingBasis:'stock'});
 await db.query("UPDATE import_rows SET parsed=(parsed::jsonb||'{\"quantity\":2}')::text WHERE workspace_id=$1 AND import_id=$2",[ctx.workspaceId,editable.id]);
 await assert.rejects(assistant.executeProposal(db,ctx,stale.proposal.id),/source or PO changed/);
 const wrong=await imports.analyse(db,ctx,{filename:'Wrong PO.csv',text:text.replace(po.number,'PO-DOES-NOT-MATCH'),allowModel:false,mappings:{name:0,code:1,quantity:2}});
 await assert.rejects(assistant.prepareAction(db,ctx,'Review wrong order reference',{...request,sourceImport:wrong.id}),/reference on the slip differs/);assert.equal(await f.balance(),13);
});

test('receiving a reviewed delivery document preserves lot and individual serial identities',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,workflows}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const catalog=require('../../src/domain/postgres-catalog-service'),lot=await catalog.createItem(db,ctx,{name:'Received lot',baseCode:'RCV-LOT',trackingMode:'lot'}),serial=await catalog.createItem(db,ctx,{name:'Received serial',baseCode:'RCV-SERIAL',trackingMode:'serial'});
 const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId:lot.skuIds[0],quantityUnits:2,unitCost:2},{skuId:serial.skuIds[0],quantityUnits:2,unitCost:2}]});
 await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 const number=(await db.query('SELECT po_number FROM purchase_orders WHERE id=$1',[po.purchaseOrderId])).rows[0].po_number;
 const text='Product,SKU,Quantity,Lot,Serial,Unit cost,PO\nReceived lot,RCV-LOT,2,LOT-R-1,,2,'+number+'\nReceived serial,RCV-SERIAL,1,,RCV-S-001,2,'+number+'\nReceived serial,RCV-SERIAL,1,,RCV-S-002,2,'+number;
 const source=await require('../../src/imports/postgres-service').analyse(db,ctx,{filename:'Tracked delivery.csv',text,allowModel:false,mappings:{name:0,code:1,quantity:2,lotCode:3,serial:4,unitCost:5}});
 const assistant=require('../../src/assistant/postgres-service'),prepared=await assistant.prepareAction(db,ctx,'Record the physically counted tracked delivery',{action:'purchase_order.receive_from_document',recordReference:number,sourceImport:source.id,receivingBasis:'stock'});
 await assistant.executeProposal(db,ctx,prepared.proposal.id);await assistant.executeProposal(db,ctx,prepared.proposal.id);
 assert.equal(await f.balance(),8);
 assert.equal(Number((await db.query('SELECT quantity FROM lot_balances b JOIN lots l ON l.id=b.lot_id WHERE b.workspace_id=$1 AND l.code=$2',[ctx.workspaceId,'LOT-R-1'])).rows[0].quantity),2);
 const units=(await db.query("SELECT serial,status,location_id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 ORDER BY serial",[ctx.workspaceId,serial.skuIds[0]])).rows;
 assert.deepEqual(units.map(s=>s.serial),['RCV-S-001','RCV-S-002']);assert(units.every(s=>s.status==='in_stock'&&s.location_id===f.location.id));
 assert.equal(Number((await db.query('SELECT sum(total_cost_minor) n FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),1200);
});
