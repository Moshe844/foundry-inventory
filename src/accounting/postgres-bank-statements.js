'use strict';

const crypto=require('node:crypto');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso,trimOrNull}=require('../lib/util');
const {parseDelimited,detectDelimiter}=require('../imports/parser');
const {sourceAmount,parse:parseRemittance}=require('./bank-remittance');
const money=require('../domain/currency');
const MAX_BYTES=require('../config').uploads.maxBytes;
const aliases={
  date:['date','transactiondate','effectivedate'],
  postedDate:['postingdate','posteddate','valuedate'],
  description:['description','memo','details','narrative','transactiondescription'],
  counterparty:['payee','counterparty','name'],
  amount:['amount','transactionamount','netamount','signedamount'],
  credit:['credit','credits','creditamount','moneyin','deposit','deposits'],
  debit:['debit','debits','debitamount','moneyout','withdrawal','withdrawals'],
  externalId:['transactionid','banktransactionid','externalid','bankid','uniqueid','fitid','traceid'],
  reference:['reference','paymentreference','invoicenumber','invoicereference','remittancereference'],
  remittance:['remittance','remittanceallocation','remittanceallocations','invoiceallocations','invoices'],
  currency:['currency','currencycode'],
};
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const shape=row=>row.map(value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,''));

function text(bytes) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw new ValidationError('Choose a complete supported bank statement export.');
  const encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';
  try{return new TextDecoder(encoding,{fatal:true}).decode(bytes);}
  catch{throw new ValidationError('Export the bank statement as UTF-8 or UTF-16 delimited text.');}
}

function date(value,format) {
  let result=String(value||'').trim();
  if(format!=='ISO'&&!/^\d{4}-\d{2}-\d{2}$/.test(result)){
    const parts=/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(result);
    if(parts){
      const [month,day]=format==='MDY'?[parts[1],parts[2]]:[parts[2],parts[1]];
      result=parts[3]+'-'+month.padStart(2,'0')+'-'+day.padStart(2,'0');
    }
  }
  const instant=Date.parse(result+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(result)||!Number.isFinite(instant)||new Date(instant).toISOString().slice(0,10)!==result) {
    throw new ValidationError('A statement date does not match the selected date format.');
  }
  return result;
}

function columns(header) {
  const normalized=shape(header);
  const mapping={};
  for(const [field,names] of Object.entries(aliases)){
    const matches=normalized.flatMap((name,index)=>names.includes(name)?[index]:[]);
    if(matches.length>1)throw new ValidationError('The statement has more than one '+field+' column.');
    if(matches.length===1)mapping[field]=matches[0];
  }
  if(mapping.date===undefined&&mapping.postedDate===undefined||mapping.description===undefined&&mapping.counterparty===undefined)return null;
  if(mapping.amount===undefined&&mapping.debit===undefined&&mapping.credit===undefined)return null;
  if(mapping.amount!==undefined&&(mapping.debit!==undefined||mapping.credit!==undefined)) {
    throw new ValidationError('Use either the signed Amount column or separate Debit and Credit columns.');
  }
  return mapping;
}

function parse(bytes,currency,dateFormat='ISO') {
  if(!['ISO','MDY','DMY'].includes(dateFormat))throw new ValidationError('Choose the date format used in the statement.');
  const content=text(bytes);
  let rows;
  try{rows=parseDelimited(content,detectDelimiter(content));}
  catch(error){throw new ValidationError(error.message);}
  let headerIndex=-1,mapping=null;
  for(let index=0;index<rows.length;index++){
    mapping=columns(rows[index]);
    if(mapping){headerIndex=index;break;}
  }
  if(headerIndex<0)throw new ValidationError('Use a statement with Date, Description and Amount, or Debit and Credit columns.');
  const header=shape(rows[headerIndex]).join('|'), result=[];
  for(let index=headerIndex+1;index<rows.length;index++){
    const row=rows[index];
    if(!row.some(c=>String(c||'').trim())||shape(row).join('|')===header)continue;
    const value=field=>String(row[mapping[field]]||'').trim();
    try {
      const transactionDate=date(value('date')||value('postedDate'),dateFormat);
      const postedDate=value('postedDate')?date(value('postedDate'),dateFormat):null;
      if(value('currency')&&money.code(value('currency'))!==currency)throw new ValidationError('The statement line uses a different currency.');
      const counterparty=trimOrNull(value('counterparty'));
      const description=value('description')||counterparty;
      if(!description||description.length>4000)throw new ValidationError('Each statement line needs its full bank description.');
      const externalId=trimOrNull(value('externalId')),reference=trimOrNull(value('reference'));
      if(externalId?.length>500||reference?.length>4000)throw new ValidationError('A statement reference exceeds the supported source field size.');
      const signed=mapping.amount!==undefined;
      let amountMinor;
      if(signed)amountMinor=sourceAmount(value('amount'),currency,'Statement amount',{signed:true});
      else {
        const credit=sourceAmount(value('credit')||'0',currency,'Statement credit');
        const debit=sourceAmount(value('debit')||'0',currency,'Statement debit',{signed:true});
        if(credit&&debit)throw new ValidationError('A row cannot contain both a debit and a credit.');
        amountMinor=credit-Math.abs(debit);
      }
      if(!amountMinor)throw new ValidationError('A statement transaction must have a nonzero amount.');
      let remittance=null,remittanceProblem=null;
      if(amountMinor>0){
        const named=value('remittance');
        const described=/^invoices?\s*:/i.test(description)||/^[^;|=]+=[^;|]+[;|][^;|=]+=/i.test(description);
        try{remittance=parseRemittance(named||reference||(described?description:null),currency,{explicit:Boolean(named||described&&!reference)});}
        catch(error){if(!(error instanceof ValidationError))throw error;remittanceProblem=error.message;}
      }
      result.push({rowNumber:index+1,transactionDate,postedDate,description,counterparty,externalId,reference,amountMinor,remittance,remittanceProblem});
    } catch(error) {
      if(error instanceof ValidationError)throw new ValidationError('Statement row '+(index+1)+': '+error.message);
      throw error;
    }
  }
  if(!result.length)throw new ValidationError('The statement contains no transaction rows.');
  return result;
}

