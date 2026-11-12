'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-quality-fixture');
const pass={revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0','1']};
test('a pre-upgrade receipt writer cannot bypass an enabled QC rule; transaction stock, money and receipt all roll back',async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});const po=await f.order();
 const before=(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const apply=quality.applyReceipt;quality.applyReceipt=async()=>({held:[],suggested:[],notHeld:[]});try{await assert.rejects(f.receive(po),/Quality inspection hold required/);}finally{quality.applyReceipt=apply;}
 assert.equal(await f.balance(),8);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before);
 assert.equal((await db.query('SELECT count(*)::int n FROM purchase_order_receipts WHERE purchase_order_id=$1',[po.purchaseOrderId])).rows[0].n,0);
 const r=await f.receive(po);assert.equal(r.qualityHoldIds.length,1);
});
test('simultaneous holds and releases preserve exact availability and repeat receipt cannot release twice',async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const first=await f.order(),second=await f.order();const receipts=await Promise.all([f.receive(first),f.receive(second)]),ids=receipts.map(r=>r.qualityHoldIds[0]);assert.equal(await f.balance(),28);assert.equal((await f.available()).available,8);
 await Promise.all(ids.map(id=>quality.inspect(db,ctx,id,pass)));assert.equal((await f.available()).available,28);
 assert.equal((await db.query('SELECT sum(quality_held)::text n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0.000000');
 await Promise.all([quality.inspect(db,ctx,ids[0],pass),quality.inspect(db,ctx,ids[0],pass)]);assert.equal((await f.hold(ids[0])).revision,2);assert.equal(await f.balance(),28);
});
test('current plan, job mode, shadow and rule allowance fence release by rule; the inspecting person still releases',async t=>{
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await quality.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 const ids=[];for(let i=0;i<4;i++)ids.push((await f.receive(await f.order(2))).qualityHoldIds[0]);
 const check=async(id,pattern)=>{const r=await quality.inspect(db,ctx,id,pass);assert.deepEqual([r.released,r.byRule],[true,false]);assert.match(r.reason,pattern);assert.equal((await f.hold(id)).released_by,ctx.actorId);};
 await f.subscribe('growth');await check(ids[0],/person who inspected/);
 await f.subscribe('pro');await require('../../src/autopilot/job-modes').save(db,ctx,51,{mode:'watch',revision:0});await check(ids[1],/Watch/);
 await require('../../src/autopilot/job-modes').save(db,ctx,51,{mode:'routine',revision:1});await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await check(ids[2],/14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by) SELECT $1,'sales_order.repeat','quality-quota-'||n,'Preserved routine','USD',100,$2 FROM generate_series(1,500)n`,[ctx.workspaceId,ctx.actorId]);
 await check(ids[3],/500 active rules/);
 await assert.rejects(quality.hold(db,{workspaceId:'foreign-inventory',actorId:ctx.actorId},ids[0]),/not in this inventory/);
 const next=(await f.receive(await f.order(2),{qcConfirmed:'yes'})).qualityHoldIds[0];
 await db.query("UPDATE users SET role='accountant',permissions=NULL WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(quality.inspect(db,ctx,next,pass),/receive|inspect|permission|access/i);assert.equal((await f.available()).available,16);assert.equal((await f.hold(next)).status,'HELD');
});
test('actual account deletion removes held goods and QC rules in FK order and preserves another business',async t=>{
 const previous=process.env.STOCKCHIEF_RUNTIME_ENV;process.env.STOCKCHIEF_RUNTIME_ENV='staging';t.after(()=>{if(previous===undefined)delete process.env.STOCKCHIEF_RUNTIME_ENV;else process.env.STOCKCHIEF_RUNTIME_ENV=previous;});
 const f=await fixture(t),{db,ctx,quality}=f,p=await quality.save(db,ctx,f.scope);await f.receive(await f.order(),{qcConfirmed:'yes'});
 const password='Admin!'+randomUUID(),admin=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'QC removal administrator',businessName:'Preserved QC inventory',email:randomUUID()+'@example.test',password});await db.query("INSERT INTO developer_account_administrators(account_id,granted_by) VALUES($1,'isolated QC cleanup test')",[admin.accountId]);
 const removal=require('../../src/domain/postgres-developer-accounts'),review=await removal.review(db,admin.accountId,f.email);assert.equal(review.canDelete,true,review.blockers.join('; '));const queued=await removal.queue(db,admin.accountId,{email:f.email,confirmEmail:f.email,confirmed:'yes',password,reviewHash:review.reviewHash});assert.equal((await removal.execute(db,queued.requestId)).signInAccountRemoved,true);
 for(const table of ['agent_quality_policies','agent_quality_holds'])assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.'+table+' WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int n FROM accounts WHERE id=$1',[admin.accountId])).rows[0].n,1);
});
