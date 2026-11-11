'use strict';

const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const auditedJobs=new Set([5,6,11,12,13,14,16,19,20,21,22,23,24,25,27,31,36,37,38,39,42,43,45,46,47,48,49,50,51,52,53,56,57,59,60,61,63,65,66,67,70,71,73,74,75,77,81,83,84,93,94,95,96,97,98,100,101,102,103,104,107,108,111,112,113,114,119,120,121,122,123,127,128,129,130,132,133,135,136,137,140,142,143,145,147,150,178,182,183,188,192]);
const definitions=require('../commercial/agent-plan-v3.json').filter(r=>auditedJobs.has(r.id));
const tiers=[['starter','Starter'],['growth','Growth'],['pro','Pro'],['enterprise','Custom']];
const modes={inherit:'Use inventory setting',watch:'Watch only',ask:'Ask me first',routine:'Handle routine work'};

function choices(plan,job){
  if(!policy.permits(plan,job,'suggest'))return [];
  const allowed=['inherit','watch'];
  if(policy.permits(plan,job,'draft'))allowed.push('ask');
  if(plan!=='starter'&&policy.permits(plan,job,'automatic',{trained:true})&&job!==77)allowed.push('routine');
  return allowed;
}

async function owner(db,ctx){
  const result=await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId]);
  if(!result.rowCount)throw new AuthorizationError('Only the business owner can change job authority.');
  const state=await policy.accountState(db,ctx.workspaceId);
  return policy.usesAgentTerms(state)?state.plan:null;
}

async function page(db,ctx){
  const plan=await owner(db,ctx);
  const {rows}=await db.query('SELECT job_id,mode,revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1',[ctx.workspaceId]);
  return definitions.map(d=>{
    const setting=rows.find(r=>Number(r.job_id)===d.id),allowed=choices(plan,d.id);
    return {id:d.id,label:d.job,allowed,mode:setting?.mode||'inherit',revision:setting?.revision||0,
      minimum:tiers.find(([k])=>policy.permits(k,d.id,'suggest'))?.[1],
      routineMinimum:d.id===77?null:tiers.find(([k])=>policy.permits(k,d.id,'automatic',{trained:true}))?.[1]};
  });
}

async function save(db,ctx,raw,input){
  const job=Number(raw),mode=input.mode,revision=Number(input.revision);
  if(!auditedJobs.has(job)||!Object.hasOwn(modes,mode)||input.revision==null||!Number.isSafeInteger(revision)||revision<0)
    throw new ValidationError('Review the current job settings before changing this mode.');
  return db.transaction(async c=>{
    const plan=await owner(c,ctx);
    policy.requireJob(plan,job,'suggest');
    if(!choices(plan,job).includes(mode))throw new ValidationError('This job cannot run at that level on your plan.');
    const prior=(await c.query('SELECT mode,revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE',[ctx.workspaceId,job])).rows[0];
    if((prior?.revision||0)!==revision)throw new ValidationError('This job setting has changed. Open its current settings.');
    if((prior?.mode||'inherit')===mode)return;
    await c.query(`INSERT INTO stockchief_runtime.agent_job_modes(workspace_id,job_id,mode,revision,updated_by) VALUES($1,$2,$3,1,$4)
      ON CONFLICT(workspace_id,job_id) DO UPDATE SET mode=EXCLUDED.mode,revision=stockchief_runtime.agent_job_modes.revision+1,updated_by=EXCLUDED.updated_by`,
      [ctx.workspaceId,job,mode,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Agent job mode changed',before:{job,mode:prior?.mode||'inherit'},after:{job,mode}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function restriction(db,workspaceId,job,automatic){
  if(!auditedJobs.has(job))return null;
  const {rows:[setting]}=await db.query('SELECT mode FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[workspaceId,job]);
  if(setting?.mode==='watch')return 'This job is set to Watch only. The owner can change its mode in StockChief AI.';
  if(setting?.mode==='ask'&&automatic)return 'This job is set to Ask me first. It needs individual approval.';
  return null;
}

module.exports={page,save,restriction,modes};
