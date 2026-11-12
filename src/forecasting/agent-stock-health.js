'use strict';
// Job 162: stock health per item and location.
//
// For each item at each location (bins roll up into their warehouse), over up
// to the last 90 days: average stock value from the stock value records, stock
// turns (cost of goods sold over average stock), gross margin return on
// inventory (gross margin over average stock) and days of supply (stock on hand
// at the recorded rate of sales). Sales and cost of goods come from posted
// journal lines for that item and location. When the stock records and the
// value records disagree, or goods carry no cost, the money ratios are
// withheld rather than guessed.
//
// Growth, Pro and Custom keep it current on their own: each day the worker
// checks every item and flags the worst ones in Needs you (those earning back
// less in gross margin than the stock costs to hold, with at least 30 days
// measured). Starter gets one suggestion. Nothing is posted or changed.
const {ValidationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const time=require('../lib/business-time');
const reports=require('../reports/agent-report-runs');

const JOB=162,ACTION='report.stock_health',KIND='reports.stock-health.v1',href='/autopilot/reviews/stock-health';
const WINDOW=90,WORST=5,MIN_DAYS=30,PAGE=50;
const rounded=value=>Math.round(value*100)/100;

// Raw figures for one page of active SKUs (by code), one row per item and location.
async function measure(db,workspaceId,{today,filter='',offset=0,limit=PAGE}){
  const {rows}=await db.query(`WITH RECURSIVE roots AS (
      SELECT id,id AS root FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL
      UNION ALL SELECT l.id,r.root FROM locations l JOIN roots r ON l.parent_location_id=r.id WHERE l.workspace_id=$1
    ), selected AS (
      SELECT s.id,s.code,s.item_id,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2) OR lower(i.name)=lower($2))
      ORDER BY s.code,s.id LIMIT $5 OFFSET $4
    ), zone AS (
      SELECT coalesce(w.time_zone,a.time_zone,'UTC') AS tz FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1
    ), book AS (
      SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1
    ), value_days AS MATERIALIZED (
      SELECT x.sku_id,x.loc,x.day,sum(x.delta)::numeric AS delta FROM (
        SELECT m.sku_id,coalesce(r.root,m.location_id) AS loc,m.cost_delta_minor AS delta,
          coalesce(e.posting_date::date,(coalesce(mv.occurred_at,m.created_at)::timestamptz AT TIME ZONE z.tz)::date) AS day
        FROM accounting_inventory_cost_movements m JOIN selected s ON s.id=m.sku_id CROSS JOIN zone z
        LEFT JOIN movements mv ON mv.workspace_id=m.workspace_id AND mv.id=m.inventory_movement_id
        LEFT JOIN accounting_journal_entries e ON e.workspace_id=m.workspace_id AND e.id=m.journal_entry_id AND e.status='POSTED'
        LEFT JOIN roots r ON r.id=m.location_id
        WHERE m.workspace_id=$1 AND m.cost_delta_minor<>0
        UNION ALL
        SELECT v.sku_id,coalesce(r.root,v.location_id),v.amount_delta_minor,
          coalesce(e.posting_date::date,(v.created_at::timestamptz AT TIME ZONE z.tz)::date)
        FROM accounting_inventory_value_adjustments v JOIN selected s ON s.id=v.sku_id CROSS JOIN zone z
        LEFT JOIN accounting_journal_entries e ON e.workspace_id=v.workspace_id AND e.id=v.journal_entry_id AND e.status='POSTED'
        LEFT JOIN roots r ON r.id=v.location_id
        WHERE v.workspace_id=$1) x
      WHERE x.day<=$3::date GROUP BY 1,2,3
    ), first_day AS (
      SELECT sku_id,loc,greatest(min(day),$3::date-${WINDOW-1}) AS first FROM value_days GROUP BY 1,2
    ), stock_value AS (
      SELECT d.sku_id,d.loc,f.first,($3::date-f.first+1) AS days,sum(d.delta) AS closing,
        sum(d.delta*($3::date-greatest(f.first,d.day)+1))/($3::date-f.first+1) AS average
      FROM value_days d JOIN first_day f ON f.sku_id=d.sku_id AND f.loc=d.loc GROUP BY d.sku_id,d.loc,f.first
    ), ledger AS (
      SELECT l.sku_id,coalesce(r.root,l.location_id) AS loc,e.posting_date::date AS day,
        sum(CASE WHEN a.system_key IN ('SALES_REVENUE','SALES_RETURNS') THEN l.credit_minor-l.debit_minor ELSE 0 END)::numeric AS sales,
        sum(CASE WHEN a.system_key='COST_OF_GOODS_SOLD' THEN l.debit_minor-l.credit_minor ELSE 0 END)::numeric AS cogs
      FROM accounting_journal_lines l JOIN selected s ON s.id=l.sku_id
      JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id AND e.status='POSTED'
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      JOIN book ON book.base_currency=l.currency LEFT JOIN roots r ON r.id=l.location_id
      WHERE l.workspace_id=$1 AND l.location_id IS NOT NULL AND e.posting_date::date<=$3::date
        AND a.system_key IN ('SALES_REVENUE','SALES_RETURNS','COST_OF_GOODS_SOLD')
      GROUP BY 1,2,3
    ), margins AS (
      SELECT g.sku_id,g.loc,sum(g.sales) AS sales,sum(g.cogs) AS cogs FROM ledger g JOIN first_day f ON f.sku_id=g.sku_id AND f.loc=g.loc
      WHERE g.day>=f.first GROUP BY g.sku_id,g.loc
    ), physical AS (
      SELECT b.sku_id,coalesce(r.root,b.location_id) AS loc,sum(b.on_hand) AS units,sum(coalesce(c.total_cost_minor,0)) AS valuation,
        bool_and(b.on_hand=coalesce(c.quantity_units,0) AND b.on_hand>=0) AS covered
      FROM balances b JOIN selected s ON s.id=b.sku_id LEFT JOIN accounting_inventory_cost_balances c
        ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id LEFT JOIN roots r ON r.id=b.location_id
      WHERE b.workspace_id=$1 GROUP BY 1,2
    ), issued AS (
      SELECT x.sku_id,x.loc,sum(x.units) AS units FROM (
        SELECT m.sku_id,coalesce(r.root,m.location_id) AS loc,-m.quantity_delta AS units,(m.occurred_at::timestamptz AT TIME ZONE z.tz)::date AS day
        FROM movements m JOIN selected s ON s.id=m.sku_id CROSS JOIN zone z LEFT JOIN roots r ON r.id=m.location_id
        WHERE m.workspace_id=$1 AND m.operation='issue' AND m.reason_code IN ('sold','sale')) x
      JOIN first_day f ON f.sku_id=x.sku_id AND f.loc=x.loc WHERE x.day BETWEEN f.first AND $3::date GROUP BY 1,2
    ), places AS (
      SELECT sku_id,loc FROM stock_value UNION SELECT sku_id,loc FROM physical WHERE units<>0
    )
    SELECT s.id AS sku_id,s.code,s.item_id,s.name,p.loc AS location_id,l.name AS location,v.days,v.average,v.closing,m.sales,m.cogs,
      ph.covered,ph.units,ph.valuation,coalesce(i.units,0) AS issued,(SELECT base_currency FROM book) AS currency
    FROM places p JOIN selected s ON s.id=p.sku_id LEFT JOIN locations l ON l.workspace_id=$1 AND l.id=p.loc
    LEFT JOIN stock_value v ON v.sku_id=p.sku_id AND v.loc=p.loc LEFT JOIN margins m ON m.sku_id=p.sku_id AND m.loc=p.loc
    LEFT JOIN physical ph ON ph.sku_id=p.sku_id AND ph.loc=p.loc LEFT JOIN issued i ON i.sku_id=p.sku_id AND i.loc=p.loc
    ORDER BY s.code,s.id,l.name,p.loc`,[workspaceId,filter,today,offset,limit+1]);
  const more=(await db.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2) OR lower(i.name)=lower($2))
    ORDER BY s.code,s.id LIMIT 1 OFFSET $3) x`,[workspaceId,filter,offset+limit])).rows[0].n>0;
  return {more,rows:rows.map(r=>{
    const reconciled=r.covered===true&&r.closing!=null&&Number(r.closing)===Number(r.valuation);
    const average=Number(r.average),eligible=reconciled&&average>0,days=r.days==null?null:Number(r.days);
    return {skuId:r.sku_id,code:r.code,itemId:r.item_id,name:r.name,locationId:r.location_id,location:r.location||'Removed location',currency:r.currency,days,
      average:reconciled?Math.round(average):null,sales:Number(r.sales??0),cogs:Number(r.cogs??0),units:r.units==null?null:Number(r.units),
      turns:eligible?rounded(Number(r.cogs??0)/average):null,gmroi:eligible?rounded((Number(r.sales??0)-Number(r.cogs??0))/average):null,
      supply:Number(r.issued)>0&&r.units!=null&&days?rounded(Number(r.units)*days/Number(r.issued)):null,reconciled};
  })};
}

function row(r){
  return {SKU:r.code,Product:r.name,Location:r.location,'Days measured':r.days,'Average stock value':r.average==null?null:money.format(r.average,r.currency),
    'Inventory turns':r.turns,'GMROI':r.gmroi,'Days of supply':r.supply,'Valuation check':r.reconciled?'Matches the stock ledger':'Stock valuation needs review',link:'/inventory/'+r.itemId};
}

// Review rows (the page, Ask and Starter's one suggestion).
async function report(db,ctx,{filter,page,today}){
  const result=await measure(db,ctx.workspaceId,{today,filter,offset:(page-1)*PAGE});
  return {more:result.more,rows:result.rows.map(row),summary:'Turns and gross margin return on inventory (GMROI) use up to '+WINDOW+' days of posted activity for each item at each location, in the inventory currency. Average investment is the daily closing stock value. Days of supply uses stock on hand and recorded sales issues during the same period. Bins count with their warehouse.'};
}

// The worst items: earning back less in gross margin than the stock costs to hold.
function worst(rows){
  return rows.filter(r=>r.gmroi!=null&&r.gmroi<1&&r.days>=MIN_DAYS&&r.average>0)
    .sort((a,b)=>a.gmroi-b.gmroi||b.average-a.average||a.code.localeCompare(b.code)||String(a.locationId).localeCompare(String(b.locationId))).slice(0,WORST);
}
async function check(db,workspaceId,today){
  let candidates=[],offset=0,checked=0;
  for(;;){
    const page=await measure(db,workspaceId,{today,offset,limit:500});
    checked+=page.rows.length;candidates=worst([...candidates,...page.rows]);
    if(!page.more)break;offset+=500;
  }
  return {asOf:today,checked,worst:candidates.map(r=>({skuId:r.skuId,code:r.code,name:r.name,locationId:r.locationId,location:r.location,currency:r.currency,
    days:r.days,average:r.average,sales:r.sales,cogs:r.cogs,turns:r.turns,gmroi:r.gmroi,supply:r.supply}))};
}
function flags(result){
  return result.worst.map(r=>({key:'item:'+r.skuId+':'+r.locationId,currency:r.currency,amount:r.average,detail:{kind:'inventory',priority:45,
    title:r.code+' at '+r.location+' earns back less than it costs to hold',
    happened:'In the last '+r.days+' days it made '+money.format(r.sales-r.cogs,r.currency)+' gross margin on '+money.format(r.average,r.currency)+' of stock on average (GMROI '+r.gmroi+
      ', '+r.turns+' turns'+(r.supply!=null?', '+r.supply+' days of supply':', no recorded sales')+').',
    why:'The stock health check flags the items that tie up the most money for the least margin.',
    recommendation:'Check its reorder point, buy less next time, or plan a clearance. StockChief has not changed anything.',
    href:href+'?'+new URLSearchParams({filter:r.code}),actionLabel:'Open stock health'}}));
}

// ---- The worker, the owner's check, the page --------------------------------

async function produce(c,ctx,today,{automatic,watch=null}){
  const result=await check(c,ctx.workspaceId,today);
  return reports.record(c,ctx,{job:JOB,period:today.slice(0,7),facts:result,result,flags:flags(result),automatic,watch,supersede:true,
    action:automatic?'StockChief checked stock health':'Checked stock health'});
}
async function run(database,workspaceId){
  const actorId=await reports.currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!reports.alone(state,JOB))return {skipped:'plan'};
  if(await reports.paused(database,workspaceId))return {held:'paused'};
  const today=await time.today(database,workspaceId);
  return reports.tx(database,async c=>produce(c,ctx,today,{automatic:true,watch:await reports.automaticStop(c,workspaceId,state,ACTION)}));
}
// Daily: the same facts replay to the same check.
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!reports.alone(state,JOB))return {queued:0};
  const today=await time.today(db,workspaceId);
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:72,maxAttempts:3,idempotencyKey:'stock-health:'+today,payload:{}});
  return {queued:job.created?1:0};
}
async function checkNow(database,ctx){
  await reports.owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  const today=await time.today(database,ctx.workspaceId);
  return reports.tx(database,async c=>produce(c,ctx,today,{automatic:false}));
}
async function page(db,ctx,query={}){
  await reports.owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
  const review=await require('../autopilot/job-reviews').run(db,ctx,'stock-health',{filter:query.filter,page:query.page});
  const alone=reports.alone(state,JOB);
  const [runs,open]=alone?[await reports.runs(db,ctx.workspaceId,JOB,{limit:5}),await reports.flagsFor(db,ctx.workspaceId,JOB)]:[[],[]];
  return {review,filter:String(query.filter||'').trim(),alone,runs,flags:open,shadow:Boolean(state.shadow),
    automatic:alone?await reports.automaticStop(db,ctx.workspaceId,state,ACTION):null,minimumDays:MIN_DAYS,window:WINDOW};
}

module.exports={JOB,ACTION,KIND,href,measure,report,worst,check,run,schedule,checkNow,page};
