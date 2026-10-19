'use strict';

const { DEFAULT_ACCOUNTS } = require('./chart');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, AuthorizationError } = require('../domain/errors');

function dateOnly(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw new ValidationError('Posting date must be a valid date in YYYY-MM-DD format.');
  }
  return text;
}

function monthBounds(date) {
  const [year, month] = date.split('-').map(Number);
  return { start:`${date.slice(0,7)}-01`, end:new Date(Date.UTC(year,month,0)).toISOString().slice(0,10) };
}

async function requireAccountingActor(client, ctx) {
  await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'accounting.core');
  const result = await client.query(`SELECT role FROM users WHERE id=$1 AND workspace_id=$2`, [ctx.actorId,ctx.workspaceId]);
  if (!result.rows.length || !['owner','accountant'].includes(result.rows[0].role)) {
    throw new AuthorizationError('Only an owner or accountant can change the books.');
  }
}

async function ensurePeriod(client, workspaceId, date) {
  const existing = await client.query(`SELECT * FROM accounting_periods WHERE workspace_id=$1
    AND starts_on <= $2 AND ends_on >= $2 ORDER BY starts_on DESC LIMIT 1 FOR UPDATE`, [workspaceId,date]);
  if (existing.rows.length) {
    if (existing.rows[0].status !== 'OPEN') throw new ValidationError(`The accounting period ending ${existing.rows[0].ends_on} is closed.`);
    return existing.rows[0];
  }
  const bounds = monthBounds(date);
  const period = { id:newId('period'), starts_on:bounds.start, ends_on:bounds.end, status:'OPEN' };
  await client.query(`INSERT INTO accounting_periods(id,workspace_id,starts_on,ends_on,status,created_at)
    VALUES($1,$2,$3,$4,'OPEN',$5)`, [period.id,workspaceId,bounds.start,bounds.end,nowIso()]);
  return period;
}

async function configureInTransaction(client, ctx, input) {
  const startDate = dateOnly(input.startDate);
  const currency = require('../domain/currency').code(input.currency||'USD');
  await requireAccountingActor(client,ctx);
  const existing=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId])).rows[0];
  if(existing&&existing.base_currency!==currency){
    const history=(await client.query("SELECT EXISTS(SELECT 1 FROM accounting_journal_entries WHERE workspace_id=$1) OR EXISTS(SELECT 1 FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND (quantity_units<>0 OR total_cost_minor<>0)) AS exists",[ctx.workspaceId])).rows[0];
    if(history.exists)throw new ValidationError('The accounting currency cannot change after journals or inventory values have been recorded. A governed currency conversion is required.');
  }
  const at = nowIso();
  await client.query(`INSERT INTO accounting_settings
      (workspace_id,enabled,accounting_start_date,base_currency,costing_method,configured_by_user_id,configured_at,updated_at)
      VALUES($1,1,$2,$3,'WEIGHTED_AVERAGE',$4,$5,$5)
      ON CONFLICT(workspace_id) DO UPDATE SET enabled=1,accounting_start_date=EXCLUDED.accounting_start_date,
        base_currency=EXCLUDED.base_currency,configured_by_user_id=EXCLUDED.configured_by_user_id,
        configured_at=COALESCE(accounting_settings.configured_at,EXCLUDED.configured_at),updated_at=EXCLUDED.updated_at`,
  [ctx.workspaceId,startDate,currency,ctx.actorId,at]);
  for (const account of DEFAULT_ACCOUNTS) {
    await client.query(`INSERT INTO accounting_accounts
        (id,workspace_id,code,name,account_type,subtype,normal_balance,system_key,is_control,active,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$10) ON CONFLICT(workspace_id,code) DO NOTHING`,
    [newId('acct'),ctx.workspaceId,account.code,account.name,account.type,account.subtype,account.normal,
      account.systemKey,account.control?1:0,at]);
  }
  await ensurePeriod(client,ctx.workspaceId,startDate);
  return { workspaceId:ctx.workspaceId, enabled:true, startDate, currency, costingMethod:'WEIGHTED_AVERAGE' };
}

async function configure(database, ctx, input) {
  return database.transaction(async (client) => {
    return configureInTransaction(client, ctx, input);
  }, { isolation:'SERIALIZABLE', retrySafe:true });
}

