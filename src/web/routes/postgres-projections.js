'use strict';

const express=require('express');
const projections=require('../../projections/postgres-service');
const reports=require('../../accounting/postgres-reports');
const ledger=require('../../accounting/postgres-ledger');
const workflows=require('../../operations/postgres-business-workflows');
const presenters=require('../postgres-presenters');
const permissions=require('../../actions/permissions');
const { requireAuth,requirePermission,asyncRoute }=require('../middleware');
const { newId,nowIso,trimOrNull }=require('../../lib/util');
const { ValidationError }=require('../../domain/errors');

function period(query){
  const to=String(query.to || new Date().toISOString().slice(0,10));
  return {from:String(query.from || `${to.slice(0,7)}-01`),to};
}

function moneyMinor(value,label){const text=String(value??'').trim();if(!/^\d+(?:\.\d{1,2})?$/.test(text))
  throw new ValidationError(`${label} must be a positive money amount.`);const amount=Math.round(Number(text)*100);
  if(!Number.isSafeInteger(amount)||amount<=0)throw new ValidationError(`${label} must be above zero.`);return amount;}

function positivePage(value){const page=Number.parseInt(value,10);return Number.isInteger(page)&&page>0?page:1;}
function zeroBasedIndex(value){const index=Number.parseInt(value,10);return Number.isInteger(index)&&index>=0?index:0;}

function movementSentence(row){const quantity=Math.abs(Number(row.quantity_delta));const product=row.variant_label||row.item_name;
  if(row.operation==='receive')return `Received ${quantity} × ${product} into ${row.location_name}.`;
  if(row.operation==='issue')return `Issued ${quantity} × ${product} from ${row.location_name}.`;
  if(row.operation==='adjust')return `Corrected ${product} by ${Number(row.quantity_delta)>0?'+':''}${row.quantity_delta} at ${row.location_name}.`;
  if(row.operation==='transfer_out')return `Sent ${quantity} × ${product} from ${row.location_name}.`;
  if(row.operation==='transfer_in')return `Received ${quantity} × ${product} at ${row.location_name} from another location.`;
  return `${String(row.operation).replaceAll('_',' ')} ${quantity} × ${product} at ${row.location_name}.`;
}

async function activityPage(database,workspaceId,query){const page=positivePage(query.page);const pageSize=50;
  const filters={operation:trimOrNull(query.operation)||'',itemId:trimOrNull(query.item)||'',
    locationId:trimOrNull(query.location)||'',actorId:trimOrNull(query.user)||'',
    dateFrom:trimOrNull(query.from)||'',dateTo:trimOrNull(query.to)||''};const search=trimOrNull(query.q)||'';
  const values=[workspaceId];const clauses=['m.workspace_id=$1'];const add=(sql,value)=>{values.push(value);clauses.push(sql.replace('?',`$${values.length}`));};
  if(filters.operation)add('m.operation=?',filters.operation);if(filters.itemId)add('m.item_id=?',filters.itemId);
  if(filters.locationId)add('m.location_id=?',filters.locationId);if(filters.actorId)add('m.actor_user_id=?',filters.actorId);
  if(filters.dateFrom)add('m.occurred_at>=?',`${filters.dateFrom}T00:00:00.000Z`);
  if(filters.dateTo)add('m.occurred_at<?',`${filters.dateTo}T23:59:59.999Z`);
  if(search){values.push(`%${search}%`);const index=values.length;clauses.push(`(i.name ILIKE $${index} OR s.code ILIKE $${index}
    OR COALESCE(m.reference,'') ILIKE $${index} OR COALESCE(m.notes,'') ILIKE $${index} OR l.name ILIKE $${index})`);}
  const where=clauses.join(' AND ');const count=(await database.query(`SELECT COUNT(*) AS count FROM movements m
    JOIN items i ON i.id=m.item_id AND i.workspace_id=m.workspace_id JOIN skus s ON s.id=m.sku_id AND s.workspace_id=m.workspace_id
    JOIN locations l ON l.id=m.location_id AND l.workspace_id=m.workspace_id WHERE ${where}`,values)).rows[0];
  values.push(pageSize+1,(page-1)*pageSize);const rows=(await database.query(`SELECT m.*,i.name AS item_name,
    s.code,s.variant_label,l.name AS location_name,u.name AS actor_name FROM movements m
    JOIN items i ON i.id=m.item_id AND i.workspace_id=m.workspace_id JOIN skus s ON s.id=m.sku_id AND s.workspace_id=m.workspace_id
    JOIN locations l ON l.id=m.location_id AND l.workspace_id=m.workspace_id LEFT JOIN users u ON u.id=m.actor_user_id
    WHERE ${where} ORDER BY m.occurred_at DESC,m.seq DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values)).rows;
  const hasMore=rows.length>pageSize;const visible=rows.slice(0,pageSize);const groups=visible.map((row)=>({operation:row.operation,
    itemId:row.item_id,displayName:row.variant_label||row.item_name,sentence:movementSentence(row),actorName:row.actor_name||'StockChief',
    occurredAt:row.occurred_at,reasonLabel:null,reference:row.reference,notes:row.notes}));
  const events=visible.map((row)=>({stream:'inventory',at:row.occurred_at,title:movementSentence(row),
    detail:[row.reference&&`Reference ${row.reference}`,row.notes].filter(Boolean).join(' · '),who:row.actor_name||'StockChief',href:`/inventory/${row.item_id}`}));
  const [locations,users,items]=await Promise.all([
    database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 ORDER BY is_active DESC,name,id`,[workspaceId]),
    database.query(`SELECT id,name FROM users WHERE workspace_id=$1 ORDER BY name,id`,[workspaceId]),
    database.query(`SELECT id,name FROM items WHERE workspace_id=$1 ORDER BY is_active DESC,name,id LIMIT 200`,[workspaceId])]);
  const total=Number(count.count);return {page,pageSize,hasMore,total,filters,groups,locations:locations.rows,users:users.rows,
    items:items.rows,stream:'inventory',query:search,streams:['inventory'],
    streamLabels:{all:'All activity',inventory:'Inventory',purchasing:'Purchasing',foundry:'StockChief',exception:'Exceptions',system:'System'},
    log:{events,counts:{all:total,inventory:total},quietChecks:0}};}

