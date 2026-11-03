'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
test('hosted load fixtures require the synthetic owner, isolate signed sessions and clean up',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,fixtures=require('../../scripts/lib/staging-load-sessions'),secret='isolated-hosted-load-secret';
 await assert.rejects(fixtures.create(db,ctx.workspaceId,secret),/dedicated synthetic/);
 await db.query("UPDATE workspaces SET name='Synthetic ERP release load fixture' WHERE id=$1",[ctx.workspaceId]);
 const fixture=await fixtures.create(db,ctx.workspaceId,secret,{users:3});assert.equal(fixture.cookies.length,3);assert.equal(new Set(fixture.cookies).size,3);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:secret});f.cleanup(()=>app.locals.sessionStore.close());
 for(const cookie of fixture.cookies){const page=await request(app).get('/inventory').set('Cookie',cookie);assert.equal(page.status,200);assert.match(page.text,/Synthetic ERP release load fixture/);}
 await fixture.close();for(const cookie of fixture.cookies)assert.equal((await request(app).get('/inventory').set('Cookie',cookie)).status,302);
 const reader=await require('../../src/domain/postgres-auth-service').createPendingAccount(db,{name:'Synthetic reader',businessName:'Synthetic ERP release reader',email:'load-reader@example.test',password:'Synthetic-reader-fixture!'});
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES('load-reader',$1,$2,'Synthetic reader','accountant',now())",[ctx.workspaceId,reader.id]);
 const distinct=await fixtures.create(db,ctx.workspaceId,secret,{users:2,distinctMembers:true});assert.equal(new Set(distinct.members.map(m=>m.accountId)).size,2);for(const cookie of distinct.cookies){assert.equal((await request(app).get('/inventory').set('Cookie',cookie)).status,200);assert.equal((await request(app).get('/money').set('Cookie',cookie)).status,200);}await distinct.close();
 await db.query("INSERT INTO platform_account_access(account_id,disabled_at,revision,reason,changed_by) VALUES($1,now(),1,'Isolated disabled fixture',$1)",[f.owner.accountId]);
 await assert.rejects(fixtures.create(db,ctx.workspaceId,secret),/Disabled accounts/);
});
