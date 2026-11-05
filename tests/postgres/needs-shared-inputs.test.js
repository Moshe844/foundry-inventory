'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('fifty distinct people share warehouse inbox sources while approvals and permissions stay private',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t);t.diagnostic(JSON.stringify(await require('../helpers/needs-shared-input-checks').check(t,f)));
});
test('lot alert totals retain local-date boundaries and count each lot once across warehouses',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,lotItem=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Expiry fixture',baseCode:'EXPIRY-SHARED',trackingMode:'lot'}),expiry=require('../../src/domain/postgres-batch-expiry');
 const second=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Other expiry warehouse',kind:'warehouse'}),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),day=n=>new Date(Date.parse(today)+n*86400000).toISOString().slice(0,10);
 for(const [name,date,locations,quantity]of [['expired',day(-1),[f.location,second],1],['today',today,[f.location],1],['last-day',day(30),[f.location],1],['future',day(31),[f.location],1],['no-date',null,[f.location],1],['empty',day(-2),[f.location],0]]){
  await db.query('INSERT INTO lots(id,workspace_id,sku_id,code,expires_at,created_at) VALUES($1,$2,$3,$1,$4,now())',['alert-'+name,ctx.workspaceId,lotItem.skuIds[0],date]);
  for(const location of locations)await db.query('INSERT INTO lot_balances(workspace_id,lot_id,location_id,quantity,updated_at) VALUES($1,$2,$3,$4,now())',[ctx.workspaceId,'alert-'+name,location.id,quantity]);
 }
 assert.deepEqual(await expiry.summary(db,ctx.workspaceId),{expired:1,soon:2});assert.deepEqual(await expiry.summary(db,'wsp_foreignexpiry'),{expired:0,soon:0});
 await db.query('UPDATE locations SET is_active=0 WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,[f.location.id,second.id]]);assert.deepEqual(await expiry.summary(db,ctx.workspaceId),{expired:0,soon:0});
});
test('empty and wholly grouped attention summaries never query inventory valuation',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,service=require('../../src/projections/postgres-attention-inbox'),sql=[],reader={query:(text,values)=>{sql.push(text);return db.query(text,values);}};
 assert.deepEqual(await service.summary(reader,ctx.workspaceId),{rows:[]});assert.equal(sql.length,1);
 await db.query(`INSERT INTO attention_items(id,workspace_id,fingerprint,category,severity,priority_score,title,concise_summary,explanation,recommendation,affected_entity_type,confidence,status,detection_rule_version,first_detected_at,last_evaluated_at)
 SELECT 'grouped-'||n,$1,'grouped-key-'||n,'low_stock','important',50,'Finding','Review','Evidence','Review','workspace','high','OPEN','fixture',now(),now() FROM generate_series(1,3)n`,[ctx.workspaceId]);sql.length=0;
 const summary=await service.summary(reader,ctx.workspaceId);assert.equal(summary.rows.length,1);assert(summary.rows[0].summary);assert(!sql.some(s=>s.includes('accounting_inventory_cost_balances')));
});
