'use strict';
// Job 184: send customer invoices and supplier bills to QuickBooks or Xero.
//
// The owner turns this on for one connected set of books (already enabled for
// verified posting), from a start date, for invoices, bills or both. Each open
// invoice or bill on or after that date is built from its own books entry in
// StockChief: the customer or supplier, the amount owed, the tax and one line
// per income or cost account. It is sent as an invoice or a bill, read back
// and checked against those exact amounts. The books entry then goes to the
// books as a journal only for what the document does not carry (the cost of
// goods on a shipment), so nothing is counted twice; an entry already sent as
// a journal is never sent again as a document.
//
// Starter and Growth: not included. Pro: each document waits for approval
// until the owner teaches it, by the saved rule on the page or by approving
// one that the books confirmed; then it sends on its own. Custom: alone.
// Pause, Watch only and the first 14 days only record what it would send; Ask
// me first and a plan that needs teaching keep it for approval. A missing
// link to a contact, an account, a tax code or (QuickBooks) the product used
// for an income account stops and asks; nothing is guessed. A document the
// books already hold under the same number is linked only when it matches
// exactly, otherwise a person checks it. An unclear send is never repeated: a
// person checks it in the books first.
const crypto=require('node:crypto');
const policy=require('../commercial/agent-plan');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {has}=require('../db/schema-installed');
const money=require('../domain/currency');

const JOB=184,DOCS='stockchief_runtime.agent_accounting_documents',SETTINGS='stockchief_runtime.agent_accounting_document_settings',MAPS='stockchief_runtime.agent_accounting_mappings';
const KIND='agent.accounting-documents.v1',EFFECT='accounting.document.export',key='accounting-documents',path='/autopilot/reviews/'+key;
const TAX_KEYS=Object.freeze({sale_taxed:'Taxed sales',sale_untaxed:'Untaxed sales',purchase_taxed:'Taxed purchases',purchase_untaxed:'Untaxed purchases'});
const PROVIDERS={quickbooks:'QuickBooks',xero:'Xero'};
const WAITING=['WATCHED','HELD','DRAFTED','FAILED','UNCERTAIN'];
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tx=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});
const audit=(c,ctx,entry)=>require('../operations/postgres-security-audit').record(c,ctx,entry);
const expected=error=>[400,402,403,404,409,422].includes(error?.status);
const providers=()=>require('../connections/providers/registry');
const supports=type=>Boolean(PROVIDERS[type]&&providers().get(type)?.postDocument);
const label=(kind,number)=>(kind==='invoice'?'Invoice ':'Bill ')+number;

async function owner(db,ctx){
  const row=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the inventory owner can send invoices and bills to the books.');
}

// The connected books this job may write to: verified posting is enabled and
// the provider can send documents.
async function books(db,workspaceId,connectorId){
  const row=(await db.query(`SELECT c.id,c.workspace_id,c.display_name,c.provider_type,c.status,c.paused_at,c.provider_account_id,c.setup_status,p.stage
    FROM workspace_connectors c JOIN accounting_sync_policies p ON p.workspace_id=c.workspace_id AND p.connector_id=c.id
    WHERE c.workspace_id=$1 AND c.id=$2`,[workspaceId,connectorId])).rows[0];
  if(!row||!PROVIDERS[row.provider_type])return {reason:'Choose connected QuickBooks or Xero books.'};
  if(row.status!=='connected'||row.paused_at)return {row,reason:'Reconnect or resume '+row.display_name+' before StockChief sends to it.'};
  if(row.stage!=='WRITE_ENABLED')return {row,reason:'Turn on verified posting for '+row.display_name+' on its connection page first.'};
  if(!supports(row.provider_type))return {row,reason:PROVIDERS[row.provider_type]+' cannot take invoices and bills here.'};
  return {row};
}

async function settingsOf(db,workspaceId){
  if(!await has(db,SETTINGS))return [];
  return (await db.query(`SELECT s.*,c.display_name,c.provider_type FROM ${SETTINGS} s JOIN workspace_connectors c ON c.workspace_id=s.workspace_id AND c.id=s.connector_id
    WHERE s.workspace_id=$1 ORDER BY c.display_name,s.connector_id`,[workspaceId])).rows;
}

// ---- The document, from its books entry -------------------------------------

