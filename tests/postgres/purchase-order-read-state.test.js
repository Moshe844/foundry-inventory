'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('purchase evidence distinguishes committed incoming stock from drafts and cancelled plans, with truthful capped coverage',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),commerce=require('../../src/operations/postgres-commerce'),catalog=require('../../src/domain/postgres-catalog-service'),lookup=require('../../src/assistant/postgres-service').lookup;
 const make=async name=>{const a=await auth.createBusiness(db,{name,businessName:name,email:randomUUID()+'@example.test',password:randomUUID()});return {workspaceId:a.workspaceId,actorId:a.userId};},ctx=await make('Unexpected purchasing states'),foreign=await make('Foreign purchasing');
 const add=async(scope,status,quantity,received,currency='USD')=>{
  const supplier=await commerce.createSupplier(db,scope,{name:randomUUID()}),item=await catalog.createItem(db,scope,{name:randomUUID(),baseCode:randomUUID(),trackingMode:'quantity'}),id=randomUUID(),number=randomUUID(),at=new Date().toISOString();
  await db.query(`INSERT INTO purchase_orders(id,workspace_id,po_number,supplier_id,status,currency,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[id,scope.workspaceId,number,supplier.id,status,currency,scope.actorId,at]);
  await db.query(`INSERT INTO purchase_order_lines(id,workspace_id,purchase_order_id,line_number,sku_id,quantity_purchase_units,quantity_units,quantity_received_units,unit_cost,line_total,created_at) VALUES($1,$2,$3,1,$4,$5,$5,$6,$7,$8,$9)`,[randomUUID(),scope.workspaceId,id,item.skuIds[0],quantity,received,status==='DRAFT'?null:0,status==='DRAFT'?null:0,at]);return number;
 };
 const draft=await add(ctx,'DRAFT',83,0),awaiting=await add(ctx,'AWAITING_APPROVAL',19,0),approved=await add(ctx,'APPROVED',7,0,'CAD'),ordered=await add(ctx,'ORDERED',11,0),partial=await add(ctx,'PARTIALLY_RECEIVED',13,8),received=await add(ctx,'RECEIVED',17,17),cancelled=await add(ctx,'CANCELLED',23,0);await add(foreign,'ORDERED',999,0);
 const readOnly={query:(sql,args)=>{assert.match(sql.trim(),/^(SELECT|WITH)\b/i);return db.query(sql,args);}},read=search=>lookup(readOnly,ctx,{view:'purchase_orders',...(search?{search}:{})});
 const all=await read(),rows=new Map(all.rows.map(r=>[r.order,r]));assert.equal(all.extent.totalRows,7);assert.equal(all.extent.complete,true);assert.equal(all.rows.reduce((n,r)=>n+r.incomingUnits,0),23);
 for(const number of [draft,awaiting,received,cancelled]){assert.equal(rows.get(number).isOpen,false);assert.equal(rows.get(number).incomingUnits,0);}
 for(const number of [approved,ordered,partial])assert.equal(rows.get(number).isOpen,true);
 assert.equal(rows.get(partial).incomingUnits,5);assert.equal(rows.get(approved).currency,'CAD');assert.equal(rows.get(approved).total,'CA$0.00');assert.equal(rows.get(draft).total,null);assert.match(all.answer,/3 are open with 23 units still expected/);
 assert.equal((await read(draft)).rows[0].outstandingUnits,83);assert.match((await read(draft)).answer,/0 still expected/);assert.equal((await read(randomUUID())).extent.totalRows,0);
 for(let n=0;n<96;n++)await add(ctx,'DRAFT',n+1,0);const capped=await read();assert.equal(capped.rows.length,100);assert.equal(capped.extent.totalRows,103);assert.equal(capped.extent.complete,false);
 assert.equal((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
});
