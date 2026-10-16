'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('governed supplier evidence preserves saved pack constraints, inherited lead times and missing values without browser discovery',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),commerce=require('../../src/operations/postgres-commerce'),catalog=require('../../src/domain/postgres-catalog-service'),assistant=require('../../src/assistant/postgres-service');
 const make=async label=>{const r=await auth.createBusiness(db,{name:label,businessName:label,email:randomUUID()+'@example.test',password:'Terms!'+randomUUID()});return {workspaceId:r.workspaceId,actorId:r.userId};};
 const ctx=await make('Term reader'),other=await make('Foreign term reader');
 const item=await catalog.createItem(db,ctx,{name:'Unfamiliar packaging',baseCode:'PACK-'+randomUUID(),trackingMode:'quantity'}),foreignItem=await catalog.createItem(db,other,{name:'Unfamiliar packaging',baseCode:'PACK-'+randomUUID(),trackingMode:'quantity'});
 const supplier=await commerce.createSupplier(db,ctx,{name:'Recorded terms',currency:'CAD',defaultLeadTimeDays:7}),absent=await commerce.createSupplier(db,ctx,{name:'No default',currency:'USD'}),foreign=await commerce.createSupplier(db,other,{name:'PRIVATE FOREIGN SUPPLIER',defaultLeadTimeDays:99});
 const link=await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:item.skuIds[0],purchaseUnit:'case',unitsPerPurchaseUnit:12,lastUnitCost:1.25,minimumOrderQuantity:3,orderMultiple:2,leadTimeDays:0});
 await commerce.linkSupplierItem(db,ctx,{supplierId:absent.id,skuId:item.skuIds[0],purchaseUnit:'unit',unitsPerPurchaseUnit:1,minimumOrderQuantity:null,orderMultiple:null,leadTimeDays:null});
 await commerce.linkSupplierItem(db,other,{supplierId:foreign.id,skuId:foreignItem.skuIds[0],minimumOrderQuantity:999,orderMultiple:99});
 const readOnly={query:(sql,args)=>{assert.match(sql.trim(),/^(SELECT|WITH)\b/i);return db.query(sql,args);}};
 const result=await assistant.lookup(readOnly,ctx,{view:'supplier_items'}),row=result.rows.find(r=>r.supplier==='Recorded terms'),missing=result.rows.find(r=>r.supplier==='No default');
 assert.equal(result.rows.length,2);assert(!JSON.stringify(result).includes('PRIVATE FOREIGN'));assert.equal(row.minimumOrderQuantity,3);assert.equal(row.orderMultiple,2);assert.equal(row.unitsPerPurchaseUnit,12);assert.equal(row.purchaseUnit,'case');assert.equal(row.leadTimeDays,0);assert.equal(row.supplierLeadTimeDays,7);assert.equal(row.effectiveLeadTimeDays,0,'A recorded zero override must not be replaced by a supplier default');assert.equal(row.currency,'CAD');assert.equal(row.lastUnitCost,1.25);
 assert.equal(missing.minimumOrderQuantity,'Not recorded');assert.equal(missing.orderMultiple,'Not recorded');assert.equal(missing.leadTimeDays,'Not recorded');assert.equal(missing.supplierLeadTimeDays,'Not recorded');assert.equal(missing.effectiveLeadTimeDays,'Not recorded');
 await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:item.skuIds[0],minimumOrderQuantity:0,leadTimeDays:null});
 const inherited=(await assistant.lookup(readOnly,ctx,{view:'supplier_items'})).rows.find(r=>r.supplier==='Recorded terms');assert.equal(inherited.minimumOrderQuantity,0);assert.equal(inherited.leadTimeDays,'Not recorded');assert.equal(inherited.effectiveLeadTimeDays,7);assert.equal(inherited.orderMultiple,2);
 // A durable observation of the same read must be rechecked, not reused as
 // current truth after the canonical terms change.
 const store=require('../../src/assistant/postgres-goal-store'),goal=await store.claim(db,ctx,(await store.create(db,ctx,'Inspect the current saved supplier purchasing constraints.')).id),gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
 const session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize});
 const input={steps:[{capability:'read.supplier_items',arguments:[],dependsOn:[]}]};
 await session.execute('business_operations',input,()=>gateway.operate(input));
 const saved=await store.get(db,ctx,goal.id),entry=Object.values(saved.checkpoint.harness.evidence).find(e=>e.name==='business_operations'),original=JSON.parse(entry.text),catalogue=(await gateway.authorize()).catalogue;
 assert.equal(original.outcomes[0].result.status,'ANSWERED');
 const current=await require('../../src/assistant/agent-evidence-verification').current(db,ctx,saved,entry,{catalogue});assert.deepEqual(current,original);
 await commerce.linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId:item.skuIds[0],minimumOrderQuantity:9});
 const changed=await require('../../src/assistant/agent-evidence-verification').current(db,ctx,saved,entry,{catalogue});assert.notDeepEqual(changed,original);assert.equal(changed.outcomes[0].result.rows.find(r=>r.supplier==='Recorded terms').minimumOrderQuantity,9);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n,'0');assert(link.id);
 t.diagnostic(JSON.stringify({actualPostgresAndGovernedRead:true,recordedZeroDistinctFromMissing:true,packUnitsRemainDistinctFromMoq:true,overrideAndInheritedLeadTimesDistinct:true,currentEvidenceRevalidated:true,tenantIsolation:true,newTools:0,paidCalls:0}));
});