// The books entries an invoice or bill stands on: its own entry, or for an
// order's invoice the entries of each shipment on that order once it shipped
// in full (until then the invoice can still grow).
async function shape(db,workspaceId,kind,id){
  const invoice=kind==='invoice';
  const doc=(await db.query(invoice
    ?`SELECT i.id,i.invoice_number number,i.customer_id contact_id,c.name contact_name,i.issue_date,i.due_date,i.status,i.currency,i.tax_minor,i.total_minor,i.journal_entry_id,i.sales_order_id,o.status order_status
       FROM accounting_customer_invoices i JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id
       LEFT JOIN sales_orders o ON o.workspace_id=i.workspace_id AND o.id=i.sales_order_id WHERE i.workspace_id=$1 AND i.id=$2`
    :`SELECT b.id,coalesce(b.supplier_invoice_number,b.bill_number) number,b.supplier_id contact_id,s.name contact_name,b.issue_date,b.due_date,b.status,b.currency,b.tax_minor,b.total_minor,b.journal_entry_id,NULL sales_order_id,NULL order_status
       FROM accounting_supplier_bills b JOIN suppliers s ON s.workspace_id=b.workspace_id AND s.id=b.supplier_id WHERE b.workspace_id=$1 AND b.id=$2`,[workspaceId,id])).rows[0];
  if(!doc)return {hold:'That '+kind+' was not found.',gone:true};
  const name=label(kind,doc.number),base={number:doc.number,contactName:doc.contact_name,journalId:doc.journal_entry_id||null};
  if(!['OPEN','PARTIALLY_PAID','PAID'].includes(doc.status))return {...base,hold:name+' is not open in your books, so it is not sent.',gone:true};
  let journals;
  if(doc.journal_entry_id)journals=(await db.query('SELECT id,status,source_type,source_record_type,source_record_id FROM accounting_journal_entries WHERE workspace_id=$1 AND id=$2',[workspaceId,doc.journal_entry_id])).rows;
  else if(invoice&&doc.sales_order_id){
    if(doc.order_status!=='FULFILLED')return {...base,hold:name+' waits until its order has shipped in full.',notYet:true};
    journals=(await db.query(`SELECT id,status,source_type,source_record_type,source_record_id FROM accounting_journal_entries WHERE workspace_id=$1 AND status='POSTED'
      AND source_type='sale_fulfillment' AND source_record_type='sales_order' AND source_record_id=$2 ORDER BY entry_number,id`,[workspaceId,doc.sales_order_id])).rows;
  }else journals=[];
  if(!journals.length)return {...base,hold:name+' has no books entry in StockChief, so there is nothing exact to send.'};
  base.journalId=journals[0].id;base.journals=journals.map(j=>j.id);
  if(journals.some(j=>j.status!=='POSTED'))return {...base,hold:'The books entry for '+name+' is not posted.'};
  const own=journals.length===1&&journals[0].source_record_type===(invoice?'customer_invoice':'supplier_bill')&&journals[0].source_record_id===doc.id;
  const shipment=invoice&&journals.every(j=>j.source_type==='sales_fulfillment'||j.source_type==='sale_fulfillment'&&j.source_record_id===doc.sales_order_id);
  if(!own&&!shipment)return {...base,hold:name+' shares a books entry StockChief cannot split into one '+kind+'. A person sends it.'};
  const lines=(await db.query(`SELECT l.id,l.account_id,l.debit_minor,l.credit_minor,l.customer_id,l.supplier_id,l.currency,a.code,a.name,a.account_type,a.system_key
    FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    WHERE l.workspace_id=$1 AND l.entry_id=ANY($2::text[]) ORDER BY l.entry_id,l.line_number,l.id`,[workspaceId,base.journals])).rows.map(l=>({...l,debit:Number(l.debit_minor),credit:Number(l.credit_minor)}));
  const currency=money.code(doc.currency);
  if(lines.some(l=>money.code(l.currency||doc.currency)!==currency))return {...base,hold:'The books entry for '+name+' uses more than one currency. A person sends it.'};
  const control=invoice?'ACCOUNTS_RECEIVABLE':'ACCOUNTS_PAYABLE',taxKey=invoice?'SALES_TAX_PAYABLE':'SALES_TAX_RECOVERABLE';
  const covered=[],grouped=new Map();let owed=0,tax=0;const rest=[];
  for(const l of lines){
    if(l.system_key===control){
      if((invoice?l.customer_id:l.supplier_id)!==doc.contact_id)return {...base,hold:'The books entry for '+name+' names another '+(invoice?'customer':'supplier')+'. A person sends it.'};
      if(invoice?l.credit:l.debit)return {...base,hold:'The books entry for '+name+' reduces what is owed on the same entry. A person sends it.'};
      owed+=invoice?l.debit:l.credit;covered.push(l.id);continue;
    }
    if(l.system_key===taxKey){tax+=invoice?l.credit-l.debit:l.debit-l.credit;covered.push(l.id);continue;}
    if(invoice&&!(l.account_type==='INCOME'&&l.credit>0&&!l.debit)){
      if(own)return {...base,hold:'The books entry for '+name+' has a '+l.name+' line an invoice cannot carry. A person sends it.'};
      rest.push(l);continue;
    }
    const amount=invoice?l.credit-l.debit:l.debit-l.credit,line=grouped.get(l.account_id)||{accountId:l.account_id,code:l.code,name:l.name,amount:0};
    line.amount+=amount;grouped.set(l.account_id,line);covered.push(l.id);
  }
  const docLines=[...grouped.values()];
  const credit=docLines.find(l=>l.amount<=0);
  if(credit)return {...base,hold:name+' has a reducing line on '+credit.name+'. A person sends it.'};
  const net=docLines.reduce((sum,l)=>sum+l.amount,0);
  if(!docLines.length||owed!==Number(doc.total_minor)||tax!==Number(doc.tax_minor)||net+tax!==Number(doc.total_minor))
    return {...base,hold:name+' does not match its books entry exactly, so StockChief did not send it. A person checks it.'};
  if(rest.reduce((sum,l)=>sum+l.debit-l.credit,0)!==0)return {...base,hold:'What is left of the books entry for '+name+' does not balance. A person sends it.'};
  return {...base,covered,doc:{kind,id:doc.id,number:doc.number,contactId:doc.contact_id,contactName:doc.contact_name,issueDate:doc.issue_date,dueDate:doc.due_date||null,
    currency,total:Number(doc.total_minor),tax,lines:docLines.map(l=>({accountId:l.accountId,accountName:l.name,amount:l.amount,description:name+' · '+l.name}))}};
}

// What the books call each part. A missing link stops and asks.
async function mapping(db,workspaceId,box,doc){
  const provider=PROVIDERS[box.provider_type],quickbooks=box.provider_type==='quickbooks',invoice=doc.kind==='invoice';
  const contact=(await db.query(`SELECT external_id FROM accounting_external_identities WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND foundry_record_id=$4`,
    [workspaceId,box.id,invoice?'customer':'supplier',doc.contactId])).rows[0];
  if(!contact)return {hold:'Link '+doc.contactName+' to a '+provider+' '+(invoice?'customer':'supplier')+' before StockChief sends '+label(doc.kind,doc.number)+'.',
    need:{kind:invoice?'customer':'supplier',localKey:doc.contactId,label:doc.contactName}};
  const accounts=new Map((await db.query(`SELECT foundry_account_id,external_id FROM accounting_posting_account_mappings WHERE workspace_id=$1 AND connector_id=$2 AND foundry_account_id=ANY($3::text[])`,
    [workspaceId,box.id,doc.lines.map(l=>l.accountId)])).rows.map(r=>[r.foundry_account_id,r.external_id]));
  const snapshot=(await db.query('SELECT external_snapshot FROM accounting_shadow_runs WHERE workspace_id=$1 AND connector_id=$2 ORDER BY started_at DESC LIMIT 1',[workspaceId,box.id])).rows[0];
  let external={};try{external=typeof snapshot?.external_snapshot==='string'?JSON.parse(snapshot.external_snapshot):snapshot?.external_snapshot||{};}catch{external={};}
  const codes=new Map((external.accounts||[]).map(a=>[String(a.externalId),a.code||null]));
  const own=await has(db,MAPS)?new Map((await db.query(`SELECT kind,local_key,external_id FROM ${MAPS} WHERE workspace_id=$1 AND connector_id=$2`,[workspaceId,box.id])).rows.map(r=>[r.kind+':'+r.local_key,r.external_id])):new Map();
  const lines=[];
  for(const l of doc.lines){
    const accountExternalId=accounts.get(l.accountId);
    if(!accountExternalId)return {hold:'Map the '+l.accountName+' account to '+provider+' before StockChief sends '+label(doc.kind,doc.number)+'.',need:{kind:'account',localKey:l.accountId,label:l.accountName}};
    const accountCode=codes.get(String(accountExternalId))||null;
    if(!quickbooks&&!accountCode)return {hold:'Xero has no account code for '+l.accountName+'. Compare the books again so StockChief can read it.',need:{kind:'account',localKey:l.accountId,label:l.accountName}};
    const itemExternalId=quickbooks&&invoice?own.get('sales_item:'+l.accountId):null;
    if(quickbooks&&invoice&&!itemExternalId)return {hold:'Choose the QuickBooks product or service used for '+l.accountName+' sales before StockChief sends '+label(doc.kind,doc.number)+'.',
      need:{kind:'sales_item',localKey:l.accountId,label:l.accountName}};
    lines.push({description:l.description,amount:l.amount,accountExternalId,accountCode,...(itemExternalId?{itemExternalId}:{})});
  }
  const taxKey=(invoice?'sale':'purchase')+'_'+(doc.tax>0?'taxed':'untaxed'),taxCode=own.get('tax_code:'+taxKey);
  if(!taxCode)return {hold:'Choose the '+provider+' tax code for '+TAX_KEYS[taxKey].toLowerCase()+' before StockChief sends '+label(doc.kind,doc.number)+'.',need:{kind:'tax_code',localKey:taxKey,label:TAX_KEYS[taxKey]}};
  if(quickbooks&&String(doc.number).length>21)return {hold:'QuickBooks numbers are at most 21 characters, so '+label(doc.kind,doc.number)+' needs a person.'};
  return {document:{kind:doc.kind,number:doc.number,reference:'StockChief '+doc.kind+' '+doc.id,contactExternalId:contact.external_id,issueDate:doc.issueDate,dueDate:doc.dueDate,
    currency:doc.currency,total:doc.total,tax:doc.tax,taxCode,lines}};
}

