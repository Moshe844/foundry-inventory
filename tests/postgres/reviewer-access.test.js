'use strict';
process.env.NODE_ENV='test';
process.env.SESSION_SECRET='isolated-review-access-fixture-session-secret';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const express=require('express'),session=require('express-session'),request=require('supertest');
const auth=require('../../src/domain/postgres-auth-service'),access=require('../../src/domain/postgres-reviewer-access');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
test('private review access requires a password, isolated synthetic inventory and live expiring grant',{timeout:240000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster();
  const db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:5});
  t.after(async()=>{await db.close();await cluster.stop();});
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const password='ReviewFixture!'+randomUUID();
  const operator=await auth.createBusiness(db,{name:'Operator',businessName:'Private customer inventory',email:randomUUID()+'@example.test',password});
  await db.query("INSERT INTO platform_console_operators(account_id,role,granted_by) VALUES($1,'OWNER','ISOLATED_TEST')",[operator.accountId]);
  const mfaSecret='JBSWY3DPEHPK3PXP';
  await db.query('INSERT INTO platform_console_mfa(account_id,sealed_secret,last_counter) VALUES($1,$2,0)',
    [operator.accountId,require('../../src/connections/credentials').encrypt(mfaSecret)]);
  const email=randomUUID()+'@example.test';
  const target=await auth.createPendingAccount(db,{name:'External reviewer',businessName:'Review setup',email,password,planId:'starter'});
  await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[target.id]);
  const grant=async id=>db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source,trial_ends_at)
    VALUES($1,$2,'starter',(SELECT id FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),
      'TRIALING','CUSTOM','ADMIN',now()+interval '30 days')`,[randomUUID(),id]);
  await grant(target.id);
  const input={email,reason:'Google Workspace OAuth verification',confirmed:'yes'};
  const issued=await access.issue(db,operator.accountId,input);
  const workspace=(await db.query('SELECT * FROM workspaces WHERE id=$1',[issued.workspaceId])).rows[0];
  assert.equal(workspace.data_mode,'synthetic');assert.equal(workspace.owner_account_id,target.id);
  assert.equal(workspace.name,'Google Workspace Review');
  assert.equal((await db.query('SELECT count(*)::int n FROM users WHERE account_id=$1',[target.id])).rows[0].n,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1',[workspace.id])).rows[0].n,0);
  assert.equal((await auth.getAccount(db,target.id)).plan,'paid','ordinary first-inventory setup finishes without a paid checkout');
  assert.equal((await db.query('SELECT stripe_subscription_id FROM account_subscriptions WHERE account_id=$1',[target.id])).rows[0].stripe_subscription_id,null);
  await access.verify(db,issued.token,target.id);
  await assert.rejects(access.verify(db,issued.token,operator.accountId));
  await assert.rejects(access.issue(db,operator.accountId,{...input,email:operator.email}));

  const app=express();app.set('view engine','ejs');app.set('views',require('path').resolve(__dirname,'../../src/web/views'));
  app.use(express.urlencoded({extended:false}));
  app.use(session({secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false}));
  app.use((req,res,next)=>{res.locals.appName='StockChief';res.locals.origin='https://app.example.test';res.locals.assetVersion='test';next();});
  const common=require('../../src/web/middleware');app.use(common.flash);app.use(common.csrf);
  app.use(require('../../src/web/postgres-auth-middleware').loadUser(db));
  app.use(require('../../src/web/mfa-middleware')(db));
  app.use(require('../../src/web/routes/postgres-mfa').createRouter(db));
  app.use(require('../../src/web/routes/postgres-auth').createPostgresAuthRouter(db,{signInCode:true}));
  app.get('/whoami',common.requireAuth,(req,res)=>res.json({accountId:req.account.id,workspaceId:req.ctx.workspaceId}));
  app.use((error,req,res,next)=>{void next;res.status(error.status||500).json({error:error.message});});
  const normal=request.agent(app),loginPage=await normal.get('/login').expect(200);
  await normal.post('/login').type('form').send({_csrf:csrf(loginPage.text),email,password}).expect(303).expect('location','/login/code');
  const codes=Number((await db.query('SELECT count(*) n FROM sign_in_codes WHERE account_id=$1',[target.id])).rows[0].n);
  assert.equal(codes,1,'ordinary password sign-in still requires its emailed code');
  const reviewer=request.agent(app),reviewPage=await reviewer.get('/reviewer-login').expect(200);
  assert.equal(reviewPage.headers['referrer-policy'],'no-referrer');assert.equal(reviewPage.headers['cache-control'],'private, no-store');
  assert.match(reviewPage.text,/reviewer-login\.js/);
  assert.match(reviewPage.text,/<meta name="referrer" content="no-referrer">/,'private page protects referrers even when an edge proxy replaces its HTTP header');
  await reviewer.post('/reviewer-login').type('form').send({_csrf:csrf(reviewPage.text),email,password:'WrongFixturePassword!',reviewToken:issued.token}).expect(401);
  const retryPage=await reviewer.get('/reviewer-login');
  await reviewer.post('/reviewer-login').type('form').send({_csrf:csrf(retryPage.text),email,password,reviewToken:issued.token}).expect(302).expect('location','/');
  assert.deepEqual((await reviewer.get('/whoami').expect(200)).body,{accountId:target.id,workspaceId:workspace.id});
  assert.equal(Number((await db.query('SELECT count(*) n FROM sign_in_codes WHERE account_id=$1',[target.id])).rows[0].n),codes,'private link plus password needs no owner-inbox code');
  assert.equal((await db.query('SELECT count(*)::int n FROM trusted_sign_in_devices WHERE account_id=$1',[target.id])).rows[0].n,0,'review sign-in never creates an unscoped remembered device');

  const ownerStore=new session.MemoryStore();
  const ownerApp=require('../../src/platform-owner/app').createOwnerConsole({database:db,store:ownerStore,
    sessionSecret:process.env.SESSION_SECRET,env:'test',customerOrigin:'https://app.example.test'});
  const ownerBrowser=request.agent(ownerApp);
  await ownerBrowser.get('/reviewer-access').expect(303).expect('location','/login');
  const ownerLogin=await ownerBrowser.get('/login').expect(200);
  await ownerBrowser.post('/login').type('form').send({_csrf:csrf(ownerLogin.text),email:operator.email,password}).expect(303).expect('location','/verify');
  const ownerVerify=await ownerBrowser.get('/verify').expect(200);
  await ownerBrowser.post('/verify').type('form').send({_csrf:csrf(ownerVerify.text),
    code:require('../../src/platform-owner/auth').codeAt(mfaSecret,Math.floor(Date.now()/30000))}).expect(303);
  const ownerReview=await ownerBrowser.get('/reviewer-access').expect(200);
  await ownerBrowser.post('/reviewer-access').type('form').send({...input}).expect(403);
  const created=await ownerBrowser.post('/reviewer-access').type('form').send({...input,_csrf:csrf(ownerReview.text)}).expect(200);
  assert.match(created.text,/https:\/\/app\.example\.test\/reviewer-login#access=sr1\./);
  assert.equal(created.headers['referrer-policy'],'no-referrer');assert.equal(created.headers['cache-control'],'private, no-store');
  const sessions=await new Promise((resolve,reject)=>ownerStore.all((error,values)=>error?reject(error):resolve(values)));
  for(const [id,value]of Object.entries(sessions))if(value.owner){value.owner.authenticatedAt=Date.now()-16*60000;
    await new Promise((resolve,reject)=>ownerStore.set(id,value,error=>error?reject(error):resolve()));}
  const stale=await ownerBrowser.get('/reviewer-access').expect(200);
  assert.match(stale.text,/Verify owner sign-in/);
  await ownerBrowser.post('/reviewer-access').type('form').send({...input,_csrf:csrf(stale.text)}).expect(403);

  const member=(await db.query('SELECT id FROM users WHERE account_id=$1 AND workspace_id=$2',[target.id,workspace.id])).rows[0];
  const mfa=require('../../src/domain/postgres-mfa'),reviewScope={accountId:target.id,workspaceId:workspace.id,actorId:member.id};
  const setup=await mfa.begin(db,reviewScope);
  const totp=require('../../src/domain/totp');
  const enrolled=await mfa.check(db,reviewScope,totp.code(setup.secret,Math.floor(Date.now()/30000)),{enroll:true});
  await reviewer.get('/whoami').expect(303).expect('location','/auth/mfa');
  const beforeMfa=await reviewer.get('/auth/mfa').expect(200);
  await reviewer.post('/auth/mfa').type('form').send({_csrf:csrf(beforeMfa.text),code:enrolled.recoveryCodes[0]}).expect(303);
  await reviewer.get('/whoami').expect(200);
  await db.query("UPDATE account_subscriptions SET status='CANCELLED' WHERE account_id=$1",[target.id]);
  assert.equal(await access.validateSession(db,issued.claims,target.id,workspace.id),false);
  await reviewer.get('/whoami').set('Accept','application/json').expect(401);
  await db.query("UPDATE account_subscriptions SET status='TRIALING' WHERE account_id=$1",[target.id]);
  await db.query('UPDATE accounts SET password_hash=$2 WHERE id=$1',[target.id,require('../../src/domain/auth-service').hashPassword('ReplacementFixture!'+randomUUID())]);
  await assert.rejects(access.verify(db,issued.token,target.id));
  await db.query('UPDATE accounts SET password_hash=$2 WHERE id=$1',[target.id,require('../../src/domain/auth-service').hashPassword(password)]);
  const fresh=await access.issue(db,operator.accountId,input);
  await require('../../src/domain/postgres-account-access').change(db,operator.accountId,target.id,
    {action:'sign_out',reason:'Revoke external review credentials',requestKey:randomUUID(),confirmed:'yes',confirmEmail:email,revision:0});
  await assert.rejects(access.verify(db,fresh.token,target.id));
  const current=await access.issue(db,operator.accountId,input);
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Other membership','staff',$4)",
    [randomUUID(),operator.workspaceId,target.id,new Date().toISOString()]);
  assert.equal(await access.validateSession(db,current.claims,target.id,workspace.id),false,'joining another inventory closes the review session');
  await db.query('DELETE FROM users WHERE account_id=$1 AND workspace_id=$2',[target.id,operator.workspaceId]);
  await db.query("UPDATE workspaces SET data_mode='production' WHERE id=$1",[workspace.id]);
  assert.equal(await access.validateSession(db,current.claims,target.id,workspace.id),false);
  await assert.rejects(access.issue(db,operator.accountId,input),/synthetic inventory/);
  await db.query("UPDATE workspaces SET data_mode='synthetic' WHERE id=$1",[workspace.id]);
  await db.query("INSERT INTO platform_console_operators(account_id,role,granted_by) VALUES($1,'SUPPORT','ISOLATED_TEST')",[target.id]);
  assert.equal(await access.validateSession(db,current.claims,target.id,workspace.id),false,'review access cannot become platform access');
  await assert.rejects(access.issue(db,operator.accountId,input));
  const audits=(await db.query("SELECT after_state FROM commercial_change_audit WHERE subject_type='private_review_access'")).rows;
  assert(audits.length>=3);assert(!JSON.stringify(audits).includes(issued.token));
});
