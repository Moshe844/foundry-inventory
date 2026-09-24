'use strict';

const crypto=require('node:crypto');
const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const reports=require('./postgres-reports');
const connections=require('../connections/postgres-service');
const providerService=require('../connections/postgres-provider-service');
const providers=require('../connections/providers/registry');
const providerEffects=require('../operations/postgres-provider-effects');

const hash=(value)=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const json=(value,fallback)=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value)||fallback;}catch{return fallback;}};

async function policy(database,workspaceId,connectorId,lock=false){
  const row=(await database.query(`SELECT * FROM accounting_sync_policies
    WHERE workspace_id=$1 AND connector_id=$2${lock?' FOR UPDATE':''}`,[workspaceId,connectorId])).rows[0];
  if(!row)throw new NotFoundError('Accounting synchronization policy not found. Reconnect this accounting system.');
  return {...row,verifiedFact:json(row.verified_fact,{})};
}

async function initialize(database,connection,actorId,fact){
  if(!fact?.label||fact.value===undefined||fact.value===null)throw new ValidationError(
    'The accounting connection did not return a verifiable read-only fact. Nothing was enabled.');
  const at=nowIso();
  await database.transaction(async(client)=>{
    await client.query(`INSERT INTO accounting_sync_policies
      (id,workspace_id,connector_id,provider_type,verified_fact,verified_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$6,$6)
      ON CONFLICT(workspace_id,connector_id) DO UPDATE SET verified_fact=EXCLUDED.verified_fact,
        verified_at=EXCLUDED.verified_at,stage='READ_ONLY_VERIFIED',posting_direction='READ_ONLY',
        requested_authority='OBSERVE',write_enabled_by_user_id=NULL,write_enabled_at=NULL,updated_at=EXCLUDED.updated_at`,
    [newId('acpol'),connection.workspace_id,connection.id,connection.provider_type,JSON.stringify(fact),at]);
    await client.query(`UPDATE workspace_connectors SET setup_status='AUTHORITY_REQUIRED',last_synced_at=$3,
      last_activity_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,[connection.workspace_id,connection.id,at]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return policy(database,connection.workspace_id,connection.id);
}

async function chooseAuthority(database,ctx,connectorId,authority){
  const requested=String(authority||'OBSERVE').toUpperCase();
  if(!['OBSERVE','POST'].includes(requested))throw new ValidationError('Choose observe or governed posting authority.');
  return database.transaction(async(client)=>{
    await policy(client,ctx.workspaceId,connectorId,true);
    const connection=(await client.query(`SELECT * FROM workspace_connectors
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,connectorId])).rows[0];
    if(!connection||!['quickbooks','xero'].includes(connection.provider_type))throw new ValidationError(
      'Choose a connected QuickBooks or Xero account.');
    const at=nowIso();const post=requested==='POST';
    await client.query(`UPDATE accounting_sync_policies SET accounting_source='FOUNDRY',posting_direction=$3,
      requested_authority=$4,stage=$5,write_enabled_by_user_id=NULL,write_enabled_at=NULL,updated_at=$6
      WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId,
      post?'FOUNDRY_TO_EXTERNAL':'READ_ONLY',requested,post?'SHADOW':'READ_ONLY_VERIFIED',at]);
    await client.query(`UPDATE workspace_connectors SET setup_status=$3,updated_at=$4
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,connectorId,post?'SHADOW_PENDING':'READ_ONLY_ACTIVE',at]);
    return policy(client,ctx.workspaceId,connectorId);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function localSnapshot(database,workspaceId,asOf){
  const trial=await reports.trialBalance(database,workspaceId,{to:asOf});
  return {asOf,currency:trial.currency,balanced:trial.balanced,accounts:trial.accounts.map((row)=>({
    id:row.id,code:row.code,name:row.name,balanceMinor:Number(row.ending_debit_minor)-Number(row.ending_credit_minor)}))};
}

