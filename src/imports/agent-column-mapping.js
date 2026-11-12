'use strict';

// Job 133: reads an import file and maps the columns.
//
// The column meanings come from known header wordings (fields.js), checked
// against the values in every row, and from a mapping the owner approved for
// an earlier file of the same layout. A column whose heading StockChief does
// not know, whose values do not fit the meaning, or that only an AI model
// could read is never settled on its own: it stops and asks.
//
// Starter proposes the mapping for a person to confirm. Growth, Pro and Custom
// map on their own when every column is settled this way, unless the first
// 14 days, Watch only, a pause, Ask me first or routine work being off say a
// person confirms. Mapping alone creates no product, stock or value.

const plans=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const fields=require('./fields');
const {nowIso}=require('../lib/util');

const JOB=133,ACTION='import.map_columns';
// Exported dated files ("stock 2026-11-12.csv") are the same export each day.
const stem=name=>String(name||'').trim().toLowerCase().replace(/[0-9]+/g,'#');

async function match(db,workspaceId,{filename,kind,columns,sheetIndex,sheetName,sourceHash}){
  if(!filename||!['xlsx','csv'].includes(kind)||!columns.length||columns.some(c=>!c.name)
    ||new Set(columns.map(c=>c.name.trim().toLowerCase())).size!==columns.length)return null;
  const headers=columns.map(c=>({name:c.name,index:c.index}));
  const {rows}=await db.query(`SELECT p.id,p.field_mappings,p.detected_type FROM import_plans p JOIN users u
    ON u.workspace_id=p.workspace_id AND u.id=p.approved_by_user_id AND u.role='owner'
    WHERE p.workspace_id=$1 AND regexp_replace(lower(btrim(p.source_name)),'[0-9]+','#','g')=$2 AND p.sheet_index=$3 AND p.sheet_name IS NOT DISTINCT FROM $4 AND p.source_kind=$5
    AND p.source_hash<>$6 AND p.status='SUCCEEDED' AND p.approval_status='APPROVED' AND p.records_invalid=0 AND p.records_valid>0
    AND p.source_columns::jsonb=$7::jsonb AND NOT (p.transformations::jsonb ? 'workbook')
    AND coalesce(p.transformations::jsonb->>'dataset','inventory')='inventory'
    ORDER BY p.approved_at DESC,p.id DESC LIMIT 2`,[workspaceId,stem(filename),sheetIndex,sheetName,kind,sourceHash,JSON.stringify(headers)]);
  if(!rows.length)return null;
  const mappings=typeof rows[0].field_mappings==='string'?JSON.parse(rows[0].field_mappings):rows[0].field_mappings;
  if(!mappings||!(mappings.name!=null||mappings.code!=null)||!Object.keys(mappings).every(f=>fields.FIELD_LABEL[f])
     ||!Object.values(mappings).every(i=>Number.isInteger(i)&&headers.some(h=>h.index===i)))return null;
  if(rows.length===2&&hash(mappings)!==hash(typeof rows[1].field_mappings==='string'?JSON.parse(rows[1].field_mappings):rows[1].field_mappings))return null;
  return {source:rows[0].id,mappings,detectedType:rows[0].detected_type};
}

// Whether StockChief may map columns without a person right now, and if not,
// the plain reason a person confirms them instead.
async function authority(db,workspaceId){
  const account=await plans.accountState(db,workspaceId);
  if(!plans.usesAgentTerms(account)||!plans.permits(account.plan,JOB,'draft'))return null;
  if(!plans.permits(account.plan,JOB,'automatic'))return {automatic:false,reason:'On Starter you confirm the columns before importing.'};
  const stopped=await plans.stopped(db,workspaceId,account,ACTION,true);
  if(stopped)return {automatic:false,reason:stopped};
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(!state.canAutomate)return {automatic:false,reason:'Handle routine work is off for this inventory, so you confirm the columns.'};
  return {automatic:true,reason:null};
}

async function automatic(db,workspaceId){
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(!state.agentTerms||!state.canAutomate||!plans.permits(state.plan,JOB,'automatic'))return false;
  return !await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,true);
}

// ---- Checking the values against the meaning ---------------------------------

