'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const commerce=require('../../src/operations/postgres-commerce');
const credentials=require('../../src/connections/postgres-credential-store');
const scheduler=require('../../src/operations/postgres-scheduler');
const jobs=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers');
const {newId}=require('../../src/lib/util');

test('PostgreSQL scheduler polls tenant mailboxes, replays safely and treats successful checks as fresh evidence',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-mail-polling'});
    await migratePostgres(database);context.after(async()=>{await database.close();cluster.stop();});
    const business=await auth.createBusiness(database,{businessName:'Polling Business',name:'Polling Owner',
      email:'polling@example.test',password:'polling-password',now:'2026-09-23T09:00:00.000Z'});
    const ctx={workspaceId:business.workspaceId,actorId:business.userId};
    await commerce.createSupplier(database,ctx,{name:'Polling Supplier',email:'supplier@example.test'});
    const connectorId=newId('con');
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       last_synced_at,last_activity_at,expected_interval_minutes,setup_status,authorized_by_user_id,
       provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Polling Gmail','gmail',$4,'{}','connected',$5,$6,NULL,$7,5,'CONNECTED',$8,
        'polling-mailbox','business@example.test',$7,$7)`,[connectorId,ctx.workspaceId,`gmail:${connectorId}`,
      JSON.stringify(['business mail']),JSON.stringify(['mail:read','mail:send']),`connection_credentials:${connectorId}`,
      '2026-09-23T10:00:00.000Z',ctx.actorId]);
    await database.transaction((client)=>credentials.put(client,ctx.workspaceId,connectorId,'provider',
      {accessToken:'polling-token',mailbox:'business@example.test'}));
    let polls=0;
    const adapter={async poll({credentials:providerCredentials,since}){
      polls+=1;assert.equal(providerCredentials.accessToken,'polling-token');assert.ok(since);
      return {cursor:`cursor-${polls}`,messages:[
        {messageId:'provider-known-1',threadId:'thread-known',sender:'supplier@example.test',
          recipients:['business@example.test'],subject:'Can Friday work?',bodyText:'Please confirm Friday.',
          receivedAt:'2026-09-23T15:30:00.000Z'},
        {messageId:'provider-unrelated-1',sender:'newsletter@example.test',subject:'Newsletter',
          bodyText:'This unrelated body must not enter business mail.',receivedAt:'2026-09-23T15:31:00.000Z'},
        {messageId:`provider-own-${polls}`,stockChiefMessageId:`mailout-${polls}`,sender:'business@example.test',
          subject:'Sent by StockChief',bodyText:'Own sent mail.',receivedAt:'2026-09-23T15:32:00.000Z'},
      ]};
    }};
    const providers={get(type){return type==='gmail'?adapter:null;}};
    const runtimeHandlers=handlers.create(providers);
    const firstNow=Date.parse('2026-09-23T16:00:00.000Z');
    await scheduler.scheduleOnce(database,{now:firstNow});
    const sweep=await jobs.processOne(database,runtimeHandlers,{owner:'mail-scheduler',now:firstNow,leaseMs:60000});
    assert.equal(sweep.status,'COMPLETED');assert.equal(sweep.result.scheduledMailboxPolls,1);
    assert.equal(sweep.result.staleConnectors,1);
    const firstPoll=await jobs.processOne(database,runtimeHandlers,{owner:'mail-worker',now:firstNow+1,leaseMs:60000});
    assert.equal(firstPoll.status,'COMPLETED');assert.deepEqual({accepted:firstPoll.result.accepted,
      setAside:firstPoll.result.setAside,replayed:firstPoll.result.replayed,ignoredOwn:firstPoll.result.ignoredOwn},
    {accepted:1,setAside:1,replayed:0,ignoredOwn:1});
    assert.equal(polls,1);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM connection_email_messages WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0].count,'1');
    const aside=(await database.query('SELECT * FROM connection_email_set_aside WHERE workspace_id=$1',[ctx.workspaceId])).rows;
    assert.equal(aside.length,1);assert.doesNotMatch(JSON.stringify(aside),/unrelated body|Own sent mail/);
    const connector=(await database.query('SELECT * FROM workspace_connectors WHERE id=$1',[connectorId])).rows[0];
    assert.ok(connector.last_synced_at);assert.equal(connector.last_error,null);
    assert.equal((await database.query(`SELECT status FROM connection_issues WHERE workspace_id=$1
      AND fingerprint=$2`,[ctx.workspaceId,`connector-stale:${connectorId}`])).rows[0].status,'RESOLVED');

    const freshNow=Date.parse(connector.last_synced_at)+4*60_000;
    await scheduler.scheduleOnce(database,{now:freshNow});
    const freshSweep=await jobs.processOne(database,runtimeHandlers,{owner:'mail-scheduler',now:freshNow,leaseMs:60000});
    assert.equal(freshSweep.result.staleConnectors,0);assert.equal(freshSweep.result.scheduledMailboxPolls,0);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.jobs WHERE workspace_id=$1
      AND kind='mailbox.poll' AND status IN ('PENDING','RETRY','RUNNING')`,[ctx.workspaceId])).rows[0].count,'0');

    const dueAgain=Date.parse(connector.last_synced_at)+6*60_000;
    await scheduler.scheduleOnce(database,{now:dueAgain});
    const dueSweep=await jobs.processOne(database,runtimeHandlers,{owner:'mail-scheduler',now:dueAgain,leaseMs:60000});
    assert.equal(dueSweep.result.scheduledMailboxPolls,1);
    const replayPoll=await jobs.processOne(database,runtimeHandlers,{owner:'mail-worker',now:dueAgain+1,leaseMs:60000});
    assert.equal(replayPoll.status,'COMPLETED');assert.equal(replayPoll.result.replayed,2);
    assert.equal(replayPoll.result.ignoredOwn,1);assert.equal(polls,2);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM connection_email_messages WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0].count,'1');
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM connection_email_set_aside WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0].count,'1');
  });
