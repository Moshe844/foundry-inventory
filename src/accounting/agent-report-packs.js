'use strict';

const money=require('../domain/currency');
const {ValidationError}=require('../domain/errors');
const time=require('../lib/business-time');

function monthsEnding(endMonth,length){
  const [year,month]=endMonth.split('-').map(Number);
  return Array.from({length},(_,i)=>new Date(Date.UTC(year,month-length+i,1)).toISOString().slice(0,7));
}
function period(today,filter,length){
  const last=monthsEnding(today.slice(0,7),2)[0];
  const closing=filter||(length===12?String(Number(today.slice(0,4))-1)+'-12':last);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(closing)||closing<'1901-01'||closing>last)throw new ValidationError('Choose a completed closing month in YYYY-MM format.');
  const months=monthsEnding(closing,length),start=months[0]+'-01';
  const [year,month]=closing.split('-').map(Number);
  return {closing,start,end:new Date(Date.UTC(year,month,0)).toISOString().slice(0,10),months};
}
async function yearEnd(db,ctx,{today,filter,page=1,download=false}){
  const span=period(today,filter,12);
  const {rows:balances}=await db.query(`SELECT l.currency,a.system_key,k.code,
    sum(l.debit_minor-l.credit_minor) AS value
    FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    LEFT JOIN skus k ON k.workspace_id=l.workspace_id AND k.id=l.sku_id
    WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.posting_date<=$2 AND a.system_key IN ('INVENTORY_ASSET','INVENTORY_IN_TRANSIT')
    GROUP BY l.currency,a.system_key,k.code ORDER BY l.currency,a.system_key,k.code LIMIT $3 OFFSET $4`,[ctx.workspaceId,span.end,download?null:101,download?0:(page-1)*100]);
  const zone=(await time.forWorkspace(db,ctx.workspaceId)).timeZone;
  const bounds=[ctx.workspaceId,time.dayBoundary(span.start,zone),time.dayBoundary(span.end,zone,{nextDay:true})];
  const during="r.workspace_id=$1 AND r.status='COMPLETED' AND r.approved_at >= $2::timestamptz AND r.approved_at < $3::timestamptz";
  const worksheets="w.workspace_id=$1 AND w.status='COMPLETED' AND w.completed_at >= $2::timestamptz AND w.completed_at < $3::timestamptz";
  const total=await db.query(`SELECT (SELECT coalesce(sum(jsonb_array_length(r.payload->'lines')),0) FROM physical_count_reviews r WHERE ${during})
    +(SELECT count(*) FROM warehouse_count_campaigns w JOIN warehouse_count_campaign_lines l ON l.workspace_id=w.workspace_id AND l.campaign_id=w.id
      WHERE ${worksheets} AND l.applied_at IS NOT NULL) AS n`,bounds);
  const counts=download?(await db.query(`SELECT (r.approved_at AT TIME ZONE $4)::date::text AS day,r.payload->'location'->>'name' AS location,
    r.payload->>'reference' AS reference,l->>'code' AS sku,l->'before'->>'physical' AS before,l->>'quantity' AS counted,
    l->>'delta' AS difference,r.payload->>'currency' AS currency,l->>'costDeltaMinor' AS value,u.name AS approver
    FROM physical_count_reviews r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'lines') AS l
    LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.approved_by_user_id
    WHERE ${during}
    UNION ALL
    SELECT (w.completed_at AT TIME ZONE $4)::date::text,loc.name,w.title,s.code,l.before_quantity::text,l.counted_quantity::text,
      (l.counted_quantity-l.before_quantity)::text,settings.base_currency,l.cost_delta_minor::text,u.name
    FROM warehouse_count_campaigns w JOIN warehouse_count_campaign_lines l ON l.workspace_id=w.workspace_id AND l.campaign_id=w.id
    JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    LEFT JOIN accounting_settings settings ON settings.workspace_id=w.workspace_id
    LEFT JOIN users u ON u.workspace_id=w.workspace_id AND u.id=w.approved_by_user_id
    WHERE ${worksheets} AND l.applied_at IS NOT NULL
    ORDER BY day,location,reference,sku`,[...bounds,zone])).rows:[];
  const listed=download?balances:balances.slice(0,100);
  const rows=listed.map(b=>({Currency:b.currency,Account:b.system_key==='INVENTORY_ASSET'?'Stock on books':'Stock in transit',
    SKU:b.code||'Unassigned ledger entries','Closing value':money.format(b.value,b.currency),
    link:'/accounting/reports/general-ledger?'+new URLSearchParams({to:span.end})}));
  const details=counts.map(c=>({Date:c.day,Location:c.location,Reference:c.reference||'',SKU:c.sku,Before:c.before,Counted:c.counted,
    Difference:c.difference,Currency:c.currency||'','Change in value':c.currency&&c.value!=null?money.format(c.value,c.currency):'','Approved by':c.approver||'Former team member'}));
  const amount=(minor,currency)=>Number(money.fromMinor(money.integer(minor,'Stock valuation',{signed:true}),currency));
  return {span,rows,counts:details,values:listed.map(b=>amount(b.value,b.currency)),countValues:counts.map(c=>c.currency&&c.value!=null?amount(c.value,c.currency):null),
    more:!download&&balances.length>100,summary:'Posted stock valuation at '+span.end+' and '+total.rows[0].n+' approved count lines from '+span.start+' through '+span.end+'. The workbook includes the supporting count lines.'};
}
const definitions=[
  {id:159,key:'board-pack',label:'Board or investor pack',filterLabel:'Closing month (YYYY-MM)',readPage:(...args)=>require('../reports/agent-board-pack').readPage(...args)},
  {id:164,key:'quarterly-supplier-pack',label:'Quarterly pack for a supplier',filterLabel:'Exact supplier name or ID',readPage:require('../purchasing/agent-supplier-pack').report},
  {id:165,key:'year-end-stocktake',label:'Year-end stocktake and valuation pack',filterLabel:'Fiscal year closing month (YYYY-MM)',readPage:yearEnd}
];
const downloads={
  'board-pack':{extension:'pdf',label:'Download board pack with charts (PDF)',render:report=>require('../reports/agent-board-pack').pdf(report)},
  'quarterly-supplier-pack':{extension:'pdf',label:'Download supplier pack (PDF)',render:require('../purchasing/agent-supplier-pack').pdf},
  'year-end-stocktake':{extension:'xlsx',label:'Download stocktake and valuation (Excel)',render:require('./agent-report-pack-files').stocktakeWorkbook}
};
module.exports={definitions,yearEnd,downloads};
