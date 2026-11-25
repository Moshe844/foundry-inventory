'use strict';process.env.NODE_ENV='test';
// The data health score (job 200) and its fix list check every active SKU nine ways. On a
// million-SKU business the single query ran past its time limit three times. The checks are
// now computed from sets gathered once per check; the scores and fix lists must be exactly
// what the previous query gave, kept verbatim as a fixture.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('data health gives exactly the previous scores and fix lists on a varied catalogue',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,location}=f,w=ctx.workspaceId,at=new Date().toISOString();
 const current=require('../../src/autopilot/catalog-health'),previous=require('../fixtures/previous-catalog-health');
 for(const meter of ['active_skus','products'])await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,$3,NULL,'Health comparison fixture')",[randomUUID(),f.owner.accountId,meter]);
 const old=new Date(Date.now()-2*365*86400000).toISOString(),recent=new Date(Date.now()-30*86400000).toISOString();
 const item=async(id,name,{unit='each',tracking='quantity',secondary=null,active=1}={})=>db.query(`INSERT INTO items(id,workspace_id,name,unit_label,tracking_mode,secondary_unit_label,is_active,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[id,w,name,unit,tracking,secondary,active,at]);
 const sku=(id,itemId,code,{barcode=null,label=null,weight=null,active=1}={})=>db.query(`INSERT INTO skus(id,workspace_id,item_id,code,barcode,variant_label,weight_grams,is_active,created_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,w,itemId,code,barcode,label,weight,active,at]);
 const balance=(skuId,onHand)=>db.query('INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) VALUES($1,$2,$3,$4,$5)',[w,skuId,location.id,onHand,at]);
 const movement=(itemId,skuId,occurred,{operation='receive',reason=null,quantity=1}={})=>db.query(`INSERT INTO movements(id,workspace_id,group_id,operation,item_id,sku_id,location_id,quantity_delta,balance_after,reason_code,actor_user_id,occurred_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)`,[randomUUID(),w,randomUUID(),operation,itemId,skuId,location.id,quantity,reason,ctx.actorId,occurred]);
 // Products that pass and fail each check, alone and together.
 await item('h-a','Alpha bolt');await sku('h-a1','h-a','ALPHA-1',{barcode:'111',weight:10});
 await item('h-b','Bravo nut');await sku('h-b1','h-b','bravo 1',{barcode:' 222'});await sku('h-b2','h-b','BRAVO/2',{barcode:'222 ',label:'Large'});
 await item('h-c','Charlie washer');await sku('h-c1','h-c','CHARLIE-1',{barcode:'',weight:0});
 await item('h-d','Delta screw');await sku('h-d1','h-d','DUP-CODE');
 await item('h-e','Echo screw');await sku('h-e1','h-e','dup-code ',{barcode:'333'});
 // Same name and options in the same unit under two products: a duplicate unless the barcodes differ.
 await item('h-f','Foxtrot  Clamp!');await sku('h-f1','h-f','FOX-1',{barcode:'444'});
 await item('h-g','foxtrot clamp');await sku('h-g1','h-g','FOX-2',{barcode:'444'});
 await item('h-h','Hotel hinge');await sku('h-h1','h-h','HOTEL-1',{barcode:'555'});
 await item('h-i','HOTEL HINGE');await sku('h-i1','h-i','HOTEL-2',{barcode:'556'});
 await item('h-j','India strap',{unit:'kg',secondary:'pieces'});await sku('h-j1','h-j','INDIA-1',{weight:5});
 await item('h-k','Juliet tape',{unit:'kg',secondary:'pieces'});await sku('h-k1','h-k','JULIET-1');
 await item('h-l','Kilo box');await sku('h-l1','h-l','KILO-1',{barcode:'777'});
 await item('h-m','Lima bag',{active:0});await sku('h-m1','h-m','LIMA-1',{barcode:'777'});
 await item('h-n','Mike crate');await sku('h-n1','h-n','MIKE-1',{active:0});await sku('h-n2','h-n','MIKE-2',{barcode:'888'});
 await item('h-o','');await sku('h-o1','h-o','OSCAR-1');
 // Suppliers: active and paused, a shared supplier code, and a supplier price.
 for(const [id,status] of [['sup-on','active'],['sup-off','inactive']])await db.query('INSERT INTO suppliers(id,workspace_id,name,status,created_at,updated_at) VALUES($1,$2,$1,$3,$4,$4)',[id,w,status,at]);
 const link=(id,supplier,skuId,{code=null,cost=null,active=1}={})=>db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,last_unit_cost,is_active,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[id,w,supplier,skuId,code,cost,active,at]);
 await link('si-1','sup-on','h-a1',{code:'X-1'});await link('si-2','sup-on','h-c1',{code:' x-1 ',cost:2.5});
 await link('si-3','sup-off','h-d1',{cost:1});await link('si-4','sup-on','h-e1',{active:0,cost:3});await link('si-5','sup-on','h-l1',{code:'X-1',active:0});
 await db.query(`INSERT INTO sku_purchase_costs(id,workspace_id,sku_id,amount_minor,source,created_at) VALUES($1,$2,'h-b1',150,'owner',$3)`,[randomUUID(),w,at]);
 const costed=(skuId,units,secondary=null)=>db.query(`INSERT INTO accounting_inventory_cost_balances(workspace_id,sku_id,location_id,quantity_units,total_cost_minor,secondary_quantity_units,updated_at)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[w,skuId,location.id,units,units*100,secondary,at]);
 await costed('h-f1',3);await costed('h-g1',0);await costed('h-j1',2,4);await costed('h-k1',2,0);await costed('h-h1',1);
 const reorder=(skuId,point)=>db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)`,[randomUUID(),w,skuId,location.id,point,at]);
 await reorder('h-a1',5);await reorder('h-b2',null);await reorder('h-h1',0);
 // Stock: below zero, last counted over a year ago, counted since, imported counts and new stock.
 await balance('h-c1',-2);await balance('h-a1',4);await balance('h-b1',3);await balance('h-d1',2);await balance('h-e1',6);await balance('h-f1',1);await balance('h-h1',0);
 await movement('h-a','h-a1',old);
 await movement('h-b','h-b1',old);await movement('h-b','h-b1',recent,{operation:'adjust'});
 await movement('h-d','h-d1',old);await movement('h-d','h-d1',recent,{reason:'file_physical_count'});
 await movement('h-e','h-e1',recent);await movement('h-e','h-e1',old);
 await movement('h-f','h-f1',old);await movement('h-f','h-f1',old,{operation:'adjust'});
 await movement('h-h','h-h1',old);
 const compare=async label=>{
  assert.deepEqual(await current.score(db,w),await previous.score(db,w),'score '+label);
  for(const filter of ['','ALPHA-1','bravo 1','Foxtrot  Clamp!','HOTEL-2','missing'])for(const page of [1,2])
   assert.deepEqual(await current.findings(db,ctx,{page,filter}),await previous.findings(db,ctx,{page,filter}),`findings ${label} ${filter} page ${page}`);
  return previous.score(db,w);
 };
 const first=await compare('varied catalogue');
 assert(first.checks.every(c=>c.passed>0&&c.failed>0),'every check both passes and fails somewhere: '+JSON.stringify(first.checks));
 // More rows than one fix-list page, so paging is compared too.
 for(let i=0;i<120;i++){await item('bulk-'+i,'Bulk part '+i);await sku('bulk-'+i+'-a','bulk-'+i,'BULK-'+i,{barcode:i%7?'9'+i:null,weight:i%3});}
 await compare('with a second page');
 await db.query("UPDATE items SET is_active=0 WHERE workspace_id=$1",[w]);
 await compare('with no active products');
});
