'use strict';
const {ValidationError}=require('../domain/errors'),policy=require('../commercial/agent-plan');
const tasks=new Map([[5,'import.count_sheet'],[127,'import.supplier_catalog'],[130,'import.variants']]);
async function assertNotReceiving(db,ctx,plan,{reviewOnly=false}={}){
  if(plan.transformations.agentJob===43)throw new ValidationError('This delivery document is linked to a purchase receipt. Open the purchase order to review the recorded units.');
  if(!reviewOnly&&plan.transformations.handwriting?.purpose==='delivery')throw new ValidationError('Receive this delivery against its purchase order using the receiving form. A general stock import would leave the purchase order outstanding and could count the goods twice.');
  if((await db.query("SELECT 1 FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='purchase_order.receive' AND idempotency_key=$2 AND status='COMPLETED'",[ctx.workspaceId,'receiving-document:'+plan.sourceHash])).rowCount)
    throw new ValidationError('This source was already recorded as a purchase receipt. Importing it as stock would count the delivery twice.');
}
async function check(db,ctx,plan,job=plan.transformations.agentJob){
  await assertNotReceiving(db,ctx,plan);
  if(job===undefined)return;
  if(!tasks.has(job))throw new ValidationError('Review this import’s agent task before running it.');
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'draft');
  const stopped=await policy.stopped(db,ctx.workspaceId,account,tasks.get(job),false);
  if(stopped)throw new ValidationError(stopped);
  if(plan.transformations.dataset==='suppliers')throw new ValidationError('Choose a product file for this task.');
  if(job===5)return require('./agent-count-source').check(db,ctx,plan);
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
  description:job===5?'Turn a reviewed count sheet or readable shelf-label photo into physical stock corrections for existing products and locations. Choose set-on-hand, review every reading and separately confirm the physical count before queuing. Never infer a count from unreadable boxes or labels.':job===127?'Prepare a supplier catalogue preview as product and purchase-cost records. Queue its approved rows for verified import.':
    'Build product variants from mapped size, color or other spreadsheet columns. Queue the reviewed catalogue preview for verified import.',
  record:'import_plan',fields:['recordReference'],permission:job===5?require('../actions/permissions').ADJUST:require('../actions/permissions').OPERATE,ownerOnly:job===5,capability:'imports.spreadsheet',
  ...(job===5?{resultingRecords:['movements','balances','accounting_journal_entries']}:{}),
  build:async(db,ctx,row)=>{
    const plan=await require('./postgres-service').get(db,ctx.workspaceId,row.id);
    await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'draft');
    if(plan.status!=='READY')throw new ValidationError(job===5?'Choose a current count preview.':'Choose a current catalogue preview.');
    if(job===5)await check(db,ctx,plan,job);
    return {payload:{recordId:plan.id,integrityHash:plan.integrityHash},summary:job===5?'Confirm the physical counts for '+plan.recordsValid+' existing stock positions from '+plan.sourceName+'. The reviewed differences change stock and its recorded value; later movements are preserved.': 'Review and queue '+plan.recordsValid+' catalogue rows from '+plan.sourceName+'. Follow the import progress for the verified product result.'};
  },execute:(db,ctx,p)=>queue({query:(...a)=>db.query(...a),transaction:fn=>fn(db)},ctx,p.recordId,p.integrityHash,job),
  verify:async(db,ctx,result,p)=>Boolean(result.job?.id&&(await db.query(`SELECT 1 FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND id=$2 AND kind='import.execute-approved' AND payload->>'planId'=$3`,[ctx.workspaceId,result.job.id,p.recordId])).rowCount)
}));
module.exports={check,specs,assertNotReceiving};
