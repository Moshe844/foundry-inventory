'use strict';

async function read(database,workspaceId){
  const rows=(await database.query(`SELECT id,kind,status,payload,result,updated_at FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND kind IN ('autopilot.evaluate','system.reconcile-business')
    AND status IN ('PENDING','RETRY','RUNNING') ORDER BY priority,created_at,id LIMIT 4`,[workspaceId])).rows;
  const checks=[];
  for(const kind of ['autopilot.evaluate','system.reconcile-business']){
    const row=rows.find(r=>r.kind===kind);if(!row)continue;
    let checked=Number(row.payload?.processedSkus||0);
    if(kind==='system.reconcile-business'&&row.payload?.runId){const run=(await database.query(`SELECT summary
      FROM stockchief_runtime.business_reconciliation_runs WHERE workspace_id=$1 AND id=$2`,
      [workspaceId,row.payload.runId])).rows[0];checked=Number(run?.summary.checkedRecords||0);}
    checks.push({kind,status:row.status,checked,updatedAt:row.updated_at,
      text:(kind==='autopilot.evaluate'?'Business review':'Stock and accounting check')+
        (row.status==='RUNNING'?' is running':' is waiting for its next batch')+
        (checked?' · '+checked.toLocaleString('en-US')+(kind==='autopilot.evaluate'?' products reviewed.':' records checked.')+'.':'.')});
  }
  const latest=(await database.query(`SELECT DISTINCT ON(kind) kind,status,result FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND kind IN ('autopilot.evaluate','system.reconcile-business')
    ORDER BY kind,updated_at DESC,id DESC`,[workspaceId])).rows;
  const stopped=latest.some(r=>r.status==='DEAD'),differences=latest.some(r=>r.result?.status==='FAILED');
  return {active:checks.length>0,checks,message:stopped?
    'A background check stopped before completion. Review Needs you for the saved error.':differences?
    'A background check found differences. Review Needs you before automatic work continues.':
    'Queued reviews have finished. Review the latest decisions in Needs you.',attention:stopped||differences};
}

async function request(database,ctx){
  return database.transaction(async client=>{
    const actor=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,ctx.actorId])).rows[0];
    require('../actions/permissions').assertCan(actor,require('../actions/permissions').OPERATE,'request a business review');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['maintenance-request:'+ctx.workspaceId]);
    const current=(await client.query(`SELECT id FROM stockchief_runtime.jobs WHERE workspace_id=$1
      AND kind='autopilot.evaluate' AND status IN ('PENDING','RETRY','RUNNING') ORDER BY created_at LIMIT 1`,[ctx.workspaceId])).rows[0];
    if(current)return {id:current.id,created:false};
    const scoped={query:client.query,transaction:operation=>operation(client)};
    const queued=await require('./postgres-job-queue').enqueue(scoped,{workspaceId:ctx.workspaceId,kind:'autopilot.evaluate',
      idempotencyKey:'requested:'+require('../lib/util').newId('check'),payload:{actorId:ctx.actorId},priority:40,maxAttempts:3});
    return {id:queued.job.id,created:queued.created};
  });
}
module.exports={read,request};
