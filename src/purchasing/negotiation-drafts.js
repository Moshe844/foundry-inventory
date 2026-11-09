'use strict';
const policy=require('../commercial/agent-plan');
const {negotiation}=require('../autopilot/partner-habits');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

async function owner(c,ctx){
  if(!(await c.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)
    throw new AuthorizationError('The inventory owner must review the supplier negotiation.');
}
async function setting(c,workspaceId,supplier){
  return (await c.query('SELECT revision FROM stockchief_runtime.supplier_negotiation_rules WHERE workspace_id=$1 AND supplier_id=$2',[workspaceId,supplier])).rows[0];
}
async function configure(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    const prior=await setting(c,ctx.workspaceId,input.supplier);
    if((prior?.revision||'')!==input.revision)throw new ValidationError('The supplier rule changed. Open the current rule.');
    if(input.remove==='1'){
      await c.query('DELETE FROM stockchief_runtime.supplier_negotiation_rules WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,input.supplier]);
      return;
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,94,'automatic',{trained:true});
    const source=await negotiation(c,ctx,input.supplier);
    if(!source.evidence||source.evidence!==input.evidence)throw new ValidationError('Review the delivery evidence before training this rule.');
    if(!prior)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    await c.query(`INSERT INTO stockchief_runtime.supplier_negotiation_rules(workspace_id,supplier_id,owner_id,revision)
      VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET owner_id=$3,revision=$4`,[ctx.workspaceId,source.supplier.id,ctx.actorId,newId('rule')]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Authorized supplier negotiation drafts',reference:source.supplier.name});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function persist(c,ctx,source){
  const at=nowIso(),key='supplier-negotiation:'+source.supplier.id+':'+source.sourceKey;
  const result=await c.query(`INSERT INTO supplier_communications(id,workspace_id,supplier_id,recipient,subject,body,status,message_kind,idempotency_key,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'PREPARED','agent_negotiation',$7,$8,$8) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
    [newId('email'),ctx.workspaceId,source.supplier.id,source.supplier.email,source.subject,source.body,key,at]);
  if(result.rowCount){
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Prepared supplier negotiation draft',reference:source.supplier.name});
    return result.rows[0].id;
  }
  return (await c.query('SELECT id FROM supplier_communications WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,key])).rows[0].id;
}
async function prepare(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,94,'draft');
    const stopped=await policy.stopped(c,ctx.workspaceId,account,'supplier.negotiation_draft',false);
    if(stopped)throw new ValidationError(stopped);
    const source=await negotiation(c,ctx,input.supplier);
    if(!source.evidence||source.evidence!==input.evidence)throw new ValidationError('The supplier delivery evidence changed. Review the current draft.');
    return persist(c,ctx,source);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function queue(c,workspaceId,day){
  const rules=await c.query(`SELECT supplier_id,revision FROM stockchief_runtime.supplier_negotiation_rules r WHERE r.workspace_id=$1
    AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=$1 AND j.kind='agent.supplier-negotiation'
      AND j.idempotency_key='negotiation:'||r.revision||':'||$2) ORDER BY supplier_id LIMIT 100`,[workspaceId,day]);
  const db={query:c.query.bind(c),transaction:work=>work(c)};
  for(const r of rules.rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:'agent.supplier-negotiation',
    idempotencyKey:'negotiation:'+r.revision+':'+day,payload:{supplier:r.supplier_id,revision:r.revision},priority:65});
}
async function processJob(c,job){
  const state=await policy.accountState(c,job.workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,94,'automatic',{trained:true}))return {skipped:'Plan changed'};
  const active=(await c.query(`SELECT r.owner_id FROM stockchief_runtime.supplier_negotiation_rules r JOIN users u
    ON u.workspace_id=r.workspace_id AND u.id=r.owner_id AND u.role='owner' JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id AND s.status='active'
    JOIN workspace_autopilot a ON a.workspace_id=r.workspace_id AND a.mode='POLICY_AUTOMATED' AND a.paused=0 AND a.suspended=0
    WHERE r.workspace_id=$1 AND r.supplier_id=$2 AND r.revision=$3 FOR SHARE OF r,u,a`,[job.workspaceId,job.payload.supplier,job.payload.revision])).rows[0];
  const stopped=await policy.stopped(c,job.workspaceId,state,'supplier.negotiation_draft',true);
  if(!active||stopped)return {skipped:stopped||'Supplier rule or authority changed'};
  const ctx={workspaceId:job.workspaceId,actorId:active.owner_id},source=await negotiation(c,ctx,job.payload.supplier);
  return source.evidence?{draft:await persist(c,ctx,source)}:{skipped:source.summary};
}
module.exports={setting,configure,prepare,queue,processJob};
