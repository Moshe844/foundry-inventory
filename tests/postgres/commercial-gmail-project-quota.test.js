'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const network=require('../../src/commercial/network');

test('Gmail project quota is atomic across tenants and fails closed before provider work',
 {timeout:120000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString,{max:10});
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const quota={method:'messages.get',units:20};
 const results=await Promise.allSettled(Array.from({length:6},()=>
  network.reserveGmailQuota(db,quota,100)));
 assert.equal(results.filter(row=>row.status==='fulfilled').length,5);
 assert.equal(results.filter(row=>row.status==='rejected').length,1);
 assert.match(results.find(row=>row.status==='rejected').reason.message,/safety ceiling/);
 const stored=(await db.query("SELECT reserved_units FROM commercial_provider_daily_quotas WHERE provider='gmail'")).rows;
 assert.equal(stored.length,1);assert.equal(Number(stored[0].reserved_units),100);
 await assert.rejects(network.reserveGmailQuota(db,null),/Unrecognized/);
 await db.query("UPDATE commercial_provider_daily_quotas SET reserved_units=$1 WHERE provider='gmail'",
  [network.GMAIL_PROJECT_DAILY_SAFE_CEILING]);
 await assert.rejects(network.before({database:db,scope:{workspaceId:'test'},system:true},
  'https://gmail.googleapis.com/gmail/v1/users/me/profile',{method:'GET'},'Gmail'),/safety ceiling/);
});