// Whether the books entry already went to these books as a journal.
async function journalSent(db,workspaceId,connectorId,journals){
  if(!journals?.length)return false;
  return (await db.query(`SELECT EXISTS(SELECT 1 FROM accounting_external_identities WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='journal_entry' AND foundry_record_id=ANY($3::text[]))
    OR EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='accounting.journal.export' AND aggregate_id=ANY($3::text[]) AND payload->>'connectorId'=$2 AND status NOT IN ('FAILED','CANCELLED')) sent`,
  [workspaceId,connectorId,journals])).rows[0].sent;
}

// The exact document for these books now, or why there is none.
async function evaluate(db,workspaceId,box,kind,id){
  const shaped=await shape(db,workspaceId,kind,id);
  if(shaped.hold)return {status:'HELD',reason:shaped.hold,gone:shaped.gone||shaped.notYet,number:shaped.number,contactName:shaped.contactName,journalId:shaped.journalId};
  if(await journalSent(db,workspaceId,box.id,shaped.journals))return {status:'IN_BOOKS',reason:'Its books entry already went to '+box.display_name+' as a journal, so it is not sent again.',
    number:shaped.number,contactName:shaped.contactName,journalId:shaped.journalId};
  const mapped=await mapping(db,workspaceId,box,shaped.doc);
  if(mapped.hold)return {status:'HELD',reason:mapped.hold,need:mapped.need,number:shaped.number,contactName:shaped.contactName,journalId:shaped.journalId};
  return {status:'READY',document:mapped.document,covered:shaped.covered,number:shaped.number,contactName:shaped.contactName,journalId:shaped.journalId,
    fingerprint:hash({connector:box.id,account:box.provider_account_id,document:mapped.document,covered:shaped.covered})};
}

// ---- Authority -------------------------------------------------------------------

async function decide(db,workspaceId){
  const state=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(state)?state.plan:null;
  if(!plan||!policy.permits(plan,JOB,'draft'))return {mode:'skip',state};
  if(state.shadow)return {mode:'watch',state,reason:'StockChief is watching during its first 14 days and did not send this.'};
  const autopilot=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(autopilot.mode==='OBSERVE')return {mode:'watch',state,reason:'StockChief is set to Watch only and did not send this.'};
  if(autopilot.paused||autopilot.suspended)return {mode:'watch',state,reason:'Automatic work is paused, so StockChief did not send this.'};
  const watch=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,false);
  if(watch)return {mode:'watch',state,reason:watch};
  return {mode:'prepare',state,autopilot};
}

async function stopped(db,workspaceId,state,automatic){
  if(state.shadow)return 'StockChief is watching during its first 14 days. Send this to the books after that, or enter it yourself.';
  const cfg=(await db.query('SELECT mode,paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(cfg?.mode==='OBSERVE')return 'StockChief is set to Watch only. Change its mode to send this.';
  if(automatic&&(Number(cfg?.paused)||Number(cfg?.suspended)))return 'Automatic work is paused.';
  const mode=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,automatic);
  if(mode)return mode;
  return automatic?require('../commercial/agent-rule-quota').restriction(db,state):null;
}

// Pro is taught by the saved rule or by one document of the same kind the
// owner approved and the books confirmed.
async function taught(db,workspaceId,connectorId,kind,settings){
  if(settings?.send_alone&&await ownerAuthored(db,workspaceId,settings.updated_by))return true;
  return (await db.query(`SELECT 1 FROM ${DOCS} d JOIN users u ON u.workspace_id=d.workspace_id AND u.id=d.approved_by AND u.role='owner'
    WHERE d.workspace_id=$1 AND d.connector_id=$2 AND d.document_kind=$3 AND d.status='SENT' AND NOT d.automatic LIMIT 1`,[workspaceId,connectorId,kind])).rowCount>0;
}
async function ownerAuthored(db,workspaceId,userId){return (await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[workspaceId,userId])).rowCount>0;}

async function waitReason(db,workspaceId,decision,settings,kind){
  if(!decision||decision.mode!=='prepare')return decision?.reason||'Sending invoices and bills to the books needs the Pro plan or above.';
  if(!decision.autopilot?.canAutomate)return 'StockChief is set to ask you first.';
  const ask=await require('../autopilot/job-modes').restriction(db,workspaceId,JOB,true);
  if(ask)return ask;
  const trained=await taught(db,workspaceId,settings.connector_id,kind,settings);
  if(policy.allowance(decision.state.plan,JOB)==='trained'&&!trained)
    return 'You have not taught StockChief to send '+kind+'s on its own yet, so it waits for your approval.';
  if(!policy.permits(decision.state.plan,JOB,'automatic',{trained}))return 'Your plan asks you to approve each one.';
  return require('../commercial/agent-rule-quota').restriction(db,decision.state);
}

// ---- Records -----------------------------------------------------------------

async function record(c,workspaceId,connectorId,kind,id,f){
  const prior=(await c.query(`SELECT status,reason FROM ${DOCS} WHERE workspace_id=$1 AND connector_id=$2 AND document_kind=$3 AND document_id=$4 FOR UPDATE`,[workspaceId,connectorId,kind,id])).rows[0];
  await c.query(`INSERT INTO ${DOCS}(workspace_id,connector_id,document_kind,document_id,journal_entry_id,number,contact_name,status,reason,need,fingerprint,payload,covered_lines,effect_id,attempt,external_id,automatic,approved_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15,0),$16,$17,$18)
    ON CONFLICT(workspace_id,connector_id,document_kind,document_id) DO UPDATE SET journal_entry_id=coalesce(EXCLUDED.journal_entry_id,agent_accounting_documents.journal_entry_id),
      number=EXCLUDED.number,contact_name=coalesce(EXCLUDED.contact_name,agent_accounting_documents.contact_name),status=EXCLUDED.status,reason=EXCLUDED.reason,need=EXCLUDED.need,
      fingerprint=coalesce(EXCLUDED.fingerprint,agent_accounting_documents.fingerprint),payload=coalesce(EXCLUDED.payload,agent_accounting_documents.payload),
      covered_lines=CASE WHEN EXCLUDED.status IN ('QUEUED','SENT') THEN EXCLUDED.covered_lines ELSE agent_accounting_documents.covered_lines END,
      effect_id=coalesce(EXCLUDED.effect_id,agent_accounting_documents.effect_id),attempt=coalesce($15,agent_accounting_documents.attempt),
      external_id=coalesce(EXCLUDED.external_id,agent_accounting_documents.external_id),automatic=EXCLUDED.automatic,
      approved_by=coalesce(EXCLUDED.approved_by,agent_accounting_documents.approved_by),updated_at=clock_timestamp()`,
  [workspaceId,connectorId,kind,id,f.journalId||null,f.number||'?',f.contactName||null,f.status,f.reason?String(f.reason).slice(0,500):null,f.need?JSON.stringify(f.need):null,
    f.fingerprint||null,f.document?JSON.stringify(f.document):null,f.covered||[],f.effectId||null,f.attempt??null,f.externalId||null,Boolean(f.automatic),f.approvedBy||null]);
  return !prior||prior.status!==f.status||prior.reason!==(f.reason?String(f.reason).slice(0,500):null);
}

