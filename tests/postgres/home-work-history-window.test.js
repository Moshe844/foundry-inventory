'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('Home counts only indexed recent work and findings, independently of old history',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 t.diagnostic(JSON.stringify(await require('../helpers/home-work-history-checks').check(db,ctx)));
 const summary=require('../../src/projections/postgres-home-summary'),cutoff='2026-11-01T00:00:00.000Z',before=await summary.activityCounts(db,ctx.workspaceId,cutoff);
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Other work history',email:randomUUID()+'@example.test',password:f.password});
 await db.query(`INSERT INTO work_items(id,workspace_id,category,source,execution_status,approval_requirement,idempotency_key,created_at,completed_at)
  VALUES('home-foreign-work',$1,'history','fixture','COMPLETED','NONE','home-foreign-work','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')`,[other.workspaceId]);
 assert.deepEqual(await summary.activityCounts(db,ctx.workspaceId,cutoff),before);
 assert.deepEqual(await summary.activityCounts(db,other.workspaceId,cutoff),{alone:1,approved:0,proposed:1,found:0,resolved:0});
});
