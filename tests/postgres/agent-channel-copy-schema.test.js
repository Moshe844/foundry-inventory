'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('channel copy upgrade preserves all prior migration checksums and actual account deletion removes both registered tables',{timeout:300000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 const migrate=require('../../src/db/migrate-postgres').migratePostgres;
 await migrate(db,{through:'317-agent-website-stock-chat.sql'});
 const before=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 await migrate(db,{through:'318-agent-channel-copy.sql'});
 const after=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 assert.equal(before.length,323);assert.equal(after.length,324);assert.deepEqual(after.filter(r=>r.name!=='318-agent-channel-copy.sql'),before);
 await migrate(db,{through:'318-agent-channel-copy.sql'});assert.deepEqual((await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows,after);
 const old=process.env.STOCKCHIEF_RUNTIME_ENV;process.env.STOCKCHIEF_RUNTIME_ENV='staging';t.after(()=>{if(old===undefined)delete process.env.STOCKCHIEF_RUNTIME_ENV;else process.env.STOCKCHIEF_RUNTIME_ENV=old;});
 const f=await require('../helpers/agent-channel-copy-fixture').fixture(t);await f.prepare();
 assert.equal((await f.db.query("SELECT count(*)::int n FROM commercial_storage_tables WHERE relation::text IN('stockchief_runtime.agent_channel_copy_sets','stockchief_runtime.agent_channel_copy_versions')")).rows[0].n,2);
 const password='Admin!'+randomUUID(),admin=await require('../../src/domain/postgres-auth-service').createBusiness(f.db,{email:randomUUID()+'@example.test',password,name:'Copy removal admin',businessName:'Other inventory preserved'});
 await f.db.query("INSERT INTO developer_account_administrators(account_id,granted_by) VALUES($1,'Isolated channel copy removal qualification')",[admin.accountId]);
 const removal=require('../../src/domain/postgres-developer-accounts'),review=await removal.review(f.db,admin.accountId,f.email);
 assert.equal(review.canDelete,true,review.blockers.join('; '));
 const queued=await removal.queue(f.db,admin.accountId,{email:f.email,confirmEmail:f.email,confirmed:'yes',password,reviewHash:review.reviewHash});
 assert.equal((await removal.execute(f.db,queued.requestId)).signInAccountRemoved,true);
 for(const table of ['agent_channel_copy_sets','agent_channel_copy_versions'])assert.equal((await f.db.query('SELECT count(*)::int n FROM stockchief_runtime.'+table+' WHERE workspace_id=$1',[f.ctx.workspaceId])).rows[0].n,0);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM accounts WHERE id=$1',[admin.accountId])).rows[0].n,1);
});
test('all plan Back links remain accessible and full storage refuses new versions without changing prior copy',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-channel-copy-fixture').fixture(t),{db,ctx,service:s}=f,p=await f.prepare();
 for(const tier of ['starter','growth','pro','enterprise']){
  await f.subscribe(tier);const page=await f.browser.get('/autopilot/channel-copy');assert.equal(page.status,200);
  const href=/<a data-channel-copy-back href="([^"]+)"/.exec(page.text)?.[1];
  assert.equal(href,tier==='starter'?'/autopilot':'/autopilot/reviews/channel-copy');assert.equal((await f.browser.get(href)).status,200);
 }
 await f.subscribe('growth');const ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId),meter=await ent.meterState(db,scope,'storage_bytes');
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('full-channel-copy-storage',$1,'storage_bytes',$2,'Isolated full storage qualification')",[f.owner.accountId,meter.capacityUsed]);
 await f.rename('Changed product needing storage');
 await assert.rejects(f.prepare({id:p.copyId,revision:1}),/storage|stored-data|capacity/i);
 assert.equal((await s.screen(db,ctx,{id:p.copyId})).history.length,1);
 assert.match(await s.download(db,ctx,p.id),/Parcel item/);
});