async function current(db,workspaceId,connectorId,kind,id,lock=false){
  return (await db.query(`SELECT * FROM ${DOCS} WHERE workspace_id=$1 AND connector_id=$2 AND document_kind=$3 AND document_id=$4${lock?' FOR UPDATE':''}`,[workspaceId,connectorId,kind,id])).rows[0]||null;
}

const HOLD_ACTION={WATCHED:'Invoice or bill watched',HELD:'Invoice or bill stopped for a person',DRAFTED:'Invoice or bill prepared for approval',IN_BOOKS:'Invoice or bill already in the books as a journal'};
async function hold(db,workspaceId,actorId,box,kind,id,f){
  await tx(db,async c=>{
    const changed=await record(c,workspaceId,box.id,kind,id,f);
    if(changed)await audit(c,{workspaceId,actorId},{action:HOLD_ACTION[f.status],reference:label(kind,f.number||'?'),
      after:{connectorId:box.id,kind,documentId:id,status:f.status,reason:f.reason||null}});
  });
  return {status:f.status,reason:f.reason};
}

// Queue the exact document for the books' worker. Checked again inside.
async function queue(db,ctx,box,kind,id,{automatic,expectedFingerprint=null}){
  return tx(db,async c=>{
    const prior=await current(c,ctx.workspaceId,box.id,kind,id,true);
    if(prior&&['QUEUED','SENT','UNCERTAIN'].includes(prior.status))throw new ValidationError('StockChief already sent '+label(kind,prior.number)+' to '+box.display_name+'.');
    if(prior&&['IN_BOOKS','DISMISSED'].includes(prior.status))throw new ValidationError(label(kind,prior.number)+' goes to the books as a journal, so it is not sent as a document.');
    const fresh=await evaluate(c,ctx.workspaceId,box,kind,id);
    if(fresh.status!=='READY')throw new ValidationError(fresh.reason);
    if(expectedFingerprint&&fresh.fingerprint!==expectedFingerprint)throw new ValidationError('The records or links changed since this was prepared. Review the current version before sending.');
    const attempt=(prior?.attempt||0)+(prior?.status==='FAILED'?1:0);
    const effect=await require('../operations/postgres-provider-effects').enqueueInTransaction(c,{workspaceId:ctx.workspaceId,kind:EFFECT,provider:box.provider_type,
      aggregateType:'accounting_'+kind,aggregateId:id,idempotencyKey:'accounting-document:'+box.id+':'+kind+':'+id+':'+attempt,requestedByUserId:ctx.actorId,
      payload:{connectorId:box.id,kind,documentId:id,fingerprint:fresh.fingerprint,providerAccountId:box.provider_account_id,automatic,actorId:ctx.actorId},priority:15,maxAttempts:12});
    await record(c,ctx.workspaceId,box.id,kind,id,{...fresh,status:'QUEUED',reason:null,effectId:effect.effect.id,attempt,automatic,approvedBy:automatic?null:ctx.actorId});
    await audit(c,ctx,{action:automatic?'Invoice or bill sent to the books by StockChief':'Invoice or bill approved for the books',reference:label(kind,fresh.number),
      after:{connectorId:box.id,books:box.display_name,kind,documentId:id,total:fresh.document.total,currency:fresh.document.currency,automatic,effectId:effect.effect.id}});
    return {queued:true,effectId:effect.effect.id};
  });
}

// ---- The routine ------------------------------------------------------------------

// Candidates: open documents of the enabled kinds from the start date that
// have no outcome yet, or are waiting on something that may have changed.
async function candidates(db,workspaceId,s,limit=50){
  return (await db.query(`SELECT kind,id FROM (
      SELECT 'invoice' kind,i.id,i.issue_date,i.created_at FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND $3 AND i.issue_date>=$5 AND i.status IN ('OPEN','PARTIALLY_PAID','PAID')
      UNION ALL SELECT 'bill',b.id,b.issue_date,b.created_at FROM accounting_supplier_bills b WHERE b.workspace_id=$1 AND $4 AND b.issue_date>=$5 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')
    ) d WHERE NOT EXISTS(SELECT 1 FROM ${DOCS} x WHERE x.workspace_id=$1 AND x.connector_id=$2 AND x.document_kind=d.kind AND x.document_id=d.id
      AND x.status NOT IN ('WATCHED','HELD','DRAFTED'))
    ORDER BY d.issue_date,d.created_at,d.id LIMIT $6`,[workspaceId,s.connector_id,s.invoices,s.bills,s.start_date,limit])).rows;
}

async function run(db,workspaceId){
  if(!await has(db,DOCS))return {skipped:true};
  const decision=await decide(db,workspaceId);
  if(decision.mode==='skip')return {skipped:true};
  const ownerId=await require('../sales/agent-customer-orders').ownerUser(db,workspaceId);
  if(!ownerId)return {skipped:true};
  const result={queued:0,held:0,watched:0,drafted:0,inBooks:0};
  for(const s of (await settingsOf(db,workspaceId)).filter(x=>x.enabled)){
    const opened=await books(db,workspaceId,s.connector_id);
    if(opened.reason)continue;
    const box=opened.row;
    for(const c of await candidates(db,workspaceId,s)){
      const e=await evaluate(db,workspaceId,box,c.kind,c.id);
      if(e.status!=='READY'){
        if(e.gone&&!(await current(db,workspaceId,box.id,c.kind,c.id)))continue;
        await hold(db,workspaceId,ownerId,box,c.kind,c.id,e);result[e.status==='IN_BOOKS'?'inBooks':'held']++;continue;
      }
      if(decision.mode==='watch'){await hold(db,workspaceId,ownerId,box,c.kind,c.id,{...e,status:'WATCHED',reason:decision.reason+' It would have sent '+label(c.kind,e.number)+' to '+box.display_name+'.'});result.watched++;continue;}
      let why=await waitReason(db,workspaceId,decision,s,c.kind);
      if(!why){
        try{await queue(db,{workspaceId,actorId:ownerId},box,c.kind,c.id,{automatic:true});result.queued++;continue;}
        catch(error){if(!expected(error))throw error;why=error.message;}
      }
      await hold(db,workspaceId,ownerId,box,c.kind,c.id,{...e,status:'DRAFTED',reason:why});result.drafted++;
    }
  }
  return result;
}

// Hourly at most, from the autopilot run, when the job may act at all.
async function schedule(db,workspaceId){
  if(!await has(db,SETTINGS))return {queued:0};
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return {queued:0};
  if(!(await settingsOf(db,workspaceId)).some(s=>s.enabled))return {queued:0};
  const hour=new Date().toISOString().slice(0,13);
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,idempotencyKey:'accounting-documents:'+hour,payload:{hour},priority:65,maxAttempts:3});
  return {queued:job.created?1:0};
}

