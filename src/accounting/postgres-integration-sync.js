'use strict';

const crypto=require('node:crypto');
const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const reports=require('./postgres-reports');
const connections=require('../connections/postgres-service');
const providerService=require('../connections/postgres-provider-service');
const providers=require('../connections/providers/registry');
const providerEffects=require('../operations/postgres-provider-effects');
const commercialUsage=require('../entitlements/postgres-service');
const commercialControl=require('../commercial/control-service');

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
  if(!['OBSERVE','SHADOW','POST'].includes(requested))throw new ValidationError('Choose observe, shadow comparison or governed posting authority.');
  return database.transaction(async(client)=>{
    await policy(client,ctx.workspaceId,connectorId,true);
    const connection=(await client.query(`SELECT * FROM workspace_connectors
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,connectorId])).rows[0];
    if(!connection||!['quickbooks','xero'].includes(connection.provider_type))throw new ValidationError(
      'Choose a connected QuickBooks or Xero account.');
    const at=nowIso();const post=requested==='POST';
    await client.query(`UPDATE accounting_sync_policies SET accounting_source='FOUNDRY',posting_direction=$3,
      requested_authority=$4,stage=$5,last_shadow_run_id=NULL,write_enabled_by_user_id=NULL,write_enabled_at=NULL,updated_at=$6
      WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId,
      post?'FOUNDRY_TO_EXTERNAL':'READ_ONLY',requested,requested==='OBSERVE'?'READ_ONLY_VERIFIED':'SHADOW',at]);
    await client.query(`UPDATE workspace_connectors SET setup_status=$3,updated_at=$4
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,connectorId,requested==='OBSERVE'?'READ_ONLY_ACTIVE':'SHADOW_PENDING',at]);
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
  const mappedExternal=new Set(mappedByLocal.values());
  for(const account of external.accounts||[]){
    if(!mappedExternal.has(String(account.externalId))&&Number(account.balanceMinor)!==0)differences.push({
      kind:'UNMAPPED_EXTERNAL_ACCOUNT',externalId:String(account.externalId),externalMinor:Number(account.balanceMinor)});
  }
  if(!external.currency||!local.currency||external.currency!==local.currency)differences.push({kind:'CURRENCY_MISMATCH',
    foundry:local.currency,external:external.currency});
  return differences;
}

async function shadow(database,ctx,connectorId,adapter,credentials,input={}){
  const current=await policy(database,ctx.workspaceId,connectorId);
  if(!['SHADOW','POST'].includes(current.requested_authority))throw new ValidationError('Choose shadow comparison or governed posting before comparing the books.');
  if(!adapter?.readAccountingSnapshot)throw new ValidationError('This provider cannot supply a certified accounting snapshot.');
  const asOf=input.asOf||new Date().toISOString().slice(0,10);const runId=newId('acshadow');const started=nowIso();
  await database.query(`INSERT INTO accounting_shadow_runs
    (id,workspace_id,connector_id,status,as_of,local_snapshot,external_snapshot,started_at)
    VALUES($1,$2,$3,'RUNNING',$4,'{}','{}',$5)`,[runId,ctx.workspaceId,connectorId,asOf,started]);
  try{
    const [local,external,mappings]=await Promise.all([localSnapshot(database,ctx.workspaceId,asOf),
      require('../commercial/operations').run(database,ctx.workspaceId,{capability:'accounting.sync',key:`accounting-shadow:${runId}`,
        provider:adapter.metadata().id||'accounting',operation:'accounting_snapshot'},async()=>adapter.readAccountingSnapshot({credentials,
          connection:await connections.get(database,ctx.workspaceId,connectorId),asOf})),
      database.query(`SELECT * FROM accounting_posting_account_mappings
        WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId])]);
    const differences=compare(local,external,mappings.rows);const status=differences.length?'MISMATCH':'MATCHED';const at=nowIso();
    await database.transaction(async(client)=>{
      const latest=await policy(client,ctx.workspaceId,connectorId,true);
      if(latest.updated_at!==current.updated_at||latest.requested_authority!==current.requested_authority){
        throw new ValidationError('Accounting authority or mappings changed during comparison. Run the comparison again; nothing was posted.');
      }
      const ready=status==='MATCHED'&&latest.requested_authority==='POST';
      await client.query(`UPDATE accounting_shadow_runs SET status=$2,local_snapshot=$3,external_snapshot=$4,
        differences=$5,completed_at=$6 WHERE id=$1`,[runId,status,JSON.stringify(local),JSON.stringify(external),
        JSON.stringify(differences),at]);
      await client.query(`UPDATE accounting_sync_policies SET last_shadow_run_id=$3,stage=$4,
        write_enabled_by_user_id=NULL,write_enabled_at=NULL,updated_at=$5
        WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connectorId,runId,ready?'WRITE_READY':status==='MATCHED'?'READ_ONLY_VERIFIED':'SHADOW',at]);
      await client.query(`UPDATE workspace_connectors SET setup_status=$3,last_synced_at=$4,last_activity_at=$4,
        updated_at=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,connectorId,ready?'WRITE_READY':status==='MATCHED'?'READ_ONLY_ACTIVE':'SHADOW_MISMATCH',at]);
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
    await client.query(`UPDATE accounting_sync_policies SET last_shadow_run_id=NULL,
      stage=CASE WHEN requested_authority='OBSERVE' THEN 'READ_ONLY_VERIFIED' ELSE 'SHADOW' END,
      write_enabled_by_user_id=NULL,write_enabled_at=NULL,updated_at=$3 WHERE workspace_id=$1 AND connector_id=$2`,
    [ctx.workspaceId,connectorId,at]);
    await client.query(`UPDATE workspace_connectors SET setup_status=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,connectorId,'SHADOW_PENDING',at]);
    return {account,external};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function enableWrites(database,ctx,connectorId){return database.transaction(async(client)=>{
  const current=await policy(client,ctx.workspaceId,connectorId,true);
  const connection=(await client.query(`SELECT * FROM workspace_connectors
    WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,connectorId])).rows[0];
  const capabilities=json(connection?.capabilities,[]);
  if(!providers.get(connection?.provider_type)?.verifyJournalEntry)throw new ValidationError('Posting is unavailable for this connection. Read-only accounting remains available.');
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
  const currencies=[...new Set(lines.map(line=>require('../domain/currency').code(line.currency)))];
  if(currencies.length!==1)throw new ValidationError('A journal with missing or mixed currencies requires reconciliation before export.');
  return {...header,currency:currencies[0],lines:lines.map((line)=>({...line,debit_minor:Number(line.debit_minor),
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
  if(!providers.get(current.provider_type)?.verifyJournalEntry)throw new ValidationError('Posting is unavailable for this connection. Read-only accounting remains available.');
  const pending=await pendingEntries(database,ctx.workspaceId,connectorId);
  const selected=new Set((input.entryIds||pending.map((row)=>row.id)).map(String));
  const targets=pending.filter((row)=>selected.has(String(row.id))&&!row.effect_status);
  const blocked=targets.filter((row)=>row.missingAccounts.length||row.missingParties.length);
  if(blocked.length)throw new ValidationError(
    'Every journal account and customer or supplier identity must be exactly mapped before export. Nothing was queued.');
  const queued=[];await database.transaction(async(client)=>{
    const account=(await client.query("SELECT provider_account_id,status,paused_at FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[ctx.workspaceId,connectorId])).rows[0];
    if(!account?.provider_account_id||account.status!=='connected'||account.paused_at)throw new ValidationError('Reconnect the accounting company before queueing exports.');
    for(const journal of targets){
    const effect=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,
      kind:'accounting.journal.export',provider:current.provider_type,aggregateType:'accounting_journal_entry',
      aggregateId:journal.id,idempotencyKey:`accounting-export:${connectorId}:${journal.id}`,
      requestedByUserId:ctx.actorId,payload:{connectorId,journalEntryId:journal.id,actorId:ctx.actorId,providerAccountId:account.provider_account_id},
      priority:15,maxAttempts:12});queued.push(effect.effect);}}, {isolation:'SERIALIZABLE',retrySafe:true});
  return {queued:queued.length,effects:queued};
}

async function executeExportEffect(database,workspaceId,effectId,options={}){
  await require('../commercial/enforcement').workspace(database,workspaceId,'accounting.post_connected');
  const claimed=await providerEffects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {externalId:claimed.effect.providerReference?.externalId||null,replayed:true};
  const effect=claimed.effect;let providerCalled=false,postReturned=false;
  try{
    const connection=await connections.get(database,workspaceId,effect.payload.connectorId);
    if(!effect.payload.providerAccountId||effect.payload.providerAccountId!==connection.provider_account_id)throw new ValidationError('The accounting company changed after this export was queued. Nothing was posted.');
    const current=await policy(database,workspaceId,connection.id);
    if(current.stage!=='WRITE_ENABLED'||connection.status!=='connected'||connection.paused_at)throw Object.assign(
      new ValidationError('Accounting export is no longer enabled on this connection.'),{status:409});
    const adapter=options.provider||providers.get(connection.provider_type);
    if(!adapter?.postJournalEntry||!adapter.verifyJournalEntry)throw Object.assign(new ValidationError('This provider has not been qualified to post and independently verify governed journals.'),{status:422});
    const credentials=options.credentials||await providerService.loadProviderCredentials(database,connection,adapter);
    const journal=await entry(database,workspaceId,connection.id,effect.payload.journalEntryId);
    if(journal.lines.some((line)=>!line.external_account_id||(connection.provider_type==='quickbooks'&&
      ((line.customer_id&&!line.external_customer_id)||(line.supplier_id&&!line.external_supplier_id)))))throw Object.assign(
      new ValidationError('A journal mapping changed before export. Nothing was posted.'),{status:422});
    const usageScope=await commercialUsage.ownerScopeForWorkspace(database,workspaceId);
    const reservation=await commercialUsage.reserveUsage(database,usageScope,{meter:'accounting_syncs',units:1,idempotencyKey:effect.idempotencyKey,
      detail:{operation:'journal_export',journalEntryId:journal.id}});
    if(!reservation.created)throw new ValidationError('This export has existing usage evidence and requires reconciliation before another provider call.');
    providerCalled=true;let result;
    try{result=await require('../commercial/context').run({...require('../commercial/context').current(),
      database,scope:usageScope,funded:true,requestId:effect.idempotencyKey},
      async()=>{
       const posted=await adapter.postJournalEntry({credentials,entry:journal,idempotencyKey:effect.idempotencyKey});
       postReturned=true;
       if(!posted?.externalId)throw new ValidationError('The accounting provider did not confirm a journal identity.');
       await providerEffects.checkpoint(database,workspaceId,effectId,effect.claimToken,{externalId:String(posted.externalId),version:posted.version??null,providerAccountId:connection.provider_account_id,verificationPending:true,journalSnapshot:journal,journalCoreHash:hash(journalCore(journal))});
       const verification=await adapter.verifyJournalEntry({credentials,entry:journal,externalId:posted.externalId});
       if(verification?.verified!==true||String(verification.externalId)!==String(posted.externalId))throw new ValidationError('The posted accounting journal has not been independently verified.');
       return {...posted,verification};
      });}
    finally{const owner=(await database.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0];
      if(owner?.owner_account_id)await commercialControl.recordCost(database,{accountId:owner.owner_account_id,workspaceId},{
        provider:connection.provider_type||'accounting_provider',operation:'journal_export',unit:'journal',quantity:1,
        idempotencyKey:`${effect.idempotencyKey}:attempt:${effect.claimToken}`,occurredAt:nowIso(),
        detail:{connectorId:connection.id,journalEntryId:journal.id}});}
    if(!result?.externalId)throw Object.assign(new ValidationError(
      'The accounting provider did not confirm an external journal identity.'),{status:422});
    await completeVerifiedExport(database,workspaceId,effect,connection,journal,result);
    return {externalId:String(result.externalId),replayed:false};
  }catch(error){const ambiguous=postReturned||providerCalled&&!providerEffects.definiteFailure(error);
    if(!ambiguous)await commercialUsage.reverseUsage(database,await commercialUsage.ownerScopeForWorkspace(database,workspaceId),
      {meter:'accounting_syncs',idempotencyKey:effect.idempotencyKey,reason:error.message});
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous});
    throw Object.assign(error,{code:ambiguous?'accounting_export_ambiguous':(error.code||'accounting_export_failed'),retryable:false});
  }
}

async function completeVerifiedExport(database,workspaceId,effect,connection,journal,result){
 const effectId=effect.id;
    await providerEffects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:{
      externalId:String(result.externalId),version:result.version==null?null:String(result.version),providerAccountId:connection.provider_account_id,journalSnapshot:journal,journalCoreHash:hash(journalCore(journal)),verificationPending:false},result,
    apply:async(client)=>{
      const current=(await client.query('SELECT provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,connection.id])).rows[0];
      if(current?.provider_account_id!==connection.provider_account_id)throw new ValidationError('The accounting company changed before verification settled. The original provider identity is retained.');
      const prior=(await client.query("SELECT external_id FROM accounting_external_identities WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='journal_entry' AND foundry_record_id=$3 FOR UPDATE",[workspaceId,connection.id,journal.id])).rows[0];
      if(prior&&prior.external_id!==String(result.externalId))throw new ValidationError('This journal already has a different provider identity. Reconcile the retained results before continuing.');
      const at=nowIso();await client.query(`INSERT INTO accounting_external_identities
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
      [newId('accheck'),workspaceId,connection.id,String(journal.entry_number),at]);
      const owner=(await client.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0];
      if(owner?.owner_account_id){const scope={accountId:owner.owner_account_id,workspaceId};
        await commercialUsage.commitUsage(client,scope,{meter:'accounting_syncs',
          idempotencyKey:effect.idempotencyKey,occurredAt:at,detail:{operation:'journal_export',connectorId:connection.id,journalEntryId:journal.id}});}},
    after:client=>require('../operations/postgres-job-queue').reconcileVerifiedEffectWithin(client,workspaceId,effect.id)});
}
function journalCore(journal){return {id:journal.id,workspaceId:journal.workspace_id,date:journal.posting_date,source:journal.source_key,currency:journal.currency,lines:journal.lines.map(l=>({id:l.id,account:l.account_id,debit:Number(l.debit_minor),credit:Number(l.credit_minor),currency:l.currency,customer:l.customer_id,supplier:l.supplier_id,item:l.item_id,sku:l.sku_id,location:l.location_id}))};}
async function verifyExistingExport(database,ctx,effectId){
 const actor=(await database.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(actor?.role!=='owner')throw new(require('../domain/errors').AuthorizationError)('Only an owner can verify an external accounting outcome.');
 const held=await providerEffects.claimVerification(database,ctx.workspaceId,effectId,'accounting.journal.export');if(held.replayed)return {verified:true,replayed:true};
 const effect=held.effect;
 try{
  const connection=await connections.get(database,ctx.workspaceId,effect.payload.connectorId),snapshot=effect.providerReference?.journalSnapshot,canonical=await entry(database,ctx.workspaceId,connection.id,effect.payload.journalEntryId);
  if(!effect.providerReference?.providerAccountId||effect.providerReference.providerAccountId!==connection.provider_account_id)throw new ValidationError('Reconnect the original accounting company before verifying this recorded operation.');
  if(!snapshot||snapshot.id!==effect.aggregateId||snapshot.workspace_id!==ctx.workspaceId||hash(journalCore(snapshot))!==effect.providerReference.journalCoreHash||hash(journalCore(canonical))!==effect.providerReference.journalCoreHash)throw new ValidationError('The retained accounting evidence requires reconciliation before verification. No journal was resent.');
  const adapter=providers.get(connection.provider_type);if(!adapter?.verifyJournalEntry)throw new ValidationError('This provider does not support independent journal verification.');
  const verification=await require('../commercial/operations').run(database,ctx.workspaceId,{capability:'connections.accounting',provider:connection.provider_type,operation:'accounting_verify',key:'accounting-verify:'+effect.id+':'+effect.claimToken},async()=>{const credentials=await providerService.loadProviderCredentials(database,connection,adapter);return adapter.verifyJournalEntry({credentials,entry:snapshot,externalId:effect.providerReference.externalId});});
  if(verification?.verified!==true||String(verification.externalId)!==effect.providerReference.externalId)throw new ValidationError('The accounting journal could not be verified.');
  const result={externalId:effect.providerReference.externalId,version:verification.version??effect.providerReference.version,verification};
  await completeVerifiedExport(database,ctx.workspaceId,effect,connection,snapshot,result);
  return {verified:true,replayed:false,externalId:result.externalId};
 }catch(error){await providerEffects.finishError(database,ctx.workspaceId,effectId,effect.claimToken,error,{ambiguous:true});throw error;}
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
  return {policy:current,canVerifyWrites:typeof providers.get(current.provider_type)?.verifyJournalEntry==='function',latestShadow:latestRow?{...latestRow,isCurrent:current.last_shadow_run_id===latestRow.id,differences:json(latestRow.differences,[]),
    externalSnapshot:json(latestRow.external_snapshot,{})}:null,mappings:mappings.rows,accounts:accounts.rows,
    pendingEntries:pending,postedEntries:posted.rows};
}

module.exports={hash,policy,initialize,chooseAuthority,localSnapshot,compare,shadow,mapAccount,mapParty,enableWrites,
  entry,pendingEntries,queuePending,executeExportEffect,verifyExistingExport,state};
require('../commercial/enforcement').guardExports(module.exports,0,1,{chooseAuthority:'connections.accounting',
 enableWrites:'accounting.post_connected',queuePending:'accounting.post_connected',executeExportEffect:'accounting.post_connected',verifyExistingExport:'connections.accounting',shadow:'accounting.sync'});