function compare(local,external,mappings=[]){
  const externalById=new Map((external.accounts||[]).map((row)=>[String(row.externalId),row]));
  const mappedByLocal=new Map(mappings.map((row)=>[String(row.foundry_account_id),String(row.external_id)]));
  const differences=[];
  for(const account of local.accounts){const externalId=mappedByLocal.get(String(account.id));
    if(!externalId){if(account.balanceMinor!==0)differences.push({kind:'UNMAPPED_LOCAL_ACCOUNT',code:account.code,
      foundryMinor:account.balanceMinor});continue;}
    const other=externalById.get(externalId);
    if(!other){differences.push({kind:'MISSING_EXTERNAL_ACCOUNT',code:account.code,externalId});continue;}
    if(Number(other.balanceMinor)!==account.balanceMinor)differences.push({kind:'BALANCE_MISMATCH',code:account.code,
      externalId,foundryMinor:account.balanceMinor,externalMinor:Number(other.balanceMinor)});
  }
  if(external.currency&&local.currency&&external.currency!==local.currency)differences.push({kind:'CURRENCY_MISMATCH',
    foundry:local.currency,external:external.currency});
  return differences;
}

async function shadow(database,ctx,connectorId,adapter,credentials,input={}){
  const current=await policy(database,ctx.workspaceId,connectorId);
  if(current.requested_authority!=='POST')throw new ValidationError('Choose governed posting before running shadow parity.');
  if(!adapter?.readAccountingSnapshot)throw new ValidationError('This provider cannot supply a certified accounting snapshot.');
  const asOf=input.asOf||new Date().toISOString().slice(0,10);const runId=newId('acshadow');const started=nowIso();
  await database.query(`INSERT INTO accounting_shadow_runs
    (id,workspace_id,connector_id,status,as_of,local_snapshot,external_snapshot,started_at)
    VALUES($1,$2,$3,'RUNNING',$4,'{}','{}',$5)`,[runId,ctx.workspaceId,connectorId,asOf,started]);
  try{
    const [local,external,mappings]=await Promise.all([localSnapshot(database,ctx.workspaceId,asOf),
      adapter.readAccountingSnapshot({credentials,connection:await connections.get(database,ctx.workspaceId,connectorId),asOf}),
      database.query(`SELECT * FROM accounting_posting_account_mappings
        WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId])]);
    const differences=compare(local,external,mappings.rows);const status=differences.length?'MISMATCH':'MATCHED';const at=nowIso();
    await database.transaction(async(client)=>{
      await client.query(`UPDATE accounting_shadow_runs SET status=$2,local_snapshot=$3,external_snapshot=$4,
        differences=$5,completed_at=$6 WHERE id=$1`,[runId,status,JSON.stringify(local),JSON.stringify(external),
        JSON.stringify(differences),at]);
      await client.query(`UPDATE accounting_sync_policies SET last_shadow_run_id=$3,stage=$4,updated_at=$5
        WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId,runId,status==='MATCHED'?'WRITE_READY':'SHADOW',at]);
      await client.query(`UPDATE workspace_connectors SET setup_status=$3,last_synced_at=$4,last_activity_at=$4,
        updated_at=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,connectorId,status==='MATCHED'?'WRITE_READY':'SHADOW_MISMATCH',at]);
    },{isolation:'SERIALIZABLE',retrySafe:true});
    return {runId,status,local,external,differences};
  }catch(error){await database.query(`UPDATE accounting_shadow_runs SET status='FAILED',error_message=$2,
    completed_at=$3 WHERE id=$1`,[runId,String(error.message).slice(0,500),nowIso()]);throw error;}
}

async function mapAccount(database,ctx,connectorId,input={}){
  const accountId=String(input.accountId||'');const externalId=String(input.externalId||'').trim();
  if(!accountId||!externalId)throw new ValidationError('Choose both the StockChief and provider account.');
  return database.transaction(async(client)=>{
    await policy(client,ctx.workspaceId,connectorId,true);
    const account=(await client.query(`SELECT * FROM accounting_accounts
      WHERE workspace_id=$1 AND id=$2 AND active=1`,[ctx.workspaceId,accountId])).rows[0];
    if(!account)throw new ValidationError('That StockChief account is not active.');
    const latest=(await client.query(`SELECT external_snapshot FROM accounting_shadow_runs
      WHERE workspace_id=$1 AND connector_id=$2 ORDER BY started_at DESC LIMIT 1`,[ctx.workspaceId,connectorId])).rows[0];
    const external=(json(latest?.external_snapshot,{}).accounts||[]).find((row)=>String(row.externalId)===externalId);
    if(!external)throw new ValidationError('That provider account was not verified in the latest read-only snapshot.');
    const occupied=(await client.query(`SELECT foundry_account_id FROM accounting_posting_account_mappings
      WHERE workspace_id=$1 AND connector_id=$2 AND external_id=$3`,[ctx.workspaceId,connectorId,externalId])).rows[0];
    if(occupied&&occupied.foundry_account_id!==accountId)throw new ValidationError(
      'That provider account is already mapped to another StockChief account.');
    const at=nowIso();await client.query(`INSERT INTO accounting_posting_account_mappings
      (id,workspace_id,connector_id,foundry_account_id,external_id,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7)
      ON CONFLICT(workspace_id,connector_id,foundry_account_id) DO UPDATE SET external_id=EXCLUDED.external_id,
        approved_by_user_id=EXCLUDED.approved_by_user_id,updated_at=EXCLUDED.updated_at`,
    [newId('acmap'),ctx.workspaceId,connectorId,accountId,externalId,ctx.actorId,at]);
    return {account,external};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function enableWrites(database,ctx,connectorId){return database.transaction(async(client)=>{
  const current=await policy(client,ctx.workspaceId,connectorId,true);
  const connection=(await client.query(`SELECT * FROM workspace_connectors
    WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,connectorId])).rows[0];
  const capabilities=json(connection?.capabilities,[]);
  if(current.posting_direction!=='FOUNDRY_TO_EXTERNAL'||current.requested_authority!=='POST')throw new ValidationError(
    'Choose StockChief as the accounting source and request posting authority first.');
  const run=current.last_shadow_run_id&&(await client.query(`SELECT status FROM accounting_shadow_runs
    WHERE id=$1 AND workspace_id=$2 AND connector_id=$3`,[current.last_shadow_run_id,ctx.workspaceId,connectorId])).rows[0];
  if(run?.status!=='MATCHED')throw new ValidationError('A matching shadow reconciliation is required before writes can be enabled.');
  if(!capabilities.includes('accounting:post'))throw new ValidationError(
    'This authorization is read-only. Reconnect and explicitly grant posting scope first.');
  const at=nowIso();await client.query(`UPDATE accounting_sync_policies SET stage='WRITE_ENABLED',
    write_enabled_by_user_id=$3,write_enabled_at=$4,updated_at=$4 WHERE workspace_id=$1 AND connector_id=$2`,
  [ctx.workspaceId,connectorId,ctx.actorId,at]);
  await client.query(`UPDATE workspace_connectors SET setup_status='ACCOUNTING_WRITE_ENABLED',updated_at=$3
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,connectorId,at]);return policy(client,ctx.workspaceId,connectorId);
},{isolation:'SERIALIZABLE',retrySafe:true});}

async function entry(database,workspaceId,connectorId,entryId){
  const header=(await database.query(`SELECT * FROM accounting_journal_entries
    WHERE workspace_id=$1 AND id=$2 AND status='POSTED'`,[workspaceId,entryId])).rows[0];
  if(!header)throw new NotFoundError('That posted journal was not found.');
  const lines=(await database.query(`SELECT line.*,account.code AS account_code,account.name AS account_name,
      mapping.external_id AS external_account_id,customer_map.external_id AS external_customer_id,
      supplier_map.external_id AS external_supplier_id
    FROM accounting_journal_lines line JOIN accounting_accounts account ON account.id=line.account_id
    LEFT JOIN accounting_posting_account_mappings mapping ON mapping.workspace_id=line.workspace_id
      AND mapping.connector_id=$2 AND mapping.foundry_account_id=line.account_id
    LEFT JOIN accounting_external_identities customer_map ON customer_map.workspace_id=line.workspace_id
      AND customer_map.connector_id=$2 AND customer_map.entity_type='customer'
      AND customer_map.foundry_record_id=line.customer_id
    LEFT JOIN accounting_external_identities supplier_map ON supplier_map.workspace_id=line.workspace_id
      AND supplier_map.connector_id=$2 AND supplier_map.entity_type='supplier'
      AND supplier_map.foundry_record_id=line.supplier_id
    WHERE line.workspace_id=$1 AND line.entry_id=$3 ORDER BY line.line_number`,[workspaceId,connectorId,entryId])).rows;
  const snapshot=(await database.query(`SELECT external_snapshot FROM accounting_shadow_runs
    WHERE workspace_id=$1 AND connector_id=$2 ORDER BY started_at DESC LIMIT 1`,[workspaceId,connectorId])).rows[0];
  const externalCodes=new Map((json(snapshot?.external_snapshot,{}).accounts||[])
    .map((account)=>[String(account.externalId),account.code||account.externalId]));
  return {...header,lines:lines.map((line)=>({...line,debit_minor:Number(line.debit_minor),
    credit_minor:Number(line.credit_minor),account_code:line.external_account_id
      ?externalCodes.get(String(line.external_account_id))||line.account_code:line.account_code}))};
}

async function pendingEntries(database,workspaceId,connectorId){
  const providerType=(await database.query(`SELECT provider_type FROM accounting_sync_policies
    WHERE workspace_id=$1 AND connector_id=$2`,[workspaceId,connectorId])).rows[0]?.provider_type;
  const rows=(await database.query(`SELECT journal.*,
      effect.status AS effect_status,effect.error_message AS effect_error_message
    FROM accounting_journal_entries journal
    LEFT JOIN stockchief_runtime.provider_effects effect ON effect.workspace_id=journal.workspace_id
      AND effect.kind='accounting.journal.export' AND effect.aggregate_id=journal.id
    WHERE journal.workspace_id=$1 AND journal.status='POSTED'
      AND COALESCE(journal.source_record_type,'')<>'accounting_connection_opening'
      AND NOT EXISTS(SELECT 1 FROM accounting_external_identities identity
        WHERE identity.workspace_id=journal.workspace_id AND identity.connector_id=$2
          AND identity.entity_type='journal_entry' AND identity.foundry_record_id=journal.id)
    ORDER BY journal.entry_number LIMIT 100`,[workspaceId,connectorId])).rows;
  const output=[];for(const row of rows){const full=await entry(database,workspaceId,connectorId,row.id);
    output.push({...full,effect_status:row.effect_status,effect_error_message:row.effect_error_message,
      missingAccounts:full.lines.filter((line)=>!line.external_account_id),
      missingParties:providerType==='quickbooks'?full.lines.filter((line)=>(line.customer_id&&!line.external_customer_id)||
        (line.supplier_id&&!line.external_supplier_id)):[]});}return output;
}

async function mapParty(database,ctx,connectorId,input={}){
  const partyType=String(input.partyType||'').toLowerCase();
  if(!['customer','supplier'].includes(partyType))throw new ValidationError('Choose a customer or supplier identity.');
  const partyId=String(input.partyId||'');const externalId=String(input.externalId||'').trim();
  if(!partyId||!externalId)throw new ValidationError('Choose both the StockChief and provider identity.');
  const table=partyType==='customer'?'customers':'suppliers';
  return database.transaction(async(client)=>{
    await policy(client,ctx.workspaceId,connectorId,true);
    const party=(await client.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,partyId])).rows[0];
    if(!party)throw new ValidationError(`That ${partyType} is not available in this inventory.`);
    const occupied=(await client.query(`SELECT foundry_record_id FROM accounting_external_identities
      WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
    [ctx.workspaceId,connectorId,partyType,externalId])).rows[0];
    if(occupied&&occupied.foundry_record_id!==partyId)throw new ValidationError(
      `That provider ${partyType} is already mapped to another StockChief ${partyType}.`);
    const at=nowIso();await client.query(`INSERT INTO accounting_external_identities
      (id,workspace_id,connector_id,entity_type,foundry_record_id,external_id,external_version,payload_hash,
       last_direction,last_seen_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'READ',$9,$9,$9)
      ON CONFLICT(workspace_id,connector_id,entity_type,foundry_record_id) DO UPDATE SET
        external_id=EXCLUDED.external_id,external_version=EXCLUDED.external_version,
        payload_hash=EXCLUDED.payload_hash,last_direction='READ',last_seen_at=EXCLUDED.last_seen_at,
        updated_at=EXCLUDED.updated_at`,[newId('acident'),ctx.workspaceId,connectorId,partyType,partyId,
      externalId,input.version==null?null:String(input.version),hash(input.external||{externalId}),at]);
    return {party,externalId};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function queuePending(database,ctx,connectorId,input={}){
  const current=await policy(database,ctx.workspaceId,connectorId);
  if(current.stage!=='WRITE_ENABLED')throw new ValidationError('Verified posting is not enabled for this accounting connection.');
  const pending=await pendingEntries(database,ctx.workspaceId,connectorId);
  const selected=new Set((input.entryIds||pending.map((row)=>row.id)).map(String));
  const targets=pending.filter((row)=>selected.has(String(row.id))&&!row.effect_status);
  const blocked=targets.filter((row)=>row.missingAccounts.length||row.missingParties.length);
  if(blocked.length)throw new ValidationError(
    'Every journal account and customer or supplier identity must be exactly mapped before export. Nothing was queued.');
  const queued=[];await database.transaction(async(client)=>{for(const journal of targets){
    const effect=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,
      kind:'accounting.journal.export',provider:current.provider_type,aggregateType:'accounting_journal_entry',
      aggregateId:journal.id,idempotencyKey:`accounting-export:${connectorId}:${journal.id}`,
      requestedByUserId:ctx.actorId,payload:{connectorId,journalEntryId:journal.id,actorId:ctx.actorId},
      priority:15,maxAttempts:12});queued.push(effect.effect);}}, {isolation:'SERIALIZABLE',retrySafe:true});
  return {queued:queued.length,effects:queued};
}

