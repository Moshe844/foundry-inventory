'use strict';process.env.NODE_ENV='test';
// Stock search now gathers matching products through one indexed lookup per searchable
// field instead of one OR across products, variants, serials and lots (which walked the
// whole catalogue: seconds per search at a million SKUs). The results must be exactly
// what the single OR condition returned, for every field and every list mode.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('stock search finds exactly what the single OR condition found, through index lookups',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),w=ctx.workspaceId,at=new Date().toISOString();
 const widget=await catalog.createItem(db,ctx,{name:'Blue Widget',baseCode:'BW-100',trackingMode:'quantity'});
 const coffee=await catalog.createItem(db,ctx,{name:'Coffee',baseCode:'COFFEE',trackingMode:'lot',hasVariants:true,options:[{name:'Flavor',values:'Original,Vanilla'},{name:'Size',values:'250g,1kg'}]});
 const lamp=await catalog.createItem(db,ctx,{name:'Old Lamp',baseCode:'LAMP-9',trackingMode:'quantity'});
 const meter=await catalog.createItem(db,ctx,{name:'Pressure meter',baseCode:'PM-1',trackingMode:'serial'});
 const post=await catalog.createItem(db,ctx,{name:'Lamp Post',baseCode:'LP-1',trackingMode:'quantity'});
 await db.query("UPDATE skus SET code='LAMPSHADE-1' WHERE id=$1",[widget.skuIds[0]]);
 await db.query("UPDATE skus SET barcode='0123456789012' WHERE id=$1",[widget.skuIds[0]]);
 await db.query('UPDATE items SET is_active=0 WHERE id=$1',[lamp.itemId]);
 await db.query('UPDATE skus SET is_active=0 WHERE id=$1',[coffee.skuIds[3]]);
 await db.query("INSERT INTO lots(id,workspace_id,sku_id,code,created_at) VALUES($1,$2,$3,'LOT-77A',$4)",[randomUUID(),w,coffee.skuIds[0],at]);
 await db.query("INSERT INTO serial_units(id,workspace_id,sku_id,serial,status,location_id,received_at,updated_at) VALUES($1,$2,$3,'SN-ABC-1',$4,$5,$6,$6)",[randomUUID(),w,meter.skuIds[0],'in_stock',f.location.id,at]);
 await db.query("INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,created_at,updated_at) VALUES($1,$2,$3,$4,5,$5,$5)",[randomUUID(),w,coffee.skuIds[1],f.location.id,at]);
 const coffeeLabels=(await db.query('SELECT variant_label FROM skus WHERE item_id=$1 ORDER BY id',[coffee.itemId])).rows.map(r=>r.variant_label);
 assert(coffeeLabels.every(Boolean),'variants carry labels to search');
 // The previous condition, verbatim, as the reference.
 const reference=async(q,{includeArchived=false,archivedOnly=false}={})=>(await db.query(`SELECT i.id FROM items i
  WHERE i.workspace_id=$1 AND ($3 OR i.is_active=1) AND (NOT $4 OR i.is_active=0)
   AND (i.name ILIKE '%'||$2||'%' OR COALESCE(i.base_code,'') ILIKE '%'||$2||'%'
    OR EXISTS(SELECT 1 FROM skus search_sku WHERE search_sku.workspace_id=$1 AND search_sku.item_id=i.id AND ($3 OR search_sku.is_active=1) AND (search_sku.code ILIKE '%'||$2||'%' OR lower(search_sku.barcode)=lower($2) OR search_sku.variant_label ILIKE '%'||$2||'%'))
    OR EXISTS(SELECT 1 FROM serial_units unit JOIN skus s ON s.id=unit.sku_id AND s.workspace_id=unit.workspace_id WHERE unit.workspace_id=$1 AND s.item_id=i.id AND unit.serial ILIKE '%'||$2||'%')
    OR EXISTS(SELECT 1 FROM lots lot JOIN skus s ON s.id=lot.sku_id AND s.workspace_id=lot.workspace_id WHERE lot.workspace_id=$1 AND s.item_id=i.id AND lot.code ILIKE '%'||$2||'%'))
  ORDER BY i.id`,[w,q,includeArchived||archivedOnly,archivedOnly])).rows.map(r=>r.id);
 const listed=async input=>{const page=await catalog.listItems(db,w,{pageSize:100,...input});return {ids:page.items.map(i=>i.id).sort(),total:page.totalCount};};
 const lowIds=(await listed({lowStock:true})).ids;assert(lowIds.includes(coffee.itemId),'the low-stock product is listed');
 const searches=['lamp','shade','bw-1','BW-100','coffee','vanilla','250G',coffeeLabels[2].slice(0,4),'0123456789012','0123456789','lot-77','LOT-77A','sn-abc','SN-ABC-1','lamp','LAMP-9','e','zzz-nothing','PM-'];
 let found=0;
 for(const q of searches){
  for(const mode of [{},{includeArchived:true},{archivedOnly:true}]){
   const expected=(await reference(q,mode)).sort(),actual=await listed({q,...mode});
   assert.deepEqual(actual.ids,expected,`search "${q}" ${JSON.stringify(mode)}`);assert.equal(actual.total,expected.length,`count for "${q}" ${JSON.stringify(mode)}`);found+=expected.length;
  }
  const low=await listed({q,lowStock:true}),expectedLow=(await reference(q)).filter(id=>lowIds.includes(id)).sort();
  assert.deepEqual(low.ids,expectedLow,`low-stock search "${q}"`);
 }
 assert(found>20,'the searches exercise real matches');
 // Every field is reachable on its own.
 for(const [q,item] of [['Blue Widget',widget],['BW-100',widget],['0123456789012',widget],['LOT-77A',coffee],['SN-ABC-1',meter],[coffeeLabels[0],coffee]])
  assert((await listed({q})).ids.includes(item.itemId),`"${q}" finds its product`);
 assert.deepEqual((await listed({q:'LAMP-9'})).ids,[],'archived products stay out of an ordinary search');
 assert.deepEqual((await listed({q:'LAMP-9',archivedOnly:true})).ids,[lamp.itemId]);
 // "lamp" finds one product by name and another only by its SKU code; with archived
 // products included a third comes by name. Pages merge both branches in order.
 assert.deepEqual((await listed({q:'lamp'})).ids,[post.itemId,widget.itemId].sort());
 for(const q of ['lamp','coffee','e','item'])for(const sort of [undefined,'newest'])for(const includeArchived of [false,true]){
  const whole=(await catalog.listItems(db,w,{q,sort,includeArchived,pageSize:100})).items.map(i=>i.id),label=JSON.stringify({q,sort,includeArchived});
  const numbered=[];for(let page=1;page<=whole.length+1;page++)numbered.push(...(await catalog.listItems(db,w,{q,sort,includeArchived,pageSize:1,page})).items.map(i=>i.id));
  assert.deepEqual(numbered,whole,'numbered pages '+label);
  const continued=[];let after=null;do{const page=await catalog.listItems(db,w,{q,sort,includeArchived,pageSize:1,afterItemId:after});continued.push(...page.items.map(i=>i.id));after=page.nextAfterItemId;}while(after);
  assert.deepEqual(continued,whole,'continued pages '+label);
 }
});
