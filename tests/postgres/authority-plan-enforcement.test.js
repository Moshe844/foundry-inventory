'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('Starter Growth and Pro enforce native authority, transfer scope and unchanged subscription billing',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser}=f,autonomy=require('../../src/autopilot/postgres-service');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 for(const plan of ['starter','growth','pro'])await t.test(plan,async()=>{
   await f.subscribe(plan);const before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows;
   async function save(path,body){const page=await browser.get('/autopilot');assert.equal(page.status,200);return browser.post(path).type('form').send({_csrf:f.csrf(page.text),...body});}
   await save('/autopilot/mode',{mode:'SUPERVISED'});
   await save('/autopilot/mode',{mode:'POLICY_AUTOMATED'});
   assert.equal((await autonomy.getState(db,ctx.workspaceId)).mode,plan==='starter'?'SUPERVISED':'POLICY_AUTOMATED');
   const transferred=await save('/autopilot/capability',{capability:'inventory_transfers',granted:'1'});
   if(plan==='pro')assert.equal(transferred.status,303);else assert(transferred.status>=400||transferred.status===303,'A refusal may render an error or redirect back with the plan warning');
   assert.equal((await autonomy.capabilityMay(db,ctx.workspaceId,'inventory_transfers')).allowed,plan==='pro');
   assert.equal((await autonomy.listCapabilities(db,ctx.workspaceId)).find(row=>row.capability==='inventory_transfers').granted,plan==='pro','Rejected requests never save a hidden higher-plan grant');
   assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,before);
 });
});