async function createAccountInTransaction(client,ctx,input){
  await requireAccountingActor(client,ctx);
  const code=require('../lib/util').requireText(input.code,'Account code',{max:30});
  const name=require('../lib/util').requireText(input.name,'Account name',{max:120});
  const type=String(input.type||'').toUpperCase();
  if(!['ASSET','LIABILITY','EQUITY','INCOME','EXPENSE','COGS'].includes(type))throw new ValidationError('Choose a valid account type.');
  const normal=String(input.normalBalance||(['ASSET','EXPENSE','COGS'].includes(type)?'DEBIT':'CREDIT')).toUpperCase();
  if(!['DEBIT','CREDIT'].includes(normal))throw new ValidationError('Normal balance must be debit or credit.');
  const at=nowIso(),id=newId('acct');
  const row=(await client.query(`INSERT INTO accounting_accounts
    (id,workspace_id,code,name,account_type,subtype,normal_balance,system_key,is_control,active,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,NULL,0,1,$8,$8) ON CONFLICT(workspace_id,code) DO NOTHING RETURNING *`,
    [id,ctx.workspaceId,code,name,type,input.subtype||null,normal,at])).rows[0];
  if(!row)throw new ValidationError('That account code is already in use.');
  return row;
}

async function createAccount(database,ctx,input){return database.transaction(
  client=>createAccountInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:true});}

function normalizeLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) throw new ValidationError('A journal entry needs at least two lines.');
  let debits=0; let credits=0;
  const normalized=lines.map((line) => {
    const debit=Number(line.debitMinor||0); const credit=Number(line.creditMinor||0);
    if (!Number.isSafeInteger(debit)||!Number.isSafeInteger(credit)||debit<0||credit<0||(!debit&&!credit)||(debit&&credit)) {
      throw new ValidationError('Each journal line needs one positive debit or credit amount.');
    }
    debits+=debit; credits+=credit;
    return { ...line,debit,credit };
  });
  if (debits!==credits) throw new ValidationError(`Journal entry is not balanced: debits ${debits}, credits ${credits}.`);
  return { normalized,total:debits };
}

