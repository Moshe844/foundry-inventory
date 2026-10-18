'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('native dataset inspection gives complete extent evidence without a second count query and rechecks current tenant state',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),create=name=>auth.createBusiness(db,{name,businessName:name,email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()}),owner=await create('Data inspector'),other=await create('Foreign business'),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},foreign={workspaceId:other.workspaceId,actorId:other.userId};
 const catalog=require('../../src/domain/postgres-catalog-service');await catalog.createItem(db,foreign,{name:'Foreign canary',baseCode:'FOREIGN-'+randomUUID().slice(0,8),trackingMode:'quantity'});
 const store=require('../../src/assistant/postgres-goal-store'),goal=await store.create(db,ctx,'Inspect the current registered catalogue records.'),claimed=await store.claim(db,ctx,goal.id),gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:claimed.run_token});
 const result=await gateway.dataset({spec:{dataset:'catalogue'}});assert.equal(result.rows.length,0);assert.deepEqual(result.extent,{rowKind:'records',returnedRows:0,totalRows:0,complete:true});assert(result.availableFields.product);assert(!JSON.stringify(result).includes('Foreign canary'));
 claimed.checkpoint.harness={candidate:'codex',calls:{},native:{}};const observation=require('../../scripts/environment-agent-demo/observations').store(claimed.checkpoint.harness,{id:goal.id+':inspect',name:'environment_dataset',result,at:new Date().toISOString(),source:{version:1,name:'environment_dataset',input:{specJson:'{"dataset":"catalogue"}',offset:0}}});
 const report={version:1,status:'completed',outcome:'answer',answer:'There are no recorded catalogue products in this business.',claims:[{evidenceId:observation.id,path:'/extent/totalRows',value:0}]},verify=()=>require('../../src/assistant/postgres-codex-verification').verify(db,ctx,claimed,JSON.stringify(report),null);
 assert.equal((await verify()).verified,true);
 await catalog.createItem(db,ctx,{name:'New unfamiliar item',baseCode:'ITEM-'+randomUUID().slice(0,8),trackingMode:'quantity'});assert.equal((await verify()).verified,false,'A new business record invalidates the old zero; extent is not trusted merely because it was recorded');
 const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0],reports=require('../../src/reports/postgres-service');
 for(let i=0;i<2;i++)await catalog.createItem(db,ctx,{name:'More unfamiliar item '+i,baseCode:'ITEM-'+randomUUID().slice(0,8),trackingMode:'quantity'});
 const spec=reports.inspectionSpec({dataset:'catalogue'},actor),page=await reports.run(db,ctx,actor,spec,{limit:2});assert.equal(page.hasMore,true);assert.equal(page.extent.complete,false);assert.equal(page.extent.totalRows,null);assert.equal(page.extent.returnedRows,1);
 const end=await reports.run(db,ctx,actor,spec,{limit:2,offset:3});assert.equal(end.rows.length,0);assert.equal(end.extent.totalRows,null,'An empty later page is not a zero-record dataset');
 const grouped=await reports.run(db,ctx,actor,{dataset:'catalogue',summary:true,aggregate:'count'});assert.equal(grouped.extent.rowKind,'groups');assert.equal(grouped.extent.totalRows,1);assert.equal(Number(grouped.rows[0].count),3);
 await assert.rejects(gateway.dataset({spec:{dataset:'catalogue',columns:['unregistered_secret']}}));
 assert.throws(()=>reports.inspectionSpec({dataset:'connections'},{role:'viewer',permissions:[]}),/permission|not allowed|cannot/i);
 assert.throws(()=>reports.normalize({dataset:'catalogue'},actor),/Choose columns/,'Explicit report-building validation remains strict');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n),0);
});

test('shared message evidence includes real saved replies and distinguishes draft, authorized and sent states',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Message inspector',businessName:'Message inspection',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},id='con_'+randomUUID(),at=new Date().toISOString();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
 VALUES($1,$2,$3,'Fixture mailbox','gmail','[]','{}','connected','[]',5,'CONNECTED',$4,$5,$5)`,[id,ctx.workspaceId,'gmail:'+id,ctx.actorId,at]);
 await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:'Known fixture supplier',email:'supplier@example.test'});
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0],mail=require('../../src/connections/postgres-mail'),captured=await mail.capture(db,connection,{externalMessageId:'reply-'+randomUUID(),sender:'supplier@example.test',subject:'Question about delivery',bodyText:'Can you confirm the delivery details?',receivedAt:at});assert(captured.accepted);
 await mail.saveDraft(db,ctx,captured.messageId,{subject:'Reviewed delivery reply',body:'This is a saved owner reply, awaiting the required sending decision.'});
 for(const status of ['PREPARED','SENT','FAILED'])await db.query(`INSERT INTO customer_communications(id,workspace_id,recipient,subject,body,status,idempotency_key,created_at,updated_at,sent_at)
 VALUES($1,$2,'customer@example.test',$3,'Fixture message',$4,$1,$5,$5,$6)`,['cc_'+randomUUID(),ctx.workspaceId,'Fixture '+status,status,at,status==='SENT'?at:null]);
 const lookup=()=>require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'messages',search:null,timeframe:'all_time'}),read=await lookup();
 const draft=read.rows.find(row=>row.kind==='draft reply');assert(draft);assert.equal(draft.status,'DRAFT');assert.equal(draft.approvalStage,'not approved for sending');assert.equal(draft.href,'/mail/'+captured.messageId);
 const prepared=read.rows.find(row=>row.subject==='Fixture PREPARED');assert.equal(prepared.kind,'draft customer email');assert.equal(prepared.approvalStage,'not approved for sending');assert.match(prepared.href,/^\/messages\/customer\//);
 assert.equal(read.rows.find(row=>row.subject==='Fixture SENT').kind,'sent customer email');
 assert.equal(read.rows.find(row=>row.subject==='Fixture FAILED').approvalStage,'sending approval not recorded','Delivery status alone never invents approval authority');
 await db.query(`INSERT INTO stockchief_runtime.email_reply_outbox(id,workspace_id,message_id,connector_id,idempotency_key,recipient,subject,body,status)
 VALUES($1,$2,$3,$4,$1,'supplier@example.test','Reviewed delivery reply','Saved reply','AMBIGUOUS')`,['out_'+randomUUID(),ctx.workspaceId,captured.messageId,id]);
 const current=await lookup(),uncertain=current.rows.find(row=>row.kind==='draft reply');assert.equal(uncertain.status,'AMBIGUOUS');assert.equal(uncertain.approvalStage,'authorized; see delivery status');assert(!current.rows.some(row=>row.subject==='Reviewed delivery reply'&&row.kind.startsWith('sent')));
 const filtered=await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'messages',search:'draft',timeframe:'all_time'});assert.equal(filtered.rows.length,2);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.provider_effects')).rows[0].n),0,'Inspecting saved work never queues an email or changes authority');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n),0);
});
