'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

// A million-row qualification file ends with one measured row (2.25 m). It used
// to make the whole file ineligible for parallel lanes. Decimal quantities now
// keep lanes, with the same exact receipts, value, journal and import evidence.
test('measured decimal stock keeps parallel lanes with exact stock, value and import evidence',{timeout:240000},async t=>{
 const prior=process.env.FOUNDRY_IMPORT_STOCK_WORKERS;process.env.FOUNDRY_IMPORT_STOCK_WORKERS='4';
 t.after(()=>{if(prior===undefined)delete process.env.FOUNDRY_IMPORT_STOCK_WORKERS;else process.env.FOUNDRY_IMPORT_STOCK_WORKERS=prior;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{ctx}=f,db=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max:5});
 t.after(()=>db.close());
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('measured-lanes',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const other=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Overflow',kind:'warehouse'});
 const definitions=Array.from({length:300},(_,p)=>({name:'Measured lane product '+p,trackingMode:'quantity',variants:Array.from({length:10},(_,v)=>({code:'MEASURED-LANE-'+p+'-'+v,options:[{name:'Size',value:String(v)}]}))}));
 for(let start=0;start<definitions.length;start+=50)await db.transaction(c=>require('../../src/domain/postgres-catalog-service').createImportedItemsInTransaction(c,ctx,definitions.slice(start,start+50)),{isolation:'READ COMMITTED'});
 // Every third product is measured in metres to three decimal places.
 const measured=definitions.filter((_,p)=>p%3===0);
 for(const product of measured){
  const item=(await db.query('SELECT item_id FROM skus WHERE workspace_id=$1 AND code=$2',[ctx.workspaceId,product.variants[0].code])).rows[0].item_id;
  await db.transaction(c=>require('../../src/domain/stock-quantity').save(c,ctx,item,{unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'}));
 }
 const isMeasured=new Set(measured.map(p=>p.name));
 const text=['Product,SKU,Location,Quantity,Unit cost,Source reference',...definitions.flatMap(p=>p.variants.flatMap(v=>[f.location,other].map(l=>[p.name,v.code,l.name,isMeasured.has(p.name)?'1.25':'1',2,v.code+'-'+l.id].join(','))))].join('\n');
 const imports=require('../../src/imports/postgres-service'),plan=await imports.analyse(db,ctx,{text,importMode:'add',allowModel:false});
 assert.equal(plan.recordsValid,6000);assert.equal(plan.recordsInvalid,0);
 assert.equal((await db.query('SELECT bool_and(parallel_stock) eligible FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id])).rows[0].eligible,true,'Decimal measured rows must not disable lanes.');
 await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const result=await imports.execute(db,ctx,plan.id);
 assert(result.verified);assert.equal(result.stockLanes,4);assert.equal(result.rowsImported,6000);
 const codes=definitions.flatMap(p=>p.variants.map(v=>v.code));
 const actual=(await db.query(`SELECT (SELECT sum(b.on_hand)::text FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id WHERE b.workspace_id=$1 AND s.code=ANY($2::text[])) units,
  (SELECT sum(c.total_cost_minor)::text FROM accounting_inventory_cost_balances c JOIN skus s ON s.id=c.sku_id AND s.workspace_id=c.workspace_id WHERE c.workspace_id=$1 AND s.code=ANY($2::text[])) value,
  (SELECT count(*)::int FROM balances b JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id WHERE b.workspace_id=$1 AND s.code=ANY($2::text[]) AND b.on_hand=1.25) measured_positions`,[ctx.workspaceId,codes])).rows[0];
 // 2,000 measured rows of 1.25 m and 4,000 whole rows of 1, at 2.00 each.
 assert.equal(Number(actual.units),6500);assert.equal(actual.value,'1300000');assert.equal(actual.measured_positions,2000);
 const evidence=(await db.query(`SELECT count(*) FILTER(WHERE quantity=1.25)::int measured,count(*) FILTER(WHERE quantity=1)::int whole,
  count(*) FILTER(WHERE jsonb_array_length(movement_ids::jsonb)<>1)::int unlinked FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED'`,[ctx.workspaceId,plan.id])).rows[0];
 assert.deepEqual(evidence,{measured:2000,whole:4000,unlinked:0},'Import evidence keeps each exact quantity and one movement per row.');
 const lanes=(await db.query('SELECT sum(row_count)::int rows,sum(quantity_delta)::text units,sum(value_minor)::text value FROM import_lane_batch_receipts WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id])).rows[0];
 assert.deepEqual({rows:lanes.rows,units:Number(lanes.units),value:lanes.value},{rows:6000,units:6500,value:'1300000'});
});
