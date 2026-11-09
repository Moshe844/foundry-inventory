'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('staging speed queries preserve accounting totals, mixed inbox groups, stock costs and filtered purchasing',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 await t.test('bounded accounting includes both date edges and retains balances',async()=>{
  const ledger=require('../../src/accounting/postgres-ledger'),reports=require('../../src/accounting/postgres-reports');
  await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
  const post=(date,key,amount)=>ledger.post(db,ctx,{postingDate:date,sourceKey:key,sourceType:'manual',description:key,lines:[{accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:amount},{accountKey:'SALES_REVENUE',creditMinor:amount}]});
  await post('2026-01-31','speed-before',900);await post('2026-02-01','speed-first',1200);await post('2026-02-28','speed-last',2300);await post('2026-03-01','speed-after',1700);
  await ledger.post(db,ctx,{postingDate:'2026-02-14',sourceKey:'speed-cost',sourceType:'manual',description:'Cost',lines:[{accountKey:'COST_OF_GOODS_SOLD',debitMinor:700},{accountKey:'INVENTORY_ASSET',creditMinor:700}]});
  const report=await reports.profitAndLoss(db,ctx.workspaceId,{from:'2026-02-01',to:'2026-02-28'});
  assert.equal(report.revenueMinor,3500);assert.equal(report.cogsMinor,700);assert.equal(report.netIncomeMinor,2800);
  assert.equal((await reports.profitAndLoss(db,ctx.workspaceId,{from:'2026-04-01',to:'2026-04-30'})).revenueMinor,0);
  assert((await reports.trialBalance(db,ctx.workspaceId,{to:'2026-03-01'})).balanced);
  assert((await reports.balanceSheet(db,ctx.workspaceId,{asOf:'2026-03-01'})).balanced);
 });
 await t.test('mixed inbox groups retain individual work and urgent counts, including null grouping fields',async()=>{
  const inbox=require('../../src/projections/postgres-work-inbox'),at=new Date().toISOString();
  const rows=[
   ['speed-big-1','replenishment_plan','purchase',f.location.id,'USD',10,'immediate','PENDING','REQUIRED'],
   ['speed-big-2','replenishment_plan','purchase',f.location.id,'USD',30,'normal','PENDING','REQUIRED'],
   ['speed-big-3','replenishment_plan','purchase',f.location.id,'USD',20,'immediate','PENDING','REQUIRED'],
   ['speed-null-1','stock_transfer','transfer',null,null,1,'normal','PENDING','REQUIRED'],
   ['speed-null-2','stock_transfer','transfer',null,null,3,'immediate','PENDING','REQUIRED'],
   ['speed-null-3','stock_transfer','transfer',null,null,2,'normal','PENDING','REQUIRED'],
   ['speed-small-1','replenishment_plan','purchase',null,'EUR',100,'immediate','PENDING','REQUIRED'],
   ['speed-small-2','replenishment_plan','purchase',null,'EUR',200,'normal','PENDING','REQUIRED'],
   ['speed-owner','owner_decision','review',null,null,0,'immediate','PENDING','REQUIRED'],
   ['speed-closed','replenishment_plan','purchase',f.location.id,'USD',999,'immediate','COMPLETED','REQUIRED'],
   ['speed-auto','replenishment_plan','purchase',f.location.id,'USD',999,'immediate','PENDING','NONE']
  ];
  for(const [id,category,type,location,currency,value,urgency,status,approval]of rows)await db.query(`INSERT INTO work_items(id,workspace_id,category,source,recommended_action,priority,idempotency_key,urgency,execution_status,approval_requirement,created_at) VALUES($1,$2,$3,'postgres_autopilot',$4,50,$1,$5,$6,$7,$8)`,[id,ctx.workspaceId,category,JSON.stringify({type,destinationLocationId:location,currency,value,displayName:id}),urgency,status,approval,at]);
  const result=(await inbox.summary(db,ctx.workspaceId)).rows,groups=result.filter(r=>r.summary),individual=result.filter(r=>!r.summary);
  assert.equal(groups.length,2);assert.deepEqual(individual.map(r=>r.id).sort(),['speed-owner','speed-small-1','speed-small-2']);
  const purchases=groups.find(r=>r.kind==='purchase'),transfers=groups.find(r=>r.kind==='transfer');
  assert.deepEqual(purchases.names,['speed-big-2','speed-big-3','speed-big-1']);assert.equal(purchases.count,3);assert.equal(purchases.urgentCount,2);
  assert.deepEqual(transfers.names,['speed-null-2','speed-null-3','speed-null-1']);assert.equal(transfers.count,3);assert.equal(transfers.urgentCount,1);
  assert.deepEqual((await inbox.summary(db,'other-inventory')).rows,[]);
 });
 await t.test('product costs still fall back to recorded stock and purchasing filters preserve variants',async()=>{
  const money=require('../../src/domain/postgres-product-money'),catalog=require('../../src/domain/postgres-catalog-service'),shortages=require('../../src/purchasing/postgres-shortage-list');
  assert.equal((await money.summary(db,ctx.workspaceId,f.item.itemId)).costLabel,'$1.00');
  const item=await catalog.createItem(db,ctx,{name:'Speed-filter product',baseCode:'SPEED-FILTER',trackingMode:'quantity',hasVariants:true,options:[{name:'Size',values:'Small,Large'}],purchaseCost:'4.25',sellingPrice:'10'});
  await db.transaction(c=>require('../../src/operations/postgres-reorder-policies').setManyInTransaction(c,ctx,item.skuIds.map(skuId=>({skuId,locationId:f.location.id,reorderPoint:5,targetStock:12}))));
  assert.deepEqual(await money.summary(db,ctx.workspaceId,item.itemId),{priceLabel:'$10.00',costLabel:'$4.25',profitLabel:'$5.75',marginLabel:'57.5%'});
  const found=await shortages.read(db,ctx.workspaceId,{q:'Large'});assert.equal(found.rows.length,1);assert.match(found.rows[0].displayName,/Large/);
  assert.equal((await shortages.read(db,ctx.workspaceId,{q:'nothing-matches-here'})).rows.length,0);
  const last=item.skuIds.slice().sort().at(-1);const paged=await shortages.read(db,ctx.workspaceId,{q:'Speed-filter',afterSkuId:last});assert.equal(paged.rows.length,0);
  assert.equal((await shortages.read(db,'other-inventory',{q:'Speed-filter'})).rows.length,0);
 });
});
