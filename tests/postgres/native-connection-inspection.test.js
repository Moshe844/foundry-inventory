'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('connection evidence reuses canonical accounting setup without loading secrets, contacting providers or granting writes',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),create=()=>auth.createBusiness(db,{name:'Connection reader',businessName:randomUUID(),email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),owner=await create(),foreign=await create(),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},sync=require('../../src/accounting/postgres-integration-sync'),assistant=require('../../src/assistant/postgres-service');
 const id='connection_'+randomUUID(),other='connection_'+randomUUID(),at=new Date().toISOString();
 async function connector(scope,key,label){await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at,last_error)
  VALUES($1,$2,$3,$4,'quickbooks','connected','["accounting:read","accounting:post"]','[]',$5,360,'AUTHORITY_REQUIRED',$6,$7,$7,$8)`,[key,scope.workspaceId,'quickbooks:'+key,label,JSON.stringify({secret:'PRIVATE_CONFIG_CREDENTIAL'}),scope.userId,at,'PRIVATE_SQL_ERROR_AND_SECRET']);}
 await connector(owner,id,'Saved accounting company');await connector(foreign,other,'PRIVATE_FOREIGN_COMPANY');
 for(const [scope,key,kind,selected]of [[ctx.workspaceId,id,'sku',1],[ctx.workspaceId,id,'location',1],[ctx.workspaceId,id,'sku',0],[foreign.workspaceId,other,'sku',1]])await db.query('INSERT INTO connection_external_records(id,workspace_id,connector_id,entity_type,external_id,display_name,provider_data,selected,last_seen_at,created_at,updated_at) VALUES($1,$2,$3,$4,$1,$5,$6,$7,$8,$8,$8)',['external_'+randomUUID(),scope,key,kind,'Cached record','{"private":"PRIVATE_PROVIDER_PAYLOAD"}',selected,at]);
 for(const [scope,key,status]of [[ctx.workspaceId,id,'RUNNING'],[ctx.workspaceId,id,'COMPLETED'],[foreign.workspaceId,other,'RUNNING']])await db.query('INSERT INTO connection_sync_runs(id,workspace_id,connector_id,sync_kind,status,error_message,started_at) VALUES($1,$2,$3,$4,$5,$6,$7)',['sync_'+randomUUID(),scope,key,'CATALOG_AND_LOCATIONS',status,'PRIVATE_SYNC_ERROR',at]);
 await db.query("INSERT INTO connection_webhook_receipts(id,workspace_id,connector_id,delivery_id,payload_hash,ciphertext,iv,auth_tag,status) VALUES($1,$2,$3,$1,'PRIVATE_HASH','PRIVATE_CIPHER','PRIVATE_IV','PRIVATE_TAG','RETRY_PENDING')",['receipt_'+randomUUID(),ctx.workspaceId,id]);
 await db.query("INSERT INTO connector_feed_events(id,workspace_id,connector_id,external_event_id,event_type,payload,status,error_message,received_at,processed_at) VALUES($1,$2,$3,$1,'catalog.updated','PRIVATE_EVENT_PAYLOAD','FAILED','PRIVATE_EVENT_ERROR',$4,$4)",['event_'+randomUUID(),ctx.workspaceId,id,at]);

 const connection=await require('../../src/connections/postgres-service').get(db,ctx.workspaceId,id);await sync.initialize(db,connection,ctx.actorId,{label:'Company currency',value:'USD'});
 const ledger=require('../../src/accounting/postgres-ledger');await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});await ledger.post(db,ctx,{sourceKey:randomUUID(),postingDate:'2026-01-01',description:'Disposable opening balance',sourceType:'opening_balances',lines:[{accountKey:'CASH',debitMinor:100},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:100}]});
 const full=await sync.state(db,ctx.workspaceId,id),light=await sync.state(db,ctx.workspaceId,id,{includeFinancialEntries:false});assert.equal(full.financialEntriesIncluded,true);assert.equal(full.pendingEntries.length,1);assert.equal(light.financialEntriesIncluded,false);assert.deepEqual(light.pendingEntries,[]);for(const key of ['policy','mappings','accounts','latestShadow','canVerifyWrites'])assert.deepEqual(light[key],full[key]);
 const before=(await db.query('SELECT * FROM accounting_sync_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 let journalQueries=0;const measured={...db,query:async(...args)=>{if(/FROM accounting_journal_entries|FROM accounting_external_identities/.test(args[0]))journalQueries++;return db.query(...args);}};
 const snapshot=await assistant.lookup(measured,ctx,{view:'connections'}),row=snapshot.rows.find(r=>r.id===id);assert(row);assert.equal(row.status,'connected');assert.equal(row.setup,'AUTHORITY_REQUIRED');assert.equal(row.accounting.requestedAuthority,'OBSERVE');assert.equal(row.accounting.stage,'READ_ONLY_VERIFIED');assert.equal(row.accounting.savedPostingScopeGranted,true);assert.equal(row.accounting.writeEnabledAt,null);assert.equal(row.accounting.latestShadow,null);assert.equal(row.accounting.accountMappings,0);assert.equal(journalQueries,0,'A setup inspection must not load individual journals or external opening balances');
 assert.equal(snapshot.coverage.complete,true);assert.equal(snapshot.coverage.matchingConnections,1);assert.equal(snapshot.administrativeDetailsAvailable,true);
 assert.equal(row.recordsAwaitingMapping,2);assert.equal(row.productsAwaitingMapping,1);assert.equal(row.locationsAwaitingMapping,1,'Unmapped locations must never be counted as products');assert.equal(row.selectedCatalogueStates.length,2,'Unselected and foreign cached records stay outside this scope');
 assert.deepEqual(row.recordedHealth.reasons,['RECORDED_ERROR']);assert.equal(row.recordedHealth.status,row.health);assert.equal(snapshot.savedStateCoverage.complete,true);
 assert.deepEqual(row.recordedSynchronizationStates,[{source:'feed_event',kind:'normalized',status:'FAILED',count:1},{source:'sync_run',kind:'CATALOG_AND_LOCATIONS',status:'COMPLETED',count:1},{source:'sync_run',kind:'CATALOG_AND_LOCATIONS',status:'RUNNING',count:1},{source:'webhook_receipt',kind:'incoming',status:'RETRY_PENDING',count:1}]);
assert(!JSON.stringify(snapshot).includes('PRIVATE_'));assert(snapshot.verification.includes('does not contact a provider'));
 assert.equal(row.accounting.postingEnablement.readyToEnable,false);
 assert.deepEqual(row.accounting.postingEnablement.requirements.filter(r=>!r.satisfied).map(r=>r.code),['POSTING_AUTHORITY','MATCHED_RECONCILIATION']);
 assert.deepEqual((await db.query('SELECT * FROM accounting_sync_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows,before);
 await assert.rejects(sync.enableWrites(db,ctx,id),/request posting authority/);
 // Inspection must use the exact run the policy owns, not a newer unrelated
 // result, and must not interpret granted API scope as business authority.
 const linked='run_'+randomUUID(),newer='run_'+randomUUID();
 for(const [run,status,date]of [[linked,'MISMATCH','2026-01-01T00:00:00.000Z'],[newer,'MATCHED','2026-01-02T00:00:00.000Z']])await db.query(`INSERT INTO accounting_shadow_runs(id,workspace_id,connector_id,status,as_of,local_snapshot,external_snapshot,started_at) VALUES($1,$2,$3,$4,'2026-01-01','{}','{}',$5)`,[run,ctx.workspaceId,id,status,date]);
 await db.query("UPDATE accounting_sync_policies SET requested_authority='POST',posting_direction='FOUNDRY_TO_EXTERNAL',last_shadow_run_id=$3 WHERE workspace_id=$1 AND connector_id=$2",[ctx.workspaceId,id,linked]);
 let inspected=(await assistant.lookup(db,ctx,{view:'connections'})).rows[0].accounting;
 assert.equal(inspected.latestShadow.status,'MATCHED');assert.equal(inspected.latestShadow.current,false);
 assert.deepEqual(inspected.postingEnablement.requirements.filter(r=>!r.satisfied).map(r=>r.code),['MATCHED_RECONCILIATION']);
 await assert.rejects(sync.enableWrites(db,ctx,id),/matching shadow reconciliation/);
 await db.query("UPDATE accounting_shadow_runs SET status='MATCHED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,linked]);
 await db.query("UPDATE workspace_connectors SET capabilities='[\"accounting:read\"]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);
 inspected=(await assistant.lookup(db,ctx,{view:'connections'})).rows[0].accounting;
 assert.deepEqual(inspected.postingEnablement.requirements.filter(r=>!r.satisfied).map(r=>r.code),['POSTING_SCOPE']);
 await assert.rejects(sync.enableWrites(db,ctx,id),/authorization is read-only/);
 await db.query("UPDATE workspace_connectors SET capabilities='[\"accounting:read\",\"accounting:post\"]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);
 inspected=(await assistant.lookup(db,ctx,{view:'connections'})).rows[0].accounting;
 assert.equal(inspected.postingEnablement.readyToEnable,true);assert.equal(inspected.writeEnabledAt,null,'A readiness inspection must not grant posting authority');
 assert.equal((await sync.policy(db,ctx.workspaceId,id)).write_enabled_at,null);
 await db.query("UPDATE users SET role='staff',permissions='{}'::jsonb WHERE id=$1",[ctx.actorId]);const restricted=await assistant.lookup(db,ctx,{view:'connections'});assert.equal(restricted.administrativeDetailsAvailable,false);assert.equal(restricted.savedStateCoverage.available,false);assert.equal(restricted.rows[0].recordedSynchronizationStates,undefined);assert.equal(restricted.rows[0].selectedCatalogueStates,undefined);assert.equal(restricted.rows[0].recordedHealth,undefined);assert.equal(restricted.rows[0].accounting,undefined);assert.equal(restricted.rows[0].savedGrantedCapabilities,undefined);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM stockchief_runtime.provider_effects')).rows[0].n,0);
 t.diagnostic(JSON.stringify({connectedIsNotPosting:true,grantedScopeIsNotAuthority:true,canonicalAccountingStateReused:true,secretAndTenantIsolation:true,adminDetailsRestricted:true,noProviderEffects:true,modelCalls:0}));
});

test('shared connection health keeps canonical priority and mail grace without exposing error text',()=>{
 const {publicHealth,publicStatus}=require('../../src/connections/postgres-service'),now=Date.parse('2026-01-02T00:00:00Z'),base={status:'connected',provider_type:'shopify',created_at:'2026-01-01T23:59:00Z',expected_interval_minutes:1};
 assert.equal(publicHealth(base,now).status,'Connected');const overdue={...base,created_at:'2026-01-01T23:58:30Z'};assert.deepEqual(publicHealth(overdue,now).reasons,['ACTIVITY_OVERDUE']);assert.equal(publicStatus(overdue,now),'Needs attention');assert.equal(publicStatus({...overdue,provider_type:'gmail'},now),'Connected');assert.equal(publicStatus({...overdue,provider_type:'microsoft365'},now),'Connected');
 const all=publicHealth({...overdue,status:'disconnected',last_error:'PRIVATE_ERROR_VALUE',paused_at:'2026-01-01',open_issues:1},now);assert.equal(all.status,'Disconnected');assert.deepEqual(all.reasons,['DISCONNECTED','RECORDED_ERROR','PAUSED','OPEN_ISSUES','ACTIVITY_OVERDUE']);assert(!JSON.stringify(all).includes('PRIVATE_ERROR_VALUE'));
 assert.equal(publicStatus({...base,expected_interval_minutes:0,created_at:null},now),'Connected');
});