async function executeExportEffect(database,workspaceId,effectId,options={}){
  const claimed=await providerEffects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {externalId:claimed.effect.providerReference?.externalId||null,replayed:true};
  const effect=claimed.effect;let providerCalled=false;
  try{
    const connection=await connections.get(database,workspaceId,effect.payload.connectorId);
    const current=await policy(database,workspaceId,connection.id);
    if(current.stage!=='WRITE_ENABLED'||connection.status!=='connected'||connection.paused_at)throw Object.assign(
      new ValidationError('Accounting export is no longer enabled on this connection.'),{status:409});
    const adapter=options.provider||providers.get(connection.provider_type);
    if(!adapter?.postJournalEntry)throw Object.assign(new ValidationError('This provider cannot post governed journals.'),{status:422});
    const credentials=options.credentials||await providerService.loadProviderCredentials(database,connection,adapter);
    const journal=await entry(database,workspaceId,connection.id,effect.payload.journalEntryId);
    if(journal.lines.some((line)=>!line.external_account_id||(connection.provider_type==='quickbooks'&&
      ((line.customer_id&&!line.external_customer_id)||(line.supplier_id&&!line.external_supplier_id)))))throw Object.assign(
      new ValidationError('A journal mapping changed before export. Nothing was posted.'),{status:422});
    providerCalled=true;const result=await adapter.postJournalEntry({credentials,entry:journal,idempotencyKey:effect.idempotencyKey});
    if(!result?.externalId)throw Object.assign(new ValidationError(
      'The accounting provider did not confirm an external journal identity.'),{status:422});
    await providerEffects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:{
      externalId:String(result.externalId),version:result.version==null?null:String(result.version)},result,
    apply:async(client)=>{const at=nowIso();await client.query(`INSERT INTO accounting_external_identities
        (id,workspace_id,connector_id,entity_type,foundry_record_id,external_id,external_version,payload_hash,
         last_direction,last_seen_at,created_at,updated_at)
        VALUES($1,$2,$3,'journal_entry',$4,$5,$6,$7,'WRITE',$8,$8,$8)
        ON CONFLICT(workspace_id,connector_id,entity_type,foundry_record_id) DO NOTHING`,
      [newId('acident'),workspaceId,connection.id,journal.id,String(result.externalId),
        result.version==null?null:String(result.version),hash(journal),at]);
      await client.query(`INSERT INTO accounting_sync_checkpoints
        (id,workspace_id,connector_id,stream,cursor,watermark_at,updated_at)
        VALUES($1,$2,$3,'journal_entries',$4,$5,$5)
        ON CONFLICT(workspace_id,connector_id,stream) DO UPDATE SET cursor=EXCLUDED.cursor,
          watermark_at=EXCLUDED.watermark_at,updated_at=EXCLUDED.updated_at`,
      [newId('accheck'),workspaceId,connection.id,String(journal.entry_number),at]);}});
    return {externalId:String(result.externalId),replayed:false};
  }catch(error){const ambiguous=providerCalled&&!providerEffects.definiteFailure(error);
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous});
    throw Object.assign(error,{code:ambiguous?'accounting_export_ambiguous':(error.code||'accounting_export_failed'),retryable:false});
  }
}

