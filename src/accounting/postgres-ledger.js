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
  const currency = String(input.currency || 'USD').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('Currency must be a three-letter code.');
  await requireAccountingActor(client,ctx);
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

async function postInTransaction(client, ctx, input) {
  const postingDate=dateOnly(input.postingDate);
  const sourceKey=String(input.sourceKey||'').trim();
  if (!sourceKey) throw new ValidationError('A durable accounting source key is required.');
  const { normalized,total }=normalizeLines(input.lines);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`journal-source:${ctx.workspaceId}:${sourceKey}`]);
    const prior=await client.query(`SELECT * FROM accounting_journal_entries
      WHERE workspace_id=$1 AND source_key=$2`,[ctx.workspaceId,sourceKey]);
    if(prior.rows.length)return { entry:prior.rows[0],replayed:true,totalMinor:total };
    const settings=await client.query(`SELECT * FROM accounting_settings WHERE workspace_id=$1 AND enabled=1`,[ctx.workspaceId]);
    if(!settings.rows.length)throw new ValidationError('Configure accounting before posting entries.');
    if(postingDate<settings.rows[0].accounting_start_date)throw new ValidationError('Posting date is before the accounting start date.');
    const period=await ensurePeriod(client,ctx.workspaceId,postingDate);
    const keys=[...new Set(normalized.map((line)=>line.accountKey).filter(Boolean))];
    const ids=[...new Set(normalized.map((line)=>line.accountId).filter(Boolean))];
    const accounts=await client.query(`SELECT id,system_key FROM accounting_accounts
      WHERE workspace_id=$1 AND active=1 AND (system_key=ANY($2::text[]) OR id=ANY($3::text[]))`,[ctx.workspaceId,keys,ids]);
    const byKey=new Map(accounts.rows.map((row)=>[row.system_key,row.id]));
    const byId=new Set(accounts.rows.map((row)=>row.id));
    if(keys.some((key)=>!byKey.has(key))||ids.some((id)=>!byId.has(id))||normalized.some((line)=>!line.accountKey&&!line.accountId))
      throw new ValidationError('One or more accounting control accounts are missing or inactive.');
    const at=nowIso(); const id=newId('je');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`journal:${ctx.workspaceId}`]);
    const count=await client.query(`SELECT COUNT(*) AS count FROM accounting_journal_entries WHERE workspace_id=$1`,[ctx.workspaceId]);
    const entryNumber=Number(count.rows[0].count)+1;
    await client.query(`INSERT INTO accounting_journal_entries
      (id,workspace_id,entry_number,posting_date,period_id,description,status,source_type,source_record_type,
       source_record_id,source_event_id,source_key,created_by_type,created_by_user_id,engine_version,metadata,
       reversal_of_entry_id,created_at,posted_at)
      VALUES($1,$2,$3,$4,$5,$6,'POSTED',$7,$8,$9,$10,$11,$12,$13,'accounting-postgres-v1',$14,$15,$16,$16)`,
    [id,ctx.workspaceId,entryNumber,postingDate,period.id,String(input.description||'Business event'),
      input.sourceType||'business_event',input.sourceRecordType||null,input.sourceRecordId||null,input.sourceEventId||null,
      sourceKey,input.createdByType||'SYSTEM',ctx.actorId||null,JSON.stringify(input.metadata||{}),input.reversalOfEntryId||null,at]);
    for(const [index,line] of normalized.entries()){
      await client.query(`INSERT INTO accounting_journal_lines
        (id,workspace_id,entry_id,line_number,account_id,debit_minor,credit_minor,currency,customer_id,supplier_id,
         item_id,sku_id,location_id,memo,metadata,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [newId('jel'),ctx.workspaceId,id,index+1,line.accountId||byKey.get(line.accountKey),line.debit,line.credit,
        input.currency||settings.rows[0].base_currency,line.customerId||null,line.supplierId||null,line.itemId||null,
        line.skuId||null,line.locationId||null,line.memo||null,JSON.stringify(line.metadata||{}),at]);
    }
  return { entry:{ id,entry_number:entryNumber,posting_date:postingDate,source_key:sourceKey,status:'POSTED' },replayed:false,totalMinor:total };
}

async function post(database,ctx,input){
  return database.transaction((client)=>postInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={ configure,configureInTransaction,post,postInTransaction };
