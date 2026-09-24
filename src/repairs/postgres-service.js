'use strict';

const crypto=require('node:crypto');
const {newId,nowIso}=require('../lib/util');
const {NotFoundError,ValidationError}=require('../domain/errors');
const providerSync=require('../connections/postgres-provider-sync');

const ACTIVE=['OPEN','DIAGNOSED','SIMULATED','NEEDS_AUTHORITY','AUTHORIZED','EXECUTING','VERIFYING','FAILED','INCONCLUSIVE'];
const parse=(value,fallback)=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value)??fallback;}catch{return fallback;}};
const encode=value=>JSON.stringify(value??{});

function hydrate(row){
  if(!row)return null;
  return {id:row.id,workspaceId:row.workspace_id,kind:row.kind,symptom:row.symptom,
    failedInvariant:row.failed_invariant,status:row.status,confidence:row.confidence,materiality:row.materiality,
    affectedRecords:parse(row.affected_records,{}),timeline:parse(row.timeline,[]),evidence:parse(row.evidence,[]),
    proposedRepair:parse(row.proposed_repair,{}),simulation:parse(row.simulation,{}),
    beforeEvidence:parse(row.before_evidence,{}),executionResult:parse(row.execution_result,{}),
    afterEvidence:parse(row.after_evidence,{}),verification:parse(row.verification,{}),adapterId:row.adapter_id,
    adapterVersion:Number(row.adapter_version),requiredPermissions:parse(row.required_permissions,[]),
    requiresApproval:Boolean(Number(row.requires_approval)),approvedByUserId:row.approved_by_user_id,
    approvedAt:row.approved_at,attempts:Number(row.attempts),checkpoint:row.checkpoint,errorMessage:row.error_message,
    idempotencyKey:row.idempotency_key,createdByUserId:row.created_by_user_id,createdAt:row.created_at,
    updatedAt:row.updated_at,resolvedAt:row.resolved_at};
}

function keyFor(kind,invariant,affected){return `${kind}:${crypto.createHash('sha256')
  .update(JSON.stringify({invariant,affected})).digest('hex').slice(0,24)}`;}

