'use strict';

const { ValidationError }=require('../domain/errors');

function day(value,label){const text=String(value || '');if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw new ValidationError(`${label} must be a valid date.`);return text;}
const value=(row)=>Number(row.value_minor || 0);

async function currency(database,workspaceId){
  return (await database.query(`SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1`,[workspaceId])).rows[0]?.base_currency || 'USD';
}

async function accountTotals(database,workspaceId,{from=null,to}){
  const values=[workspaceId,to];let fromClause='';
  if(from){values.push(from);fromClause=` AND e.posting_date >= $${values.length}`;}
  return (await database.query(`SELECT a.id,a.code,a.name,a.account_type,a.subtype,a.normal_balance,
      COALESCE(SUM(l.debit_minor),0) AS debit_minor,COALESCE(SUM(l.credit_minor),0) AS credit_minor
    FROM accounting_accounts a LEFT JOIN accounting_journal_lines l ON l.account_id=a.id AND l.workspace_id=a.workspace_id
      AND EXISTS(SELECT 1 FROM accounting_journal_entries e WHERE e.id=l.entry_id AND e.workspace_id=$1
        AND e.status='POSTED' AND e.posting_date <= $2${fromClause})
    WHERE a.workspace_id=$1 AND a.active=1 GROUP BY a.id,a.code,a.name,a.account_type,a.subtype,a.normal_balance
    ORDER BY a.code`,values)).rows;
}

async function profitAndLoss(database,workspaceId,input={}){
  const to=day(input.to || new Date().toISOString().slice(0,10),'To date');
  const from=day(input.from || `${to.slice(0,7)}-01`,'From date');
  if(from>to)throw new ValidationError('From date must not be after to date.');
  const rows=await accountTotals(database,workspaceId,{from,to});
  const sum=(type)=>rows.filter((row)=>row.account_type===type).reduce((total,row)=>total+
    (type==='INCOME'?Number(row.credit_minor)-Number(row.debit_minor):Number(row.debit_minor)-Number(row.credit_minor)),0);
  const revenueMinor=sum('INCOME');const cogsMinor=sum('COGS');const operatingExpenseMinor=sum('EXPENSE');
  return {from,to,currency:await currency(database,workspaceId),accounts:rows,revenueMinor,cogsMinor,operatingExpenseMinor,
    grossProfitMinor:revenueMinor-cogsMinor,netIncomeMinor:revenueMinor-cogsMinor-operatingExpenseMinor};
}

async function balanceSheet(database,workspaceId,input={}){
  const asOf=day(input.asOf || new Date().toISOString().slice(0,10),'As-of date');
  const rows=await accountTotals(database,workspaceId,{to:asOf});
  const assets=rows.filter((row)=>row.account_type==='ASSET').map((row)=>({...row,net_minor:Number(row.debit_minor)-Number(row.credit_minor)}));
  const liabilities=rows.filter((row)=>row.account_type==='LIABILITY').map((row)=>({...row,net_minor:Number(row.credit_minor)-Number(row.debit_minor)}));
  const equities=rows.filter((row)=>row.account_type==='EQUITY').map((row)=>({...row,net_minor:Number(row.credit_minor)-Number(row.debit_minor)}));
  const income=rows.filter((row)=>row.account_type==='INCOME').reduce((sum,row)=>sum+Number(row.credit_minor)-Number(row.debit_minor),0);
  const costs=rows.filter((row)=>['COGS','EXPENSE'].includes(row.account_type)).reduce((sum,row)=>sum+Number(row.debit_minor)-Number(row.credit_minor),0);
  const assetMinor=assets.reduce((sum,row)=>sum+row.net_minor,0);const liabilityMinor=liabilities.reduce((sum,row)=>sum+row.net_minor,0);
  const postedEquityMinor=equities.reduce((sum,row)=>sum+row.net_minor,0);const currentEarningsMinor=income-costs;
  const liabilitiesAndEquityMinor=liabilityMinor+postedEquityMinor+currentEarningsMinor;
  return {asOf,currency:await currency(database,workspaceId),assets,liabilities,equities,assetMinor,liabilityMinor,
    postedEquityMinor,currentEarningsMinor,liabilitiesAndEquityMinor,balanced:assetMinor===liabilitiesAndEquityMinor};
}

async function trialBalance(database,workspaceId,input={}){
  const to=day(input.to || new Date().toISOString().slice(0,10),'To date');
  const from=day(input.from || '1900-01-01','From date');
  const rows=await accountTotals(database,workspaceId,{to});
  const accounts=rows.map((row)=>{const net=Number(row.debit_minor)-Number(row.credit_minor);return {...row,
    ending_debit_minor:Math.max(0,net),ending_credit_minor:Math.max(0,-net)};});
  const totals=accounts.reduce((sum,row)=>({ending_debit_minor:sum.ending_debit_minor+row.ending_debit_minor,
    ending_credit_minor:sum.ending_credit_minor+row.ending_credit_minor}),{ending_debit_minor:0,ending_credit_minor:0});
  return {from,to,currency:await currency(database,workspaceId),accounts,totals,
    balanced:totals.ending_debit_minor===totals.ending_credit_minor};
}

async function generalLedger(database,workspaceId,input={}){
  const to=day(input.to || new Date().toISOString().slice(0,10),'To date');
  const from=day(input.from || `${to.slice(0,7)}-01`,'From date');
  const rows=(await database.query(`SELECT e.id AS entry_id,e.entry_number,e.posting_date,e.description,
      a.code AS account_code,a.name AS account_name,l.debit_minor,l.credit_minor,l.currency
    FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.entry_id=e.id
    JOIN accounting_accounts a ON a.id=l.account_id WHERE e.workspace_id=$1 AND e.status='POSTED'
      AND e.posting_date BETWEEN $2 AND $3 ORDER BY e.posting_date,e.entry_number,l.line_number`,[workspaceId,from,to])).rows;
  return {from,to,rows:rows.map((row)=>({...row,debit_minor:Number(row.debit_minor),credit_minor:Number(row.credit_minor)}))};
}

module.exports={profitAndLoss,balanceSheet,trialBalance,generalLedger};