// ---- The books' worker ------------------------------------------------------------

// Checked again just before the provider is called: the same records, links,
// books and authority as when it was queued.
async function authority(db,workspaceId,p,box){
  const row=await current(db,workspaceId,p.connectorId,p.kind,p.documentId);
  if(!row||row.status!=='QUEUED'||row.fingerprint!==p.fingerprint)throw Object.assign(new ValidationError('This document changed after it was queued. Nothing was sent.'),{status:409});
  const state=await policy.requireWorkspaceJob(db,workspaceId,JOB,'draft');
  const stop=await stopped(db,workspaceId,state,p.automatic===true);
  if(stop)throw Object.assign(new ValidationError(stop),{status:409});
  if(p.automatic===true){
    const settings=(await settingsOf(db,workspaceId)).find(s=>s.connector_id===p.connectorId&&s.enabled);
    const why=settings?await waitReason(db,workspaceId,await decide(db,workspaceId),settings,p.kind):'Sending invoices and bills was turned off for these books.';
    if(why)throw Object.assign(new ValidationError(why),{status:409});
  }
  const fresh=await evaluate(db,workspaceId,box,p.kind,p.documentId);
  if(fresh.status!=='READY'||fresh.fingerprint!==p.fingerprint)throw Object.assign(new ValidationError(fresh.status==='READY'?'The records or links changed after this was queued. Nothing was sent.':fresh.reason),{status:409});
  return fresh;
}

async function settle(c,workspaceId,p,f){
  await c.query(`UPDATE ${DOCS} SET status=$5,reason=$6,external_id=coalesce($7,external_id),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND connector_id=$2 AND document_kind=$3 AND document_id=$4`,[workspaceId,p.connectorId,p.kind,p.documentId,f.status,f.reason?String(f.reason).slice(0,500):null,f.externalId||null]);
}

async function identify(c,workspaceId,p,externalId,version,document){
  const entity=p.kind==='invoice'?'customer_invoice':'supplier_bill';
  const prior=(await c.query('SELECT external_id FROM accounting_external_identities WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND foundry_record_id=$4 FOR UPDATE',[workspaceId,p.connectorId,entity,p.documentId])).rows[0];
  if(prior&&prior.external_id!==String(externalId))throw new ValidationError('This document already has a different identity in the books. A person checks it.');
  const at=require('../lib/util').nowIso();
  await c.query(`INSERT INTO accounting_external_identities(id,workspace_id,connector_id,entity_type,foundry_record_id,external_id,external_version,payload_hash,last_direction,last_seen_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'WRITE',$9,$9,$9) ON CONFLICT(workspace_id,connector_id,entity_type,foundry_record_id) DO NOTHING`,
  [require('../lib/util').newId('acident'),workspaceId,p.connectorId,entity,p.documentId,String(externalId),version==null?null:String(version),hash(document),at]);
}

async function executeEffect(database,workspaceId,effectId,options={}){
  await require('../commercial/enforcement').workspace(database,workspaceId,'accounting.post_connected');
  const effects=require('../operations/postgres-provider-effects'),usage=require('../entitlements/postgres-service');
  const claimed=await effects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {externalId:claimed.effect.providerReference?.externalId||null,replayed:true};
  const effect=claimed.effect,p=effect.payload;let posting=false,postReturned=false,reserved=false,usageScope=null;
  try{
    const opened=await books(database,workspaceId,p.connectorId);
    if(opened.reason)throw Object.assign(new ValidationError(opened.reason),{status:409});
    const box=opened.row;
    if(!p.providerAccountId||p.providerAccountId!==box.provider_account_id)throw Object.assign(new ValidationError('The connected company changed after this was queued. Nothing was sent.'),{status:409});
    const fresh=await authority(database,workspaceId,p,box);
    const adapter=options.provider||providers().get(box.provider_type);
    if(!adapter?.postDocument||!adapter.findDocument||!adapter.verifyDocument)throw Object.assign(new ValidationError(PROVIDERS[box.provider_type]+' cannot take invoices and bills here.'),{status:422});
    const connection=await require('../connections/postgres-service').get(database,workspaceId,box.id);
    const credentials=options.credentials||await require('../connections/postgres-provider-service').loadProviderCredentials(database,connection,adapter);
    usageScope=await usage.ownerScopeForWorkspace(database,workspaceId);
    const reservation=await usage.reserveUsage(database,usageScope,{meter:'accounting_syncs',units:1,idempotencyKey:effect.idempotencyKey,detail:{operation:'document_export',kind:p.kind,documentId:p.documentId}});
    if(!reservation.created)throw Object.assign(new ValidationError('This document has earlier usage evidence. A person checks it before another send.'),{status:409});
    reserved=true;
    const context=require('../commercial/context');
    const result=await context.run({...context.current(),database,scope:usageScope,funded:true,requestId:effect.idempotencyKey},async()=>{
      const existing=await adapter.findDocument({credentials,document:fresh.document});
      if(existing){
        // Already in the books under this number: linked only when it is the same document.
        try{return {...await adapter.verifyDocument({credentials,document:fresh.document,externalId:existing.externalId}),adopted:true};}
        catch(error){if(!(error instanceof ValidationError))throw error;
          throw Object.assign(new ValidationError(box.display_name+' already has '+label(p.kind,fresh.number)+' and it is different from StockChief’s. Nothing was sent; a person checks it.'),{status:409});}
      }
      posting=true;
      const posted=await adapter.postDocument({credentials,document:fresh.document,idempotencyKey:effect.idempotencyKey});
      postReturned=true;
      if(!posted?.externalId)throw new ValidationError('The books did not confirm the new '+p.kind+'.');
      await effects.checkpoint(database,workspaceId,effectId,effect.claimToken,{externalId:String(posted.externalId),version:posted.version??null,providerAccountId:box.provider_account_id,verificationPending:true});
      const verified=await adapter.verifyDocument({credentials,document:fresh.document,externalId:posted.externalId});
      if(verified?.verified!==true||String(verified.externalId)!==String(posted.externalId))throw new ValidationError('The books did not confirm the same '+p.kind+'.');
      return verified;
    });
    await effects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:{externalId:String(result.externalId),version:result.version??null,providerAccountId:box.provider_account_id,adopted:Boolean(result.adopted)},
      result:{externalId:String(result.externalId),adopted:Boolean(result.adopted)},apply:async c=>{
        await identify(c,workspaceId,p,result.externalId,result.version,fresh.document);
        await settle(c,workspaceId,p,{status:'SENT',reason:result.adopted?'The books already had this exact '+p.kind+'; StockChief linked it instead of sending another.':null,externalId:result.externalId});
        await usage.commitUsage(c,usageScope,{meter:'accounting_syncs',idempotencyKey:effect.idempotencyKey,occurredAt:require('../lib/util').nowIso(),detail:{operation:'document_export',connectorId:box.id,kind:p.kind,documentId:p.documentId}});
      }});
    return {externalId:String(result.externalId),adopted:Boolean(result.adopted),replayed:false};
  }catch(error){
    const ambiguous=postReturned||(posting&&!effects.definiteFailure(error));
    if(reserved&&!ambiguous)await usage.reverseUsage(database,usageScope,{meter:'accounting_syncs',idempotencyKey:effect.idempotencyKey,reason:error.message});
    await effects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous,apply:async c=>{
      await settle(c,workspaceId,p,ambiguous?{status:'UNCERTAIN',reason:'StockChief cannot tell whether the books took this: '+String(error.message).slice(0,300)+' It will not send it again until a person checks.'}
        :{status:'FAILED',reason:String(error.message).slice(0,500)});
    }});
    throw Object.assign(error,{code:ambiguous?'accounting_document_ambiguous':(error.code||'accounting_document_failed'),retryable:false});
  }
}