const NUMBER=/^[-+]?\d[\d,]*(?:\.\d+)?$/,WHOLE=/^\d+$/;
const money=value=>{try{return require('../pricing/price-service').toMinor(require('./source-money').clean(value))!==null;}catch{return false;}};
const date=value=>{try{const read=require('./row-validator').readDate(value);return Boolean(read?.ok&&read.value);}catch{return false;}};
const TESTS={
  quantity:v=>NUMBER.test(v.replace(/\s/g,'')),
  unitCost:money,sellingPrice:money,
  barcode:v=>/^\d{6,14}$/.test(v.replace(/[\s-]/g,'')),
  reorderPoint:v=>WHOLE.test(v),targetStock:v=>WHOLE.test(v),safetyStock:v=>WHOLE.test(v),leadTimeDays:v=>WHOLE.test(v),
  expiresAt:date,receivedAt:date,
  currency:v=>/^[A-Za-z]{3}$/.test(v),
  name:v=>!NUMBER.test(v),location:v=>!NUMBER.test(v),unitLabel:v=>!NUMBER.test(v),
  serialTracked:v=>/^(?:yes|no|true|false|1|0)$/i.test(v),lotTracked:v=>/^(?:yes|no|true|false|1|0)$/i.test(v),
};
const KIND={quantity:'numbers',unitCost:'money amounts',sellingPrice:'money amounts',barcode:'barcodes',reorderPoint:'whole numbers',
  targetStock:'whole numbers',safetyStock:'whole numbers',leadTimeDays:'whole numbers of days',expiresAt:'dates',receivedAt:'dates',
  currency:'three-letter currency codes',name:'product names',location:'location names',unitLabel:'units such as each or box',
  serialTracked:'yes or no',lotTracked:'yes or no'};

// One pass over every row for the mapped columns that have a value test.
function fitRates(rows,mappings){
  const checks=Object.entries(mappings).filter(([field,index])=>TESTS[field]&&Number.isInteger(index))
    .map(([field,index])=>({field,index,test:TESTS[field],filled:0,fit:0}));
  if(!checks.length)return {};
  for(const row of rows)for(const check of checks){
    const value=String(row.cells?.[check.index]??'').trim();
    if(!value)continue;
    check.filled++;if(check.test(value))check.fit++;
  }
  return Object.fromEntries(checks.map(c=>[c.field,{filled:c.filled,fit:c.fit}]));
}

// Every column, with how its meaning was settled, and the ones to ask about.
function assess({columns,rows,mappings,profiles=[],confident=[],aiApplied=[],saved=null}){
  const byIndex=new Map(profiles.map(p=>[p.index,p]));
  const fieldAt=new Map(Object.entries(mappings).map(([field,index])=>[index,field]));
  const byModel=new Set(aiApplied.map(a=>a.column));
  const rates=fitRates(rows,mappings);
  const numberQuestion=mappings.quantity===undefined;
  const out=[],unclear=[];
  for(const column of columns){
    const field=fieldAt.get(column.index),profile=byIndex.get(column.index)||{filled:0,numericRate:0},base={index:column.index,name:column.name};
    if(field){
      const rate=rates[field],fits=!rate||!rate.filled||rate.fit/rate.filled>=0.8;
      const how=saved&&saved[field]===column.index?'saved':byModel.has(column.name)?'ai':confident.includes(field)?'heading':'values';
      out.push({...base,field,how});
      if(!fits)unclear.push({...base,field,reason:'The values do not look like '+(KIND[field]||fields.FIELD_LABEL[field].toLowerCase())+'.'});
      else if(how==='ai')unclear.push({...base,field,reason:'Only the AI reader could place this column, from its values.'});
      continue;
    }
    if(!profile.filled){out.push({...base,field:null,how:'empty'});continue;}
    const because=fields.ignorableAs(column.name);
    if(because){out.push({...base,field:null,how:'kept',because});continue;}
    // The number question already asks about unlabelled numbers.
    if(numberQuestion&&profile.numericRate>=0.8){out.push({...base,field:null,how:'number'});continue;}
    out.push({...base,field:null,how:'unknown'});
    unclear.push({...base,field:null,reason:'StockChief does not know what this column holds.'});
  }
  return {columns:out,unclear};
}

// A mapped column whose values do not fit, or that only the AI reader placed,
// could import wrong data: it stops the import until a person answers. A
// column StockChief does not know is kept as a product detail, so nothing is
// lost; it stops StockChief mapping on its own and asks, and approving the
// preview keeps it as a detail.
function stateFor(unclear,identity,automatic){
  if(!identity||unclear.some(u=>u.field))return 'ask';
  return unclear.length||!automatic?'confirm':'automatic';
}

// The saved column review for a new preview, or null when job 133 does not
// apply (an older plan, an explicit mapping from the caller, or a workbook,
// image or handwriting reading with its own review).
async function review(db,workspaceId,{columns,rows,mappings,profiles,confident,aiApplied,saved}){
  const power=await authority(db,workspaceId);
  if(!power)return null;
  const found=assess({columns,rows,mappings,profiles,confident,aiApplied,saved});
  const identity=mappings.name!==undefined||mappings.code!==undefined;
  const state=stateFor(found.unclear,identity,power.automatic);
  return {version:1,state,automatic:power.automatic,reason:power.reason,mappingHash:hash(mappings),
    columns:found.columns,unclear:found.unclear,decidedAt:nowIso(),...(state==='automatic'?{decidedBy:'stockchief'}:{})};
}

