'use strict';

const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError}=require('../domain/errors');
const table='stockchief_runtime.agent_document_filing_scopes';
const partyTables={supplier:{table:'suppliers',active:"status='active'"},customer:{table:'customers',active:"record_state='ACTIVE'"}};
const allowedKinds={supplier:['purchase_order','item'],customer:['sales_order','item']};

async function identity(db,workspaceId,connectorId,partyKind,partyId){
  const definition=partyTables[partyKind];
  if(!definition)return null;
  return (await db.query(`SELECT c.id AS mailbox_id,c.provider_account_id,c.provider_type,lower(btrim(p.email)) AS email,p.id AS party_id
    FROM workspace_connectors c JOIN ${definition.table} p ON p.workspace_id=c.workspace_id
    WHERE c.workspace_id=$1 AND c.id=$2 AND p.id=$3 AND p.${definition.active} AND btrim(p.email)<>''
    AND c.provider_type IN('gmail','microsoft365') AND c.status='connected' AND c.paused_at IS NULL AND c.provider_account_id IS NOT NULL
    AND 1=(SELECT count(*) FROM (
      SELECT s.id FROM suppliers s WHERE s.workspace_id=p.workspace_id AND s.status='active' AND lower(btrim(s.email))=lower(btrim(p.email))
      UNION ALL SELECT u.id FROM customers u WHERE u.workspace_id=p.workspace_id AND u.record_state='ACTIVE' AND lower(btrim(u.email))=lower(btrim(p.email))
    ) matches) FOR SHARE OF c,p`,[workspaceId,connectorId,partyId])).rows[0]||null;
}

