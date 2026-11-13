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
  const total=await db.query('SELECT coalesce(sum(jsonb_array_length(r.payload->\'lines\')),0) AS n FROM physical_count_reviews r WHERE '+during,bounds);
  const counts=download?(await db.query(`SELECT (r.approved_at AT TIME ZONE $4)::date::text AS day,r.payload->'location'->>'name' AS location,
    r.payload->>'reference' AS reference,l->>'code' AS sku,l->'before'->>'physical' AS before,l->>'quantity' AS counted,
    l->>'delta' AS difference,r.payload->>'currency' AS currency,l->>'costDeltaMinor' AS value,u.name AS approver
    FROM physical_count_reviews r CROSS JOIN LATERAL jsonb_array_elements(r.payload->'lines') AS l
    LEFT JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.approved_by_user_id
    WHERE ${during} ORDER BY r.approved_at,r.id,l->>'code'`,[...bounds,zone])).rows:[];
  const listed=download?balances:balances.slice(0,100);
  const rows=listed.map(b=>({Currency:b.currency,Account:b.system_key==='INVENTORY_ASSET'?'Stock on books':'Stock in transit',
    SKU:b.code||'Unassigned ledger entries','Closing value':money.format(b.value,b.currency),
    link:'/accounting/reports/general-ledger?'+new URLSearchParams({to:span.end})}));
  const settings=(await db.query('SELECT enabled,accounting_start_date,base_currency,costing_method FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]||null;
  const method=METHODS[settings?.costing_method]||'Not set';
  // Completed count worksheets (cycle counts and the annual stocktake) applied in the year.
  const worksheets=download?(await db.query(`SELECT (q.applied_at AT TIME ZONE $4)::date::text AS day,l.name AS location,c.title AS reference,s.code AS sku,
      q.before_quantity::text AS before,q.counted_quantity::text AS counted,(q.counted_quantity-q.before_quantity)::text AS difference,q.cost_delta_minor::text AS value,u.name AS approver
    FROM warehouse_count_campaign_lines q JOIN warehouse_count_campaigns c ON c.workspace_id=q.workspace_id AND c.id=q.campaign_id
    JOIN skus s ON s.workspace_id=q.workspace_id AND s.id=q.sku_id JOIN locations l ON l.workspace_id=q.workspace_id AND l.id=q.location_id
    LEFT JOIN users u ON u.workspace_id=c.workspace_id AND u.id=c.approved_by_user_id
    WHERE q.workspace_id=$1 AND c.status='COMPLETED' AND q.applied_at IS NOT NULL AND q.counted_quantity IS NOT NULL
      AND q.applied_at >= $2::timestamptz AND q.applied_at < $3::timestamptz ORDER BY q.applied_at,c.id,s.code,l.name`,[...bounds,zone])).rows:[];
  const base=settings?.base_currency||'USD';
  const details=[...counts.map(c=>({Date:c.day,Location:c.location,Reference:c.reference||'',SKU:c.sku,Before:c.before,Counted:c.counted,
    Difference:c.difference,Currency:c.currency,'Change in value':money.format(c.value,c.currency),'Approved by':c.approver||'Former team member',Source:'Count review'})),
  ...worksheets.map(c=>({Date:c.day,Location:c.location,Reference:c.reference||'',SKU:c.sku,Before:c.before,Counted:c.counted,
    Difference:c.difference,Currency:base,'Change in value':money.format(c.value||0,base),'Approved by':c.approver||'Former team member',Source:'Count worksheet'}))];
  const amount=(minor,currency)=>Number(money.fromMinor(money.integer(minor,'Stock valuation',{signed:true}),currency));
  const result={span,rows,counts:details,values:listed.map(b=>amount(b.value,b.currency)),
    countValues:[...counts.map(c=>amount(c.value,c.currency)),...worksheets.map(c=>amount(c.value||0,base))],method,
    more:!download&&balances.length>100,summary:'Posted stock valuation at '+span.end+' ('+method.toLowerCase()+') and '+total.rows[0].n+' approved count lines from '+span.start+' through '+span.end+'. The workbook includes the supporting count lines.'};
  if(!download)return result;
  // The rest of the accountant's pack: the year's roll-forward, write-downs and signed-off stocktakes.
  const year=await require('../reports/agent-month-end-stock').compute(db,ctx.workspaceId,{start:span.start,end:span.end});
  const rollForward=(year.currencies||[]).map(c=>({currency:c.currency,...Object.fromEntries(Object.entries(c.totals).map(([k,v])=>[k,amount(String(v),c.currency)])),
    booksClosing:amount(String(c.books.closing),c.currency),booksTransit:amount(String(c.books.transit),c.currency),difference:amount(String(c.difference.closing),c.currency),
    locations:c.locations.map(p=>({name:p.name,opening:amount(String(p.opening),c.currency),receipts:amount(String(p.receipts),c.currency),cogs:amount(String(p.cogs),c.currency),
      adjustments:amount(String(p.adjustments),c.currency),writeoffs:amount(String(p.writeoffs),c.currency),transfers:amount(String(p.transfers),c.currency),
      other:amount(String(p.other),c.currency),closing:amount(String(p.closing),c.currency)}))}));
  const writeDowns=(await db.query(`SELECT w.posting_date AS day,s.code AS sku,l.name AS location,w.quantity_units::text AS quantity,w.currency,
      w.before_value_minor::text AS before,w.after_value_minor::text AS after,w.evidence_reference AS evidence,u.name AS approver
    FROM accounting_inventory_write_downs w JOIN skus s ON s.workspace_id=w.workspace_id AND s.id=w.sku_id JOIN locations l ON l.workspace_id=w.workspace_id AND l.id=w.location_id
    LEFT JOIN users u ON u.workspace_id=w.workspace_id AND u.id=w.approved_by
    WHERE w.workspace_id=$1 AND w.posting_date BETWEEN $2 AND $3 ORDER BY w.posting_date,w.id`,[ctx.workspaceId,span.start,span.end])).rows
    .map(w=>({date:w.day,sku:w.sku,location:w.location,quantity:Number(w.quantity),currency:w.currency,before:amount(w.before,w.currency),after:amount(w.after,w.currency),
      writtenDown:amount(String(BigInt(w.before)-BigInt(w.after)),w.currency),evidence:w.evidence,approver:w.approver||'Former team member'}));
  const stocktakes=(await db.query(`SELECT title,(signed_off_at AT TIME ZONE $4)::date::text AS day,signoff FROM stockchief_runtime.agent_annual_stocktakes
    WHERE workspace_id=$1 AND status='SIGNED_OFF' AND signed_off_at >= $2::timestamptz AND signed_off_at < $3::timestamptz ORDER BY signed_off_at,id`,[...bounds,zone])).rows
    .map(s=>({title:s.title,date:s.day,positions:Number(s.signoff?.positions||0),differences:Number(s.signoff?.differences||0),value:amount(String(s.signoff?.value_difference||0),base)}));
  const pending=Number((await db.query(`SELECT count(*)::int AS n FROM physical_count_reviews WHERE workspace_id=$1 AND status='PENDING' AND created_at < $2::timestamptz`,[ctx.workspaceId,bounds[2]])).rows[0].n);
  return {...result,base,accounting:{enabled:Boolean(Number(settings?.enabled)),start:settings?.accounting_start_date||null,problem:year.problem||null},
    business:(await require('../operations/postgres-company-profile').get(db,ctx.workspaceId)).legalName,rollForward,writeDowns,stocktakes,pending};
}
const METHODS={WEIGHTED_AVERAGE:'Weighted average cost',FIFO:'First in, first out (FIFO)',SPECIFIC_IDENTIFICATION:'Specific identification'};
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
