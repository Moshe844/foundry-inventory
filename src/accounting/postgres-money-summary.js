'use strict';
// Aggregate dashboard amounts in PostgreSQL; detailed evidence remains on its own pages.
const {exact,sum}=require('./customer-money');
async function read(db,workspaceId,{from,to,chartFrom}){
 const [cash,receipts]=await Promise.all([
 db.query(`WITH entries AS (
 SELECT e.id,e.posting_date,l.currency,sum(l.debit_minor-l.credit_minor)::numeric amount
 FROM accounting_accounts a JOIN accounting_journal_lines l ON l.workspace_id=a.workspace_id AND l.account_id=a.id
 JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id
 WHERE a.workspace_id=$1 AND a.subtype='CASH' AND e.status='POSTED' AND e.posting_date BETWEEN $2 AND $3
 GROUP BY e.id,e.posting_date,l.currency)
 SELECT currency,left(posting_date::text,7) AS month_key,
 coalesce(sum(greatest(amount,0)),0)::text incoming,coalesce(sum(greatest(-amount,0)),0)::text outgoing,
 coalesce(sum(greatest(amount,0)) FILTER(WHERE posting_date>=$4),0)::text period_in,
 coalesce(sum(greatest(-amount,0)) FILTER(WHERE posting_date>=$4),0)::text period_out
 FROM entries GROUP BY currency,left(posting_date::text,7) ORDER BY month_key`,[workspaceId,from<chartFrom?from:chartFrom,to,from]),
 db.query(`SELECT l.currency,coalesce(sum(l.credit_minor-l.debit_minor),0)::text amount
 FROM accounting_accounts a JOIN accounting_journal_lines l ON l.workspace_id=a.workspace_id AND l.account_id=a.id
 JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id
 WHERE a.workspace_id=$1 AND a.system_key='RECEIVED_NOT_INVOICED' AND e.status='POSTED' AND e.posting_date<=$2 GROUP BY l.currency`,[workspaceId,to])]);
 return {cash:cash.rows,receipts:receipts.rows};
}
function present(result,currency){const cash=result.cash.filter(r=>r.currency===currency),inMinor=sum(cash,'period_in'),outMinor=sum(cash,'period_out');return {cashFlow:{inMinor,outMinor,netMinor:exact(inMinor-outMinor)},months:new Map(cash.map(r=>[r.month_key,{inMinor:exact(r.incoming),outMinor:exact(r.outgoing),netMinor:exact(exact(r.incoming)-exact(r.outgoing))}])),receivedNotBilledMinor:exact(result.receipts.find(r=>r.currency===currency)?.amount)};}
module.exports={read,present};