async function configure(db,ctx,input){
  const service=require('./agent-document-discovery');
  return db.transaction(async c=>{
    await service.owner(c,ctx);
    if(input.stop==='yes'){
      const result=await c.query(`UPDATE ${table} SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND enabled`,
        [ctx.workspaceId,input.id,Number(input.revision)||0]);
      if(!result.rowCount)throw new ValidationError('The saved mailbox scope changed. Reload before stopping it.');
      await require('../operations/postgres-security-audit').record(c,ctx,{action:'Automatic document filing scope stopped',reference:input.id});
      return {stopped:true};
    }
    await service.authorize(c,ctx,true);
    const [partyKind,partyId]=String(input.party||'').split(':');
    const targetKinds=[...new Set((Array.isArray(input.targetKinds)?input.targetKinds:[input.targetKinds]).filter(Boolean))].sort();
    const source=await identity(c,ctx.workspaceId,input.connectorId,partyKind,partyId);
    if(!source||input.confirmed!=='yes'||!targetKinds.length||targetKinds.some(kind=>!allowedKinds[partyKind]?.includes(kind)))
      throw new ValidationError('Confirm an active mailbox, one known sender and the exact eligible record types for that sender.');
    const prior=(await c.query(`SELECT id,enabled,revision FROM ${table} WHERE workspace_id=$1 AND connector_id=$2 AND party_kind=$3 AND party_id=$4 FOR UPDATE`,
      [ctx.workspaceId,input.connectorId,partyKind,partyId])).rows[0];
    if(prior?.enabled&&Number(input.revision)!==prior.revision)throw new ValidationError('Stop the current scope before replacing its authority.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    const id=prior?.id||newId('filing-scope');
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'document-filing-scope:'+id,8192,{finished:true});
    await c.query(`INSERT INTO ${table}(id,workspace_id,connector_id,party_kind,party_id,scope_identity,target_kinds,authorized_by)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT(workspace_id,connector_id,party_kind,party_id)
      DO UPDATE SET scope_identity=EXCLUDED.scope_identity,target_kinds=EXCLUDED.target_kinds,authorized_by=EXCLUDED.authorized_by,
      enabled=true,revision=agent_document_filing_scopes.revision+1,effective_at=clock_timestamp()`,
      [id,ctx.workspaceId,input.connectorId,partyKind,partyId,JSON.stringify(source),targetKinds,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Automatic document filing scope approved',reference:id,
      after:{mailbox:input.connectorId,partyKind,partyId,targetKinds}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function matchesMessage(rule,message){
  return message.trust_status==='TRUSTED'&&message.classification===rule.party_kind&&message.connector_id===rule.connector_id&&
    message.sender===rule.scope_identity.email&&(!message.supplier_id||message.supplier_id===rule.party_id)&&
    new Date(message.received_at)>=new Date(rule.effective_at);
}

async function current(db,ctx,row,source){
  if(!row.source_identity.scopeId)return null;
  const rule=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND enabled FOR SHARE`,
    [ctx.workspaceId,row.scope_id,row.scope_revision])).rows[0];
  if(!rule||rule.authorized_by!==ctx.actorId||!source||!matchesMessage(rule,source))
    throw new ValidationError('The exact supplier or customer mailbox filing scope changed or stopped.');
  const now=await identity(db,ctx.workspaceId,rule.connector_id,rule.party_kind,rule.party_id);
  if(!now||hash(now)!==hash(rule.scope_identity))throw new ValidationError('The approved sender or connected mailbox identity changed. Review its authority.');
  return rule;
}

async function queueMessage(db,workspaceId,messageId){
  const message=(await db.query(`SELECT id,connector_id,supplier_id,lower(btrim(sender)) AS sender,received_at,classification,trust_status
    FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 AND trust_status='TRUSTED'`,[workspaceId,messageId])).rows[0];
  if(!message)return {queued:0};
  if(!Number.isFinite(new Date(message.received_at).getTime()))return {queued:0};
  const matching=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND connector_id=$2 AND party_kind=$3 AND enabled
    AND scope_identity->>'email'=$4 AND effective_at<=$5::timestamptz ORDER BY id`,
    [workspaceId,message.connector_id,message.classification,message.sender,message.received_at])).rows.filter(rule=>matchesMessage(rule,message));
  if(matching.length!==1)return {queued:0};
  const rule=matching[0],ctx={workspaceId,actorId:rule.authorized_by};
  const files=(await db.query(`SELECT id FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 AND content IS NOT NULL AND COALESCE(external_attachment_id,'') NOT LIKE 'stockchief:%' ORDER BY id`,[workspaceId,messageId])).rows;
  let queued=0,stopped=0;
  for(const file of files){
    try{
      const result=await require('./agent-document-discovery').enqueue(db,ctx,{fileAttachment:file.id,automatic:'yes'},rule);
      if(!result.replayed)queued++;
    }catch(error){if(!['entitlement_required','validation_error','forbidden'].includes(error.code))throw error;stopped++;}
  }
  return {queued,stopped};
}

async function choices(db,ctx,{includeOptions=false}={}){
  const scopes=(await db.query(`SELECT r.id,r.revision,r.party_kind,r.target_kinds,r.scope_identity->>'email' AS email,c.display_name AS mailbox
    FROM ${table} r JOIN workspace_connectors c ON c.workspace_id=r.workspace_id AND c.id=r.connector_id
    WHERE r.workspace_id=$1 AND r.enabled ORDER BY email,mailbox,r.id`,[ctx.workspaceId])).rows;
  if(!includeOptions)return {scopes,parties:[],mailboxes:[]};
  const parties=(await db.query(`SELECT 'supplier:'||id AS value,name,email,'Supplier' AS type FROM suppliers WHERE workspace_id=$1 AND status='active' AND btrim(email)<>''
    UNION ALL SELECT 'customer:'||id,name,email,'Customer' FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND btrim(email)<>'' ORDER BY name,value`,[ctx.workspaceId])).rows;
  const mailboxes=(await db.query(`SELECT id,display_name FROM workspace_connectors WHERE workspace_id=$1 AND status='connected' AND paused_at IS NULL
    AND provider_type IN('gmail','microsoft365') AND provider_account_id IS NOT NULL ORDER BY display_name,id`,[ctx.workspaceId])).rows;
  return {scopes,parties,mailboxes};
}
module.exports={table,configure,queueMessage,current,choices,matchesMessage};
