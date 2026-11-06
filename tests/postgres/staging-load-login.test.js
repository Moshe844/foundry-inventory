'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
test('hosted qualification uses distinct normal logins, restores passwords and removes only its sessions',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,fixtures=require('../../scripts/lib/staging-load-login');
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomBytes(32).toString('hex')}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 f.cleanup(async()=>{await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,options={users:1,base};
 await assert.rejects(fixtures.create(db,ctx.workspaceId,options),/dedicated synthetic/);
 await assert.rejects(fixtures.create(db,ctx.workspaceId,{...options,base:'https://example.com'}),/restricted to staging/);
 await db.query("UPDATE workspaces SET name='Synthetic ERP release normal login' WHERE id=$1",[ctx.workspaceId]);
 const reader=await require('../../src/domain/postgres-auth-service').createPendingAccount(db,{name:'Reader',businessName:'Synthetic reader',email:crypto.randomUUID()+'@example.test',password:'Synthetic-reader-fixture!'});
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES('normal-reader',$1,$2,'Reader','accountant',now())",[ctx.workspaceId,reader.id]);
 const before=(await db.query('SELECT id,password_hash FROM accounts WHERE id=ANY($1::text[]) ORDER BY id',[[f.owner.accountId,reader.id]])).rows;
 // An unfinished signup is refused by the real login route. The fixture must
 // restore both accounts even after the first member has already signed in.
 await assert.rejects(fixtures.create(db,ctx.workspaceId,{...options,users:2}),/sign-in was refused/);
 assert.deepEqual((await db.query('SELECT id,password_hash FROM accounts WHERE id=ANY($1::text[]) ORDER BY id',[[f.owner.accountId,reader.id]])).rows,before);
 await db.query("UPDATE accounts SET plan='free',email_verified_at=now(),last_workspace_id=$2 WHERE id=$1",[reader.id,ctx.workspaceId]);
 const normal=await fixtures.create(db,ctx.workspaceId,{...options,users:2});assert.equal(new Set(normal.members.map(m=>m.accountId)).size,2);assert.equal(normal.cookies.length,2);
 t.after(()=>normal.close());
 for(const cookie of normal.cookies){const page=await fetch(base+'/inventory',{headers:{cookie},redirect:'manual'});assert.equal(page.status,200);assert.match(await page.text(),/Synthetic ERP release normal login/);}
 await normal.close();await normal.close();
 assert.deepEqual((await db.query('SELECT id,password_hash FROM accounts WHERE id=ANY($1::text[]) ORDER BY id',[[f.owner.accountId,reader.id]])).rows,before);
 for(const cookie of normal.cookies){const page=await fetch(base+'/inventory',{headers:{cookie},redirect:'manual'});await page.arrayBuffer();assert.equal(page.status,302);}
 await db.query("INSERT INTO platform_account_access(account_id,disabled_at,revision,reason,changed_by) VALUES($1,now(),1,'Isolated disabled fixture',$1)",[f.owner.accountId]);
 await assert.rejects(fixtures.create(db,ctx.workspaceId,options),/enabled and exclusive/);
 assert.deepEqual((await db.query('SELECT id,password_hash FROM accounts WHERE id=ANY($1::text[]) ORDER BY id',[[f.owner.accountId,reader.id]])).rows,before);
});
test('qualification refuses a synthetic member shared with another inventory before changing any password',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,fixtures=require('../../scripts/lib/staging-load-login');
 await db.query("UPDATE workspaces SET name='Synthetic ERP release shared-member test' WHERE id=$1",[ctx.workspaceId]);
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other inventory',email:crypto.randomUUID()+'@example.test',password:'Other-fixture-password!'});
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES('shared-owner',$1,$2,'Shared owner','accountant',now())",[other.workspaceId,f.owner.accountId]);
 const before=(await db.query('SELECT password_hash FROM accounts WHERE id=$1',[f.owner.accountId])).rows[0].password_hash;
 await assert.rejects(fixtures.create(db,ctx.workspaceId,{users:1}),/enabled and exclusive/);
 assert.equal((await db.query('SELECT password_hash FROM accounts WHERE id=$1',[f.owner.accountId])).rows[0].password_hash,before);
});
