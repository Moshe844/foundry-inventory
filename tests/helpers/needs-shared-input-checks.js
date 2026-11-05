'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function check(t,{db,ctx}){
 const prefix='needs-'+randomUUID(),at=new Date().toISOString(),actors=Array.from({length:50},(_,n)=>prefix+'-user-'+n);
 await db.transaction(async c=>{
  await c.query("INSERT INTO accounts(id,email,name,password_hash,created_at) SELECT $1||'-account-'||n,$1||'-'||n||'@example.test','Concurrent reader','unused-fixture-hash',$2 FROM generate_series(0,49)n",[prefix,at]);
  await c.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) SELECT $1||'-user-'||n,$2,$1||'-account-'||n,'Concurrent reader','staff',CASE WHEN n%2=0 THEN '[\"VIEW\"]' ELSE '[]' END,$3 FROM generate_series(0,49)n",[prefix,ctx.workspaceId,at]);
  await c.query(`INSERT INTO attention_items(id,workspace_id,fingerprint,category,severity,priority_score,title,concise_summary,explanation,recommendation,affected_entity_type,confidence,status,detection_rule_version,first_detected_at,last_evaluated_at)
   VALUES($1,$2,$1,'shared-input-test','important',50,'Shared current stock finding','Review current stock','Fixture evidence','Review current stock','workspace','high','OPEN','concurrent-read-fixture',$3,$3)`,[prefix,ctx.workspaceId,at]);
 });
 const statements=[],reader={...db,query:(sql,values)=>{statements.push(sql);return db.query(sql,values);}},approvals=require('../../src/assistant/postgres-approval-projection'),privateActors=[];
 const privatePending=t.mock.method(approvals,'pending',async(database,workspaceId,actorId)=>{assert.equal(database,reader);assert.equal(workspaceId,ctx.workspaceId);privateActors.push(actorId);return [{kind:'approval',requiredPermissions:['VIEW'],priority:100,title:'Private approval '+actorId,sourceId:'private-'+actorId,href:'/private/'+actorId}];});
 const projection=require('../../src/projections/postgres-service'),expirySql=require('../../src/domain/postgres-batch-expiry').SUMMARY_SQL,started=performance.now();
 try{
  const lists=await Promise.all(actors.map(actorId=>projection.needs(reader,ctx.workspaceId,actorId))),elapsedMs=performance.now()-started;
  assert.equal(privateActors.length,50,'Each private approval read must use its own actor');assert.equal(new Set(privateActors).size,50);
  assert.equal(statements.filter(sql=>sql===expirySql).length,1,'Fifty people share one warehouse expiry read');
  assert.equal(statements.filter(sql=>sql.includes('FROM attention_items a')).length,2,'The shared finding population and its bounded individual values are each read once');
  assert.equal(statements.filter(sql=>sql.includes('FROM accounting_supplier_bills b')).length,1);
  assert.equal(statements.filter(sql=>sql.includes('FROM users WHERE')).length,50,'Membership is never shared between actors');
  for(let n=0;n<50;n++){
   if(n%2){assert.equal(lists[n].length,0,'A person with no permissions sees neither shared facts nor private approvals');continue;}
   assert(lists[n].some(r=>r.sourceId===prefix));assert(lists[n].some(r=>r.sourceId==='private-'+actors[n]));
   assert(!lists[n].some(r=>r.sourceId.startsWith('private-')&&r.sourceId!=='private-'+actors[n]),'Private approvals never cross people');
  }
  const beforeForeign=statements.length;assert.deepEqual(await projection.needs(reader,'wsp_foreignsharedinput',actors[0]),[]);assert.equal(statements.length,beforeForeign+1,'A foreign membership cannot load any shared source');
  await db.query("UPDATE attention_items SET status='RESOLVED' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,prefix]);
  assert(!(await projection.needs(reader,ctx.workspaceId,actors[0])).some(r=>r.sourceId===prefix),'A committed stock finding change invalidates shared input immediately');
  await db.query("UPDATE users SET permissions='[]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,actors[0]]);
  assert.deepEqual(await projection.needs(reader,ctx.workspaceId,actors[0]),[],'Revoked permission is checked on the next read');
  assert(elapsedMs<1500,`Fifty-person shared inbox read took ${elapsedMs}ms`);
  return {people:50,sharedExpiryQueries:1,privateApprovalReads:50,elapsedMs,permissionsIsolated:true,commitInvalidation:true,paidCalls:0};
 }finally{
  privatePending.mock.restore();await db.transaction(async c=>{await c.query('DELETE FROM attention_items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,prefix]);await c.query('DELETE FROM users WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,actors]);await c.query('DELETE FROM accounts WHERE id=ANY($1::text[])',[actors.map((_,n)=>prefix+'-account-'+n)]);});
 }
}
module.exports={check};
