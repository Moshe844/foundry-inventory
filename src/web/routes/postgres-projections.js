'use strict';

const express=require('express');
const projections=require('../../projections/postgres-service');
const reports=require('../../accounting/postgres-reports');
const presenters=require('../postgres-presenters');
const permissions=require('../../actions/permissions');
const { requireAuth,requirePermission,asyncRoute }=require('../middleware');
const { newId,nowIso,trimOrNull }=require('../../lib/util');
const { ValidationError }=require('../../domain/errors');

function period(query){
  const to=String(query.to || new Date().toISOString().slice(0,10));
  return {from:String(query.from || `${to.slice(0,7)}-01`),to};
}

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
    return res.page('manager/postgres-needs-you',{title:'Needs you',nav:'attention',room:true,items});
  }));
  router.get('/activity',requireAuth,asyncRoute(async(req,res)=>{
    const activity=(await projections.brief(database,req.ctx.workspaceId)).activity;
    return res.page('inventory/postgres-activity',{title:'Activity',nav:'history',activity});
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
    return res.page('accounting/subledger',{title:payable?'Bills to pay':'Money customers owe',nav:'accounting',kind,rows,
      aging:aging(rows),counterparties:[],canPay:false,canReview:false});}
  router.get('/accounting/receivables',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view receivables'),asyncRoute((req,res)=>subledger(req,res,'receivables')));
  router.get('/accounting/payables',requireAuth,requirePermission(permissions.VIEW_ACCOUNTING,'view payables'),asyncRoute((req,res)=>subledger(req,res,'payables')));
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
    return res.page('accounting/postgres-entry',{title:`Entry #${entry.entry_number}`,nav:'accounting',entry,lines});
  }));
  return router;
}

module.exports={createPostgresProjectionsRouter};
