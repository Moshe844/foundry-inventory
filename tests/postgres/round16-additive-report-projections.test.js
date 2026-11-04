'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('movement sums preserve local dates while counts, averages and quantity filters retain the exact events',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,inventory=require('../../src/domain/postgres-inventory-engine'),reports=require('../../src/reports/postgres-service'),registry=require('../../src/reports/postgres-registry'),actor={role:'owner'},at='2026-01-01T23:59:59.999Z';
 await t.test('absolute ISO dates parse consistently while ambiguous and invalid dates are reviewable',async()=>{
  const values=['2026-03-08T01:59:59.999-05:00','2026-03-08','1900-01-01T23:40:28.001Z','2026-02-30','2026-03-08T00:00:00+25:00','yesterday','not-a-date'];
  const rows=(await db.query('SELECT stockchief_movement_instant(value) instant FROM unnest($1::text[]) WITH ORDINALITY AS t(value,n) ORDER BY n',[values])).rows;
  assert.deepEqual(rows.map(r=>r.instant?.toISOString()||null),['2026-03-08T06:59:59.999Z','2026-03-08T00:00:00.000Z','1900-01-01T23:40:28.001Z',null,null,null,null]);
 });
 await t.test('report compilation settings remain local to their transaction',async()=>{
  const before=(await db.query('SHOW jit')).rows[0].jit;
  await db.transaction(async c=>assert.equal((await c.query('SHOW jit')).rows[0].jit,'off'),{readOnly:true,jit:false});
  assert.equal((await db.query('SHOW jit')).rows[0].jit,before);
  await assert.rejects(db.transaction(()=>null,{jit:'off'}),TypeError);
 });
 const commands=Array.from({length:100},(_,n)=>({skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,occurredAt:at,idempotencyKey:'second-event-'+n}));commands.push({...commands[0],quantity:3,idempotencyKey:'second-larger-event'});
 for(const [n,instant]of ['1900-01-01T23:40:27.999Z','1900-01-01T23:40:28.001Z','2026-03-08T06:59:59.999Z','2026-03-08T07:00:00.001Z','2026-03-09T03:59:59.999Z','2026-03-09T04:00:00.000Z','2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z','2026-11-02T04:59:59.999Z'].entries())commands.push({...commands[0],occurredAt:instant,idempotencyKey:'second-boundary-'+n});await db.transaction(c=>inventory.receiveManyInTransaction(c,ctx,commands),{retrySafe:true});
 const base={dataset:'movements',measure:'quantity_delta',filters:[{field:'occurred_on',operator:'at_least',value:'1800-01-01'},{field:'occurred_on',operator:'at_most',value:'2026-12-31'}]},normalize=rows=>rows.map(r=>({day:r.occurred_on,total:Number(r.total)})).sort((a,b)=>a.day.localeCompare(b.day));
 await t.test('selected New York DST days include exactly their 23 or 25 calendar hours',async()=>{
  await db.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1",[ctx.workspaceId]);
  for(const date of ['2026-03-08','2026-11-01']){const result=await reports.run(db,ctx,actor,{dataset:'movements',summary:true,aggregate:'count',filters:[{field:'occurred_on',operator:'equals',value:date}]});assert.equal(Number(result.rows[0].count),3,date);}
 });
 for(const timeZone of ['America/New_York','Asia/Kathmandu','Europe/Amsterdam','Pacific/Chatham']){await db.query('UPDATE workspaces SET time_zone=$2 WHERE id=$1',[ctx.workspaceId,timeZone]);const result=await reports.run(db,ctx,actor,{...base,groups:['occurred_on'],aggregate:'sum'}),expected=(await db.query('WITH source AS ('+registry.get('movements').source+') SELECT occurred_on,sum(quantity_delta) total FROM source GROUP BY occurred_on ORDER BY occurred_on',[ctx.workspaceId])).rows;assert.deepEqual(normalize(result.rows),normalize(expected),timeZone);}
 await db.query("UPDATE workspaces SET time_zone='UTC' WHERE id=$1",[ctx.workspaceId]);const january={...base,summary:true,filters:[{field:'occurred_on',operator:'equals',value:'2026-01-01'}]};for(const [aggregate,column,expected]of [['sum','total',103],['count','count',101],['average','average',103/101],['minimum','minimum',1],['maximum','maximum',3]])assert(Math.abs(Number((await reports.run(db,ctx,actor,{...january,aggregate})).rows[0][column])-expected)<1e-9,aggregate);
 const filtered={...january,aggregate:'sum',filters:[...january.filters,{field:'quantity_delta',operator:'at_least',value:2}]};assert.equal(Number((await reports.run(db,ctx,actor,filtered)).rows[0].total),3);assert.doesNotMatch(reports.queryFor(reports.normalize(filtered,actor),ctx.workspaceId).sql,/inventory_movement_second_totals/);
 const grouped=await reports.run(db,ctx,actor,{...january,summary:false,groups:['quantity_delta'],aggregate:'sum'});assert.deepEqual(grouped.rows.map(r=>[Number(r.quantity_delta),Number(r.total)]).sort((a,b)=>a[0]-b[0]),[[1,100],[3,3]]);
 const before=(await db.query('SELECT sum(movement_count)::int n FROM inventory_movement_second_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;await assert.rejects(db.transaction(async c=>{await inventory.receiveInTransaction(c,ctx,{...commands[0],quantity:30,idempotencyKey:'second-rollback'});throw Error('rollback movement total');}),/rollback movement total/);assert.equal((await db.query('SELECT sum(movement_count)::int n FROM inventory_movement_second_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before);
 await require('../helpers/recreate-read-view')(db,'inventory_movement_second_totals');assert.equal((await db.query('SELECT sum(movement_count)::int n FROM inventory_movement_second_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before);assert.equal((await reports.run(db,ctx,actor,{...january,aggregate:'sum'})).rows[0].total,'103');
 assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname='movement_second_totals'")).rows[0].n,0,'Rebuilding a reader must not restore the shared movement write trigger');
 await t.test('an ambiguous legacy movement date cannot break a report and names the affected SKU',async()=>{
  await db.query(`INSERT INTO movements(id,workspace_id,group_id,operation,item_id,sku_id,location_id,lot_id,quantity_delta,balance_after,reason_code,notes,reference,actor_user_id,occurred_at)
   SELECT $2,workspace_id,group_id,operation,item_id,sku_id,location_id,lot_id,quantity_delta,balance_after,reason_code,notes,reference,actor_user_id,'yesterday' FROM movements WHERE workspace_id=$1 AND operation='receive' ORDER BY seq LIMIT 1`,[ctx.workspaceId,require('../../src/lib/util').newId('pgmov')]);
  const result=await reports.run(db,ctx,actor,{...january,aggregate:'sum'}),sku=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.skuIds[0]])).rows[0].code;
  assert.equal(Number(result.rows[0].total),103);assert.equal(result.warnings.length,1);assert(result.warnings[0].includes(sku));
 });
 await t.test('movement export counts and composed metrics preserve their own date parameters',async()=>{
  const sku=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.skuIds[0]])).rows[0].code;
  const filters=[{field:'sku',operator:'equals',value:sku},{field:'occurred_on',operator:'equals',value:'2026-01-01'}];
  assert.equal(await reports.countAtMost(db,ctx,actor,{dataset:'movements',columns:['sku','quantity_delta'],filters},1000),101);
  const spec={dataset:'composed',dimension:'sku',metrics:[{alias:'stock',dataset:'stock',aggregate:'sum',measure:'on_hand',filters:[{field:'sku',operator:'equals',value:sku}]},{alias:'moved',dataset:'movements',aggregate:'sum',measure:'quantity_delta',filters}],chart:'table'},composed=require('../../src/reports/postgres-composed'),result=await composed.run(db,ctx,actor,spec);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].sku,sku);assert.equal(Number(result.rows[0].moved),103);assert.equal(result.warnings.length,1);
  const stock=Number((await db.query('SELECT sum(on_hand)::text n FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,f.item.skuIds[0]])).rows[0].n);assert.equal(Number(result.rows[0].stock),stock);assert.equal(await composed.countAtMost(db,ctx,actor,spec,1000),1);
 });
 await t.test('movement reports remain available without the legacy second-by-second view',async()=>{
  await db.query('DROP VIEW inventory_movement_second_totals');
  const uncached={query:db.query.bind(db),transaction:db.transaction.bind(db)};
  assert.equal(Number((await reports.run(uncached,ctx,actor,{...january,aggregate:'sum'})).rows[0].total),103);
  assert.equal(Number((await reports.run(uncached,ctx,actor,{...january,aggregate:'count'})).rows[0].count),101);
 });
});
test('valuation sums use exact totals without changing row-value filters, averages, counts or empty inventories',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),reports=require('../../src/reports/postgres-service'),actor={role:'owner'},item=await catalog.createItem(db,ctx,{name:'Valuation lot',trackingMode:'quantity',purchaseCost:'1.25'});await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:item.skuIds[0],locationId:f.location.id,quantity:2,idempotencyKey:'valuation-projection-extra'});
 const spec={dataset:'inventory_valuation',summary:true,measure:'book_cost_minor',filters:[{field:'currency',operator:'equals',value:'USD'}]};for(const [aggregate,column,expected]of [['sum','total',650],['count','count',2],['average','average',325],['minimum','minimum',250],['maximum','maximum',400]])assert.equal(Number((await reports.run(db,ctx,actor,{...spec,aggregate})).rows[0][column]),expected,aggregate);
 const filtered={...spec,aggregate:'sum',filters:[...spec.filters,{field:'costed_units',operator:'at_least',value:3}]};assert.equal(Number((await reports.run(db,ctx,actor,filtered)).rows[0].total),400);assert.doesNotMatch(reports.queryFor(reports.normalize(filtered,actor),ctx.workspaceId).sql,/inventory_cost_coverage_totals/);assert.match(reports.queryFor(reports.normalize({...spec,aggregate:'sum'},actor),ctx.workspaceId).sql,/inventory_cost_coverage_totals/);
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Empty fixture',businessName:'Empty valuation',email:require('node:crypto').randomUUID()+'@example.test',password:require('node:crypto').randomUUID()+'!A'}),otherCtx={workspaceId:other.workspaceId,actorId:other.userId};await require('../../src/accounting/postgres-ledger').configure(db,otherCtx,{currency:'USD',startDate:'2026-01-01'});const place=await require('../../src/domain/postgres-location-service').createLocation(db,otherCtx,{name:'Uncosted room',kind:'warehouse'}),uncosted=await catalog.createItem(db,otherCtx,{name:'No cost yet',trackingMode:'quantity'});await require('../../src/domain/postgres-inventory-engine').receive(db,otherCtx,{skuId:uncosted.skuIds[0],locationId:place.id,quantity:2,idempotencyKey:'uncosted-valuation'});assert.equal((await reports.run(db,otherCtx,actor,{...spec,summary:false,groups:['currency'],aggregate:'sum'})).rows.length,0,'Physical-only stock must not create a recorded-value group');
});
