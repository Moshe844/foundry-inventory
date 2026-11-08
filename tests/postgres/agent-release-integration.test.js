'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('the combined release preserves historical authority, gates new terms and measures tenant-scoped workflow data',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner}=f,agent=require('../../src/commercial/agent-plan'),autonomy=require('../../src/autopilot/postgres-service');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,'pro','approved-2026-11-02:pro','COMP')",[randomUUID(),owner.accountId]);
 const old=await agent.accountState(db,ctx.workspaceId);assert.equal(old.terms.offerId,'approved-2026-11-02');assert.equal(old.shadow,false);
 await autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');assert.equal((await autonomy.getState(db,ctx.workspaceId)).mode,'POLICY_AUTOMATED');
 await autonomy.configureRoutine(db,ctx,{role:'owner'},{purchaseEnabled:true,supplierIds:['fixture-supplier'],maximumValue:10000,weeklyValue:20000});
 await db.query("UPDATE account_subscriptions SET plan_version_id='agent-v3:pro' WHERE account_id=$1",[owner.accountId]);
 assert.equal((await agent.accountState(db,ctx.workspaceId)).shadow,true);assert.equal((await autonomy.getState(db,ctx.workspaceId)).mode,'OBSERVE');
 await assert.rejects(autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED'),/shadow/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '15 days')::text WHERE id=$1",[owner.accountId]);
 await assert.rejects(autonomy.configureRoutine(db,ctx,{role:'owner'},{purchaseEnabled:true,supplierIds:['fixture-supplier'],maximumValue:10000,weeklyValue:20000}),/1000 per order/);
 const expected=['agent_playbooks','agent_playbook_runs','agent_time_samples','purchase_requests','lot_recall_events','lot_certificate_requirements','lot_certificates','shipbob_sandbox_orders','shipbob_sandbox_stock','shipbob_sandbox_rules','orderful_orders','orderful_changes','orderful_outbound','orderful_rules','orderful_inbox'];
 for(const name of expected){const relation='stockchief_runtime.'+name;
  assert.equal((await db.query('SELECT count(*)::int n FROM commercial_storage_tables WHERE relation=$1::regclass',[relation])).rows[0].n,1,relation);
  assert.equal((await db.query('SELECT count(*)::int n FROM commercial_storage_usage WHERE workspace_id=$1 AND relation=$2::regclass',[ctx.workspaceId,relation])).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal AND tgname LIKE '%commercial%storage%'",[relation])).rows[0].n,0);
 }
 const book=randomUUID();await db.query("INSERT INTO stockchief_runtime.agent_playbooks(id,workspace_id,created_by,name,steps,cadence) VALUES($1,$2,$3,'Scoped storage','[]','manual')",[book,ctx.workspaceId,ctx.actorId]);
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other scope',email:randomUUID()+'@example.test',password:'Scope!'+randomUUID()});
 await assert.rejects(db.query("INSERT INTO stockchief_runtime.agent_playbook_runs(id,workspace_id,playbook_id,request_key,result) VALUES($1,$2,$3,'foreign','[]')",[randomUUID(),other.workspaceId,book]),e=>e.code==='23503');
 await db.query("INSERT INTO stockchief_runtime.agent_playbook_runs(id,workspace_id,playbook_id,request_key,result) VALUES($1,$2,$3,'owned',$4::jsonb)",[randomUUID(),ctx.workspaceId,book,JSON.stringify([{message:'Preserved result '+'.'.repeat(4096)}])]);
 await require('../../src/commercial/storage-capacity').baseline(db,ctx.workspaceId,'stockchief_runtime.agent_playbook_runs');
 const measured=(await db.query("SELECT u.baseline_bytes::text bytes,(SELECT sum(octet_length(convert_to(to_jsonb(t)::text,'UTF8')))::text FROM stockchief_runtime.agent_playbook_runs t WHERE workspace_id=$1) exact FROM commercial_storage_usage u WHERE u.workspace_id=$1 AND u.relation='stockchief_runtime.agent_playbook_runs'::regclass",[ctx.workspaceId])).rows[0];assert.equal(measured.bytes,measured.exact);assert(Number(measured.bytes)>4096);
});