async function postManyInTransaction(client,ctx,inputs){
  if(!Array.isArray(inputs))throw new ValidationError('Journal entries must be a list.');
  if(!inputs.length)return [];
  if(!(ctx.verifiedProviderReceipt&&inputs.every(input=>['customer_payment','customer_deposit'].includes(input.sourceType))))
    await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'accounting.core');
  const prepared=inputs.map(input=>{const postingDate=dateOnly(input.postingDate),sourceKey=String(input.sourceKey||'').trim();
    if(!sourceKey)throw new ValidationError('A durable accounting source key is required.');
    return {input,postingDate,sourceKey,...normalizeLines(input.lines)};});
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`journal:${ctx.workspaceId}`]);
  const sourceKeys=[...new Set(prepared.map(row=>row.sourceKey))],prior=(await client.query('SELECT * FROM accounting_journal_entries WHERE workspace_id=$1 AND source_key=ANY($2::text[])',[ctx.workspaceId,sourceKeys])).rows;
  const entries=new Map(prior.map(entry=>[entry.source_key,entry])),fresh=new Map();
  for(const row of prepared)if(!entries.has(row.sourceKey)&&!fresh.has(row.sourceKey))fresh.set(row.sourceKey,row);
  const rows=[...fresh.values()];
  if(rows.length){
    const settings=(await client.query('SELECT * FROM accounting_settings WHERE workspace_id=$1 AND enabled=1 FOR SHARE',[ctx.workspaceId])).rows[0];
    if(!settings)throw new ValidationError('Configure accounting before posting entries.');
    const periods=new Map();
    for(const row of rows){row.currency=require('../domain/currency').code(row.input.currency||settings.base_currency);
      if(row.currency!==settings.base_currency)throw new ValidationError('This transaction uses '+row.currency+' but the accounting books use '+settings.base_currency+'. A verified currency conversion is required before posting; no foreign amount was relabelled.');
      if(row.postingDate<settings.accounting_start_date)throw new ValidationError('Posting date is before the accounting start date.');
      if(!periods.has(row.postingDate))periods.set(row.postingDate,await ensurePeriod(client,ctx.workspaceId,row.postingDate));
    }
    const allLines=rows.flatMap(row=>row.normalized),keys=[...new Set(allLines.map(line=>line.accountKey).filter(Boolean))],ids=[...new Set(allLines.map(line=>line.accountId).filter(Boolean))];
    const accounts=(await client.query('SELECT id,system_key FROM accounting_accounts WHERE workspace_id=$1 AND active=1 AND (system_key=ANY($2::text[]) OR id=ANY($3::text[]))',[ctx.workspaceId,keys,ids])).rows;
    const byKey=new Map(accounts.map(row=>[row.system_key,row.id])),byId=new Set(accounts.map(row=>row.id));
    if(keys.some(key=>!byKey.has(key))||ids.some(id=>!byId.has(id))||allLines.some(line=>!line.accountKey&&!line.accountId))throw new ValidationError('One or more accounting control accounts are missing or inactive.');
    const firstNumber=Number((await client.query('SELECT COALESCE(MAX(entry_number),0)+1 AS next FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].next),at=nowIso(),journalRows=[],journalLines=[];
    for(const [index,row]of rows.entries()){
      const input=row.input,id=newId('je'),entry={id,entry_number:firstNumber+index,posting_date:row.postingDate,source_key:row.sourceKey,status:'POSTED'};entries.set(row.sourceKey,entry);
      journalRows.push({...entry,period_id:periods.get(row.postingDate).id,description:String(input.description||'Business event'),source_type:input.sourceType||'business_event',source_record_type:input.sourceRecordType||null,source_record_id:input.sourceRecordId||null,source_event_id:input.sourceEventId||null,created_by_type:input.createdByType||'SYSTEM',metadata:JSON.stringify(input.metadata||{}),reversal_of_entry_id:input.reversalOfEntryId||null});
      for(const [position,line]of row.normalized.entries())journalLines.push({id:newId('jel'),entry_id:id,line_number:position+1,account_id:line.accountId||byKey.get(line.accountKey),debit_minor:line.debit,credit_minor:line.credit,currency:row.currency,customer_id:line.customerId||null,supplier_id:line.supplierId||null,item_id:line.itemId||null,sku_id:line.skuId||null,location_id:line.locationId||null,memo:line.memo||null,metadata:JSON.stringify(line.metadata||{})});
    }
    await client.query(`INSERT INTO accounting_journal_entries(id,workspace_id,entry_number,posting_date,period_id,description,status,source_type,source_record_type,source_record_id,source_event_id,source_key,created_by_type,created_by_user_id,engine_version,metadata,reversal_of_entry_id,created_at,posted_at)
      SELECT x.id,$1,x.entry_number,x.posting_date,x.period_id,x.description,'POSTED',x.source_type,x.source_record_type,x.source_record_id,x.source_event_id,x.source_key,x.created_by_type,$2,'accounting-postgres-v1',x.metadata,x.reversal_of_entry_id,$3,$3
      FROM jsonb_to_recordset($4::jsonb) AS x(id text,entry_number bigint,posting_date text,period_id text,description text,source_type text,source_record_type text,source_record_id text,source_event_id text,source_key text,created_by_type text,metadata text,reversal_of_entry_id text)`,[ctx.workspaceId,ctx.actorId||null,at,JSON.stringify(journalRows)]);
    await client.query(`INSERT INTO accounting_journal_lines(id,workspace_id,entry_id,line_number,account_id,debit_minor,credit_minor,currency,customer_id,supplier_id,item_id,sku_id,location_id,memo,metadata,created_at)
      SELECT x.id,$1,x.entry_id,x.line_number,x.account_id,x.debit_minor,x.credit_minor,x.currency,x.customer_id,x.supplier_id,x.item_id,x.sku_id,x.location_id,x.memo,x.metadata,$2
      FROM jsonb_to_recordset($3::jsonb) AS x(id text,entry_id text,line_number bigint,account_id text,debit_minor bigint,credit_minor bigint,currency text,customer_id text,supplier_id text,item_id text,sku_id text,location_id text,memo text,metadata text)`,[ctx.workspaceId,at,JSON.stringify(journalLines)]);
  }
  const seen=new Set(prior.map(entry=>entry.source_key));
  return prepared.map(row=>{const replayed=seen.has(row.sourceKey);seen.add(row.sourceKey);return {entry:entries.get(row.sourceKey),replayed,totalMinor:row.total};});
}

async function postInTransaction(client,ctx,input){return (await postManyInTransaction(client,ctx,[input]))[0];}
async function post(database,ctx,input){
  return database.transaction((client)=>postInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:true});
}

// Zero-value inventory events still require configured books and an open
// period. They do not create fictitious zero-amount journal lines.
async function validatePostingDateInTransaction(client,ctx,value){
 await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'accounting.core');
 const date=dateOnly(value),settings=(await client.query('SELECT accounting_start_date FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 if(!settings)throw new ValidationError('Configure accounting before posting inventory value.');
 if(date<settings.accounting_start_date)throw new ValidationError('Posting date is before the accounting start date.');
 return ensurePeriod(client,ctx.workspaceId,date);
}
module.exports={ configure,configureInTransaction,createAccount,createAccountInTransaction,post,postInTransaction,postManyInTransaction,validatePostingDateInTransaction };