// ---- Journal export: what a document already carries ------------------------------

// For the journal export (a shared path). Lines a queued or sent document
// carries are left out of the journal. A document in scope that has not gone
// yet holds its books entry back, so nothing is counted twice.
async function coverage(db,workspaceId,connectorId,journalId){
  const none={covered:new Set(),waiting:[]};
  if(!await has(db,DOCS))return none;
  const settings=(await db.query(`SELECT * FROM ${SETTINGS} WHERE workspace_id=$1 AND connector_id=$2 AND enabled`,[workspaceId,connectorId])).rows[0];
  const journal=(await db.query('SELECT source_type,source_record_type,source_record_id FROM accounting_journal_entries WHERE workspace_id=$1 AND id=$2',[workspaceId,journalId])).rows[0];
  const order=journal?.source_type==='sale_fulfillment'&&journal.source_record_type==='sales_order'?journal.source_record_id:null;
  const rows=(await db.query(`SELECT document_kind,document_id,number,status,covered_lines FROM ${DOCS} d WHERE d.workspace_id=$1 AND d.connector_id=$2
    AND (d.journal_entry_id=$3 OR $4::text IS NOT NULL AND d.document_kind='invoice' AND d.document_id IN (SELECT id FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$4))`,
  [workspaceId,connectorId,journalId,order])).rows;
  if(!rows.length&&!settings)return none;
  const covered=new Set(rows.filter(r=>['QUEUED','SENT'].includes(r.status)).flatMap(r=>r.covered_lines||[]));
  const state=await policy.accountState(db,workspaceId);
  // A plan that no longer includes the job releases waiting entries to go as
  // journals; an unclear send still holds its entry until a person checks.
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return {covered,waiting:rows.filter(r=>r.status==='UNCERTAIN').map(r=>label(r.document_kind,r.number))};
  const waiting=rows.filter(r=>WAITING.includes(r.status)).map(r=>label(r.document_kind,r.number));
  if(settings){
    const unseen=(await db.query(`SELECT kind,number FROM (
        SELECT 'invoice' kind,i.id,i.invoice_number number FROM accounting_customer_invoices i WHERE i.workspace_id=$1 AND $3 AND (i.journal_entry_id=$2 OR $7::text IS NOT NULL AND i.sales_order_id=$7)
          AND i.issue_date>=$5 AND i.status IN ('OPEN','PARTIALLY_PAID','PAID')
        UNION ALL SELECT 'bill',b.id,coalesce(b.supplier_invoice_number,b.bill_number) FROM accounting_supplier_bills b WHERE b.workspace_id=$1 AND $4 AND b.journal_entry_id=$2 AND b.issue_date>=$5 AND b.status IN ('OPEN','PARTIALLY_PAID','PAID')
      ) d WHERE NOT EXISTS(SELECT 1 FROM ${DOCS} x WHERE x.workspace_id=$1 AND x.connector_id=$6 AND x.document_kind=d.kind AND x.document_id=d.id)`,
    [workspaceId,journalId,settings.invoices,settings.bills,settings.start_date,connectorId,order])).rows;
    waiting.push(...unseen.map(r=>label(r.kind,r.number)));
  }
  return {covered,waiting};
}

// ---- Owner actions ---------------------------------------------------------------

async function documentRow(db,workspaceId,connectorId,kind,id){
  if(!['invoice','bill'].includes(kind))throw new NotFoundError('That document was not found.');
  const row=await current(db,workspaceId,connectorId,kind,id);
  if(!row)throw new NotFoundError('That document was not found.');
  return row;
}

// A person approves the exact document. It is built again first; if anything
// changed it is shown again instead of being sent.
async function approve(db,ctx,connectorId,kind,id,input={}){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm the books and the exact amounts before sending.');
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const stop=await stopped(db,ctx.workspaceId,state,false);
  if(stop)throw new ValidationError(stop);
  const row=await documentRow(db,ctx.workspaceId,connectorId,kind,id);
  if(!['WATCHED','HELD','DRAFTED','FAILED'].includes(row.status))throw new ValidationError('This is no longer waiting for you.');
  const opened=await books(db,ctx.workspaceId,connectorId);
  if(opened.reason)throw new ValidationError(opened.reason);
  const fresh=await evaluate(db,ctx.workspaceId,opened.row,kind,id);
  if(fresh.status!=='READY'){await hold(db,ctx.workspaceId,ctx.actorId,opened.row,kind,id,fresh);throw new ValidationError(fresh.reason);}
  if(fresh.fingerprint!==input.expectedFingerprint){
    await tx(db,c=>record(c,ctx.workspaceId,connectorId,kind,id,{...fresh,status:row.status==='FAILED'?'FAILED':'DRAFTED',reason:row.reason,attempt:row.attempt}));
    throw new ValidationError('The records or links changed since this was prepared. Review the updated version before sending.');
  }
  return queue(db,ctx,opened.row,kind,id,{automatic:false,expectedFingerprint:fresh.fingerprint});
}

async function dismiss(db,ctx,connectorId,kind,id){
  return tx(db,async c=>{
    await owner(c,ctx);
    const row=(await c.query(`UPDATE ${DOCS} SET status='DISMISSED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND connector_id=$2 AND document_kind=$3 AND document_id=$4
      AND status IN ('WATCHED','HELD','DRAFTED','FAILED') RETURNING number`,[ctx.workspaceId,connectorId,kind,id])).rows[0];
    if(!row)throw new ValidationError('This is no longer waiting for you.');
    await audit(c,ctx,{action:'Invoice or bill left to go as a journal',reference:label(kind,row.number),after:{connectorId,kind,documentId:id,status:'DISMISSED'}});
  });
}

