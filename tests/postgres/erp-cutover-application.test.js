'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),cutover=require('../../src/onboarding/postgres-cutover');
test('native PostgreSQL ERP application resumes atomic batches without duplicate stock, orders, value or variants',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Cutover owner',businessName:'Native ERP application',email:'native-cutover@example.test',password:'ERP-cutover-qualification!'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const records=[
 {type:'account',key:'equipment',payload:{name:'ERP Equipment',code:'QA-EQUIPMENT',type:'ASSET'}},
 {type:'opening_receivable',key:'ar-1',payload:{documentNumber:'ERP-AR-1',customerKey:'customer',issueDate:'2026-10-01',dueDate:'2026-11-01',balanceMinor:10000,originalTotalMinor:15000,currency:'USD'}},
 {type:'opening_payable',key:'ap-1',payload:{documentNumber:'ERP-AP-1',supplierKey:'supplier',issueDate:'2026-10-01',balanceMinor:3000,currency:'USD'}},
 {type:'location',key:'warehouse',payload:{name:'ERP Main',kind:'warehouse'}},
 {type:'product',key:'product',payload:{name:'ERP product',trackingMode:'quantity',unitLabel:'unit'}},
 ...['red','blue'].map((key,i)=>({type:'sku',key,payload:{productKey:'product',code:'ERP-'+key,options:[{name:'Colour',value:key}]}})),
 {type:'supplier',key:'supplier',payload:{name:'ERP supplier',currency:'USD'}},
 {type:'customer',key:'customer',payload:{name:'ERP customer'}},
 {type:'supplier_item',key:'terms',payload:{supplierKey:'supplier',skuKey:'red',supplierSku:'S-RED',purchaseUnit:'unit',unitsPerPurchaseUnit:1,lastUnitCost:95,isPreferred:true}},
 ...['red','blue'].map(key=>({type:'selling_price',key:'price-'+key,payload:{skuKey:key,amountMinor:12500,currency:'USD'}})),
 ...['red','blue'].map(key=>({type:'purchase_cost',key:'cost-'+key,payload:{skuKey:key,amountMinor:9500,currency:'USD'}})),
 {type:'reorder_policy',key:'policy',payload:{skuKey:'red',locationKey:'warehouse',reorderPoint:3,targetStock:20,safetyStock:1}},
 {type:'inventory_position',key:'red-stock',payload:{skuKey:'red',locationKey:'warehouse',quantity:12,totalCostMinor:114000,currency:'USD',reservedQuantity:2,damagedQuantity:0,availableQuantity:10}},
 {type:'inventory_position',key:'blue-stock',payload:{skuKey:'blue',locationKey:'warehouse',quantity:5,totalCostMinor:47500,currency:'USD',reservedQuantity:0,damagedQuantity:0,availableQuantity:5}},
 {type:'purchase_order',key:'po',payload:{orderNumber:'ERP-PO-42',supplierKey:'supplier',destinationLocationKey:'warehouse',currency:'USD',status:'ORDERED',remainingOnly:true,lines:[{skuKey:'red',quantity:4,unitPriceMinor:9500}]}},
 {type:'sales_order',key:'so',payload:{orderNumber:'ERP-SO-42',customerKey:'customer',fulfillmentLocationKey:'warehouse',deliveryMethod:'PICKUP',currency:'USD',status:'CONFIRMED',remainingOnly:true,lines:[{skuKey:'red',quantity:2,unitPriceMinor:12500}]}},
 {type:'opening_journal',key:'opening',payload:{currency:'USD',postingDate:'2026-10-30',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:161500},{accountKey:'ACCOUNTS_RECEIVABLE',customerKey:'customer',debitMinor:10000},{accountKey:'ACCOUNTS_PAYABLE',supplierKey:'supplier',creditMinor:3000},{accountSourceKey:'equipment',debitMinor:2000},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:170500}]}},
 {type:'history_fact',key:'prior-shipment',payload:{factType:'source_order_history',operatingEffect:false,originalOrder:'ERP-SO-42',previouslyShipped:6}}
 ];
 const counts=Object.fromEntries(Object.keys(cutover.TYPES).map(k=>[k,records.filter(r=>r.type===k).length])),manifest={counts,accounting:{currency:'USD',startDate:'2026-10-30'}};
 const pkg=await cutover.create(db,ctx,{sourceNamespace:'erp:qa-company',sourceLabel:'ERP operating position',snapshotHash:'d'.repeat(64),manifest});
 await cutover.stage(db,ctx,pkg.id,{batchKey:'page-1',records});const sealed=await cutover.freeze(db,ctx,pkg.id,{sourceStopped:true,manifest});await cutover.validatePage(db,ctx,pkg.id);await cutover.approve(db,ctx,pkg.id,sealed.postgres_state.sealedHash);
 await assert.rejects(cutover.applyPage(db,ctx,pkg.id,{limit:1,afterRecord:()=>{throw Error('Synthetic crash');}}),/Synthetic crash/);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM locations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0,'record effect and checkpoint roll back together');
 let result;for(let i=0;i<records.length+5;i++){result=await cutover.applyPage(db,ctx,pkg.id,{limit:1});if(result.done)break;}assert.equal(result.package.status,'RECONCILING');assert.equal(Number(result.package.applied_count),records.length);
 assert.equal((await cutover.applyPage(db,ctx,pkg.id)).replayed,true);
 const totals=(await db.query('SELECT (SELECT count(*) FROM items WHERE workspace_id=$1) AS items,(SELECT count(*) FROM skus WHERE workspace_id=$1) AS skus,(SELECT sum(on_hand) FROM balances WHERE workspace_id=$1) AS units,(SELECT sum(total_cost_minor) FROM accounting_inventory_cost_balances WHERE workspace_id=$1) AS value,(SELECT count(*) FROM movements WHERE workspace_id=$1) AS movements,(SELECT sum(quantity) FROM sales_order_allocations WHERE workspace_id=$1) AS reserved',[ctx.workspaceId])).rows[0];assert.deepEqual(Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,Number(v)])),{items:1,skus:2,units:17,value:161500,movements:2,reserved:2});
 assert.equal((await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].status,'ORDERED');assert.equal((await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].status,'CONFIRMED');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),1);
 assert.equal(Number((await db.query('SELECT sum(debit_minor-credit_minor) AS n FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM migration_history_facts WHERE package_id=$1',[pkg.id])).rows[0].n),1,'history remains evidence rather than replaying old stock');
 await assert.rejects(db.query("UPDATE migration_records SET payload_json='{}' WHERE package_id=$1",[pkg.id]),/sealed/);
 await db.transaction(async c=>{await c.query("SELECT set_config('stockchief.cutover_package_id',$1,true)",[pkg.id]);await c.query('UPDATE items SET name=$2 WHERE workspace_id=$1',[ctx.workspaceId,'Synthetic reconciliation mismatch']);});
 let failedCheck;do{failedCheck=await cutover.reconcilePage(db,ctx,pkg.id,{limit:1});}while(!failedCheck.done);assert.equal(failedCheck.matched,false);await assert.rejects(cutover.activate(db,ctx,pkg.id,sealed.postgres_state.sealedHash),/must match/);
 await db.transaction(async c=>{await c.query("SELECT set_config('stockchief.cutover_package_id',$1,true)",[pkg.id]);await c.query('UPDATE items SET name=$2 WHERE workspace_id=$1',[ctx.workspaceId,records.find(r=>r.type==='product').payload.name]);});const retried=await cutover.retryReconciliation(db,ctx,pkg.id);assert.equal(retried.postgres_state.reconciliationAfter,null,'A failed earlier record is reconsidered from the beginning');
 let reconciled;for(let i=0;i<records.length+2;i++){reconciled=await cutover.reconcilePage(db,ctx,pkg.id,{limit:1});if(reconciled.done)break;}
 if(!reconciled.matched)t.diagnostic(JSON.stringify((await db.query("SELECT label,evidence_json FROM migration_reconciliation_checks WHERE package_id=$1 AND status<>'MATCHED'",[pkg.id])).rows));
 assert.equal(reconciled.matched,true);assert.equal(reconciled.package.status,'VERIFIED');
 await assert.rejects(cutover.activate(db,ctx,pkg.id,'changed-hash'),/must match/);
 const active=await cutover.activate(db,ctx,pkg.id,sealed.postgres_state.sealedHash);assert.equal(active.status,'CUTOVER_ACTIVE');assert.equal((await cutover.activate(db,ctx,pkg.id,sealed.postgres_state.sealedHash)).replayed,true);
 await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'First post-cutover item',trackingMode:'quantity'});
 assert.equal((await cutover.applyPage(db,ctx,pkg.id)).replayed,true,'activation cannot replay the initial operating position');

});
