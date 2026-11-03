'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),playwright=require('playwright');

test('an invitation opened where the owner is signed in sets a password, confirms it and signs the new person in',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);let app,server,browser;
 t.after(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(app)await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),lifecycle=require('../../src/domain/postgres-account-lifecycle');
 const ownerPassword='Owner-password!'+randomUUID().slice(0,6),owner=await auth.createBusiness(db,{name:'MOshe',businessName:'QA – Complex (variants, 3 locations, thresholds)',email:randomUUID()+'@example.test',password:ownerPassword});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 const base='http://127.0.0.1:'+server.address().port;browser=await playwright.chromium.launch();
 const errors=[],page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(owner.email);await page.locator('[name=password]').fill(ownerPassword);
 await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);

 // A new person, opened in the owner's browser.
 const staffEmail=randomUUID()+'@example.test',invited=await lifecycle.createInvitation(db,ctx,{name:'Hendel',email:staffEmail,role:'staff'},{origin:base,includeToken:true});
 await page.goto(base+'/invite?token='+encodeURIComponent(invited.token));
 const card=await page.locator('main').innerText();
 assert.match(card,/Join QA – Complex/);assert.match(card,new RegExp('signed in as '+owner.email.replace(/\./g,'\\.'),'i'));
 assert(await page.getByLabel('Create a password').isVisible());assert(await page.getByLabel('Confirm password').isVisible());
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.getByLabel('Create a password').fill('Teammate-pass-1!');await page.getByLabel('Confirm password').fill('Teammate-pass-2!');
 await page.locator('[name=confirmPassword]').evaluate(input=>input.setCustomValidity(''));
 await page.locator('form[action="/invite"]').evaluate(form=>form.noValidate=true);
 await Promise.all([page.waitForLoadState('load'),page.getByRole('button',{name:'Accept invitation'}).click()]);
 assert.match(await page.locator('main').innerText(),/The two passwords don’t match/);
 await page.getByLabel('Create a password').fill('Teammate-pass-1!');await page.getByLabel('Confirm password').fill('Teammate-pass-1!');
 await Promise.all([page.waitForURL(url=>!url.pathname.startsWith('/invite')),page.getByRole('button',{name:'Accept invitation'}).click()]);
 assert.match(await page.locator('body').innerText(),/Welcome to QA – Complex/);
 const staff=(await db.query('SELECT u.role,a.email FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND lower(a.email)=$2',[owner.workspaceId,staffEmail])).rows[0];
 assert.equal(staff.role,'staff');
 assert.equal((await page.request.get(base+'/settings/password')).url().includes('/login'),false,'the new person is signed in');

 // An email that already has an account signs in with its own password.
 const other=await auth.createBusiness(db,{name:'Existing',businessName:'Elsewhere',email:randomUUID()+'@example.test',password:'Existing-pass-1!'});
 const second=await lifecycle.createInvitation(db,ctx,{name:'Existing',email:other.email,role:'staff'},{origin:base,includeToken:true});
 const fresh=await browser.newPage();await fresh.goto(base+'/invite?token='+encodeURIComponent(second.token));
 assert.equal(await fresh.getByLabel('Confirm password').count(),0);
 await fresh.getByLabel('Password for '+other.email).fill('Wrong-password-1!');
 await Promise.all([fresh.waitForLoadState('load'),fresh.getByRole('button',{name:'Accept invitation'}).click()]);
 assert.match(await fresh.locator('main').innerText(),/doesn’t match the StockChief account/);
 await fresh.getByLabel('Password for '+other.email).fill('Existing-pass-1!');
 await Promise.all([fresh.waitForURL(url=>!url.pathname.startsWith('/invite')),fresh.getByRole('button',{name:'Accept invitation'}).click()]);
 assert.equal((await db.query('SELECT count(*)::int n FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND a.id=$2',[owner.workspaceId,other.accountId])).rows[0].n,1);

 // A link alone never opens an existing account.
 const third=await lifecycle.createInvitation(db,ctx,{name:'Existing',email:owner.email.replace('@','+x@'),role:'staff'},{origin:base,includeToken:true});
 await auth.createBusiness(db,{name:'X',businessName:'X',email:owner.email.replace('@','+x@'),password:'Existing-pass-2!'});
 await assert.rejects(lifecycle.acceptInvitation(db,third.token,{}),/already has a StockChief account/);
 assert.deepEqual(errors,[]);
});