async function appendEvent(client,repairCase,event,detail={},actorUserId=null){
  await client.query(`INSERT INTO repair_case_events
    (id,workspace_id,repair_case_id,event,detail,actor_user_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
  [newId('rce'),repairCase.workspaceId,repairCase.id,event,encode(detail),actorUserId,nowIso()]);
}

async function getFrom(client,workspaceId,id,{lock=false}={}){
  const row=(await client.query(`SELECT * FROM repair_cases WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,
    [workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That repair case is not in this inventory.');
  return hydrate(row);
}

async function get(database,workspaceId,id){return getFrom(database,workspaceId,id);}

async function list(database,workspaceId,{statuses=null,limit=100}={}){
  const bounded=Math.min(250,Math.max(1,Number(limit)||100));
  const rows=statuses?.length
    ?(await database.query(`SELECT * FROM repair_cases WHERE workspace_id=$1 AND status=ANY($2::text[])
      ORDER BY updated_at DESC,id DESC LIMIT $3`,[workspaceId,statuses,bounded])).rows
    :(await database.query(`SELECT * FROM repair_cases WHERE workspace_id=$1
      ORDER BY updated_at DESC,id DESC LIMIT $2`,[workspaceId,bounded])).rows;
  return rows.map(hydrate);
}

async function events(database,workspaceId,id){
  await get(database,workspaceId,id);
  return (await database.query(`SELECT event.detail,event.event,event.created_at,user_record.name AS actor_name
    FROM repair_case_events event LEFT JOIN users user_record ON user_record.id=event.actor_user_id
    WHERE event.workspace_id=$1 AND event.repair_case_id=$2 ORDER BY event.created_at,event.id`,[workspaceId,id])).rows
    .map(row=>({event:row.event,detail:parse(row.detail,{}),actorName:row.actor_name,createdAt:row.created_at}));
}

async function reportableMappings(database,workspaceId,connectorId=null){
  return (await database.query(`SELECT mapping.id,mapping.connector_id,mapping.external_id,mapping.foundry_record_id,
      mapping.updated_at,connector.display_name AS connection_name,item.name AS item_name,sku.variant_label,sku.code
    FROM connection_mappings mapping JOIN workspace_connectors connector ON connector.id=mapping.connector_id
      AND connector.workspace_id=mapping.workspace_id
    JOIN skus sku ON sku.id=mapping.foundry_record_id AND sku.workspace_id=mapping.workspace_id
    JOIN items item ON item.id=sku.item_id AND item.workspace_id=sku.workspace_id
    WHERE mapping.workspace_id=$1 AND mapping.entity_type='sku' AND ($2::text IS NULL OR mapping.connector_id=$2)
    ORDER BY lower(connector.display_name),lower(mapping.external_id)`,[workspaceId,connectorId||null])).rows;
}

async function selectableSkus(database,workspaceId){
  return (await database.query(`SELECT sku.id,sku.code,sku.variant_label,item.name AS item_name FROM skus sku
    JOIN items item ON item.id=sku.item_id AND item.workspace_id=sku.workspace_id
    WHERE sku.workspace_id=$1 AND sku.is_active=1 AND item.is_active=1
    ORDER BY lower(item.name),lower(COALESCE(sku.variant_label,'')),lower(sku.code)`,[workspaceId])).rows;
}

async function openWrongMapping(database,ctx,input){
  return database.transaction(async client=>{
    const mapping=(await client.query(`SELECT mapping.*,connector.display_name AS connection_name
      FROM connection_mappings mapping JOIN workspace_connectors connector ON connector.id=mapping.connector_id
        AND connector.workspace_id=mapping.workspace_id
      WHERE mapping.workspace_id=$1 AND mapping.id=$2 AND mapping.entity_type='sku' FOR UPDATE OF mapping`,
    [ctx.workspaceId,String(input.mappingId||'')])).rows[0];
    if(!mapping)throw new ValidationError('Choose a current external product match from this inventory.');
    const correct=(await client.query(`SELECT sku.id,sku.code,sku.variant_label,item.name AS item_name FROM skus sku
      JOIN items item ON item.id=sku.item_id AND item.workspace_id=sku.workspace_id
      WHERE sku.workspace_id=$1 AND sku.id=$2 AND sku.is_active=1 AND item.is_active=1`,
    [ctx.workspaceId,String(input.correctSkuId||'')])).rows[0];
    if(!correct)throw new ValidationError('Choose the StockChief product this external item should use.');
    if(correct.id===mapping.foundry_record_id)throw new ValidationError('That external item already uses the selected product. Nothing needs repairing.');
    const affected={connectorId:mapping.connector_id,entityType:'sku',externalId:mapping.external_id,
      foundryRecordId:correct.id,expectedCurrentFoundryRecordId:mapping.foundry_record_id};
    const invariant=`External product ${mapping.external_id} must resolve to the owner-approved StockChief SKU`;
    const idempotencyKey=`owner-report:wrong-mapping:${mapping.id}:${correct.id}:${mapping.updated_at}`;
    const existing=(await client.query(`SELECT * FROM repair_cases WHERE workspace_id=$1 AND idempotency_key=$2`,
      [ctx.workspaceId,idempotencyKey])).rows[0];
    if(existing)return {repairCase:hydrate(existing),created:false};
    const note=String(input.note||'').trim().slice(0,1000);const at=nowIso();const id=newId('repair');
    const evidence=[{source:'owner_report',connectionId:mapping.connector_id,connectionName:mapping.connection_name,
      mappingId:mapping.id,currentStockChiefRecordId:mapping.foundry_record_id,expectedSkuId:correct.id,note:note||null},
      {source:'connection_mapping',connectorId:mapping.connector_id,entityType:'sku',externalId:mapping.external_id,
        currentStockChiefRecordId:mapping.foundry_record_id}];
    const proposed={connectorId:mapping.connector_id,entityType:'sku',externalId:mapping.external_id,
      foundryRecordId:correct.id,expectedCurrentFoundryRecordId:mapping.foundry_record_id};
    const simulation={summary:`Future imported activity for ${mapping.external_id} will use ${correct.item_name}${correct.variant_label?` / ${correct.variant_label}`:''} · ${correct.code}.`,
      before:{foundryRecordId:mapping.foundry_record_id},after:{foundryRecordId:correct.id},
      consequences:['Historical business records are not rewritten.','Future imported activity uses the corrected mapping.'],externalEffects:[]};
    await client.query(`INSERT INTO repair_cases
      (id,workspace_id,kind,symptom,failed_invariant,status,confidence,materiality,affected_records,timeline,
       evidence,proposed_repair,simulation,before_evidence,adapter_id,adapter_version,required_permissions,
       requires_approval,idempotency_key,created_by_user_id,checkpoint,created_at,updated_at)
      VALUES($1,$2,'wrong_mapping',$3,$4,'NEEDS_AUTHORITY','high','high',$5,$6,$7,$8,$9,$10,
       'wrong-mapping-postgres',1,$11,1,$12,$13,'simulated',$14,$14)`,
    [id,ctx.workspaceId,`${mapping.external_id} is connected to the wrong StockChief product`,invariant,
      encode(affected),encode([{at:mapping.updated_at||mapping.created_at,event:'current mapping recorded'}]),
      encode(evidence),encode(proposed),encode(simulation),encode({mapping:evidence[1]}),encode(['ADMIN']),
      idempotencyKey,ctx.actorId,at]);
    let repairCase=await getFrom(client,ctx.workspaceId,id);
    await appendEvent(client,repairCase,'opened',{symptom:repairCase.symptom,failedInvariant:invariant,affectedRecords:affected},ctx.actorId);
    await appendEvent(client,repairCase,'diagnosed',{confidence:'high',materiality:'high',evidence},ctx.actorId);
    await appendEvent(client,repairCase,'simulated',simulation,ctx.actorId);
    repairCase=await getFrom(client,ctx.workspaceId,id);
    return {repairCase,created:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function approve(database,ctx,id){
  return database.transaction(async client=>{
    let repairCase=await getFrom(client,ctx.workspaceId,id,{lock:true});
    if(repairCase.status==='RESOLVED'||repairCase.approvedAt)return {...repairCase,replayed:true};
    if(repairCase.status!=='NEEDS_AUTHORITY')throw new ValidationError('This repair is not waiting for approval.');
    const at=nowIso();
    await client.query(`UPDATE repair_cases SET status='AUTHORIZED',approved_by_user_id=$3,approved_at=$4,
      checkpoint='authorized',error_message=NULL,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,ctx.actorId,at]);
    repairCase=await getFrom(client,ctx.workspaceId,id);
    await appendEvent(client,repairCase,'authorized',{simulation:repairCase.simulation},ctx.actorId);
    return {...repairCase,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function verification(client,repairCase){
  if(repairCase.kind!=='wrong_mapping')return {passed:false,needsHuman:true,
    checks:[{name:'A native PostgreSQL repair adapter exists',passed:false}]};
  const proposed=repairCase.proposedRepair;
  const mapping=(await client.query(`SELECT foundry_record_id FROM connection_mappings
    WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
  [repairCase.workspaceId,proposed.connectorId,proposed.entityType,proposed.externalId])).rows[0];
  const passed=Boolean(mapping&&mapping.foundry_record_id===proposed.foundryRecordId);
  return {passed,checks:[{name:'Future external activity resolves to the approved record',passed,
    observed:mapping?.foundry_record_id||null}]};
}

async function finalize(client,repairCase,checked,actorId){
  const at=nowIso();const status=checked.passed?'RESOLVED':checked.needsHuman?'NEEDS_AUTHORITY':'FAILED';
  await client.query(`UPDATE repair_cases SET status=$3,verification=$4,after_evidence=$5,
    checkpoint=$6,error_message=$7,resolved_at=$8,updated_at=$9 WHERE workspace_id=$1 AND id=$2`,
  [repairCase.workspaceId,repairCase.id,status,encode(checked),encode({checks:checked.checks||[]}),
    checked.passed?'verified':'verification_failed',checked.passed?null:'Post-repair verification did not pass.',
    checked.passed?at:null,at]);
  const updated=await getFrom(client,repairCase.workspaceId,repairCase.id);
  await appendEvent(client,updated,checked.passed?'verified_and_resolved':'verification_failed',checked,actorId);
  return updated;
}

async function verify(database,ctx,id){
  return database.transaction(async client=>{
    const repairCase=await getFrom(client,ctx.workspaceId,id,{lock:true});
    return finalize(client,repairCase,await verification(client,repairCase),ctx.actorId);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function recordFailure(database,ctx,id,error){
  await database.transaction(async client=>{
    const repairCase=await getFrom(client,ctx.workspaceId,id,{lock:true});
    if(repairCase.status==='RESOLVED')return;
    const at=nowIso();
    await client.query(`UPDATE repair_cases SET status='FAILED',attempts=attempts+1,error_message=$3,
      checkpoint='execution_failed',updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,String(error.message||error),at]);
    await appendEvent(client,{...repairCase,attempts:repairCase.attempts+1},'execution_failed',{error:String(error.message||error)},ctx.actorId);
  },{isolation:'READ COMMITTED'});
}

async function execute(database,ctx,id){
  try{return await database.transaction(async client=>{
    let repairCase=await getFrom(client,ctx.workspaceId,id,{lock:true});
    if(repairCase.status==='RESOLVED')return {repairCase,replayed:true};
    if(!repairCase.approvedAt||!['AUTHORIZED','FAILED','EXECUTING','VERIFYING'].includes(repairCase.status))
      throw new ValidationError('Review and approve this repair before running it.');
    const already=await verification(client,repairCase);
    if(already.passed)return {repairCase:await finalize(client,repairCase,already,ctx.actorId),replayed:true};
    if(repairCase.kind!=='wrong_mapping')throw new ValidationError('This migrated repair kind does not yet have a native PostgreSQL executor.');
    const at=nowIso();
    await client.query(`UPDATE repair_cases SET status='EXECUTING',attempts=attempts+1,checkpoint='executing',
      error_message=NULL,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,at]);
    repairCase=await getFrom(client,ctx.workspaceId,id);
    await appendEvent(client,repairCase,'execution_started',{attempt:repairCase.attempts},ctx.actorId);
    const proposed=repairCase.proposedRepair;
    const mapping=await providerSync.setMappingInTransaction(client,ctx,{connectorId:proposed.connectorId,
      entityType:proposed.entityType,externalId:proposed.externalId,foundryRecordId:proposed.foundryRecordId,
      expectedFoundryRecordId:proposed.expectedCurrentFoundryRecordId});
    const result={mappingId:mapping.id,foundryRecordId:mapping.foundry_record_id};
    await client.query(`UPDATE repair_cases SET status='VERIFYING',execution_result=$3,
      checkpoint='domain_action_complete',updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,encode(result),nowIso()]);
    repairCase=await getFrom(client,ctx.workspaceId,id);
    await appendEvent(client,repairCase,'domain_action_completed',result,ctx.actorId);
    return {repairCase:await finalize(client,repairCase,await verification(client,repairCase),ctx.actorId),replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});}
  catch(error){
    const repairCase=await get(database,ctx.workspaceId,id).catch(()=>null);
    if(repairCase?.approvedAt)await recordFailure(database,ctx,id,error);
    throw error;
  }
}

module.exports={ACTIVE,hydrate,keyFor,get,list,events,reportableMappings,selectableSkus,openWrongMapping,
  approve,execute,verify};
