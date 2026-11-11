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
 const {payload:current}=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',
   [ctx.workspaceId,p.proposal.id])).rows[0];
 const {fingerprintVersion,legacyFingerprint,...legacy}=current;
 legacy.fingerprint=legacyFingerprint;
 legacy.receiving=legacy.receiving.map(({variantLabel,unit,secondaryUnit,secondaryQuantity,serialWeights,...row})=>row);
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET payload=$3::jsonb WHERE workspace_id=$1 AND id=$2',
   [ctx.workspaceId,p.proposal.id,JSON.stringify(legacy)]);
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

test('one checked packing slip receives split purchase lines, multiple batches, actual serial weights and fractional stock',{timeout:720000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,workflows,browser}=f;
 await subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const overflow=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Overflow receiving',kind:'warehouse'});
 const catalog=require('../../src/domain/postgres-catalog-service');
 const lot=await catalog.createItem(db,ctx,{name:'Measured batches',baseCode:'SLIP-BATCH',trackingMode:'lot',
   unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
 const serial=await catalog.createItem(db,ctx,{name:'Measured serials',baseCode:'SLIP-SERIAL',trackingMode:'serial',
   unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
 const decimal=await catalog.createItem(db,ctx,{name:'Fractional roll',baseCode:'SLIP-ROLL',trackingMode:'quantity',
   unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'});
 const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,currency:'USD',
   idempotencyKey:randomUUID(),lines:[
     {skuId:lot.skuIds[0],quantityUnits:3,secondaryQuantity:'3.75',unitCost:'2.50'},
     {skuId:lot.skuIds[0],quantityUnits:1,secondaryQuantity:'1.50',unitCost:'2.50',destinationLocationId:overflow.id},
     {skuId:serial.skuIds[0],quantityUnits:2,secondaryQuantity:'2.35',unitCost:'4.00'},
     {skuId:decimal.skuIds[0],quantityUnits:'1.25',unitCost:'3.50'}
   ]});
 await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
 const expiry=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
 const rows=[
   ['Measured batches','SLIP-BATCH','1','piece','SLIP-A','','1.25',po.poNumber,'1','Dispatch',expiry],
   ['Measured batches','SLIP-BATCH','2','piece','SLIP-B','','2.50',po.poNumber,'1','Dispatch',expiry],
   ['Measured batches','SLIP-BATCH','1','piece','SLIP-C','','1.50',po.poNumber,'2','Overflow receiving',expiry],
   ['Measured serials','SLIP-SERIAL','1','piece','SERIAL-BATCH','WEIGHED-001','1.10',po.poNumber,'3','Dispatch',expiry],
   ['Measured serials','SLIP-SERIAL','1','piece','SERIAL-BATCH','WEIGHED-002','1.25',po.poNumber,'3','Dispatch',expiry],
   ['Fractional roll','SLIP-ROLL','0.50','m','','','',po.poNumber,'4','Dispatch',''],
   ['Fractional roll','SLIP-ROLL','0.75','m','','','',po.poNumber,'4','Dispatch','']
 ];
 const header='Product,SKU,Quantity,Unit,Lot,Serial,Weight (kg),PO,PO line,Location,Expiry';
 const text=(values=rows,names=header)=>names+'\n'+values.map(row=>row.join(',')).join('\n');
 const imports=require('../../src/imports/postgres-service'),assistant=require('../../src/assistant/postgres-service');
 async function source(contents){
   return imports.analyse(db,ctx,{filename:'Measured packing slip '+randomUUID()+'.csv',text:contents,
     allowModel:false,defaultLocationId:f.location.id,mappings:{name:0,code:1,quantity:2,unitLabel:3,lotCode:4,serial:5,location:9,expiresAt:10}});
 }
 const original=await source(text());
 const input={action:'purchase_order.receive_from_document',recordReference:po.poNumber,sourceImport:original.id,receivingBasis:'stock'};
 const prepare=extra=>assistant.prepareAction(db,ctx,'Prepare the physically counted packing slip',{...input,...extra});
 await subscribe('starter');
 await assert.rejects(prepare(),error=>error.code==='entitlement_required'&&/Growth/.test(error.message));
 const locked=await browser.get('/imports/'+original.id).expect(200);
 assert.match(locked.text,/Growth<\/span> Prepare receiving forms/);
 assert.doesNotMatch(locked.text,/name="purchaseOrder"/);
 const refused=await browser.post('/imports/'+original.id+'/receiving-form').type('form')
   .send({_csrf:f.csrf(locked.text),purchaseOrder:po.poNumber,receivingBasis:'stock'}).expect(303);
 assert.doesNotMatch(refused.headers.location,/^\/actions\//);
 assert.equal((await db.query(`SELECT count(*)::int n FROM stockchief_runtime.assistant_action_proposals
   WHERE workspace_id=$1 AND action_type='purchase_order.receive_from_document'`,[ctx.workspaceId])).rows[0].n,0);
 await subscribe('growth');
 const wrongUnit=await source(text(rows,header.replace('Weight (kg)','Weight (lb)')));
 await assert.rejects(prepare({sourceImport:wrongUnit.id}),/original actual weight in kg/);
 await assert.rejects(prepare({receivingBasis:'purchase'}),/printed quantity unit.*approved purchase pack/);
 const ambiguous=rows.map((row,index)=>index===0?row.map((value,column)=>[8,9].includes(column)?'':value):row);
 const unclearLine=await source(text(ambiguous));
 await assert.rejects(prepare({sourceImport:unclearLine.id}),/Include the PO line number or receiving warehouse/);
 const imported=await browser.get('/imports/'+original.id).expect(200);
 const ready=await browser.post('/imports/'+original.id+'/receiving-form').type('form')
   .send({_csrf:f.csrf(imported.text),purchaseOrder:po.poNumber,receivingBasis:'stock'}).expect(303);
 const first={proposal:{id:ready.headers.location.split('/').at(-1)}};
 const review=await browser.get('/actions/'+first.proposal.id).expect(200);
 assert.match(review.text,/actual 2\.35 kg/);
 assert.match(review.text,/WEIGHED-001 · 1\.1 kg/);
 assert.match(review.text,/\$4\.00 per kg/);
 assert.match(review.text,/Overflow receiving/);
 assert.match(review.text,/Confirm physical receipt/);
 const savings=require('../../src/autopilot/time-saved');
 const receiptTiming=async()=> (await savings.report(db,ctx,'week')).rows.find(row=>row.key==='receiving-document');
 assert.equal((await receiptTiming()).count,0);
 for(const plan of ['pro','enterprise']){
   await subscribe(plan);
   const prepared=await prepare();
   const {payload}=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',
     [ctx.workspaceId,prepared.proposal.id])).rows[0];
   assert.equal(payload.receiving.length,5);
 }
 await subscribe('starter');
 await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),error=>error.code==='entitlement_required');
 await subscribe('growth');
 await browser.post('/actions/'+first.proposal.id+'/approve').type('form').send({_csrf:f.csrf(review.text)}).expect(303);
 const applied=await assistant.executeProposal(db,ctx,first.proposal.id);
 const repeated=await assistant.executeProposal(db,ctx,first.proposal.id);
 assert.equal(repeated.result.receiptId,applied.result.receiptId);
 assert.equal(applied.result.status,'RECEIVED');
 assert.equal(new Set(applied.result.lines.map(line=>line.movementId)).size,5);
 assert.deepEqual(applied.result.lines.map(line=>line.totalCostMinor).sort((a,b)=>a-b),[313,375,438,625,940]);
 const batches=(await db.query(`SELECT l.code,b.location_id,b.quantity::text,b.secondary_quantity::text FROM lot_balances b
   JOIN lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id WHERE b.workspace_id=$1 AND l.sku_id=$2 ORDER BY l.code`,
   [ctx.workspaceId,lot.skuIds[0]])).rows;
 assert.deepEqual(batches.map(row=>[row.code,row.location_id,Number(row.quantity),Number(row.secondary_quantity)]),
   [['SLIP-A',f.location.id,1,1.25],['SLIP-B',f.location.id,2,2.5],['SLIP-C',overflow.id,1,1.5]]);
 const serials=(await db.query(`SELECT u.serial,u.secondary_quantity::text,l.code FROM serial_units u JOIN lots l
   ON l.workspace_id=u.workspace_id AND l.id=u.lot_id WHERE u.workspace_id=$1 AND u.sku_id=$2 ORDER BY u.serial`,
   [ctx.workspaceId,serial.skuIds[0]])).rows;
 assert.deepEqual(serials.map(row=>[row.serial,Number(row.secondary_quantity),row.code]),
   [['WEIGHED-001',1.1,'SERIAL-BATCH'],['WEIGHED-002',1.25,'SERIAL-BATCH']]);
 const physical=(await db.query('SELECT sum(on_hand)::text AS quantity FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 assert.equal(Number(physical.quantity),11.25);
 const evidence=await require('../../src/purchasing/supplier-invoice-match').receiptEvidence(db,ctx.workspaceId,po.purchaseOrderId);
 assert.equal(evidence.size,4);
 assert([...evidence.values()].every(row=>row.proven));
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_supplier_bills WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 assert.deepEqual(await receiptTiming(),{key:'receiving-document',label:'Prepare one packing-slip receiving form from the original (administration only)',
   count:1,samples:0,minutes:null});
 await savings.sample(db,ctx,{activity:'receiving-document',manualMinutes:'12',reviewMinutes:'4',requestKey:randomUUID()});
 assert.equal((await receiptTiming()).minutes,8);
});
