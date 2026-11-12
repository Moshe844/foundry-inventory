'use strict';
const {ValidationError}=require('../domain/errors');
const money=require('../domain/currency');
const {addDays}=require('./customer-money');

function period(today,filter){
  const current=today.slice(0,7);
  const month=filter||addDays(current+'-01',-1).slice(0,7);
  if(!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)||month<'1900-01'||month>=current)
    throw new ValidationError('Choose a completed calendar month, for example 2026-01.');
  const start=month+'-01',end=addDays(addDays(start,32).slice(0,7)+'-01',-1);
  return {month,start,end,previous:addDays(start,-1).slice(0,7)+'-01'};
}
async function monthly(db,ctx,options,margin){
  const dates=period(options.today,options.filter);
  const settings=(await db.query('SELECT enabled,accounting_start_date FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  if(!settings?.enabled||!settings.accounting_start_date||settings.accounting_start_date>dates.end)
    return {rows:[],more:false,summary:'The selected month precedes the available accounting records. Review the accounting start date.'};
  const balances=(await db.query(`SELECT l.currency,
    sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.system_key='INVENTORY_ASSET') AS stock,
    sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.system_key='INVENTORY_IN_TRANSIT') AS transit,
    sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.account_type='COGS' AND e.posting_date>=$2) AS cogs,
    sum(l.credit_minor-l.debit_minor) FILTER (WHERE a.account_type='INCOME' AND e.posting_date>=$2) AS revenue,
    sum(l.debit_minor-l.credit_minor) FILTER (WHERE a.account_type='COGS' AND e.posting_date>=$4 AND e.posting_date<$2) AS prior_cost,
    sum(l.credit_minor-l.debit_minor) FILTER (WHERE a.account_type='INCOME' AND e.posting_date>=$4 AND e.posting_date<$2) AS prior_revenue,
    count(DISTINCT e.id) FILTER (WHERE e.posting_date>=$2) AS entries
    FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.posting_date<=$3
      AND (a.account_type IN ('COGS','INCOME') OR a.system_key IN ('INVENTORY_ASSET','INVENTORY_IN_TRANSIT'))
    GROUP BY l.currency ORDER BY l.currency`,[ctx.workspaceId,dates.start,dates.end,dates.previous])).rows;
  const link='/accounting/reports/general-ledger?'+new URLSearchParams({from:margin?dates.previous:dates.start,to:dates.end});
  const rows=balances.map(b=>{
    const fmt=n=>money.format(n??0,b.currency);
    if(!margin)return {Month:dates.month,Currency:b.currency,'Stock on books at month end':fmt(b.stock),'Stock in transit':fmt(b.transit),
      'Cost of goods sold':fmt(b.cogs),'Relevant postings this month':Number(b.entries),link};
    const revenue=money.integer(b.revenue??0,'Revenue',{signed:true}),cogs=money.integer(b.cogs??0,'Cost of goods',{signed:true});
    const priorRevenue=money.integer(b.prior_revenue??0,'Previous revenue',{signed:true}),priorCost=money.integer(b.prior_cost??0,'Previous cost',{signed:true});
    const comparable=settings.accounting_start_date<=dates.previous;
    return {Month:dates.month,Currency:b.currency,'Gross profit':fmt(revenue-cogs),'Revenue change':comparable?fmt(revenue-priorRevenue):null,
      'Cost of goods change':comparable?fmt(cogs-priorCost):null,'Gross profit change':comparable?fmt((revenue-cogs)-(priorRevenue-priorCost)):null,
      'Gross margin':revenue>0?((revenue-cogs)*100/revenue).toFixed(2)+'%':null,link};
  });
  const note=settings.accounting_start_date>dates.start?' Accounting began partway through this month.':'';
  return {rows,more:false,summary:(margin?'Changes compare posted revenue and cost of goods with the preceding calendar month. Comparisons require accounting coverage for both months.':
    'Month-end balances and cost of goods sold use posted journal entries through '+dates.end+'. In-transit stock is listed separately.')+note};
}
module.exports=[
  {id:157,key:'margin-change',label:'Explain a change in gross profit',filterLabel:'Completed month (YYYY-MM)',readPage:(db,ctx,opts)=>monthly(db,ctx,opts,true)}
];