// This remains the same identity used by the original single-row import.
function transactionHash(bankId,{transactionDate,amountMinor,description,externalId}) {
  return digest(JSON.stringify({bankId,transactionDate,amountMinor,description,externalId}));
}

async function importStatement(database,ctx,bankId,{buffer,filename,dateFormat='ISO'}) {
  const safeName=String(filename||'').split(/[\\/]/).pop().trim();
  if(!safeName||safeName.length>240||/[\u0000-\u001f\u007f]/.test(safeName))throw new ValidationError('Choose a named statement export.');
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_BYTES)throw new ValidationError('Choose a complete supported bank statement export.');
  const sourceHash=digest(buffer);
  return database.transaction(async db=>{
    const permissions=require('../actions/permissions');
    const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    permissions.assertCan(actor,permissions.RECONCILE_ACCOUNTS,'import bank evidence');
    const bank=(await db.query('SELECT id,currency FROM accounting_bank_accounts WHERE workspace_id=$1 AND id=$2 AND active=1 FOR SHARE',[ctx.workspaceId,bankId])).rows[0];
    if(!bank)throw new NotFoundError('That financial account was not found in this inventory.');
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['bank:'+ctx.workspaceId+':'+bankId]);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['bank-statement-original:'+ctx.workspaceId+':'+sourceHash]);
    const previous=(await db.query(`SELECT id,bank_account_id,row_count,imported_count,date_format FROM stockchief_runtime.bank_statement_originals
      WHERE workspace_id=$1 AND source_hash=$2`,[ctx.workspaceId,sourceHash])).rows[0];
    if(previous){
      if(previous.bank_account_id!==bankId)throw new ValidationError('This exact statement original is already assigned to another bank account.');
      if(previous.date_format!==dateFormat)throw new ValidationError('This statement original was already saved with another date format.');
      return {id:previous.id,rows:previous.row_count,imported:0,replayed:true};
    }
    const lines=parse(buffer,bank.currency,dateFormat);
    const identity=new Set(), external=new Set(), unnumbered=new Set(), descriptionKeys=new Set();
    for(const line of lines){
      line.contentHash=transactionHash(bankId,line);
      if(identity.has(line.contentHash)||line.externalId&&external.has(line.externalId)){
        throw new ValidationError('The statement repeats a transaction identity. Separate genuine identical entries using their bank transaction IDs.');
      }
      const descriptionKey=JSON.stringify([line.transactionDate,line.amountMinor,line.description]);
      if(unnumbered.has(descriptionKey)||!line.externalId&&descriptionKeys.has(descriptionKey)) {
        throw new ValidationError('Repeated statement details need distinct bank transaction IDs.');
      }
      if(!line.externalId)unnumbered.add(descriptionKey);
      descriptionKeys.add(descriptionKey);
      identity.add(line.contentHash);if(line.externalId)external.add(line.externalId);
    }
    const saved=(await db.query(`WITH matches AS (
      SELECT t.id FROM accounting_bank_transactions t WHERE t.workspace_id=$1 AND t.bank_account_id=$2
        AND (t.content_hash=ANY($3::text[]) OR t.external_id=ANY($4::text[]))
      UNION
      SELECT t.id FROM jsonb_to_recordset($5::jsonb) AS x("transactionDate" text,"amountMinor" bigint,description text,"externalId" text)
      JOIN accounting_bank_transactions t ON t.workspace_id=$1 AND t.bank_account_id=$2
        AND t.transaction_date=x."transactionDate" AND t.amount_minor=x."amountMinor"
        AND md5(t.description)=md5(x.description) AND t.description=x.description AND (x."externalId" IS NULL OR t.external_id IS NULL)
      ) SELECT t.id,t.external_id,t.content_hash,t.transaction_date,t.amount_minor,t.description,t.reference,t.remittance,t.remittance_problem
      FROM matches m JOIN accounting_bank_transactions t ON t.id=m.id AND t.workspace_id=$1 AND t.bank_account_id=$2`,
    [ctx.workspaceId,bankId,[...identity],[...external],JSON.stringify(lines)])).rows;
    const byHash=new Map(saved.map(row=>[row.content_hash,row])),byExternal=new Map(saved.filter(row=>row.external_id).map(row=>[row.external_id,row]));
    const possibleRepeats=new Map();
    for(const row of saved){
      const key=JSON.stringify([row.transaction_date,Number(row.amount_minor),row.description]);
      if(!possibleRepeats.has(key))possibleRepeats.set(key,[]);
      possibleRepeats.get(key).push(row);
    }
    const fresh=[];
    for(const line of lines){
      const possible=possibleRepeats.get(JSON.stringify([line.transactionDate,line.amountMinor,line.description]))||[];
      const existing=byHash.get(line.contentHash)||byExternal.get(line.externalId)
        ||possible.find(row=>!row.external_id||!line.externalId);
      if(existing){
        if(existing.content_hash!==line.contentHash||existing.reference&&line.reference&&existing.reference!==line.reference
          ||existing.remittance&&line.remittance&&!require('node:util').isDeepStrictEqual(existing.remittance,line.remittance)
          ||existing.remittance_problem&&line.remittance) {
          throw new ValidationError('Statement row '+line.rowNumber+' conflicts with the retained bank transaction. Review its original before importing.');
        }
        continue;
      }
      fresh.push({...line,id:newId('banktx')});
    }
    const id=newId('bankstmt');
    await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'bank-statement:'+sourceHash+':'+bankId,
      buffer.length*2+Buffer.byteLength(JSON.stringify(fresh))+4096,{finished:true});
    const inserted=await db.query(`INSERT INTO stockchief_runtime.bank_statement_originals(id,workspace_id,bank_account_id,filename,source_hash,original,
      date_format,row_count,imported_count,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(workspace_id,source_hash) DO NOTHING RETURNING id`,
    [id,ctx.workspaceId,bankId,safeName,sourceHash,buffer,dateFormat,lines.length,fresh.length,ctx.actorId]);
    if(!inserted.rowCount)throw new ValidationError('This statement was saved by another upload. Refresh the bank statement history.');
    if(fresh.length)await db.query(`INSERT INTO accounting_bank_transactions(id,workspace_id,bank_account_id,external_id,transaction_date,
      posted_date,amount_minor,description,counterparty,reference,content_hash,import_source,status,imported_at,statement_id,statement_row,remittance,remittance_problem)
      SELECT x.id,$1,$2,x."externalId",x."transactionDate",x."postedDate",x."amountMinor",x.description,x.counterparty,x.reference,x."contentHash",
        'bank_statement_file','UNMATCHED',$3,$4,x."rowNumber",x.remittance,x."remittanceProblem"
      FROM jsonb_to_recordset($5::jsonb) AS x(id text,"externalId" text,"transactionDate" text,"postedDate" text,"amountMinor" bigint,
        description text,counterparty text,reference text,"contentHash" text,"rowNumber" integer,remittance jsonb,"remittanceProblem" text)`,
    [ctx.workspaceId,bankId,nowIso(),id,JSON.stringify(fresh)]);
    return {id,rows:lines.length,imported:fresh.length,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function parseRemittanceFile(bytes,bank){
  const content=text(bytes);
  let rows;
  try{rows=parseDelimited(content,detectDelimiter(content));}catch(error){throw new ValidationError(error.message);}
  const header=rows.findIndex(row=>shape(row).some(c=>['invoice','invoicenumber','invoicereference'].includes(c)));
  if(header<0)throw new ValidationError('Use a customer remittance export with an Invoice column and its exact Amount column if present.');
  const normalized=shape(rows[header]);
  const column=(names,optional=true)=>{
    const matches=normalized.flatMap((name,index)=>names.includes(name)?[index]:[]);
    if(matches.length>1||!optional&&!matches.length)throw new ValidationError('Confirm the exact remittance source columns.');
    return matches[0];
  };
  const invoice=column(['invoice','invoicenumber','invoicereference'],false);
  const amount=column(['amount','paidamount','allocationamount']);
  const currency=column(aliases.currency);
  const identity=column(aliases.externalId);
  const values=[],numbers=new Set();
  for(const row of rows.slice(header+1)){
    if(!row.some(c=>String(c||'').trim())||shape(row).join('|')===normalized.join('|'))continue;
    const number=String(row[invoice]||'').trim();
    if(!number||number.length>150||/[=;|\u0000-\u001f\u007f]/.test(number)||numbers.has(number.toLowerCase())){
      throw new ValidationError('List each exact invoice number once in the customer remittance.');
    }
    numbers.add(number.toLowerCase());
    if(row[currency]&&money.code(row[currency])!==bank.currency)throw new ValidationError('The remittance uses a different currency.');
    if(row[identity]&&String(row[identity]).trim()!==bank.external_id)throw new ValidationError('The remittance identifies a different bank transaction.');
    const value=amount===undefined?null:sourceAmount(row[amount],bank.currency,'Remittance allocation');
    if(value!==null&&value<=0)throw new ValidationError('Each stated remittance allocation must be positive.');
    values.push({invoiceNumber:number,amountMinor:value});
  }
  if(!values.length)throw new ValidationError('The remittance does not contain an invoice.');
  if(amount!==undefined&&money.sum(values.map(value=>value.amountMinor))!==Number(bank.amount_minor)) {
    throw new ValidationError('The stated remittance amounts do not equal this bank credit.');
  }
  return values;
}

async function attachRemittance(database,ctx,transactionId,{buffer,filename,confirmed}){
  const safeName=String(filename||'').split(/[\\/]/).pop().trim();
  if(confirmed!=='yes'||!safeName||safeName.length>240||/[\u0000-\u001f\u007f]/.test(safeName)){
    throw new ValidationError('Confirm this exact customer remittance belongs to the selected bank credit.');
  }
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_BYTES)throw new ValidationError('Choose the complete customer remittance.');
  const sourceHash=digest(buffer);
  return database.transaction(async db=>{
    const owner=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)
      FOR SHARE OF u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!owner)throw new (require('../domain/errors').AuthorizationError)('Only the current inventory owner can confirm a customer remittance.');
    await require('../commercial/agent-plan').requireWorkspaceJob(db,ctx.workspaceId,103,'draft');
    const bank=await require('./postgres-banking').receiptAccount(db,ctx.workspaceId,transactionId,{lock:true});
    if(bank.status!=='UNMATCHED')throw new ValidationError('Choose an unmatched bank credit before changing its remittance evidence.');
    const remittance=parseRemittanceFile(buffer,bank);
    let stored=(await db.query(`SELECT id FROM stockchief_runtime.bank_remittance_originals
      WHERE workspace_id=$1 AND bank_transaction_id=$2 AND source_hash=$3`,[ctx.workspaceId,bank.id,sourceHash])).rows[0];
    if(!stored){
      const id=newId('bankremit');
      await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'bank-remittance:'+id,
        buffer.length*2+Buffer.byteLength(JSON.stringify(remittance))+4096,{finished:true});
      stored=(await db.query(`INSERT INTO stockchief_runtime.bank_remittance_originals(id,workspace_id,bank_transaction_id,
        filename,source_hash,original,remittance,confirmed_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
      [id,ctx.workspaceId,bank.id,safeName,sourceHash,buffer,JSON.stringify(remittance),ctx.actorId])).rows[0];
    }
    if(bank.remittance_original_id===stored.id)return {id:stored.id,replayed:true};
    await db.query(`UPDATE accounting_bank_transactions SET remittance=$3::jsonb,remittance_original_id=$4,
      remittance_problem=NULL,receipt_checked_at=NULL,receipt_check_problem=NULL WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,bank.id,JSON.stringify(remittance),stored.id]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Customer remittance confirmed for bank credit',
      reference:bank.id,after:{sourceId:stored.id,sourceHash,invoiceCount:remittance.length}});
    return {id:stored.id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function original(db,workspaceId,id,{remittance=false}={}){
  const table=remittance?'bank_remittance_originals':'bank_statement_originals';
  const row=(await db.query('SELECT filename,source_hash,original FROM stockchief_runtime.'+table+' WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!row||digest(row.original)!==row.source_hash)throw new NotFoundError('That verified statement original is unavailable.');
  return row;
}

module.exports={MAX_BYTES,parse,transactionHash,importStatement,attachRemittance,original};
