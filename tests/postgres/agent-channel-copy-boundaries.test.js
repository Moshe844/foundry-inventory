'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-channel-copy-fixture');
test('stale previews and settings cannot authorize different copy; downgrades preserve saved text while stopping all new writing',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,preview=await s.preview(db,ctx,f.input);
 await f.rename('Current checked name');
 await assert.rejects(s.save(db,ctx,{...f.input,sourceHash:preview.sourceHash,confirmed:'yes'}),/new preview/);
 const p=await f.prepare();await s.configure(db,ctx,p.copyId,{revision:1,confirmed:'yes'});
 await assert.rejects(s.configure(db,ctx,p.copyId,{revision:1,stop:'yes'}),/Reload/);
 await f.rename('Changed after downgrade');
 for(const plan of ['starter','growth']){
  await f.subscribe(plan);
  assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).held,true);
  await assert.rejects(s.request(db,ctx,p.copyId),/Pro|include|permission/i);
  if(plan==='starter')await assert.rejects(f.prepare({label:'No new Starter writing'}),/Growth|include|permission/i);
  assert.equal((await s.screen(db,ctx,{id:p.copyId})).history.length,1);
  assert.match(await s.download(db,ctx,p.id),/Current checked name/);
 }
 await s.configure(db,ctx,p.copyId,{revision:2,stop:'yes'});
 assert.equal((await s.screen(db,ctx,{id:p.copyId})).selected.enabled,false);
});
test('real global, per-job, first-fourteen-day and disabled-owner authority stops routine copies before a version is written',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,p=await f.prepare();await s.configure(db,ctx,p.copyId,{revision:1,confirmed:'yes'});await f.rename('Not yet authorized replacement');
 const count=async()=>(await s.screen(db,ctx,{id:p.copyId})).history.length;
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).held,true);assert.equal(await count(),1);await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,128,{mode:'watch',revision:0});assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).held,true);await modes.save(db,ctx,128,{mode:'ask',revision:1});assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).held,true);await modes.save(db,ctx,128,{mode:'routine',revision:2});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).held,true);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("INSERT INTO platform_account_access(account_id,disabled_at,reason,changed_by) VALUES($1,now(),'Isolated copy access test',$1)",[f.owner.accountId]);assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).held,true);await db.query('DELETE FROM platform_account_access WHERE account_id=$1',[f.owner.accountId]);
 assert.equal(await count(),1);assert.equal((await s.onCopy(db,ctx.workspaceId,p.copyId)).replayed,false);assert.equal(await count(),2);
});
test('foreign products, other owners and staff cannot prepare or download another inventory copy',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,p=await f.prepare();
 await assert.rejects(f.prepare({skuIds:['foreign-product']}),/inactive or foreign/);
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Preserved other inventory',email:randomUUID()+'@example.test',password:f.password});
 await assert.rejects(s.download(db,{workspaceId:other.workspaceId,actorId:other.userId},p.id),/not in this inventory/);
 await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(s.preview(db,ctx,f.input),/current inventory owner/);await assert.rejects(s.download(db,ctx,p.id),/current inventory owner/);
});
