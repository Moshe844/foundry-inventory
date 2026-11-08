'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('large imports commit stock and an atomic retryable reorder job, then prepare exact defaults in bounded pages',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service'),defaults=require('../../src/imports/default-reorder-points');
 const lines=['Product,SKU,Location,Quantity,Unit cost'];
 for(let n=0;n<6000;n++)lines.push(['Default family '+Math.floor(n/10),'DEFAULT-'+n,'Dispatch',n<10||n%10===9?0:1+n%3,'1.00'].join(','));
 const plan=await imports.analyse(db,ctx,{text:lines.join('\n'),allowModel:false,importMode:'add'});assert.equal(plan.recordsValid,6000);await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.reorderDefaults.state,'QUEUED');
 const before=await f.balance(),queue=require('../../src/operations/postgres-job-queue'),job=await queue.get(db,result.reorderDefaults.jobId,ctx.workspaceId);assert.equal(job.kind,'import.initialize-reorders');assert.equal(job.status,'PENDING');
 assert.equal((await db.query('SELECT count(*)::int n FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 assert.equal((await imports.report(db,ctx.workspaceId,plan.id)).reorderDefaults.state,'PREPARING');
 const ownerSku=(await db.query("SELECT id FROM skus WHERE workspace_id=$1 AND code='DEFAULT-10'",[ctx.workspaceId])).rows[0].id;
 await db.query("INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,notes,created_at,updated_at) VALUES('owner-default-rule',$1,$2,$3,7,21,'manual','Owner rule',now(),now())",[ctx.workspaceId,ownerSku,f.location.id]);
 const everywhereSku=(await db.query("SELECT id FROM skus WHERE workspace_id=$1 AND code='DEFAULT-20'",[ctx.workspaceId])).rows[0].id;
 await db.query("INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,notes,created_at,updated_at) VALUES('owner-everywhere-rule',$1,$2,NULL,4,12,'manual','Owner everywhere rule',now(),now())",[ctx.workspaceId,everywhereSku]);
 let pages=0,maxRead=0,maxWrite=0;
 const observed={query:async(sql,values)=>{
  if(/FROM import_rows/.test(sql)){assert.match(sql,/LIMIT 5000/);assert.doesNotMatch(sql,/DISTINCT ON/);}
  if(/INSERT INTO reorder_policies/.test(sql))maxWrite=Math.max(maxWrite,JSON.parse(values[2]).length);
  const result=await db.query(sql,values);if(/FROM import_rows/.test(sql)){pages++;maxRead=Math.max(maxRead,result.rows.length);}return result;
 }};
 assert.equal((await defaults.run({...job,workspaceId:'foreign-workspace'},observed)).state,'NOT_REQUIRED');
 const prepared=await defaults.run(job,observed);assert.equal(prepared.state,'COMPLETE');assert.equal(prepared.created,5998);assert(pages>=2);assert.equal(maxRead,5000);assert(maxWrite<=1000);
 assert.equal((await defaults.run(job,observed)).created,0,'Retry does not duplicate or replace rules');assert.equal(await f.balance(),before);
 const rules=(await db.query("SELECT s.code,p.reorder_point::text point,p.target_stock::text target FROM reorder_policies p JOIN skus s ON s.id=p.sku_id WHERE p.workspace_id=$1",[ctx.workspaceId])).rows,by=new Map(rules.map(r=>[r.code,r]));assert.equal(rules.length,6000);assert.deepEqual(by.get('DEFAULT-10'),{code:'DEFAULT-10',point:'7',target:'21'});assert.deepEqual(by.get('DEFAULT-20'),{code:'DEFAULT-20',point:'4',target:'12'});assert.equal(by.get('DEFAULT-0').target,'2');assert.equal(by.get('DEFAULT-19').target,'2');
 // The real worker handler uses the maintenance lane and records completion.
 const handler=require('../../src/operations/postgres-runtime-handlers').create()[job.kind];assert.equal(handler.workerLane,'maintenance');await queue.processOne(db,{[job.kind]:handler},{owner:'reorder-default-fixture'});assert.equal((await queue.get(db,job.id,ctx.workspaceId)).status,'COMPLETED');assert.equal((await imports.report(db,ctx.workspaceId,plan.id)).reorderDefaults.state,'COMPLETE');
 t.diagnostic(JSON.stringify({sourceRows:6000,maxRead,maxWrite,exactFallbacks:true,ownerRulePreserved:true,retrySafe:true,paidCalls:0}));
});

test('small measured imports keep exact fractional reorder defaults immediately',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
 const products=await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,[{name:'Exact measured defaults',trackingMode:'quantity',variants:Array.from({length:4},(_,n)=>({code:'MEASURE-DEFAULT-'+n,options:[{name:'Weight',value:String(n)}]}))}]));
 await db.transaction(c=>require('../../src/domain/stock-quantity').save(c,ctx,products[0].itemId,{unitLabel:'kg',quantityPrecision:6,quantityIncrement:'0.000001'}));
 const imports=require('../../src/imports/postgres-service'),plan=await imports.analyse(db,ctx,{text:'SKU,Location,Quantity\nMEASURE-DEFAULT-0,Dispatch,0\nMEASURE-DEFAULT-1,Dispatch,0.000001\nMEASURE-DEFAULT-2,Dispatch,0.000002\nMEASURE-DEFAULT-3,Dispatch,3.75',importMode:'add',allowModel:false});assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.reorderDefaults.state,'COMPLETE');
 const source=await imports.rowsFor(db,ctx.workspaceId,plan.id);assert.equal(source.find(r=>r.parsed.code==='MEASURE-DEFAULT-3').quantity,3.75);assert.equal(source.find(r=>r.parsed.code==='MEASURE-DEFAULT-1').quantity,0.000001);
 const rule=(await db.query("SELECT target_stock::text target FROM reorder_policies p JOIN skus s ON s.id=p.sku_id WHERE p.workspace_id=$1 AND s.code='MEASURE-DEFAULT-0'",[ctx.workspaceId])).rows[0];assert.equal(rule.target,'0.000002');
});
