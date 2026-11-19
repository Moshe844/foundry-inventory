'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const policy=require('../../src/commercial/agent-plan'),assistant=require('../../src/assistant/postgres-service');
const access=require('../../src/commercial/agent-proposal-access');

test('all paid plans allow day-one individual approval without changing billing, connections or automatic authority',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch(),base='http://127.0.0.1:'+server.address().port;
 f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
 const view=await chrome.newPage({viewport:{width:1440,height:1000}}),browserErrors=[];
 view.on('pageerror',error=>browserErrors.push(error.message));view.setDefaultTimeout(20000);
 await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
 await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
 const folder=require('node:path').join(process.cwd(),'output','customer-navigation-ci','day-one-approvals');require('node:fs').mkdirSync(folder,{recursive:true});
 const mailboxId='reviewed-mailbox-'+randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'Reviewed Microsoft mailbox','microsoft365','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'reviewed-microsoft-account',now(),now())`,[mailboxId,ctx.workspaceId,'connection_credentials:'+mailboxId,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,mailboxId,'provider',{accessToken:'reviewed-mail-fixture'}));
 const delivered=[],mailProvider={send:async({credentials,message})=>{
  assert.equal(credentials.accessToken,'reviewed-mail-fixture');
  assert(require('../../src/commercial/individual-approval').active(ctx.workspaceId),'a worker restores only the saved individual approval');
  const account=await policy.accountState(db,ctx.workspaceId);
  assert.equal(await policy.stopped(db,ctx.workspaceId,account,'communication.send_email',false),null);
  assert.equal(await policy.stopped(db,ctx.workspaceId,account,'communication.send_email',true),policy.SHADOW_REASON);
  delivered.push(message.id);return {externalMessageId:'reviewed-provider-'+message.id};
 }};
 const snapshots=async()=>({
  subscriptions:(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,
  connections:(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 ORDER BY id',[ctx.workspaceId])).rows,
  credentials:(await db.query('SELECT id,ciphertext,iv,auth_tag FROM connection_credentials WHERE workspace_id=$1 ORDER BY id',[ctx.workspaceId])).rows,
 });
 const prepare=async(plan,suffix)=>{
  const prepared=await assistant.prepareAction(db,ctx,'Add this exact reviewed supplier',{
   action:'create_contact',recipientKind:'supplier',recipient:'Reviewed '+plan+' '+suffix,recipientEmail:plan+'-'+suffix+'@example.test'});
  assert.equal(prepared.status,'PREPARED',JSON.stringify(prepared));return assistant.getProposal(db,ctx.workspaceId,prepared.proposal.id);
 };
 for(const plan of ['starter','growth','pro'])await t.test(plan,async()=>{
  await f.subscribe(plan);await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  await db.query("UPDATE workspace_autopilot SET mode='OBSERVE' WHERE workspace_id=$1",[ctx.workspaceId]);
  const before=await snapshots(),state=await policy.accountState(db,ctx.workspaceId);
  assert(state.shadow);const proposal=await prepare(plan,'day-one');
  const review=await access.review(db,ctx,proposal,{mission:true});
  assert.equal(review.individual.blocked,false);assert.equal(review.mission.blocked,true);assert(review.watchPeriod.endsAt);
  await assert.rejects(assistant.executeMission(db,ctx,proposal.id),/not part of a multi-step mission/,'an individual proposal cannot be treated as an approved whole request');
  const page=await browser.get('/actions/'+proposal.id).expect(200);
  assert.match(page.text,/data-individual-watch-approval/);
  const button=page.text.match(/<button[^>]*>Approve only this change<\/button>/);
  assert(button,'individual review button is present');assert.doesNotMatch(button[0],/disabled/);
  await view.goto(base+'/actions/'+proposal.id);
  assert(await view.getByRole('button',{name:'Approve only this change',exact:true}).isEnabled());
  for(const width of [1440,390]){
   await view.setViewportSize({width,height:1000});assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await view.screenshot({path:require('node:path').join(folder,plan+'-'+width+'.png'),fullPage:true});
  }
  await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Approve only this change',exact:true}).click()]);
  assert.equal((await db.query("SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=$2",[ctx.workspaceId,'Reviewed '+plan+' day-one'])).rows[0].n,1);
  await assistant.executeProposal(db,ctx,proposal.id);
  assert.equal((await db.query("SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=$2",[ctx.workspaceId,'Reviewed '+plan+' day-one'])).rows[0].n,1,'replay cannot create a second supplier');
  const mail=require('../../src/connections/postgres-outbound-mail'),approval=require('../../src/commercial/individual-approval');
  const queued=await approval.run(ctx,()=>db.transaction(c=>mail.queueInTransaction(c,ctx,{recipientKind:'customer',recipientId:'fixture-customer',recipientEmail:'receiver@example.test',connectorId:mailboxId,subject:'Reviewed '+plan+' test',body:'One individually approved test message.'},'reviewed-day-one-'+plan)));
  const effect=await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,queued.effectId);
  assert.equal(effect.payload.individualApprovalActorId,ctx.actorId);
  const providers={get:()=>mailProvider},handlers=require('../../src/operations/postgres-runtime-handlers').create(providers);
  const sent=await require('../../src/operations/postgres-job-queue').processOne(db,handlers,{owner:'reviewed-test-worker',kinds:['provider.effect']});
  assert.equal(sent.status,'COMPLETED',JSON.stringify(sent.lastError));
  assert.equal((await mail.get(db,ctx.workspaceId,'customer',queued.communicationId)).status,'SENT');
  const count=delivered.length;await mail.executeSendEffect(db,ctx.workspaceId,queued.effectId,{provider:mailProvider});assert.equal(delivered.length,count,'delivery replay sends no second email');
  assert.equal(approval.active(ctx.workspaceId),false,'worker approval authority does not leak into the next operation');
  assert.equal(await policy.stopped(db,ctx.workspaceId,state,'contact.create',true),policy.SHADOW_REASON);
  await assert.rejects(require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED'),/14 days|shadow/);
  const settings=await browser.get('/autopilot').expect(200);assert.match(settings.text,/Automatic actions are blocked until/);assert.match(settings.text,/Nothing switches on just because the period ends/);
  const report=await browser.get('/autopilot/shadow').expect(200);assert.match(report.text,/Individual approvals are available from day one/);assert.match(report.text,/separate from your refund guarantee/);
  const bill=await browser.get('/billing').redirects(2).expect(200);assert.match(bill.text,/data-plan-watch-period/);
  // The period uses account age and keeps the complete 336-hour boundary.
  await db.query("UPDATE accounts SET created_at=(now()-interval '335 hours 59 minutes')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal((await policy.accountState(db,ctx.workspaceId)).shadow,true);
  await db.query("UPDATE accounts SET created_at=(now()-interval '336 hours 1 minute')::text WHERE id=$1",[f.owner.accountId]);
  const after=await policy.accountState(db,ctx.workspaceId);assert.equal(after.shadow,false);
  assert.match(await policy.stopped(db,ctx.workspaceId,after,'contact.create',true),/watch-only/,'expiration cannot enable automation by itself');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'SUPERVISED');
  const postWatch=await prepare(plan,'after-watch');assert.equal((await access.review(db,ctx,postWatch,{mission:true})).individual.blocked,false);
  await assistant.executeProposal(db,ctx,postWatch.id);
  // Existing job ceilings remain effective: Growth automatic transfers still require Pro,
  // and Starter cannot acquire automatic purchasing by waiting out the watch period.
  if(plan!=='pro')assert.throws(()=>policy.requireJob(plan,119,'automatic'),e=>e.code==='entitlement_required');
  if(plan==='starter')assert.throws(()=>policy.requireJob(plan,20,'automatic'),e=>e.code==='entitlement_required');
  else await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  assert.deepEqual(await snapshots(),before,'approval and watch-period expiry leave subscription billing and existing connection credentials unchanged');
  const restricted=await prepare(plan,'permission');
  if(plan==='starter')assert.equal((await access.review(db,ctx,{...restricted,action_type:'sales_quote.create',payload:{}})).individual.blocked,true,'a reviewed action does not unlock a higher-plan duty');
  const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  await db.query("UPDATE users SET role='staff',permissions='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
  try{await assert.rejects(assistant.executeProposal(db,ctx,restricted.id),/permission|owner|allowed|access/i);}
  finally{await db.query('UPDATE users SET role=$3,permissions=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,actor.role,actor.permissions]);}
  const foreign={...ctx,workspaceId:'different-inventory-'+randomUUID()};
  await assert.rejects(assistant.executeProposal(db,foreign,restricted.id));
 });
 assert.deepEqual(browserErrors,[]);
 assert.equal(delivered.length,3,'all three paid plans delivered one individually approved message through the worker');
});