// An unclear send: look in the books. The same document there is linked;
// nothing there lets a person send it again. Nothing is posted here.
async function check(db,ctx,connectorId,kind,id){
  await owner(db,ctx);
  const row=await documentRow(db,ctx.workspaceId,connectorId,kind,id);
  if(row.status!=='UNCERTAIN')throw new ValidationError('Only a send StockChief could not confirm is checked here.');
  const opened=await books(db,ctx.workspaceId,connectorId);
  if(opened.reason)throw new ValidationError(opened.reason);
  const adapter=providers().get(opened.row.provider_type),document=typeof row.payload==='string'?JSON.parse(row.payload):row.payload;
  const connection=await require('../connections/postgres-service').get(db,ctx.workspaceId,connectorId);
  const found=await require('../commercial/operations').run(db,ctx.workspaceId,{capability:'connections.accounting',provider:opened.row.provider_type,operation:'accounting_verify',key:'accounting-document-check:'+connectorId+':'+kind+':'+id+':'+crypto.randomUUID()},async()=>{
    const credentials=await require('../connections/postgres-provider-service').loadProviderCredentials(db,connection,adapter);
    const existing=await adapter.findDocument({credentials,document});
    if(!existing)return null;
    return adapter.verifyDocument({credentials,document,externalId:existing.externalId});
  });
  return tx(db,async c=>{
    const p={connectorId,kind,documentId:id};
    if(found){await identify(c,ctx.workspaceId,p,found.externalId,found.version,document);await settle(c,ctx.workspaceId,p,{status:'SENT',reason:'A person checked: the books have this exact '+kind+'.',externalId:found.externalId});}
    else await settle(c,ctx.workspaceId,p,{status:'FAILED',reason:'A person checked: the books do not have it. You can send it again.'});
    await audit(c,ctx,{action:'Invoice or bill checked in the books',reference:label(kind,row.number),after:{connectorId,kind,documentId:id,found:Boolean(found)}});
    return {found:Boolean(found)};
  });
}