// A person changed the mapping without confirming every column: the columns
// they changed are answered; the rest keep their state.
function afterChange(previous,mappings,{confirmed=false,actorId=null}={}){
  if(!previous)return previous;
  const at=nowIso(),mappingHash=hash(mappings);
  if(confirmed)return {...previous,state:'confirmed',unclear:[],mappingHash,confirmedBy:actorId,confirmedAt:at};
  if(previous.mappingHash===mappingHash)return previous;
  const before=new Map(previous.columns.map(c=>[c.index,c.field||null])),now=new Map(Object.entries(mappings).map(([f,i])=>[i,f]));
  const changed=index=>(now.get(index)||null)!==(before.get(index)??null);
  const columns=previous.columns.map(c=>changed(c.index)?{...c,field:now.get(c.index)||null,how:'person'}:c);
  const unclear=previous.unclear.filter(u=>!changed(u.index));
  const identity=mappings.name!==undefined||mappings.code!==undefined;
  const state=previous.state==='automatic'||previous.state==='confirmed'?'confirmed':stateFor(unclear,identity,previous.automatic&&previous.state!=='confirm');
  return {...previous,state,columns,unclear,mappingHash,...(state==='confirmed'?{confirmedBy:actorId,confirmedAt:at}:{})};
}

function pending(plan){const r=plan?.transformations?.columnReview;return Boolean(r&&['ask','confirm'].includes(r.state));}

async function access(db,ctx){
  const agent=await require('../autopilot/postgres-service').getState(db,ctx.workspaceId);
  return {allowed:agent.agentTerms&&plans.permits(agent.plan,JOB,'draft')&&await require('../operations/postgres-warehouse-access').scope(db,ctx)===null,
    block:!agent.canAct?'StockChief is watching or paused. You can review the columns manually.':await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,JOB,false)};
}
async function verify(db,ctx,plan,input){
  await plans.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
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
  return require('./postgres-preview-revisions').queue(db,ctx,id,{expectedHash:plan.integrityHash,fieldMappings:prior.mappings,columnSource:prior.source,confirmColumns:true});
}

// A person answers the column question: each listed column keeps its meaning,
// takes a new one, or is kept as a product detail. Unchanged answers confirm
// the preview without reading the rows again.
async function confirm(db,ctx,id,input={}){
  await plans.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const imports=require('./postgres-service'),plan=await imports.get(db,ctx.workspaceId,id);
  const review=plan.transformations.columnReview;
  if(plan.status!=='READY'||plan.approvalStatus!=='AWAITING_APPROVAL'||plan.integrityHash!==input.expectedHash)
    throw new ValidationError('The preview changed. Review the current columns before confirming them.');
  if(!review)throw new ValidationError('This preview has no column question.');
  const next={...plan.fieldMappings},indexes=new Set(plan.sourceColumns.map(c=>c.index));
  for(const [raw,choice] of Object.entries(input.choices||{})){
    const index=Number(raw),field=String(choice||'').trim();
    if(!indexes.has(index)||field&&!fields.FIELD_IDS.includes(field))throw new ValidationError('Choose a meaning listed for each column.');
    for(const [key,value] of Object.entries(next))if(value===index)delete next[key];
    if(field){if(next[field]!==undefined)throw new ValidationError('Two columns cannot have the same meaning. Change the other column first.');next[field]=index;}
  }
  if(next.name===undefined&&next.code===undefined)throw new ValidationError('Choose the column with product names or SKUs.');
  if(hash(next)!==hash(plan.fieldMappings))
    return require('./postgres-preview-revisions').queue(db,ctx,id,{expectedHash:plan.integrityHash,fieldMappings:next,confirmColumns:true});
  return db.transaction(async client=>{
    const saved=(await client.query('SELECT integrity_hash,status,approval_status,transformations FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!saved||saved.integrity_hash!==input.expectedHash||saved.status!=='READY'||saved.approval_status!=='AWAITING_APPROVAL')
      throw new ValidationError('The preview changed. Review the current columns before confirming them.');
    const current=(typeof saved.transformations==='string'?JSON.parse(saved.transformations):saved.transformations).columnReview;
    const confirmed=afterChange(current,plan.fieldMappings,{confirmed:true,actorId:ctx.actorId});
    await client.query("UPDATE import_plans SET transformations=(transformations::jsonb||jsonb_build_object('columnReview',$3::jsonb))::text WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId,id,JSON.stringify(confirmed)]);
    await require('../operations/postgres-security-audit').record(client,ctx,{action:'Import columns confirmed',reference:id,
      before:{state:current?.state,unclear:(current?.unclear||[]).map(u=>u.name)},after:{state:'confirmed',mappings:plan.fieldMappings}});
    return {plan:{...plan,transformations:{...plan.transformations,columnReview:confirmed}},queued:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={JOB,ACTION,stateFor,match,automatic,authority,assess,review,afterChange,pending,apply,access,verify,confirm,stem};
