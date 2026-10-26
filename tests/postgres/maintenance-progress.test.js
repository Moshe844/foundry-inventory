'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('repeated check requests reuse pending work, progress stays scoped and read-only staff cannot schedule automation',
  {timeout:120000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t),p=require('../../src/operations/postgres-maintenance-progress');
  const first=await p.request(f.db,f.ctx),again=await p.request(f.db,f.ctx);
  assert.equal(first.created,true);assert.equal(again.created,false);assert.equal(first.id,again.id);
  const progress=await p.read(f.db,f.ctx.workspaceId);
  assert.equal(progress.active,true);assert.match(progress.checks[0].text,/waiting for its next batch/);
  assert.equal((await p.read(f.db,'unrelated-business')).active,false);
  await f.db.query("UPDATE users SET role='viewer' WHERE workspace_id=$1 AND id=$2",[f.ctx.workspaceId,f.ctx.actorId]);
  await assert.rejects(p.request(f.db,f.ctx),/permission|allowed|authori/i);
  assert.equal((await f.db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='autopilot.evaluate'",[f.ctx.workspaceId])).rows[0].n,1);
  assert.equal(await f.balance(),4);
});
