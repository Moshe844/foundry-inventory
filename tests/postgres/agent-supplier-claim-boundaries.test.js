'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-claim-fixture');
async function effect(f,id){return (await f.db.query("SELECT e.* FROM stockchief_runtime.provider_effects e JOIN stockchief_runtime.agent_supplier_claims c ON c.workspace_id=e.workspace_id AND c.communication_id=e.aggregate_id WHERE c.id=$1 ORDER BY e.created_at DESC LIMIT 1",[id])).rows[0];}
test('Concurrent routine claims respect exact goods limits even when drafts were prepared before the rolling week',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f,p=await f.preview(await f.damaged()),r=await service.configure(db,ctx,p.id,f.limits({includePhotos:'',maxWeekly:'2.00'})),q=await f.preview(await f.damaged());
 await db.query("UPDATE stockchief_runtime.agent_supplier_claims SET created_at=now()-interval '8 days' WHERE workspace_id=$1",[ctx.workspaceId]);
 const outcomes=await Promise.allSettled([service.sendAutomatic(db,ctx,p.id,r.id),service.sendAutomatic(db,ctx,q.id,r.id)]);assert.equal(outcomes.filter(o=>o.status==='fulfilled').length,1);assert.match(outcomes.find(o=>o.status==='rejected').reason.message,/rolling seven-day/);await f.deliver();assert.equal(f.sent.length,1);
 const large=await f.preview(await f.damaged(3));await assert.rejects(service.sendAutomatic(db,ctx,large.id,r.id),/exceeds current owner authority/);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_supplier_claims WHERE workspace_id=$1 AND automatic_reserved_at IS NOT NULL',[ctx.workspaceId])).rows[0].n,1);
 await assert.rejects(service.configure(db,ctx,p.id,f.limits({includePhotos:''})),/active rule already/);
 await service.configure(db,ctx,p.id,{ruleId:r.id,revision:1,stop:'yes'});assert.equal((await service.rule(db,ctx,r.id)).enabled,false);
});
test('Late recipient change refuses provider delivery, and an exact individual review can replace only definitively unsent claims',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f,p=await f.preview(await f.damaged()),r=await service.configure(db,ctx,p.id,f.limits({includePhotos:''}));await service.sendAutomatic(db,ctx,p.id,r.id);
 const e=await effect(f,p.id),outbound=require('../../src/connections/postgres-outbound-mail');
 await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,e.id,{provider:f.provider,beforeSend:async()=>{await db.query("UPDATE suppliers SET email='changed@example.test' WHERE workspace_id=$1",[ctx.workspaceId]);}}),/changed/);assert.equal(f.sent.length,0);assert.equal((await effect(f,p.id)).error_code,'claim_needs_review');
 await db.query("UPDATE suppliers SET email='damage@example.test' WHERE workspace_id=$1",[ctx.workspaceId]);await f.send(p);await f.deliver();assert.equal(f.sent.length,1);await f.send(p);await f.deliver();assert.equal(f.sent.length,1);
 const q=await f.preview(await f.damaged());await f.send(q);const uncertain=await effect(f,q.id);await assert.rejects(outbound.executeSendEffect(db,ctx.workspaceId,uncertain.id,{provider:{send:async()=>{throw Error('Synthetic lost acceptance response');}}}),/Synthetic lost/);
 assert.equal((await effect(f,q.id)).status,'AMBIGUOUS');await assert.rejects(f.send(q),/Uncertain|uncertain/);assert.equal(f.sent.length,1);
});
test('Pause, shadow, current job modes and tampered photo bytes stop queued claims before any provider call',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f,hold=await f.damaged(),photo=await f.photo(hold),p=await f.preview(hold,[photo.id]),r=await service.configure(db,ctx,p.id,f.limits());
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,46,{mode:'watch',revision:0});await assert.rejects(service.sendAutomatic(db,ctx,p.id,r.id),/Watch|watch/);await modes.save(db,ctx,46,{mode:'inherit',revision:1});
 await require('../../src/autopilot/postgres-service').pause(db,ctx,{role:'owner'},'Test supplier claim pause');await assert.rejects(service.sendAutomatic(db,ctx,p.id,r.id),/paused/);await require('../../src/autopilot/postgres-service').resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await assert.rejects(service.sendAutomatic(db,ctx,p.id,r.id),/14|shadow|Watch|watch/);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await service.sendAutomatic(db,ctx,p.id,r.id);await db.query("UPDATE stockchief_runtime.agent_quality_photos SET email_content=decode('ffd8ff00','hex') WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,photo.id]);const e=await effect(f,p.id);
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,e.id,{provider:f.provider}),/integrity review/);assert.equal(f.sent.length,0);
 await f.subscribe('starter');await service.configure(db,ctx,p.id,{ruleId:r.id,revision:1,stop:'yes'});assert.equal((await service.rule(db,ctx,r.id)).enabled,false);
});
test('Photo selection stays with its physical delivery and owner role loss blocks private claims',{timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f,a=await f.damaged(),b=await f.damaged(),photo=await f.photo(a);await assert.rejects(f.preview(b,[photo.id]),/exact delivery inspection/);
 const p=await f.preview(a,[photo.id]);await db.query("UPDATE users SET role='staff' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(service.page(db,ctx,{id:p.id}),/Only the inventory owner/);await assert.rejects(f.send(p),/Only the inventory owner/);assert.equal(f.sent.length,0);
});
test('Photo evidence preserves ten distinct originals, replays exact evidence and refuses a larger or conflicting claim selection',{timeout:240000},async t=>{
 const f=await fixture(t,'growth'),{db,ctx}=f,hold=await f.damaged(),sharp=require('sharp'),ids=[];
 for(let i=0;i<10;i++){const buffer=await sharp({create:{width:64,height:64,channels:3,background:{r:90+i,g:60,b:30}}}).png().toBuffer(),file={filename:'physical-'+i+'.png',buffer};const p=await f.photoService.upload(db,ctx,hold,file,{caption:'Recorded physical photo '+i});ids.push(p.id);assert.deepEqual((await f.photoService.load(db,ctx,p.id)).bytes,buffer);if(i===0){assert.equal((await f.photoService.upload(db,ctx,hold,file,{caption:'Recorded physical photo '+i})).id,p.id);await assert.rejects(f.photoService.upload(db,ctx,hold,file,{caption:'Changed note'}),/different note/);}}
 assert.equal((await f.photoService.list(db,ctx,hold)).length,10);await assert.rejects(f.photo(hold),/already has ten photos/);await f.subscribe('pro');await assert.rejects(f.preview(hold,ids.slice(0,4)),/three exact photos/);
 const selected=await f.preview(hold,ids.slice(0,3));assert.equal(selected.snapshot.photos.length,3);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_quality_photos WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,10);
});
