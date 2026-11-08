'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const books=require('../../src/autopilot/playbooks');
test('playbooks recheck each job and the owner at registration, schedule, replay and readback',{timeout:180000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async()=>{await db.close();await cluster.stop();});
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Books',email:randomUUID()+'@example.test',password:'Demo!'+randomUUID()});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
  async function subscribe(id){await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status)
    VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'),'ACTIVE')
    ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),owner.accountId,id]);}
  const definition={name:'Weekly stock',steps:['low-stock','value'],cadence:'weekly'};
  await subscribe('starter');await assert.rejects(books.create(db,ctx,definition),/Growth/);
  await subscribe('growth');
  await assert.rejects(books.create(db,ctx,{...definition,steps:['value','supplier-review']}),/Pro/);
  await assert.rejects(books.create(db,ctx,{...definition,steps:['value','combined-stock']}),/Custom/);
  await assert.rejects(books.create(db,ctx,{...definition,steps:['value','payout']}),/supported/);
  await assert.rejects(books.create(db,{...ctx,actorId:'fake-owner'},definition),/owner/);
  const first=await books.create(db,ctx,definition);
  for(let i=1;i<10;i++) await books.create(db,ctx,definition);
  await assert.rejects(books.create(db,ctx,definition),/10 playbooks/);
  const results=await books.run(db,ctx,first,'review');assert.equal(results.length,2);
  assert.deepEqual(await books.run(db,ctx,first,'review'),results);
  await db.query("UPDATE stockchief_runtime.agent_playbooks SET next_at=now()-interval '1 minute' WHERE id=$1",[first]);
  await db.transaction(books.schedule);await db.transaction(books.schedule);
  const queued=await db.query("SELECT * FROM stockchief_runtime.jobs WHERE kind='agent.playbook' AND workspace_id=$1",[ctx.workspaceId]);
  assert.equal(queued.rowCount,1);
  const handler=require('../../src/operations/postgres-runtime-handlers').create()['agent.playbook'];
  const job={workspaceId:ctx.workspaceId,payload:queued.rows[0].payload};
  assert.equal((await handler(job,db)).length,2);
  await subscribe('starter');
  assert.equal((await handler(job,db)).held,true);
  assert.equal((await books.list(db,ctx)).books.find(b=>b.id===first).result,null);
  await subscribe('pro');
  const report=await books.create(db,ctx,{...definition,steps:['value','supplier-review']});
  assert.equal((await books.run(db,ctx,report,'review'))[1].rows.length,0);
  await assert.rejects(books.create(db,ctx,{...definition,steps:['value','combined-stock']}),/Custom/);
  await subscribe('enterprise');
  const combined=await books.create(db,ctx,{...definition,steps:['value','combined-stock']});
  assert.equal((await books.run(db,ctx,combined,'review'))[1].rows[0].inventory,'Books');
  await books.remove(db,ctx,combined);await assert.rejects(books.run(db,ctx,combined,'review'),/available/);
});
