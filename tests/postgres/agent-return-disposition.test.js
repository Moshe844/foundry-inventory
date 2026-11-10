'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-return-disposition-fixture');
test('real physical return decision stays quarantined until separate human approval and teaches only matching Pro work',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,returnId=await f.received(),r=await f.newRule(),a=await f.observe(returnId);
 assert.equal((await s.onObservation(db,ctx.workspaceId,a.id,ctx.actorId)).held,true);
 assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,returnId)).status,'RECEIVED');
 const manual=await f.manual(a.id);await f.apply(a.id);assert.equal((await f.apply(a.id)).replayed,true);
 assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,returnId)).status,'COMPLETED');
 await s.configure(db,ctx,r.id,{revision:1,exampleId:manual.id,confirmed:'yes'});
 const next=await f.received(),b=await f.observe(next),jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
 assert.equal(await jobs.claim(db,{owner:'old-return-worker',kinds:['mail.customer-return.v1']}),null);
 for(let n=0;n<2;n++){const j=await jobs.processOne(db,{[s.kind]:handlers[s.kind]},{owner:'current-return-planner'});assert.equal(j.status,'COMPLETED',JSON.stringify(j.lastError));}
 const plan=await s.assessment(db,ctx,b.id);assert.equal(plan.status,'READY');assert.equal(plan.proposal.automatic,true);assert.equal(plan.proposal.lines[0].outcome,'RESTOCK');
 assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,next)).status,'RECEIVED');
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 await f.apply(b.id);assert.equal(await f.balance(),100);
});
test('Custom plans exact restock repair and scrap without training while actual write-offs always need human approval',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f;await f.subscribe('enterprise');
 for(const [code,outcome,destination]of [['GOOD','RESTOCK',f.location.id],['BROKEN','REPAIR',f.repair.id],['DESTROYED','SCRAP',null]]){
  const rule=await f.newRule(code,outcome,destination);await s.configure(db,ctx,rule.id,{revision:1,confirmed:'yes'});const id=await f.received(),a=await f.observe(id,code),before=await f.balance();
  assert.equal((await s.onObservation(db,ctx.workspaceId,a.id,ctx.actorId)).automatic,true);const p=await s.assessment(db,ctx,a.id);assert.equal(p.status,'READY');assert.equal(await f.balance(),before);
  if(outcome==='SCRAP'){assert.equal(p.proposal.lines[0].writeoffMinor,100);await assert.rejects(f.apply(a.id),/Separately approve/);}
  await f.apply(a.id,outcome==='SCRAP'?{writeoffConfirmed:'yes'}:{});const native=await f.returns.getCustomerReturn(db,ctx.workspaceId,id);
  assert.equal(Number(native.lines[0][{RESTOCK:'quantity_restocked',REPAIR:'quantity_repair',SCRAP:'quantity_scrapped'}[outcome]]),1);assert.equal(await f.balance(),before-(outcome==='SCRAP'?1:0));
 }
 assert.equal(Number((await db.query("SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::text n FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND a.system_key='INVENTORY_ADJUSTMENTS'",[ctx.workspaceId])).rows[0].n),100);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_sale_refunds WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});
