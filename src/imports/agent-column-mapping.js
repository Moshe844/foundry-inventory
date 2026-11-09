'use strict';

const plans=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const fields=require('./fields');

async function match(db,workspaceId,{filename,kind,columns,sheetIndex,sheetName,sourceHash}){
  if(!filename||!['xlsx','csv'].includes(kind)||!columns.length||columns.some(c=>!c.name)
    ||new Set(columns.map(c=>c.name.trim().toLowerCase())).size!==columns.length)return null;
  const headers=columns.map(c=>({name:c.name,index:c.index}));
  const {rows}=await db.query(`SELECT p.id,p.field_mappings,p.detected_type FROM import_plans p JOIN users u
    ON u.workspace_id=p.workspace_id AND u.id=p.approved_by_user_id AND u.role='owner'
    WHERE p.workspace_id=$1 AND p.source_name=$2 AND p.sheet_index=$3 AND p.sheet_name IS NOT DISTINCT FROM $4 AND p.source_kind=$5
    AND p.source_hash<>$6 AND p.status='SUCCEEDED' AND p.approval_status='APPROVED' AND p.records_invalid=0 AND p.records_valid>0
    AND p.source_columns::jsonb=$7::jsonb AND NOT (p.transformations::jsonb ? 'workbook')
    AND coalesce(p.transformations::jsonb->>'dataset','inventory')='inventory'
    ORDER BY p.approved_at DESC,p.id DESC LIMIT 2`,[workspaceId,filename,sheetIndex,sheetName,kind,sourceHash,JSON.stringify(headers)]);
  if(!rows.length)return null;
  const mappings=typeof rows[0].field_mappings==='string'?JSON.parse(rows[0].field_mappings):rows[0].field_mappings;
  if(!mappings||!(mappings.name!=null||mappings.code!=null)||!Object.keys(mappings).every(f=>fields.FIELD_LABEL[f])
     ||!Object.values(mappings).every(i=>Number.isInteger(i)&&headers.some(h=>h.index===i)))return null;
  if(rows.length===2&&hash(mappings)!==hash(typeof rows[1].field_mappings==='string'?JSON.parse(rows[1].field_mappings):rows[1].field_mappings))return null;
  return {source:rows[0].id,mappings,detectedType:rows[0].detected_type};
}

async function automatic(db,workspaceId){
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(!state.agentTerms||!state.canAutomate||!plans.permits(state.plan,133,'automatic'))return false;
  return !await require('../autopilot/job-modes').restriction(db,workspaceId,133,true);
}

async function access(db,ctx){
  const agent=await require('../autopilot/postgres-service').getState(db,ctx.workspaceId);
  return {allowed:agent.agentTerms&&plans.permits(agent.plan,133,'draft')&&await require('../operations/postgres-warehouse-access').scope(db,ctx)===null,
    block:!agent.canAct?'StockChief is watching or paused. You can review the columns manually.':await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,133,false)};
}
async function verify(db,ctx,plan,input){
  await plans.requireWorkspaceJob(db,ctx.workspaceId,133,'draft');
  const current=await access(db,ctx);
  if(!current.allowed||current.block)throw new ValidationError(current.block||'Inventory-wide access is required to reuse a column mapping.');
  const prior=await match(db,ctx.workspaceId,{filename:plan.sourceName,kind:plan.sourceKind,columns:plan.sourceColumns,
    sheetIndex:plan.sheetIndex,sheetName:plan.sheetName,sourceHash:plan.sourceHash});
  if(!prior||prior.source!==input.source||plan.integrityHash!==input.integrityHash||plan.transformations.columnTemplate?.source!==prior.source)
    throw new ValidationError('The current preview or the earlier column mapping changed. Review the import again.');
  return prior;
}
async function apply(db,ctx,id,input){
  const plan=await require('./postgres-service').get(db,ctx.workspaceId,id);
  const prior=await verify(db,ctx,plan,input);
  return require('./postgres-preview-revisions').queue(db,ctx,id,{expectedHash:plan.integrityHash,fieldMappings:prior.mappings,columnSource:prior.source});
}
module.exports={match,automatic,apply,access,verify};
