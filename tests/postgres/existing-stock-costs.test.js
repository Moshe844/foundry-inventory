'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster'),{openPostgres}=require('../../src/db/postgres'),{migratePostgres}=require('../../src/db/migrate-postgres');
const cost=require('../../src/accounting/postgres-inventory-costs'),inventory=require('../../src/domain/postgres-inventory-engine'),ledger=require('../../src/accounting/postgres-ledger');
const assistant=require('../../src/assistant/postgres-service'),pricing=require('../../src/pricing/postgres-service');
test('existing-stock cost uses governed approval, immutable evidence and atomic accounting without a new physical receipt',{timeout:180000},async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const at='2026-01-01T00:00:00.000Z',today=new Date().toISOString().slice(0,10),ctx={workspaceId:'w',actorId:'owner'};
 await db.query("INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('a','cost@example.test','Owner','x',$1),('staffacct','stock@example.test','Operator','x',$1)",[at]);
 await db.query("INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES('w','Cost test','a',$1),('other','Other business','a',$1)",[at]);
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES('owner','w','a','Owner','owner',$1),('staff','w','staffacct','Operator','staff',$1),('other-owner','other','a','Other owner','owner',$1)",[at]);
 await db.query("INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at) VALUES('loc','w','Depot','warehouse',1,$1),('foreign','other','Foreign','warehouse',1,$1)",[at]);
 await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
 async function stock(code,units){
  await db.query('INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at) VALUES($1,$2,$3,$3,\'quantity\',1,$4,$4)',['item-'+code,'w',code,at]);
  await db.query('INSERT INTO skus(id,workspace_id,item_id,code,is_default,is_active,created_at) VALUES($1,$2,$3,$4,1,1,$5)',[code,'w','item-'+code,code,at]);
  await inventory.receive(db,ctx,{skuId:code,locationId:'loc',quantity:units,idempotencyKey:'receipt-'+code});
  return {skuId:code,locationId:'loc',unitCost:'35.00',basis:'opening_inventory',evidenceReference:'Owner-confirmed opening valuation '+code,postingDate:today};
 }
 const input=await stock('UNFAMILIAR',20);
 await pricing.setPurchaseCost(db,ctx,{skuId:input.skuId,amount:'35',currency:'USD'});
 assert.equal((await db.query('SELECT count(*) AS n FROM accounting_inventory_cost_balances WHERE workspace_id=$1',['w'])).rows[0].n,'0','Purchase quote does not manufacture cost evidence');
 const physicalBefore=(await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',['w'])).rows[0].n;
 const prepared=await cost.prepare(db,ctx,input,'Record evidenced cost for existing stock.');
 assert.equal(prepared.status,'PREPARED');assert.equal((await db.query('SELECT count(*) AS n FROM accounting_inventory_cost_establishments')).rows[0].n,'0');
 const executed=await assistant.executeProposal(db,ctx,prepared.proposal.id);
 assert.equal(executed.status,'EXECUTED');assert.equal(executed.result.physicalUnits,20);assert.equal(executed.result.costedUnits,20);assert.equal(executed.result.totalCostMinor,70000);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',['w'])).rows[0].n,physicalBefore);
 const again=await assistant.executeProposal(db,ctx,prepared.proposal.id);assert.equal(again.replayed,true);
 assert.equal((await db.query('SELECT count(*) AS n FROM accounting_inventory_cost_establishments')).rows[0].n,'1');
 const valuation=await assistant.lookup(db,ctx,{view:'inventory_valuation',search:'UNFAMILIAR'});
 assert.equal(valuation.rows[0].costedUnits,20);assert.equal(valuation.rows[0].inventoryBookCost,'$700.00');
 const history=await assistant.lookup(db,ctx,{view:'inventory_cost_movements',search:'UNFAMILIAR'});
 assert.equal(history.rows[0].physicalStockChange,0);assert.equal(history.rows[0].bookCostChange,'$700.00');
 const event=(await db.query("SELECT * FROM accounting_inventory_cost_events WHERE workspace_id='w' AND cost_source_type='inventory_cost_establishment'")).rows[0];
 assert.equal(Number(event.physical_quantity_delta),0);assert.match(event.source_reference,/Owner-confirmed/);
 await assert.rejects(db.query("UPDATE accounting_inventory_cost_establishments SET evidence_reference='tampered'"),/immutable/i);
 await assert.rejects(db.query('DELETE FROM accounting_inventory_cost_establishments'),/cannot be deleted/i);
 await assert.rejects(cost.prepare(db,ctx,input),/missing cost|costed again/i);
 await assert.rejects(cost.prepare(db,{...ctx,actorId:'staff'},input),/owner or accountant/i);
 await assert.rejects(cost.prepare(db,{...ctx,actorId:'other-owner'},input),/owner or accountant/i);
 await assert.rejects(cost.prepare(db,ctx,{...input,locationId:'foreign'}),/not active in this business/i);
 const stale=await stock('CHANGING',10),staleProposal=await cost.prepare(db,ctx,stale);
 await inventory.issue(db,ctx,{skuId:stale.skuId,locationId:'loc',quantity:2,reasonCode:'damaged',idempotencyKey:'changed-stock'});
 await assert.rejects(assistant.executeProposal(db,ctx,staleProposal.proposal.id),/changed after this approval/i);
 assert.equal((await assistant.getProposal(db,'w',staleProposal.proposal.id)).status,'PENDING');
 const remaining=await cost.prepare(db,ctx,{...stale,unitCost:'12'}),remainingDone=await assistant.executeProposal(db,ctx,remaining.proposal.id);
 assert.equal(remainingDone.result.physicalUnits,8);assert.equal(remainingDone.result.costedUnits,8);assert.equal(remainingDone.result.totalCostMinor,9600,'Only stock actually left on hand is costed');
 const partial=await stock('PARTIAL',7),one=await cost.prepare(db,ctx,{...partial,quantity:3,unitCost:'4.25',basis:'previously_expensed'});
 await assistant.executeProposal(db,ctx,one.proposal.id);
 const two=await cost.prepare(db,ctx,{...partial,unitCost:'6.00',quantity:4});const twoDone=await assistant.executeProposal(db,ctx,two.proposal.id);
 assert.equal(twoDone.result.costedUnits,7);assert.equal(twoDone.result.totalCostMinor,3675);
 const zero=await stock('ZERO',2),zeroProposal=await cost.prepare(db,ctx,{...zero,unitCost:'0'}),zeroDone=await assistant.executeProposal(db,ctx,zeroProposal.proposal.id);
 assert.equal(zeroDone.result.costedUnits,2);assert.equal(zeroDone.result.totalCostMinor,0);assert.equal(zeroDone.result.journalEntryId,null);
 const concurrent=await stock('CONCURRENT',5),a=await cost.prepare(db,ctx,concurrent),b=await cost.prepare(db,ctx,concurrent);
 const results=await Promise.allSettled([assistant.executeProposal(db,ctx,a.proposal.id),assistant.executeProposal(db,ctx,b.proposal.id)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 // A genuine customer fulfillment must now pass the original cost gate and
 // consume recorded cost. It must not invalidate the earlier immutable proof.
 const customer=await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'Buyer'});
 const sales=require('../../src/operations/postgres-business-workflows');
 const order=await sales.createSalesOrder(db,ctx,{customerId:customer.id,deliveryMethod:'PICKUP',fulfillmentLocationId:'loc',
  lines:[{skuId:'UNFAMILIAR',quantity:2,unitPriceMinor:8000}],idempotencyKey:'sell-costed-stock'});
 await sales.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'confirm-costed-stock'});
 await sales.fulfillSalesOrder(db,ctx,order.salesOrderId,{lines:[{lineId:order.lineIds[0],locationId:'loc',quantity:2}],idempotencyKey:'fulfill-costed-stock'});
 const afterSale=(await db.query("SELECT b.on_hand,c.quantity_units,c.total_cost_minor FROM balances b JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id WHERE b.workspace_id='w' AND b.sku_id='UNFAMILIAR'")).rows[0];
 assert.equal(Number(afterSale.on_hand),18);assert.equal(Number(afterSale.quantity_units),18);assert.equal(Number(afterSale.total_cost_minor),63000);
 const original=await assistant.getProposal(db,'w',prepared.proposal.id);
 assert.equal(await cost.verify(db,ctx,original.result,{...original.payload,idempotencyKey:original.idempotency_key}),true);
 const zeroOrder=await sales.createSalesOrder(db,ctx,{customerId:customer.id,deliveryMethod:'PICKUP',fulfillmentLocationId:'loc',
  lines:[{skuId:'ZERO',quantity:1,unitPriceMinor:2500}],idempotencyKey:'sell-zero-cost-stock'});
 await sales.confirmSalesOrder(db,ctx,zeroOrder.salesOrderId,{idempotencyKey:'confirm-zero-cost-stock'});
 await sales.fulfillSalesOrder(db,ctx,zeroOrder.salesOrderId,{lines:[{lineId:zeroOrder.lineIds[0],locationId:'loc',quantity:1}],idempotencyKey:'fulfill-zero-cost-stock'});
 assert.equal(Number((await db.query("SELECT quantity_units FROM accounting_inventory_cost_balances WHERE workspace_id='w' AND sku_id='ZERO'")).rows[0].quantity_units),1);
 const gatewayInput=await stock('DISCOVERED',4),contract=require('../../src/assistant/postgres-capability-registry').registry.get('inventory.establish_cost');
 const actor=(await db.query("SELECT role,permissions FROM users WHERE id='owner' AND workspace_id='w'")).rows[0];
 const outcome=await require('../../src/assistant/postgres-control-plane').executeStep(assistant.capabilityService(),db,ctx,
  {contract,args:{sku:'DISCOVERED',location:'Depot',quantity:4,amount:7.25,costBasis:'opening_inventory',reference:'Confirmed opening sheet DISCOVERED'},dependsOn:[]},
  {actor,sourceMessage:'Record the cost of four existing DISCOVERED units at Depot at $7.25 each from confirmed opening sheet DISCOVERED.',provider:{complete:async()=>{throw Error('No helper-model dependency is allowed');}}});
 assert.equal(outcome.result.status,'PREPARED');assert.equal((await assistant.executeProposal(db,ctx,outcome.result.proposal.id)).result.totalCostMinor,2900);
 const freeGoods=await stock('FREE-PO',1),supplier=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:'Free goods supplier'});
 const po=await sales.createPurchaseOrder(db,ctx,{supplierId:supplier.id,destinationLocationId:'loc',lines:[{skuId:freeGoods.skuId,quantityUnits:2,unitCost:0}],idempotencyKey:'free-po-create'});
 await sales.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'free-po-approve'});
 await sales.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'free-po-place'});
 const poLine=(await db.query('SELECT id FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',[ctx.workspaceId,po.purchaseOrderId])).rows[0];
 const freeReceipt=await sales.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{lines:[{lineId:poLine.id,quantity:1,locationId:'loc'}],idempotencyKey:'free-po-receive'});
 assert.equal(freeReceipt.lines[0].totalCostMinor,0);assert.equal(freeReceipt.lines[0].journalEntryId,null);
 assert.equal(Number((await db.query("SELECT quantity_units FROM accounting_inventory_cost_balances WHERE workspace_id='w' AND sku_id='FREE-PO'")).rows[0].quantity_units),1);
 const bad=await stock('BAD',1);
 for(const alteration of [{currency:'EUR'},{basis:'invented'},{unitCost:'1.234'},{quantity:2},{evidenceReference:''},{postingDate:'2026-02-30'}])await assert.rejects(cost.prepare(db,ctx,{...bad,...alteration}));
 const close=await cost.prepare(db,ctx,bad);
 await db.query("UPDATE accounting_periods SET status='CLOSED' WHERE workspace_id='w' AND starts_on<=$1 AND ends_on>=$1",[today]);
 await assert.rejects(assistant.executeProposal(db,ctx,close.proposal.id),/closed/i);
 await assert.rejects(sales.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{lines:[{lineId:poLine.id,quantity:1,locationId:'loc'}],idempotencyKey:'free-po-closed-period'}),/closed/i);
 assert.equal((await assistant.getProposal(db,'w',close.proposal.id)).status,'PENDING');
 assert.equal((await db.query("SELECT count(*) AS n FROM accounting_supplier_bills WHERE workspace_id='w'")).rows[0].n,'0');
 assert.equal((await db.query("SELECT count(*) AS n FROM accounting_payments WHERE workspace_id='w'")).rows[0].n,'0');
});
