'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('pricing evidence covers approved lifecycle and pending policies from both entry points without activating them',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),create=()=>auth.createBusiness(db,{name:'Policy reader',businessName:randomUUID(),email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),owner=await create(),other=await create(),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},foreign={workspaceId:other.workspaceId,actorId:other.userId},service=require('../../src/pricing/postgres-promotions'),assistant=require('../../src/assistant/postgres-service'),calculator=require('../../src/pricing/calculator');
 const at=Date.now(),past=new Date(at-86400000).toISOString(),future=new Date(at+86400000).toISOString(),later=new Date(at+2*86400000).toISOString(),definitions=[
  {kind:'guard',name:'Current safeguards',currency:'USD',minimumMarginBps:2000,maximumDiscountBps:1500},
  {kind:'promotion',name:'Turned off',currency:'USD',enabled:false,discount:{type:'percent',value:100}},
  {kind:'promotion',name:'Future offer',currency:'USD',startsAt:future,endsAt:later,discount:{type:'percent',value:200}},
  {kind:'promotion',name:'Ended offer',currency:'USD',endsAt:past,discount:{type:'percent',value:300}}
 ];
 for(const definition of definitions){const p=await service.propose(db,ctx,definition);await service.decide(db,ctx,p.id,p.integrity_hash,true);}
 const pendingDefinition={kind:'promotion',name:'Waiting offer',currency:'USD',discount:{type:'percent',value:400}},pending=await service.propose(db,ctx,pendingDefinition),nativeDefinition={...pendingDefinition,name:'Assistant waiting offer'};
 const config=await service.configuration(db,ctx,nativeDefinition),native=(await assistant.createProposal(db,ctx,'Prepared only','pricing.rule.configure',config.payload,'Disposable fixture')).proposal;
 await service.propose(db,foreign,{...pendingDefinition,name:'PRIVATE FOREIGN OFFER'});
 const snapshot=await assistant.lookup(db,ctx,{view:'pricing'});assert.equal(snapshot.rows.length,4);assert.deepEqual(snapshot.rows.map(r=>r.lifecycle).sort(),['ACTIVE','DISABLED','EXPIRED','SCHEDULED']);assert.equal(snapshot.pending.length,2);assert(snapshot.pending.some(p=>p.id===pending.id&&p.source==='pricing'));assert(snapshot.pending.some(p=>p.id===native.id&&p.source==='assistant'));assert(!JSON.stringify(snapshot).includes('PRIVATE FOREIGN OFFER'));
 assert.equal(snapshot.authority.activationRequiresApproval,true);assert.equal(snapshot.authority.pendingProposalsAffectPricing,false);assert.equal(snapshot.coverage.approvedRulesComplete,true);assert.equal(snapshot.coverage.pendingProposalsComplete,true);assert.equal(snapshot.rows.find(r=>r.kind==='guard').minimumMarginBps,2000);
 const filtered=await assistant.lookup(db,ctx,{view:'pricing',search:'Assistant waiting'});assert.equal(filtered.rows.length,0);assert.equal(filtered.pending.length,1);assert.equal(filtered.pending[0].id,native.id);
 assert.equal((await service.getProposal(db,ctx,pending.id)).status,'PENDING');assert.equal((await assistant.getProposal(db,ctx.workspaceId,native.id)).status,'PENDING');assert.equal((await service.list(db,ctx)).length,4);
 assert.equal((await service.inspect(db,ctx,{search:pending.id})).pending[0].id,pending.id);
 const racing=await service.propose(db,ctx,{...pendingDefinition,name:'Approved during inspection'});let changed=false;
 const racingDb={...db,transaction:(fn,settings)=>db.transaction(client=>fn({query:async(...args)=>{const result=await client.query(...args);if(!changed&&args[0].includes('FROM stockchief_runtime.pricing_rules r JOIN')){changed=true;await service.decide(db,ctx,racing.id,racing.integrity_hash,true);}return result;}}),settings)};
 const coherent=await service.inspect(racingDb,ctx);assert(changed);assert.equal(coherent.rows.length,4);assert(coherent.pending.some(p=>p.id===racing.id),'An approval during inspection must not fall between the approved and pending reads');assert.equal((await service.inspect(db,ctx)).rows.length,5);
 assert.equal(calculator.lifecycle({startsAt:future,endsAt:later},Date.parse(future)),'ACTIVE');assert.equal(calculator.lifecycle({startsAt:future,endsAt:later},Date.parse(later)),'EXPIRED');assert.equal(calculator.lifecycle({enabled:false,startsAt:future},at),'DISABLED');
 await db.query("UPDATE users SET permissions='{}'::jsonb,role='staff' WHERE id=$1",[ctx.actorId]);await assert.rejects(service.inspect(db,ctx),/permission|allowed|access|manage pricing/i);
 t.diagnostic(JSON.stringify({allPolicyLifecycles:true,bothPendingSources:true,inspectionCannotActivate:true,concurrentApprovalSnapshotConsistent:true,tenantIsolation:true,permissionRevocation:true,modelCalls:0}));
});
