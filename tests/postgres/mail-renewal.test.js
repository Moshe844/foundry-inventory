'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const credentials=require('../../src/connections/postgres-credential-store');
const scheduler=require('../../src/operations/postgres-scheduler');
const jobs=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers');
const {newId}=require('../../src/lib/util');

test('PostgreSQL scheduler renews an expiring mailbox push subscription with retry-safe encrypted credentials',
  {timeout:120000},async(context)=>{const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-mail-renewal'});
    await migratePostgres(database);context.after(async()=>{await database.close();cluster.stop();});
    const business=await auth.createBusiness(database,{businessName:'Renewal Business',name:'Renewal Owner',
      email:'renewal@example.test',password:'renewal-password',now:'2026-09-23T09:00:00.000Z'});
    const connectorId=newId('con');const now=Date.parse('2026-09-23T16:00:00.000Z');
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       last_synced_at,last_activity_at,expected_interval_minutes,setup_status,authorized_by_user_id,
       provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Renewal Gmail','gmail',$4,'{}','connected',$5,$6,$8,$8,5,'CONNECTED',$7,
        'renewal-mailbox','renewal-mailbox@example.test',$9,$9)`,[connectorId,business.workspaceId,`gmail:${connectorId}`,
      JSON.stringify(['business mail']),JSON.stringify(['MAIL_READ','MAIL_SEND','MAILBOX_WATCH']),
      `connection_credentials:${connectorId}`,business.userId,new Date(now-60_000).toISOString(),'2026-09-23T09:00:00.000Z']);
    await database.transaction((client)=>credentials.put(client,business.workspaceId,connectorId,'provider',{
      accessToken:'renewal-secret',refreshToken:'renewal-refresh',mailbox:'renewal-mailbox@example.test',
      expiresAt:now+60*60_000,deliveryMode:'push',historyId:'before',watchExpiration:now+60_000,
    },new Date(now+60*60_000).toISOString()));
    let attempts=0;let seenWebhook=null;const adapter={registerWebhooks(){throw new Error('register should not be used');},
      async renewWebhooks({credentials:current,webhookUrl}){attempts+=1;seenWebhook=webhookUrl;
        assert.equal(current.accessToken,'renewal-secret');if(attempts===1)throw Object.assign(new Error('temporary provider outage'),{retryable:true});
        return {credentials:{...current,deliveryMode:'push',historyId:'after',watchExpiration:now+6*24*60*60_000}};
      }};
    const providers={get(type){return type==='gmail'?adapter:null;}};
    const runtime=handlers.create(providers,{publicOrigin:'https://qualify.stockchief.test'});
    await scheduler.scheduleOnce(database,{now});const sweep=await jobs.processOne(database,runtime,
      {owner:'renewal-scheduler',now,leaseMs:60000});
    assert.equal(sweep.status,'COMPLETED');assert.equal(sweep.result.scheduledMailboxRenewals,1);
    const failed=await jobs.processOne(database,runtime,{owner:'renewal-worker',now:now+1,leaseMs:60000});
    assert.equal(failed.kind,'mailbox.renew-push');assert.equal(failed.status,'RETRY');
    assert.equal((await credentials.get(database,business.workspaceId,connectorId,'provider')).historyId,'before');
    const completed=await jobs.processOne(database,runtime,{owner:'renewal-worker',now:now+2000,leaseMs:60000});
    assert.equal(completed.status,'COMPLETED');assert.equal(completed.result.renewed,true);assert.equal(attempts,2);
    assert.equal(seenWebhook,'https://qualify.stockchief.test/api/v1/connections/gmail/webhooks');
    const stored=await credentials.get(database,business.workspaceId,connectorId,'provider');
    assert.equal(stored.historyId,'after');assert.equal(stored.watchExpiration,now+6*24*60*60_000);
    const raw=(await database.query('SELECT ciphertext FROM connection_credentials WHERE connector_id=$1',[connectorId])).rows[0];
    assert.doesNotMatch(raw.ciphertext,/renewal-secret|renewal-refresh|after/);
    await scheduler.scheduleOnce(database,{now:now+60_000});const duplicateSweep=await jobs.processOne(database,runtime,
      {owner:'renewal-scheduler',now:now+60_000,leaseMs:60000});
    assert.equal(duplicateSweep.result.scheduledMailboxRenewals,0);
  });
