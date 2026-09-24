'use strict';

const express=require('express');
const projections=require('../../projections/postgres-service');
const reports=require('../../accounting/postgres-reports');
const { requireAuth,asyncRoute }=require('../middleware');

function period(query){
  const to=String(query.to || new Date().toISOString().slice(0,10));
  return {from:String(query.from || `${to.slice(0,7)}-01`),to};
}

function createPostgresProjectionsRouter(database){
  const router=express.Router();
  router.get(['/', '/overview'],requireAuth,asyncRoute(async(req,res)=>{
    const result=await projections.brief(database,req.ctx.workspaceId);
    res.locals.attentionCount=result.needs.length;
    return res.page('foundry/postgres-brief',{title:'StockChief',nav:'home',room:true,...result,
      isEmpty:result.stats.itemCount===0});
  }));
  router.get('/needs-you',requireAuth,asyncRoute(async(req,res)=>{
    const items=await projections.needs(database,req.ctx.workspaceId);res.locals.attentionCount=items.length;
    return res.page('manager/postgres-needs-you',{title:'Needs you',nav:'attention',room:true,items});
  }));
  router.get('/activity',requireAuth,asyncRoute(async(req,res)=>{
    const activity=(await projections.brief(database,req.ctx.workspaceId)).activity;
    return res.page('inventory/postgres-activity',{title:'Activity',nav:'history',activity});
  }));
  router.get(['/money','/accounting'],requireAuth,asyncRoute(async(req,res)=>{
    const dates=period(req.query);const [pnl,balance,receivables,payables]=await Promise.all([
      reports.profitAndLoss(database,req.ctx.workspaceId,dates),
      reports.balanceSheet(database,req.ctx.workspaceId,{asOf:dates.to}),
      database.query(`SELECT COALESCE(SUM(balance_minor),0) AS amount FROM accounting_customer_invoices
        WHERE workspace_id=$1 AND status IN ('OPEN','PARTIALLY_PAID')`,[req.ctx.workspaceId]),
      database.query(`SELECT COALESCE(SUM(balance_minor),0) AS amount FROM accounting_supplier_bills
        WHERE workspace_id=$1 AND status IN ('OPEN','PARTIALLY_PAID','DISPUTED')`,[req.ctx.workspaceId]),
    ]);
    return res.page('accounting/postgres-money',{title:'Money',nav:'accounting',pnl,balance,from:dates.from,to:dates.to,
      receivableMinor:Number(receivables.rows[0].amount),payableMinor:Number(payables.rows[0].amount)});
  }));
  router.get('/accounting/reports/:kind',requireAuth,asyncRoute(async(req,res)=>{
    const dates=period(req.query);let report;let title;
    if(req.params.kind==='profit-and-loss'){report=await reports.profitAndLoss(database,req.ctx.workspaceId,dates);title='Profit and loss';}
    else if(req.params.kind==='balance-sheet'){report=await reports.balanceSheet(database,req.ctx.workspaceId,{asOf:req.query.asOf || dates.to});title='Balance sheet';}
    else if(req.params.kind==='trial-balance'){report=await reports.trialBalance(database,req.ctx.workspaceId,dates);title='Trial balance';}
    else if(req.params.kind==='general-ledger'){report=await reports.generalLedger(database,req.ctx.workspaceId,dates);title='General ledger';}
    else return res.status(404).page('error',{title:'Report not found',status:404,message:'That report does not exist.'});
    return res.page('accounting/report',{title,nav:'accounting',kind:req.params.kind,report,from:dates.from,to:dates.to,
      configured:{currency:report.currency || 'USD'}});
  }));
  router.get('/accounting/entries/:id',requireAuth,asyncRoute(async(req,res)=>{
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