function aging(rows){const today=Date.now();const buckets={current:0,days1to30:0,days31to60:0,days61to90:0,over90:0};let totalMinor=0;
  for(const row of rows){if(!['OPEN','PARTIALLY_PAID'].includes(row.status))continue;const balance=Number(row.balance_minor||0);totalMinor+=balance;
    const due=row.due_date?Math.floor((today-Date.parse(row.due_date))/86400000):-1;
    if(due<=0)buckets.current+=balance;else if(due<=30)buckets.days1to30+=balance;else if(due<=60)buckets.days31to60+=balance;
    else if(due<=90)buckets.days61to90+=balance;else buckets.over90+=balance;}
  return {totalMinor,buckets};}

function createPostgresProjectionsRouter(database){
  const router=express.Router();
  router.get(['/', '/overview'],requireAuth,asyncRoute(async(req,res)=>{
    const result=await presenters.home(database,req.ctx.workspaceId);
    res.locals.attentionCount=result.brief.needs.length;
    return res.page('foundry/brief',{title:'StockChief',nav:'home',room:true,...result,
      stats:result.brief.stats,brief:{body:'',source:'deterministic',createdAt:null},activeMigration:null,
      routineProposal:null,financialPulse:null,observedBrief:'',canOperate:permissions.can(req.user,permissions.OPERATE)});
  }));
  router.get(['/needs-you','/needs-you/all'],requireAuth,asyncRoute(async(req,res)=>{
    const items=await projections.needs(database,req.ctx.workspaceId);res.locals.attentionCount=items.length;
    items.coverageErrors=[];
    return res.page('manager/needs-you',{title:'Needs you',nav:'attention',room:true,inbox:items,at:zeroBasedIndex(req.query.at)});
  }));
  router.get('/activity',requireAuth,asyncRoute(async(req,res)=>{
    return res.page('activity/list',{title:'Activity',nav:'history',backToFallback:{href:'/everything',label:'Everything else'},
      ...(await activityPage(database,req.ctx.workspaceId,req.query))});
  }));
  router.get(['/money','/accounting'],requireAuth,asyncRoute(async(req,res)=>{
    const result=await presenters.money(database,req.ctx.workspaceId,period(req.query));
    return res.page('accounting/money',{title:'Money',nav:'accounting',room:true,...result,
      configured:{enabled:true,currency:result.story.currency},period:{key:'custom',from:result.from,to:result.to,label:'Current period'}});
  }));
  router.get(['/accounting/books','/money/books'],requireAuth,(req,res)=>res.redirect(302,'/money'));
  router.get('/accounting/transactions',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view accounting transactions'),asyncRoute(async(req,res)=>{const dates=period(req.query);
    const entries=(await database.query(`SELECT * FROM accounting_journal_entries WHERE workspace_id=$1 AND status='POSTED'
      AND posting_date BETWEEN $2 AND $3 ORDER BY posting_date DESC,entry_number DESC`,[req.ctx.workspaceId,dates.from,dates.to])).rows;
    return res.page('accounting/transactions',{title:'Accounting transactions',nav:'accounting',from:dates.from,to:dates.to,
      rows:[],entries});
  }));
  router.get('/accounting/chart',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view the chart of accounts'),asyncRoute(async(req,res)=>res.page('accounting/chart',{
    title:'Chart of accounts',nav:'accounting',accounts:(await database.query(`SELECT * FROM accounting_accounts
      WHERE workspace_id=$1 ORDER BY code,id`,[req.ctx.workspaceId])).rows,
  })));
  router.post('/accounting/chart',requireAuth,requirePermission(permissions.MANAGE_ACCOUNTING,'add accounting accounts'),asyncRoute(async(req,res)=>{const code=trimOrNull(req.body.code);const name=trimOrNull(req.body.name);
    const type=String(req.body.type||'');const normal=String(req.body.normalBalance||'');
    if(!code||!name||!['ASSET','LIABILITY','EQUITY','INCOME','COGS','EXPENSE'].includes(type)||!['DEBIT','CREDIT'].includes(normal))
      throw new ValidationError('Enter a valid account code, name, type and normal balance.');const at=nowIso();
    await database.query(`INSERT INTO accounting_accounts(id,workspace_id,code,name,account_type,subtype,normal_balance,is_control,active,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,0,1,$8,$8)`,[newId('acct'),req.ctx.workspaceId,code,name,type,trimOrNull(req.body.subtype),normal,at]);
    req.flash('success','Account added to this inventory’s chart.');return res.redirect(303,'/accounting/chart');
  }));
  router.get('/accounting/periods',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view accounting periods'),asyncRoute(async(req,res)=>res.page('accounting/periods',{
    title:'Accounting periods',nav:'accounting',periods:(await database.query(`SELECT * FROM accounting_periods
      WHERE workspace_id=$1 ORDER BY starts_on DESC,id DESC`,[req.ctx.workspaceId])).rows,today:new Date().toISOString().slice(0,10),
  })));
  router.post('/accounting/periods/:id/close',requireAuth,requirePermission(permissions.CLOSE_ACCOUNTING_PERIOD,'close accounting periods'),asyncRoute(async(req,res)=>{const changed=await database.query(`UPDATE accounting_periods
      SET status='CLOSED',closed_by_user_id=$3,closed_at=$4,close_note=$5 WHERE workspace_id=$1 AND id=$2 AND status='OPEN' RETURNING id`,
    [req.ctx.workspaceId,req.params.id,req.ctx.actorId,nowIso(),trimOrNull(req.body.note)]);
    if(!changed.rows.length)throw new ValidationError('That period is already closed or unavailable.');
    req.flash('success','Period closed. Later corrections must preserve the posted history.');return res.redirect(303,'/accounting/periods');
  }));
  async function subledger(req,res,kind){const payable=kind==='payables';const table=payable?'accounting_supplier_bills':'accounting_customer_invoices';
    const party=payable?'suppliers':'customers';const partyKey=payable?'supplier_id':'customer_id';const partyName=payable?'supplier_name':'customer_name';
    const extra=payable?`,b.purchase_order_id,po.po_number,b.supplier_invoice_number,b.match_status`:'';
    const join=payable?'LEFT JOIN purchase_orders po ON po.id=b.purchase_order_id':'';
    const rows=(await database.query(`SELECT b.*,p.name AS ${partyName}${extra} FROM ${table} b JOIN ${party} p ON p.id=b.${partyKey}
      ${join} WHERE b.workspace_id=$1 ORDER BY COALESCE(b.due_date,'9999-12-31'),b.created_at DESC`,[req.ctx.workspaceId])).rows;
    const counterparties=(await database.query(`SELECT id,name FROM ${party} WHERE workspace_id=$1 ${payable?"AND status='active'":''} ORDER BY lower(name)`,
      [req.ctx.workspaceId])).rows;
    return res.page('accounting/subledger',{title:payable?'Bills to pay':'Money customers owe',nav:'accounting',kind,rows,
      aging:aging(rows),counterparties,canPay:permissions.can(req.user,permissions.RECORD_PAYMENTS),
      canReview:payable&&permissions.can(req.user,permissions.MANAGE_ACCOUNTING)});}
  router.get('/accounting/receivables',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view receivables'),asyncRoute((req,res)=>subledger(req,res,'receivables')));
  router.get('/accounting/payables',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view payables'),asyncRoute((req,res)=>subledger(req,res,'payables')));
  router.post('/accounting/receivables/:id/payment',requireAuth,requirePermission(permissions.RECORD_PAYMENTS,'record customer payments'),asyncRoute(async(req,res)=>{
    const invoice=(await database.query(`SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id])).rows[0];if(!invoice)throw new ValidationError('That customer invoice was not found.');
    await workflows.recordCustomerPayment(database,req.ctx,{customerId:invoice.customer_id,customerInvoiceId:invoice.id,
      paymentDate:req.body.paymentDate,amountMinor:moneyMinor(req.body.amount,'Payment amount'),method:trimOrNull(req.body.method),
      reference:trimOrNull(req.body.reference),idempotencyKey:trimOrNull(req.body.idempotencyKey)||newId('customer-payment')});
    req.flash('success',`Payment recorded against ${invoice.invoice_number}.`);return res.redirect(303,'/accounting/receivables');
  }));
  router.post('/accounting/payables/:id/payment',requireAuth,requirePermission(permissions.RECORD_PAYMENTS,'record supplier payments'),asyncRoute(async(req,res)=>{
    const bill=(await database.query(`SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id])).rows[0];if(!bill)throw new ValidationError('That supplier bill was not found.');
    await workflows.recordSupplierPayment(database,req.ctx,{supplierId:bill.supplier_id,supplierBillId:bill.id,
      paymentDate:req.body.paymentDate,amountMinor:moneyMinor(req.body.amount,'Payment amount'),method:trimOrNull(req.body.method),
      reference:trimOrNull(req.body.reference),idempotencyKey:trimOrNull(req.body.idempotencyKey)||newId('supplier-payment')});
    req.flash('success',`Payment recorded against ${bill.bill_number}.`);const returnTo=String(req.body.returnTo||'');
    return res.redirect(303,/^\/purchasing\/orders\/[A-Za-z0-9_-]+$/.test(returnTo)?returnTo:'/accounting/payables');
  }));
  router.get('/accounting/adjustments/new',requireAuth,requirePermission(permissions.MANAGE_ACCOUNTING,'create accounting adjustments'),asyncRoute(async(req,res)=>{
    const accounts=(await database.query(`SELECT * FROM accounting_accounts WHERE workspace_id=$1 AND active=1 ORDER BY code,id`,
      [req.ctx.workspaceId])).rows;
    return res.page('accounting/adjustment-new',{title:'New accounting adjustment',nav:'accounting',today:new Date().toISOString().slice(0,10),accounts});
  }));
  router.post('/accounting/adjustments',requireAuth,requirePermission(permissions.MANAGE_ACCOUNTING,'create accounting adjustments'),asyncRoute(async(req,res)=>{
    if(req.body.debitAccountId===req.body.creditAccountId)throw new ValidationError('Choose two different accounts for an adjustment.');
    const amountMinor=moneyMinor(req.body.amount,'Adjustment amount');const posted=await ledger.post(database,req.ctx,{
      postingDate:req.body.postingDate,description:req.body.description,sourceType:'manual_adjustment',sourceRecordType:'manual_adjustment',
      sourceKey:`manual-adjustment:${newId('form')}`,createdByType:'USER',metadata:{reason:trimOrNull(req.body.reason)},lines:[
        {accountId:req.body.debitAccountId,debitMinor:amountMinor,memo:trimOrNull(req.body.reason)},
        {accountId:req.body.creditAccountId,creditMinor:amountMinor,memo:trimOrNull(req.body.reason)}]});
    req.flash('success',`Adjustment #${posted.entry.entry_number} posted. It remains reversible and auditable.`);
    return res.redirect(303,`/accounting/entries/${posted.entry.id}`);
  }));
  router.get('/accounting/tax',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view tax accounting'),asyncRoute(async(req,res)=>{const [rates,balances,settings]=await Promise.all([
    database.query(`SELECT * FROM accounting_tax_rates WHERE workspace_id=$1 ORDER BY effective_from DESC,name`,[req.ctx.workspaceId]),
    database.query(`SELECT a.system_key,COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit_minor-l.credit_minor ELSE 0 END),0)::bigint AS balance FROM accounting_accounts a
      LEFT JOIN accounting_journal_lines l ON l.account_id=a.id AND l.workspace_id=a.workspace_id
      LEFT JOIN accounting_journal_entries e ON e.id=l.entry_id AND e.status='POSTED'
      WHERE a.workspace_id=$1 AND a.system_key IN ('SALES_TAX_PAYABLE','SALES_TAX_RECOVERABLE') GROUP BY a.system_key`,[req.ctx.workspaceId]),
    database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[req.ctx.workspaceId])]);
    const byKey=Object.fromEntries(balances.rows.map((row)=>[row.system_key,Number(row.balance)]));
    return res.page('accounting/tax',{title:'Sales-tax records',nav:'accounting',rates:rates.rows,
      payableMinor:Math.max(0,-Number(byKey.SALES_TAX_PAYABLE||0)),recoverableMinor:Math.max(0,Number(byKey.SALES_TAX_RECOVERABLE||0)),
      currency:settings.rows[0]?.base_currency||'USD',today:new Date().toISOString().slice(0,10)});
  }));
  router.post('/accounting/tax/rates',requireAuth,requirePermission(permissions.MANAGE_ACCOUNTING,'configure tax rates'),asyncRoute(async(req,res)=>{const percent=Number(req.body.ratePercent);
    if(!Number.isFinite(percent)||percent<0||percent>100)throw new ValidationError('Tax rate must be between 0 and 100 percent.');
    const at=nowIso();await database.query(`INSERT INTO accounting_tax_rates(id,workspace_id,name,jurisdiction,rate_millionths,
      applies_to,effective_from,effective_to,active,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$10)`,[newId('tax'),req.ctx.workspaceId,trimOrNull(req.body.name),
      trimOrNull(req.body.jurisdiction),Math.round(percent*10000),req.body.appliesTo||'SALES',req.body.effectiveFrom,
      trimOrNull(req.body.effectiveTo),req.ctx.actorId,at]);req.flash('success','Dated tax rate saved.');return res.redirect(303,'/accounting/tax');
  }));
  router.get('/accounting/banking',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view banking and reconciliation'),asyncRoute(async(req,res)=>{const [banks,accounts,transactions,reconciliations,payments,journals]=await Promise.all([
    database.query(`SELECT b.*,a.code AS ledger_account_code,a.name AS ledger_account_name FROM accounting_bank_accounts b
      JOIN accounting_accounts a ON a.id=b.ledger_account_id WHERE b.workspace_id=$1 AND b.active=1 ORDER BY b.name`,[req.ctx.workspaceId]),
    database.query(`SELECT id,code,name FROM accounting_accounts WHERE workspace_id=$1 AND active=1 AND account_type IN ('ASSET','LIABILITY') ORDER BY code`,[req.ctx.workspaceId]),
    database.query(`SELECT t.*,b.name AS bank_name FROM accounting_bank_transactions t JOIN accounting_bank_accounts b ON b.id=t.bank_account_id
      WHERE t.workspace_id=$1 ORDER BY t.transaction_date DESC,t.id DESC LIMIT 200`,[req.ctx.workspaceId]),
    database.query(`SELECT r.*,b.name AS bank_name FROM accounting_reconciliations r JOIN accounting_bank_accounts b ON b.id=r.bank_account_id
      WHERE r.workspace_id=$1 ORDER BY r.statement_end_date DESC,r.id DESC`,[req.ctx.workspaceId]),
    database.query(`SELECT p.*,COALESCE(c.name,s.name,'Unknown') AS counterparty FROM accounting_payments p LEFT JOIN customers c ON c.id=p.customer_id
      LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.workspace_id=$1 ORDER BY p.payment_date DESC LIMIT 100`,[req.ctx.workspaceId]),
    database.query(`SELECT id,entry_number,posting_date,description FROM accounting_journal_entries WHERE workspace_id=$1 AND status='POSTED'
      ORDER BY posting_date DESC,entry_number DESC LIMIT 100`,[req.ctx.workspaceId])]);
    return res.page('accounting/banking',{title:'Banking and reconciliation',nav:'accounting',banks:banks.rows,accounts:accounts.rows,
      transactions:transactions.rows,reconciliations:reconciliations.rows,paymentMatches:payments.rows,journalMatches:journals.rows,
      today:new Date().toISOString().slice(0,10)});
  }));
  router.get('/foundry/briefing',requireAuth,(req,res)=>res.redirect(302,'/'));
  router.get('/accounting/reports/:kind',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view financial reports'),asyncRoute(async(req,res)=>{
    const dates=period(req.query);let report;let title;
    if(req.params.kind==='profit-and-loss'){report=await reports.profitAndLoss(database,req.ctx.workspaceId,dates);title='Profit and loss';}
    else if(req.params.kind==='balance-sheet'){report=await reports.balanceSheet(database,req.ctx.workspaceId,{asOf:req.query.asOf || dates.to});title='Balance sheet';}
    else if(req.params.kind==='trial-balance'){report=await reports.trialBalance(database,req.ctx.workspaceId,dates);title='Trial balance';}
    else if(req.params.kind==='general-ledger'){report=await reports.generalLedger(database,req.ctx.workspaceId,dates);title='General ledger';}
    else return res.status(404).page('error',{title:'Report not found',status:404,message:'That report does not exist.'});
    return res.page('accounting/report',{title,nav:'accounting',kind:req.params.kind,report,from:dates.from,to:dates.to,
      configured:{currency:report.currency || 'USD'}});
  }));
  router.get('/accounting/entries/:id',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view journal entries'),asyncRoute(async(req,res)=>{
    const entry=(await database.query(`SELECT * FROM accounting_journal_entries WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id])).rows[0];
    if(!entry)return res.status(404).page('error',{title:'Entry not found',status:404,message:'That journal entry does not exist.'});
    const lines=(await database.query(`SELECT l.*,a.code AS account_code,a.name AS account_name FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.id=l.account_id WHERE l.workspace_id=$1 AND l.entry_id=$2 ORDER BY l.line_number`,
    [req.ctx.workspaceId,entry.id])).rows;
    entry.lines=lines;return res.page('accounting/entry',{title:`Entry #${entry.entry_number}`,nav:'accounting',entry,ownerExplanation:null});
  }));
  router.post('/accounting/entries/:id/reverse',requireAuth,requirePermission(permissions.MANAGE_ACCOUNTING,'reverse journal entries'),asyncRoute(async(req,res)=>{
    const entry=(await database.query(`SELECT * FROM accounting_journal_entries WHERE workspace_id=$1 AND id=$2`,
      [req.ctx.workspaceId,req.params.id])).rows[0];if(!entry)throw new ValidationError('That journal entry does not exist.');
    if(entry.reversal_of_entry_id)throw new ValidationError('A reversal entry cannot itself be reversed from this screen.');
    const lines=(await database.query(`SELECT l.* FROM accounting_journal_lines l WHERE l.workspace_id=$1 AND l.entry_id=$2 ORDER BY l.line_number`,
      [req.ctx.workspaceId,entry.id])).rows;const posted=await ledger.post(database,req.ctx,{postingDate:req.body.postingDate,
      description:`Reversal of entry #${entry.entry_number}: ${trimOrNull(req.body.reason)||entry.description}`,
      sourceType:'journal_reversal',sourceRecordType:'journal_entry',sourceRecordId:entry.id,sourceKey:`journal-reversal:${entry.id}`,
      createdByType:'USER',reversalOfEntryId:entry.id,metadata:{reversalOfEntryId:entry.id,reason:trimOrNull(req.body.reason)},lines:lines.map((line)=>({
        accountId:line.account_id,debitMinor:Number(line.credit_minor),creditMinor:Number(line.debit_minor),memo:`Reversal of entry #${entry.entry_number}`}))});
    req.flash('success',`Correction posted as entry #${posted.entry.entry_number}. The original remains unchanged.`);
    return res.redirect(303,`/accounting/entries/${posted.entry.id}`);
  }));
  return router;
}

module.exports={createPostgresProjectionsRouter};
