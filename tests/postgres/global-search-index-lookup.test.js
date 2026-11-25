'use strict';process.env.NODE_ENV='test';
// The search box now starts product matches from index lookups, sums stock only for the
// rows shown, and for a term matching thousands of SKUs keeps only the best rows of each
// kind. Its results must equal the previous search's, kept verbatim as a fixture.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('the search box returns exactly what it returned before, for specific and broad terms',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,w=ctx.workspaceId,at=new Date().toISOString();
 const catalog=require('../../src/domain/postgres-catalog-service'),current=require('../../src/domain/postgres-search-service'),previous=require('../fixtures/previous-global-search');
 for(const meter of ['active_skus','products'])await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,$3,NULL,'Search comparison fixture')",[randomUUID(),f.owner.accountId,meter]);
 const widget=await catalog.createItem(db,ctx,{name:'Blue Widget',baseCode:'BW-100',trackingMode:'quantity'});
 const coffee=await catalog.createItem(db,ctx,{name:'Coffee',baseCode:'COFFEE',trackingMode:'lot',hasVariants:true,options:[{name:'Flavor',values:'Original,Vanilla'},{name:'Size',values:'250g,1kg'}]});
 const lamp=await catalog.createItem(db,ctx,{name:'Old Lamp',baseCode:'LAMP-9',trackingMode:'quantity'});
 const meter=await catalog.createItem(db,ctx,{name:'Pressure meter',baseCode:'PM-1',trackingMode:'serial'});
 await db.query("UPDATE skus SET barcode='0123456789012' WHERE id=$1",[widget.skuIds[0]]);
 await db.query('UPDATE items SET is_active=0 WHERE id=$1',[lamp.itemId]);
 await db.query('UPDATE skus SET is_active=0 WHERE id=$1',[coffee.skuIds[3]]);
 await db.query("INSERT INTO lots(id,workspace_id,sku_id,code,created_at) VALUES($1,$2,$3,'LOT-77A',$4)",[randomUUID(),w,coffee.skuIds[0],at]);
 await db.query("INSERT INTO serial_units(id,workspace_id,sku_id,serial,status,location_id,received_at,updated_at) VALUES($1,$2,$3,'SN-ABC-1','in_stock',$4,$5,$5)",[randomUUID(),w,meter.skuIds[0],f.location.id,at]);
 // More than two thousand SKUs share "Bulk", so the one-pass path is compared as well.
 await db.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,is_active,has_variants,created_at,updated_at)
  SELECT 'bulk-'||g,$1,'Bulk item '||g,'BULK-'||g,'quantity',1,CASE WHEN g<=450 THEN 1 ELSE 0 END,$2,$2 FROM generate_series(1,550) g`,[w,at]);
 await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,variant_label,is_active,created_at)
  SELECT 'bulk-'||g||'-'||z.size,$1,'bulk-'||g,'BULK-'||g||'-'||z.size,z.size,1,$2 FROM generate_series(1,450) g CROSS JOIN unnest(ARRAY['XS','S','M','L','XL']) z(size)`,[w,at]);
 await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at) SELECT 'bulk-'||g||'-only',$1,'bulk-'||g,'BULK-'||g,1,$2 FROM generate_series(451,550) g`,[w,at]);
 const bulkSkus=Number((await db.query("SELECT count(*) n FROM skus WHERE workspace_id=$1 AND code ILIKE '%bulk%' AND is_active=1",[w])).rows[0].n);
 assert(bulkSkus>2000,'the broad term matches more SKUs than the one-by-one path takes');
 const terms=['Blue','widget','BW-100','bw-1','0123456789012','coffee','vanilla','250g','Original','lamp','LAMP-9','LOT-77','sn-abc','Bulk','bulk item 1','BULK-12','BULK-450-XL','bulk-45','XL','xs','item','Dispatch','Parcel','e','zzz-nothing'];
 let compared=0,broadRows=0;
 for(const term of terms)for(const options of [{},{limit:8,groupLimit:3},{limit:100},{limit:5}]){
  const now=await current.search(db,w,term,options),before=await previous.search(db,w,term,options);
  assert.deepEqual(now,before,`search "${term}" ${JSON.stringify(options)}`);
  compared+=now.results.length;if(/bulk/i.test(term))broadRows+=now.results.length;
 }
 assert(compared>200,'the comparison covers real results');assert(broadRows>50,'the broad term returned rows to compare');
});
