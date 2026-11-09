'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// A workbook record whose stock is split from per-location columns states one
// reorder point for the SKU. It applies to the SKU's total, never to each
// location, which made every warehouse with less than that number "low".
// A file that lists one location per row keeps its per-location settings.
test('reorder points from a location-column workbook apply to the SKU total, row-per-location files stay per location',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),imports=require('../../src/imports/postgres-service'),owner=await auth.createBusiness(db,{name:'Owner',businessName:'Reorder scope',email:randomUUID()+'@example.test',password:randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const XLSX=require('xlsx'),book=XLSX.utils.book_new();
 for(const [name,grid] of [['Catalogue',[['Reference','Label','Hue','Cost','Reorder at'],['ZX-11','Panel','Blue',8,5],['ZX-27','Panel','Red',2,4]]],['Positions',[['Reference','Counter','Store room','Physical total'],['ZX-11',2,4,6],['ZX-27',3,0,3]]]])XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(grid),name);
 const ref=(sheet,column)=>({sheet,column}),contract={baseSheet:0,joins:[{sheet:1,fromSheet:0,fromColumn:0,toColumn:0}],fields:[{field:'code',source:ref(0,0)},{field:'name',source:ref(0,1)},{field:'unitCost',source:ref(0,3)},{field:'reorderPoint',source:ref(0,4)}],variants:[ref(0,2)],stock:{total:ref(1,3),locations:[ref(1,1),ref(1,2)]},coverage:[{sheet:0,role:'inventory',reason:'Catalogue.'},{sheet:1,role:'reference',reason:'Quantities by location.'}]};
 let plan=await imports.analyse(db,ctx,{buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'}),filename:'Positions.xlsx',allowModel:false,workbookContract:contract});
 plan=await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,proposedLocations:{Counter:{name:'Front counter',kind:'store'},'Store room':{name:'Store room',kind:'warehouse'}}});
 assert.equal(plan.recordsInvalid,0);const rows=await imports.rowsFor(db,ctx.workspaceId,plan.id);assert.equal(rows.length,4);assert(rows.every(r=>r.parsed.reorderEverywhere===true),'every split row states a SKU-wide reorder point');
 await imports.approve(db,ctx,plan.id,plan.integrityHash);assert((await imports.execute(db,ctx,plan.id)).verified);
 const policies=(await db.query(`SELECT s.code,p.location_id,p.reorder_point::int AS point FROM reorder_policies p JOIN skus s ON s.id=p.sku_id WHERE p.workspace_id=$1 ORDER BY s.code,p.location_id NULLS FIRST`,[ctx.workspaceId])).rows;
 assert.deepEqual(policies,[{code:'ZX-11',location_id:null,point:5},{code:'ZX-27',location_id:null,point:4}]);
 const skus=(await db.query('SELECT id,code,item_id FROM skus WHERE workspace_id=$1 ORDER BY code',[ctx.workspaceId])).rows;
 const low=(await require('../../src/reports/postgres-low-stock-badges').forSkus(db,ctx.workspaceId,skus.map(s=>s.id))).map(r=>skus.find(s=>s.id===r.sku_id).code);
 assert.deepEqual(low,['ZX-27'],'6 in total is above 5 even though each location holds less; 3 is at or below 4');
 const overview=await require('../../src/domain/postgres-product-overview').overview(db,ctx,skus[0].item_id,{});assert.equal(overview.low,true);assert.equal(overview.lowVariants,1);

 // One location per row: each row's reorder point is that location's.
 const sites=(await db.query("SELECT id,name FROM locations WHERE workspace_id=$1 AND name IN ('Front counter','Store room') ORDER BY name",[ctx.workspaceId])).rows;
 const flat=await imports.analyse(db,ctx,{text:'SKU,Name,Location,Quantity,Unit cost,Reorder point\nRL-1,Rail,Front counter,2,1.00,3\nRL-1,Rail,Store room,9,1.00,7',allowModel:false});
 assert.equal(flat.recordsInvalid,0);assert((await imports.rowsFor(db,ctx.workspaceId,flat.id)).every(r=>!r.parsed.reorderEverywhere));
 await imports.approve(db,ctx,flat.id,flat.integrityHash);assert((await imports.execute(db,ctx,flat.id)).verified);
 const perSite=(await db.query(`SELECT l.name,p.reorder_point::int AS point FROM reorder_policies p JOIN skus s ON s.id=p.sku_id JOIN locations l ON l.id=p.location_id WHERE p.workspace_id=$1 AND s.code='RL-1' ORDER BY l.name`,[ctx.workspaceId])).rows;
 assert.deepEqual(perSite,[{name:sites[0].name,point:3},{name:sites[1].name,point:7}]);
});
