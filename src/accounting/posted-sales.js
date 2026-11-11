'use strict';
// "Sales this period" has one meaning everywhere: revenue posted to the books,
// over the business's own calendar. Orders, Money and Reports all read this.
const reports=require('./postgres-reports'),clock=require('../lib/business-time');
async function forPeriod(db,workspaceId,period){const pnl=await reports.profitAndLoss(db,workspaceId,period);return {from:pnl.from,to:pnl.to,minor:pnl.revenueMinor,currency:pnl.currency};}
async function thisMonth(db,workspaceId){const today=(await clock.forWorkspace(db,workspaceId)).calendarDate;return forPeriod(db,workspaceId,{from:today.slice(0,7)+'-01',to:today});}
// The same revenue, day by day: what each posted day added to the period's total, so
// the days always add up to forPeriod. Only the period's own entries and the income
// accounts' lines are read; a period too busy for that answers null instead of
// scanning the ledger.
const DAY=/^\d{4}-\d{2}-\d{2}$/;
async function byDay(db,workspaceId,{from,to}){
 if(!DAY.test(String(from))||!DAY.test(String(to))||from>to)throw new RangeError('Daily sales need a from and to date.');
 const entries=Number((await db.query(`SELECT count(*) AS n FROM (SELECT 1 FROM accounting_journal_entries
  WHERE workspace_id=$1 AND status='POSTED' AND posting_date<=$2 AND posting_date>=$3 LIMIT 20001) bounded`,[workspaceId,to,from])).rows[0].n);
 if(entries>20000)return null;
 const rows=(await db.query(`WITH income AS MATERIALIZED (
   SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND account_type='INCOME'
  ), period AS MATERIALIZED (
   SELECT id,posting_date FROM accounting_journal_entries WHERE workspace_id=$1 AND status='POSTED' AND posting_date<=$2 AND posting_date>=$3
  ) SELECT p.posting_date AS day,SUM(l.credit_minor)-SUM(l.debit_minor) AS minor
  FROM accounting_journal_lines l JOIN period p ON p.id=l.entry_id
  WHERE l.workspace_id=$1 AND l.account_id=ANY(ARRAY(SELECT id FROM income)) AND l.entry_id=ANY(ARRAY(SELECT id FROM period))
  GROUP BY p.posting_date`,[workspaceId,to,from])).rows;
 const posted=new Map(rows.map(row=>[String(row.day).slice(0,10),Number(row.minor)]));
 const days=[];for(let at=Date.parse(from+'T00:00:00Z'),end=Date.parse(to+'T00:00:00Z');at<=end;at+=86400000){const day=new Date(at).toISOString().slice(0,10);days.push({day,minor:posted.get(day)||0});}
 return days;
}
module.exports={forPeriod,thisMonth,byDay};