async function state(database,workspaceId,connectorId){
  let current=null;try{current=await policy(database,workspaceId,connectorId);}catch{return null;}
  const [latest,mappings,accounts,pending,posted]=await Promise.all([
    database.query(`SELECT * FROM accounting_shadow_runs WHERE workspace_id=$1 AND connector_id=$2
      ORDER BY started_at DESC LIMIT 1`,[workspaceId,connectorId]),
    database.query(`SELECT mapping.*,account.code AS account_code,account.name AS account_name
      FROM accounting_posting_account_mappings mapping JOIN accounting_accounts account ON account.id=mapping.foundry_account_id
      WHERE mapping.workspace_id=$1 AND mapping.connector_id=$2 ORDER BY account.code`,[workspaceId,connectorId]),
    database.query(`SELECT * FROM accounting_accounts WHERE workspace_id=$1 AND active=1 ORDER BY code`,[workspaceId]),
    pendingEntries(database,workspaceId,connectorId),
    database.query(`SELECT journal.entry_number,journal.description,identity.external_id,identity.last_seen_at
      FROM accounting_external_identities identity JOIN accounting_journal_entries journal ON journal.id=identity.foundry_record_id
      WHERE identity.workspace_id=$1 AND identity.connector_id=$2 AND identity.entity_type='journal_entry'
      ORDER BY journal.entry_number DESC LIMIT 20`,[workspaceId,connectorId]),
  ]);
  const latestRow=latest.rows[0]||null;
  return {policy:current,latestShadow:latestRow?{...latestRow,differences:json(latestRow.differences,[]),
    externalSnapshot:json(latestRow.external_snapshot,{})}:null,mappings:mappings.rows,accounts:accounts.rows,
    pendingEntries:pending,postedEntries:posted.rows};
}

module.exports={hash,policy,initialize,chooseAuthority,localSnapshot,compare,shadow,mapAccount,mapParty,enableWrites,
  entry,pendingEntries,queuePending,executeExportEffect,state};
