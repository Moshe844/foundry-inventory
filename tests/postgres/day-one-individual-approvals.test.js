'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const policy=require('../../src/commercial/agent-plan'),assistant=require('../../src/assistant/postgres-service');
const access=require('../../src/commercial/agent-proposal-access');

test('all paid plans allow day-one individual approval without changing billing, connections or automatic authority',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser}=f;
 const snapshots=async()=>({
  subscriptions:(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,
  connections:(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 ORDER BY id',[ctx.workspaceId])).rows,
  credentials:(await db.query('SELECT id,ciphertext,iv,auth_tag FROM connection_credentials WHERE workspace_id=$1 ORDER BY id',[ctx.workspaceId])).rows,
 });
 const prepare=async(plan,suffix)=>{
  const prepared=await assistant.prepareAction(db,ctx,'Add this exact reviewed supplier',{
   action:'create_contact',recipientKind:'supplier',recipient:'Reviewed '+plan+' '+suffix,recipientEmail:plan+'-'+suffix+'@example.test'});
  assert.equal(prepared.status,'PREPARED',JSON.stringify(prepared));return prepared.proposal;
 };
 for(const plan of ['starter','growth','pro'])await t.test(plan,async()=>{
  await f.subscribe(plan);await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  await db.query("UPDATE workspace_autopilot SET mode='OBSERVE' WHERE workspace_id=$1",[ctx.workspaceId]);
  const before=await snapshots(),state=await policy.accountState(db,ctx.workspaceId);
  assert(state.shadow);const proposal=await prepare(plan,'day-one');
  const review=await access.review(db,ctx,proposal,{mission:true});
  assert.equal(review.individual.blocked,false);assert.equal(review.mission.blocked,true);assert(review.watchPeriod.endsAt);
  const page=await browser.get('/actions/'+proposal.id).expect(200);
  assert.match(page.text,/data-individual-watch-approval/);
  const button=page.text.match(/<button[^>]*>Approve only this change<\/button>/);
  assert(button,'individual review button is present');assert.doesNotMatch(button[0],/disabled/);
  await browser.post('/actions/'+proposal.id+'/approve').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  assert.equal((await db.query("SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=$2",[ctx.workspaceId,'Reviewed '+plan+' day-one'])).rows[0].n,1);
  await assistant.executeProposal(db,ctx,proposal.id);
  assert.equal((await db.query("SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND name=$2",[ctx.workspaceId,'Reviewed '+plan+' day-one'])).rows[0].n,1,'replay cannot create a second supplier');
  assert.equal(await policy.stopped(db,ctx.workspaceId,state,'contact.create',true),policy.SHADOW_REASON);
  await assert.rejects(require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED'),/14 days|shadow/);
  const settings=await browser.get('/autopilot').expect(200);assert.match(settings.text,/Automatic actions are blocked until/);assert.match(settings.text,/Nothing switches on just because the period ends/);
  const report=await browser.get('/autopilot/shadow').expect(200);assert.match(report.text,/Individual approvals are available from day one/);assert.match(report.text,/separate from your refund guarantee/);
  const bill=await browser.get('/billing').expect(200);assert.match(bill.text,/data-plan-watch-period/);
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
  const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  await db.query("UPDATE users SET role='staff',permissions='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
  try{await assert.rejects(assistant.executeProposal(db,ctx,restricted.id),/permission|owner|allowed|access/i);}
  finally{await db.query('UPDATE users SET role=$3,permissions=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,actor.role,actor.permissions]);}
  const foreign={...ctx,workspaceId:'different-inventory-'+randomUUID()};
  await assert.rejects(assistant.executeProposal(db,foreign,restricted.id));
 });
});