async function saveSettings(db,ctx,input={}){
  return tx(db,async c=>{
    await owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const connectorId=String(input.connectorId||'');
    const opened=await books(c,ctx.workspaceId,connectorId);
    if(!opened.row)throw new ValidationError(opened.reason);
    if(opened.reason&&input.enabled!=='no')throw new ValidationError(opened.reason);
    const invoices=[].concat(input.kinds||[]).includes('invoice'),bills=[].concat(input.kinds||[]).includes('bill');
    if(input.enabled!=='no'&&!invoices&&!bills)throw new ValidationError('Choose invoices, bills or both.');
    const today=await require('../lib/business-time').today(c,ctx.workspaceId);
    const start=String(input.startDate||'').trim()||today;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!Number.isFinite(Date.parse(start+'T00:00:00Z')))throw new ValidationError('Choose a start date.');
    const sendAlone=input.sendAlone==='yes'&&policy.allowance(state.plan,JOB)==='trained';
    const prior=(await c.query(`SELECT * FROM ${SETTINGS} WHERE workspace_id=$1 AND connector_id=$2 FOR UPDATE`,[ctx.workspaceId,connectorId])).rows[0];
    if(prior&&input.revision!=null&&input.revision!==''&&Number(input.revision)!==prior.revision)throw new ValidationError('These settings changed. Reload before saving.');
    const enabled=input.enabled!=='no';
    if(enabled&&sendAlone&&!(prior?.enabled&&prior?.send_alone))await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    const values=[ctx.workspaceId,connectorId,enabled,enabled?invoices:prior?.invoices??true,enabled?bills:prior?.bills??true,prior&&!enabled?prior.start_date:start,enabled&&sendAlone,ctx.actorId];
    if(prior)await c.query(`UPDATE ${SETTINGS} SET enabled=$3,invoices=$4,bills=$5,start_date=$6,send_alone=$7,updated_by=$8,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND connector_id=$2`,values);
    else await c.query(`INSERT INTO ${SETTINGS}(workspace_id,connector_id,enabled,invoices,bills,start_date,send_alone,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,values);
    await audit(c,ctx,{action:'Invoice and bill sending settings saved',reference:opened.row.display_name,
      before:prior?{enabled:prior.enabled,invoices:prior.invoices,bills:prior.bills,startDate:prior.start_date,sendAlone:prior.send_alone}:{},
      after:{enabled,invoices:values[3],bills:values[4],startDate:values[5],sendAlone:values[6]}});
  });
}

// Links the books need: a tax code, the QuickBooks product for an income
// account's sales, a customer or supplier, or an account.
async function saveMapping(db,ctx,input={}){
  const kind=String(input.kind||''),connectorId=String(input.connectorId||''),localKey=String(input.localKey||'').trim(),externalId=String(input.externalId||'').trim();
  if(!externalId||externalId.length>100)throw new ValidationError('Enter the identity your books use, up to 100 characters.');
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const opened=await books(db,ctx.workspaceId,connectorId);
  if(!opened.row)throw new ValidationError(opened.reason);
  const sync=require('./postgres-integration-sync');
  if(kind==='customer'||kind==='supplier'){await sync.mapParty(db,ctx,connectorId,{partyType:kind,partyId:localKey,externalId});}
  else if(kind==='account'){await sync.mapAccount(db,ctx,connectorId,{accountId:localKey,externalId});}
  else{
    if(kind==='tax_code'&&!Object.hasOwn(TAX_KEYS,localKey))throw new ValidationError('Choose taxed or untaxed sales or purchases.');
    if(kind==='sales_item'){
      if(opened.row.provider_type!=='quickbooks')throw new ValidationError('Only QuickBooks needs a product for each income account.');
      if(!(await db.query("SELECT 1 FROM accounting_accounts WHERE workspace_id=$1 AND id=$2 AND account_type='INCOME' AND active=1",[ctx.workspaceId,localKey])).rowCount)throw new ValidationError('Choose one of your income accounts.');
    }
    if(!['tax_code','sales_item'].includes(kind))throw new ValidationError('Choose what to link.');
    await tx(db,c=>c.query(`INSERT INTO ${MAPS}(workspace_id,connector_id,kind,local_key,external_id,mapped_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,connector_id,kind,local_key) DO UPDATE SET external_id=EXCLUDED.external_id,mapped_by=EXCLUDED.mapped_by,updated_at=clock_timestamp()`,
    [ctx.workspaceId,connectorId,kind,localKey,externalId,ctx.actorId]));
  }
  await tx(db,c=>audit(c,ctx,{action:'Invoice and bill link saved',reference:opened.row.display_name,after:{connectorId,kind,localKey,externalId}}));
}

// ---- Pages and Needs you --------------------------------------------------------

const OUTCOME={WATCHED:'Watched only',HELD:'Stopped for you',DRAFTED:'Waiting for your approval',QUEUED:'Sending',SENT:'In the books',FAILED:'Not sent',UNCERTAIN:'Check in the books',IN_BOOKS:'Already in the books as a journal',DISMISSED:'Goes as a journal'};
const href=r=>'/autopilot/accounting-documents/'+encodeURIComponent(r.connector_id)+'/'+r.document_kind+'/'+encodeURIComponent(r.document_id);

async function inbox(db,workspaceId){
  if(!await has(db,DOCS))return [];
  const rows=(await db.query(`SELECT d.*,c.display_name FROM ${DOCS} d JOIN workspace_connectors c ON c.workspace_id=d.workspace_id AND c.id=d.connector_id
    WHERE d.workspace_id=$1 AND (d.status='UNCERTAIN' OR d.status IN ('WATCHED','HELD','DRAFTED','FAILED') AND (
      d.document_kind='invoice' AND EXISTS(SELECT 1 FROM accounting_customer_invoices i WHERE i.workspace_id=d.workspace_id AND i.id=d.document_id AND i.status IN ('OPEN','PARTIALLY_PAID','PAID'))
      OR d.document_kind='bill' AND EXISTS(SELECT 1 FROM accounting_supplier_bills b WHERE b.workspace_id=d.workspace_id AND b.id=d.document_id AND b.status IN ('OPEN','PARTIALLY_PAID','PAID'))))
    ORDER BY d.updated_at DESC,d.document_id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>({kind:'accounting',importance:'Needs You',priority:r.status==='UNCERTAIN'?88:r.status==='DRAFTED'?82:r.status==='WATCHED'?60:80,
    title:r.status==='DRAFTED'?label(r.document_kind,r.number)+' is ready for '+r.display_name:r.status==='UNCERTAIN'?'Check '+label(r.document_kind,r.number)+' in '+r.display_name
      :r.status==='WATCHED'?'StockChief watched '+label(r.document_kind,r.number):label(r.document_kind,r.number)+' needs you before it goes to '+r.display_name,
    happened:label(r.document_kind,r.number)+(r.contact_name?' for '+r.contact_name:'')+(r.status==='UNCERTAIN'?' may or may not be in the books.':' has not gone to the books.'),
    why:r.reason||'A person decides.',recommendation:r.status==='DRAFTED'?'Check the amounts, then send it.':r.status==='UNCERTAIN'?'Check the books before anything is sent again.':'Fix what is missing, then send it, or let it go as a journal.',
    href:href(r),actionLabel:r.status==='DRAFTED'?'Review and send':'Review',sourceId:'accounting-document:'+r.connector_id+':'+r.document_kind+':'+r.document_id,
    createdAt:r.updated_at,timeLabel:'Updated',at:r.updated_at}));
}

async function review(db,ctx,{page=1,filter=''}={}){
  const state=await policy.accountState(db,ctx.workspaceId),training=policy.usesAgentTerms(state)&&policy.allowance(state.plan,JOB)==='trained';
  const summary='StockChief sends your open customer invoices and supplier bills to QuickBooks or Xero, built from their own books entries, and checks what the books show. '+
    (training?'Pro waits for your approval until you teach it, by the rule below or by sending one it prepared.':'Custom sends on its own.')+
    ' A missing link to a contact, account or tax code stops and asks. Nothing is counted twice: what an invoice or bill carries is left out of its journal.';
  if(!await has(db,DOCS))return {summary:'Invoices and bills are being upgraded. Try again shortly.',rows:[],more:false};
  const rows=(await db.query(`SELECT d.*,c.display_name FROM ${DOCS} d JOIN workspace_connectors c ON c.workspace_id=d.workspace_id AND c.id=d.connector_id
    WHERE d.workspace_id=$1 AND ($3='' OR lower(d.number)=lower($3) OR lower(coalesce(d.contact_name,''))=lower($3))
    ORDER BY d.updated_at DESC,d.document_id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(Math.max(1,Number(page)||1)-1)*100,String(filter||'').trim()])).rows;
  const settings=await settingsOf(db,ctx.workspaceId);
  const connectors=(await db.query(`SELECT c.id,c.display_name,c.provider_type FROM workspace_connectors c JOIN accounting_sync_policies p ON p.workspace_id=c.workspace_id AND p.connector_id=c.id
    WHERE c.workspace_id=$1 AND c.provider_type IN ('quickbooks','xero') AND c.status='connected' ORDER BY c.display_name,c.id`,[ctx.workspaceId])).rows;
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const needs=(await db.query(`SELECT DISTINCT ON (d.connector_id,d.need->>'kind',d.need->>'localKey') d.connector_id,d.need,c.display_name,c.provider_type FROM ${DOCS} d
    JOIN workspace_connectors c ON c.workspace_id=d.workspace_id AND c.id=d.connector_id WHERE d.workspace_id=$1 AND d.status='HELD' AND d.need IS NOT NULL
    ORDER BY d.connector_id,d.need->>'kind',d.need->>'localKey',d.updated_at DESC LIMIT 50`,[ctx.workspaceId])).rows;
  return {summary,more:rows.length>100,
    rows:rows.slice(0,100).map(r=>({Document:label(r.document_kind,r.number),Contact:r.contact_name||'',Books:r.display_name,Outcome:OUTCOME[r.status]+(r.automatic&&['QUEUED','SENT'].includes(r.status)?' by StockChief':''),link:href(r)})),
    accountingDocumentsForm:{training,today,
      books:connectors.map(c=>{const s=settings.find(x=>x.connector_id===c.id);return {id:c.id,name:c.display_name,provider:PROVIDERS[c.provider_type],
        enabled:Boolean(s?.enabled),invoices:s?s.invoices:true,bills:s?s.bills:true,startDate:s?.start_date||today,sendAlone:Boolean(s?.send_alone),revision:s?.revision??''};}),
      needs:needs.map(n=>({connectorId:n.connector_id,books:n.display_name,kind:n.need.kind,localKey:n.need.localKey,label:n.need.label,
        ask:{customer:'Customer in '+PROVIDERS[n.provider_type],supplier:'Supplier in '+PROVIDERS[n.provider_type],account:'Account in '+PROVIDERS[n.provider_type],
          sales_item:'QuickBooks product or service',tax_code:PROVIDERS[n.provider_type]+' tax code'}[n.need.kind]}))}};
}

async function detail(db,ctx,connectorId,kind,id){
  await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');
  const row=await documentRow(db,ctx.workspaceId,connectorId,kind,id);
  const box=(await db.query('SELECT display_name,provider_type FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,connectorId])).rows[0];
  const opened=await books(db,ctx.workspaceId,connectorId);
  let fresh=null;
  if(['WATCHED','HELD','DRAFTED','FAILED'].includes(row.status)&&!opened.reason)fresh=await evaluate(db,ctx.workspaceId,opened.row,kind,id);
  const document=fresh?.document||(typeof row.payload==='string'?JSON.parse(row.payload):row.payload);
  const amount=v=>money.fromMinor(v,document?.currency||'USD');
  return {document:{title:label(kind,row.number),contact:row.contact_name,books:box?.display_name,provider:PROVIDERS[box?.provider_type]||'',outcome:OUTCOME[row.status],status:row.status,
      reason:fresh&&fresh.status!=='READY'?fresh.reason:row.reason,automatic:row.automatic,
      lines:document?document.lines.map(l=>({description:l.description,amount:amount(l.amount)})):[],
      total:document?amount(document.total):null,tax:document?amount(document.tax):null,currency:document?.currency||null,taxCode:document?.taxCode||null,
      issueDate:document?.issueDate||null},
    connectorId,kind,id,fingerprint:fresh?.status==='READY'?fresh.fingerprint:null,booksProblem:opened.reason||null,
    canSend:fresh?.status==='READY',canCheck:row.status==='UNCERTAIN',canDismiss:['WATCHED','HELD','DRAFTED','FAILED'].includes(row.status)};
}

module.exports={JOB,KIND,EFFECT,path,TAX_KEYS,shape,mapping,evaluate,decide,waitReason,taught,run,schedule,queue,executeEffect,coverage,approve,dismiss,check,saveSettings,saveMapping,inbox,review,detail,
  definition:{id:JOB,key,label:'Send invoices and bills to QuickBooks or Xero',filterLabel:'Invoice or bill number, or customer or supplier',readPage:review}};
