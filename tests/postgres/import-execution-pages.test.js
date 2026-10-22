'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('wide variant imports bound reads and catalogue writes, preserve added fields, and retry atomically',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Reviewer',businessName:'Unfamiliar variant inventory',email:randomUUID()+'@example.test',password:randomUUID()+'!A'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
 const tag=randomUUID().slice(0,8),csv=['Name,SKU,Variant Size,Location,Quantity,Unit cost,Selling price,Reorder level,Supplier,Lead time days,Inspection grade',...Array.from({length:3603},(_,i)=>`Family ${tag},${tag}-${Math.floor(i/3)},Size ${Math.floor(i/3)},Room ${i%3},2,1.25,3.50,4,Vendor ${tag},12,Grade ${i%5}`)].join('\n');
 const service=require('../../src/imports/postgres-service');const plan=await service.analyse(db,ctx,{text:csv,allowModel:false});assert.equal(plan.recordsValid,3603);await service.approve(db,ctx,plan.id,plan.integrityHash);
 let pages=0;const transaction=db.transaction.bind(db),bounded={...db,transaction:(fn,settings)=>transaction(c=>fn({query:(sql,values=[])=>{
  if(/FROM import_rows[\s\S]*FOR UPDATE/.test(sql)&&!/import_plans/.test(sql)){assert(!/SELECT \*/.test(sql));assert(/LIMIT 500/.test(sql));pages++;}
  if(/^INSERT INTO (items|skus|item_options|sku_option_values)\(/.test(sql))for(const v of values)if(typeof v==='string'&&v[0]==='[')assert(JSON.parse(v).length<=500,'Bound catalogue statements even when one product has many variants');
  return c.query(sql,values);
 }}),settings)};
 await assert.rejects(service.execute(bounded,ctx,plan.id,{beforeRow:({rowsImported})=>{if(rowsImported===3000)throw Error('Interrupted before final verification');}}),/Interrupted/);
 for(const table of ['items','skus','balances','accounting_journal_entries','catalog_source_facts'])assert.equal(Number((await db.query(`SELECT count(*) n FROM ${table} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].n),0);
 const failed=await service.report(db,ctx.workspaceId,plan.id),progress=[];
 const result=await service.execute(bounded,ctx,plan.id,{retryExecutionId:failed.id,onProgress:p=>progress.push(p)});assert(result.verified);assert.equal(result.skusCreated,1201);assert.equal(result.rowsImported,3603);assert.equal(result.units,7206);assert(pages>=16);assert(progress.some(p=>p.preparedRows===3603));
 const facts=(await db.query("SELECT count(*)::int n FROM catalog_source_facts WHERE workspace_id=$1 AND name='Inspection grade'",[ctx.workspaceId])).rows[0];assert.equal(facts.n,3603);
 assert.equal(Number((await db.query('SELECT sum(total_cost_minor) n FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),900750);
 assert.equal(Number((await db.query('SELECT count(*) n FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),3603);assert((await service.execute(db,ctx,plan.id)).duplicate);
});
