'use strict';
const {ValidationError}=require('../domain/errors'),policy=require('../commercial/agent-plan');
const tasks=new Map([[127,'import.supplier_catalog'],[130,'import.variants']]);
async function check(db,ctx,plan,job=plan.transformations.agentJob){
  if(job===undefined)return;
  if(!tasks.has(job))throw new ValidationError('Review this import’s agent task before running it.');
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'draft');
  const stopped=await policy.stopped(db,ctx.workspaceId,account,tasks.get(job),false);
  if(stopped)throw new ValidationError(stopped);
  if(plan.transformations.dataset==='suppliers')throw new ValidationError('Choose a product catalogue for this task.');
  if(job===130&&!(plan.transformations.variantColumns?.length||require('./fields').VARIANT_FIELDS.some(field=>plan.fieldMappings[field]!==undefined)))
    throw new ValidationError('Map the actual size, color or other variant columns before preparing variants.');
  const stock=await db.query(`SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status IN ('VALID','NEEDS_REVIEW') AND quantity>0 LIMIT 1`,[ctx.workspaceId,plan.id]);
  if(stock.rowCount)throw new ValidationError('This task creates product and price records. Review physical stock through the stock import workflow.');
}
async function queue(db,ctx,id,expectedHash,job){
  return db.transaction(async client=>{
    const row=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!row||row.integrity_hash!==expectedHash||row.status!=='READY')throw new ValidationError('The catalogue preview changed. Review it again.');
    const imports=require('./postgres-service'),scoped={query:(...a)=>client.query(...a),transaction:fn=>fn(client)};
    const plan=await imports.get(scoped,ctx.workspaceId,id);
    if(plan.transformations.agentJob!==undefined&&plan.transformations.agentJob!==job)throw new ValidationError('Continue the approved agent task for this file.');
    await check(client,ctx,plan,job);
    await client.query("UPDATE import_plans SET transformations=(transformations::jsonb||jsonb_build_object('agentJob',$3::int))::text WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,job]);
    return imports.approveAndQueue(scoped,ctx,id,expectedHash);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
const specs=[...tasks].map(([job,name])=>({name,
  description:job===127?'Prepare a supplier catalogue preview as product and purchase-cost records. Queue its approved rows for verified import.':
    'Build product variants from mapped size, color or other spreadsheet columns. Queue the reviewed catalogue preview for verified import.',
  record:'import_plan',fields:['recordReference'],permission:require('../actions/permissions').OPERATE,capability:'imports.spreadsheet',
  build:async(db,ctx,row)=>{
    const plan=await require('./postgres-service').get(db,ctx.workspaceId,row.id);
    await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'draft');
    if(plan.status!=='READY')throw new ValidationError('Choose a current catalogue preview.');
    return {payload:{recordId:plan.id,integrityHash:plan.integrityHash},summary:'Review and queue '+plan.recordsValid+' catalogue rows from '+plan.sourceName+'. Follow the import progress for the verified product result.'};
  },execute:(db,ctx,p)=>queue({query:(...a)=>db.query(...a),transaction:fn=>fn(db)},ctx,p.recordId,p.integrityHash,job),
  verify:async(db,ctx,result,p)=>Boolean(result.job?.id&&(await db.query(`SELECT 1 FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND id=$2 AND kind='import.execute-approved' AND payload->>'planId'=$3`,[ctx.workspaceId,result.job.id,p.recordId])).rowCount)
}));
module.exports={check,specs};
