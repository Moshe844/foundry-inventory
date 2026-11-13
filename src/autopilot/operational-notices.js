'use strict';

const policy=require('../commercial/agent-plan');
const {hasVerifiedMigration}=require('../db/migrate-postgres');
const transferArrivals=require('../transfers/agent-transfer-arrivals');
const purchaseBudgets=require('../purchasing/agent-budgets');
const stockLoss=require('./stock-loss-patterns');
const unusualActivity=require('./unusual-activity');
const returnRates=require('./return-rates');
const marginPrices=require('../pricing/agent-margin-prices');
const orderPrices=require('../sales/agent-order-price-alerts');
const supplierPrices=require('../purchasing/agent-supplier-price-increases');
const history=require('../commercial/agent-history');
const exceptionReviews=require('./exception-reviews');
const overdue=exceptionReviews.find(d=>d.id===168);
const stockDiscrepancies=exceptionReviews.find(d=>d.id===3);
const migratedInboxDatabases=new WeakSet();
const orderCredit=require('../sales/order-credit-exposure');
const customerHealth=require('../sales/customer-health');
const monitoredJobs=[10,77,80,82,88,91,110,116];
const historyScopedJobs=[82,88,116];
const noticeOperation=job=>[50,77].includes(job)?'suggest':[21,212,213].includes(job)?'draft':'automatic';
const transfers=`WITH positions AS (
    SELECT t.id,t.transfer_number,t.status,${transferArrivals.expectedDate} AS due,src.name AS source,dst.name AS destination,
      CASE WHEN count(DISTINCT i.unit_label)=1 THEN min(i.unit_label) END AS unit,
      sum(l.shipped_quantity) AS shipped,sum(l.received_quantity) AS received,sum(l.lost_quantity+l.damaged_quantity) AS exceptions,
      sum(l.shipped_quantity-l.received_quantity-l.lost_quantity-l.damaged_quantity) AS outstanding
    FROM inventory_transfers t JOIN inventory_transfer_lines l ON l.workspace_id=t.workspace_id AND l.transfer_id=t.id
    JOIN skus sku ON sku.workspace_id=l.workspace_id AND sku.id=l.sku_id
    JOIN items i ON i.workspace_id=sku.workspace_id AND i.id=sku.item_id
    JOIN locations src ON src.workspace_id=t.workspace_id AND src.id=t.source_location_id
    JOIN locations dst ON dst.workspace_id=t.workspace_id AND dst.id=t.destination_location_id
    WHERE t.workspace_id=$1 AND t.status IN ('SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED','RECEIVED')
      AND ($2='' OR lower(t.transfer_number)=lower($2) OR lower(src.name)=lower($2) OR lower(dst.name)=lower($2))
    GROUP BY t.id,src.name,dst.name)
  SELECT p.transfer_number AS "Transfer",p.source AS "From",p.destination AS "To",p.due::text AS "Due",p.unit AS "Unit",
    CASE WHEN p.unit IS NOT NULL THEN p.shipped END AS "Dispatched",
    CASE WHEN p.unit IS NOT NULL THEN p.received END AS "Received",
    CASE WHEN p.unit IS NOT NULL THEN p.outstanding END AS "Still in transit",
    CASE WHEN p.unit IS NOT NULL THEN p.exceptions END AS "Lost or damaged",
    CASE WHEN p.outstanding>0 AND p.due<$3::date THEN 'Past expected arrival'
      WHEN p.outstanding>0 AND p.due IS NULL THEN 'Arrival date not recorded' WHEN p.outstanding>0 THEN 'In transit'
      WHEN p.exceptions>0 THEN 'Closed with a difference' ELSE 'Received complete' END AS "Result",
    coalesce(n.reminders,0) AS "In-app reminders", n.last_reminded::text AS "Last reminder",
    (SELECT max(e.created_at) FROM inventory_transfer_events e WHERE e.workspace_id=$1 AND e.transfer_id=p.id
      AND e.event_type='ARRIVAL_FOLLOW_UP_CHECKED') AS "Last receiving check",'/transfers/'||p.id AS link
    FROM positions p LEFT JOIN stockchief_runtime.agent_operational_notices n ON n.workspace_id=$1 AND n.job_id=124
      AND n.kind='Transfer' AND n.reference=p.transfer_number AND n.link='/transfers/'||p.id
    ORDER BY (p.outstanding>0 AND p.due<$3::date) DESC NULLS LAST,p.due NULLS LAST,p.transfer_number`;

async function checkStockDiscrepancies(db,workspaceId,today){
  const existing=await db.query(`SELECT 1 FROM stockchief_runtime.agent_stock_discrepancy_checks
    WHERE workspace_id=$1 AND checked_on>=$2::date`,[workspaceId,today]);
  if(existing.rowCount)return;
  await db.query(`INSERT INTO stockchief_runtime.agent_stock_discrepancy_checks AS previous(workspace_id,checked_on,findings)
    SELECT $1,$3::date,count(*)::int FROM (${stockDiscrepancies.sql}) findings
    ON CONFLICT(workspace_id) DO UPDATE SET checked_on=excluded.checked_on,findings=excluded.findings
    WHERE previous.checked_on<excluded.checked_on`,[workspaceId,'',today]);
}

async function enabledMonitors(db,workspaceId,state,jobs){
  if(!policy.usesAgentTerms(state)||state.shadow)return new Set();
  const eligible=jobs.filter(job=>policy.permits(state.plan,job,noticeOperation(job)));
  if(!eligible.length)return new Set();
  const {rows}=await db.query(`SELECT requested.job FROM workspaces w
    CROSS JOIN unnest($2::int[]) requested(job)
    LEFT JOIN workspace_autopilot a ON a.workspace_id=w.id
    LEFT JOIN stockchief_runtime.agent_job_modes m ON m.workspace_id=w.id AND m.job_id=requested.job
    WHERE w.id=$1 AND w.deletion_requested_at IS NULL AND a.mode IS DISTINCT FROM 'OBSERVE'
      AND coalesce(a.paused,0)=0 AND coalesce(a.suspended,0)=0
      AND coalesce(m.mode,'inherit')<>'watch' AND (requested.job=77 OR coalesce(m.mode,'inherit')<>'ask')
      AND EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner')`,
  [workspaceId,eligible]);
  return new Set(rows.map(row=>row.job));
}

async function refresh(db,workspaceId,{now=new Date()}={}){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,168,'automatic'))return;
  const {calendarDate:today,timeZone}=await require('../lib/business-time').forWorkspace(db,workspaceId,now);
  const includeTransfers=await transferArrivals.enabled(db,workspaceId,account,{lock:true});
  const monitors=await enabledMonitors(db,workspaceId,account,monitoredJobs);
  const supplierPriceChecks=monitors.has(91)&&(hasVerifiedMigration(db,'392-agent-supplier-price-increases.sql')||
    (await db.query("SELECT to_regclass('stockchief_runtime.agent_supplier_price_lists') IS NOT NULL AS installed")).rows[0].installed);
  if(supplierPriceChecks)await require('../purchasing/agent-supplier-price-lists').lockNotices(db,workspaceId);
  const includeHistory=historyScopedJobs.some(job=>monitors.has(job));
  const args=[workspaceId,'',today];
  if(includeTransfers)args.push(timeZone);
  if(includeHistory)args.push((await history.access(db,workspaceId)).salesFrom);
  const cutoff=includeHistory?'$'+args.length:'NULL';
  // Job 169: channel problems are read for many products at once in JS
  // (agent-channel-alerts.js), then kept open or cleared like the others.
  if(policy.permits(account.plan,169,'automatic'))args.push(JSON.stringify(await require('../connections/agent-channel-alerts').candidates(db,workspaceId)));
  const channelAlerts=policy.permits(account.plan,169,'automatic')?' UNION ALL SELECT 169,kind,ref,link,$3::date FROM jsonb_to_recordset($'+args.length+'::jsonb) AS channel(kind text,ref text,link text)':'';
  const learned=await require('./approval-learning').notices(db,workspaceId,account);
  if(learned.length)args.push(JSON.stringify(learned));
  const learning=learned.length?' UNION ALL SELECT 208,kind,ref,link,$3::date FROM jsonb_to_recordset($'+args.length+'::jsonb) AS learned(kind text,ref text,link text)':'';
  // Job 209: every kind of repeated fix, from records.
  const corrections=policy.permits(account.plan,209,'automatic')?` UNION ALL SELECT 209,'Correction',reference,link,$3::date FROM (`+await require('./correction-rules').noticeSql(db)+`) corrections`:'';
  if(policy.permits(account.plan,3,'automatic'))await checkStockDiscrepancies(db,workspaceId,today);
  await require('../accounting/agent-cash-planning').preparePaymentChecks(db,workspaceId,account,today);
  // Job 166 needs migration 459 (its notice job number and alert levels).
  const stockAlerts=await require('../db/schema-installed').has(db,'stockchief_runtime.agent_alert_channels');
  // Job 180 needs the team summary table and its notice job number.
  const teamSummary=require('./team-summary'),teamSummaries=policy.permits(account.plan,180,'automatic')&&await require('../db/schema-installed').has(db,teamSummary.table);
  // Job 204 opens its own daily digest once migration 492 adds it.
  const workDigest=require('./agent-work-digest'),workDigests=await require('../db/schema-installed').has(db,workDigest.table);
  const watchRules=await require('./watch-rules').candidates(db);
  // Job 50: orders with a waited-for item now reserved and no customer update
  // for it. One update per line needs migration 507; before it, per order.
  const stockReady=require('../sales/agent-stock-ready'),stockLines=await require('../db/schema-installed').has(db,'stockchief_runtime.agent_stock_ready_lines');
  const watched=[];
  // Jobs 170 and 171 need migration 473 (their settings and sources).
  let unusualAlerts='';
  for(const [job,d] of Object.entries(require('./activity-watches').spec)){
    if(!policy.permits(account.plan,Number(job),'automatic')||(d.ready&&!await d.ready(db)))continue;
    if(Number(job)===unusualActivity.JOB){
      const rows=await unusualActivity.read(db,[workspaceId,'',today]);
      args.push(JSON.stringify(rows.map(row=>({kind:row.Alert,ref:row.reference,link:row.link}))));
      unusualAlerts=' UNION ALL SELECT '+job+',kind,ref,link,$3::date FROM jsonb_to_recordset($'+args.length+'::jsonb) AS unusual(kind text,ref text,link text)';
    }else watched.push([job,d]);
  }
  const watchQueries=watched.map(([job,d])=>' UNION ALL SELECT '+job+',"Alert",reference,link,$3::date FROM ('+d.sql+') observed').join('')+unusualAlerts;
  // Job 201: the pause StockChief took itself stays open until the owner resumes.
  const breakerPause=await require('./circuit-breaker').noticeSql(db,account);
  // Job 87's channel price checks run through the worker (agent-channel-price-checks.js).
  const candidates='SELECT 168 AS job,"Type" AS kind,"Reference" AS ref,link,"Due"::date AS due FROM ('+overdue.sql+') x'+
    (policy.permits(account.plan,50,'suggest')?` UNION ALL SELECT DISTINCT 50,'Stock ready',waited.order_number,'/autopilot/reviews/stock-ready-updates',$3::date FROM (`+
      stockReady.readyLines()+' AND '+stockReady.unnoticed(stockLines)+`) waited`:'')+
    (policy.permits(account.plan,204,'automatic')?(workDigests?` UNION ALL SELECT 204,'Daily work',d.report_date::text,'${workDigest.path}?filter='||d.report_date::text,d.report_date
     FROM ${workDigest.table} d WHERE d.workspace_id=$1 AND (d.summary->>'count')::int>0
      AND d.report_date=(SELECT max(report_date) FROM ${workDigest.table} WHERE workspace_id=$1)`:` UNION ALL SELECT 204,'Daily work',d.report_date,'/autopilot/reviews/daily-work?filter='||d.report_date,d.report_date::date
     FROM workspace_daily_digests d WHERE d.workspace_id=$1 AND d.summary::jsonb->>'format'='agent-brief' AND (d.summary::jsonb->>'actions')::int>0
      AND d.report_date=(SELECT max(report_date) FROM workspace_daily_digests WHERE workspace_id=$1 AND summary::jsonb->>'format'='agent-brief')`):'')+
    corrections+learning+
    (policy.permits(account.plan,21,'draft')?` UNION ALL SELECT 21,'Reorder change',c.id,'/planning/reorder-refresh',c.created_at::date
      FROM stockchief_runtime.agent_reorder_refresh_changes c WHERE c.workspace_id=$1 AND c.status='DRAFT'`:'')+
    ` UNION ALL SELECT 67,'Recurring order',r.id,'/autopilot/reviews/recurring-customer-orders',r.next_date
      FROM stockchief_runtime.recurring_customer_orders r WHERE r.workspace_id=$1 AND r.paused AND r.problem IS NOT NULL`+
    ` UNION ALL SELECT 206,'Automation',s.month,'/autopilot/reviews/automation-opportunities',(s.month||'-01')::date
      FROM stockchief_runtime.agent_automation_opportunities s WHERE s.workspace_id=$1 AND s.month=left($3::text,7)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.rows) opportunity JOIN stockchief_runtime.assistant_action_proposals p
        ON p.workspace_id=s.workspace_id AND '/actions/'||p.id=opportunity->>'link'
        WHERE NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_draft_rules r WHERE r.workspace_id=p.workspace_id
          AND r.action_type=p.action_type AND r.scope_key=p.payload#>>'{training,key}'))`+
    watchRules+
    (stockAlerts?' UNION ALL SELECT 166,kind,ref,link,$3::date FROM ('+require('./stock-alerts').sql+') low':'')+
    (teamSummaries?` UNION ALL SELECT 180,'Team summary',s.report_date::text,'${teamSummary.path}?filter='||s.report_date::text,s.report_date FROM ${teamSummary.table} s
      WHERE s.workspace_id=$1 AND s.report_date=(SELECT max(report_date) FROM ${teamSummary.table} WHERE workspace_id=$1)`:'')+
    (includeTransfers?' UNION ALL '+transferArrivals.candidates('$4'):'')+
    (monitors.has(110)?' UNION ALL '+purchaseBudgets.overBudgetNotices:'')+
    (monitors.has(80)?' UNION ALL '+orderCredit.notices:'')+
    (monitors.has(77)?' UNION ALL '+marginPrices.notices:'')+
    (monitors.has(82)?' UNION ALL '+orderPrices.notices(cutoff):'')+
    (monitors.has(88)?' UNION ALL '+customerHealth.notices(cutoff):'')+
    (supplierPriceChecks?' UNION ALL '+supplierPrices.notices:'')+
    (monitors.has(116)?' UNION ALL SELECT * FROM ('+returnRates.notices(cutoff)+') return_rates':'')+
    (monitors.has(10)?' UNION ALL SELECT 10,\'Stock loss\',reference,link,$3::date FROM ('+stockLoss.sql+') losses':'')+watchQueries+channelAlerts+breakerPause;
  await db.query(`WITH current AS MATERIALIZED (${candidates}), upserted AS (
    INSERT INTO stockchief_runtime.agent_operational_notices AS n(workspace_id,job_id,kind,reference,link,due,last_reminded,history_from)
    SELECT $1,job,kind,ref,link,due,$3::date,CASE WHEN job IN (${historyScopedJobs.join(',')}) THEN ${cutoff}::text::date END FROM current
    ON CONFLICT(workspace_id,job_id,kind,reference,link) DO UPDATE SET due=excluded.due,last_reminded=excluded.last_reminded,
      reminders=n.reminders+CASE WHEN n.last_reminded<excluded.last_reminded OR (n.resolved AND n.job_id<>124) THEN 1 ELSE 0 END,
      resolved=false,history_from=excluded.history_from
    WHERE n.resolved OR (n.job_id IN (124,168) AND (n.last_reminded<excluded.last_reminded OR n.due<>excluded.due))
      OR (n.job_id IN (${historyScopedJobs.join(',')}) AND n.history_from IS DISTINCT FROM excluded.history_from)
    RETURNING job_id)
    UPDATE stockchief_runtime.agent_operational_notices n SET resolved=true WHERE n.workspace_id=$1 AND NOT n.resolved
      AND NOT EXISTS(SELECT 1 FROM current c WHERE c.job=n.job_id AND c.kind=n.kind AND c.ref=n.reference AND c.link=n.link)`,
  args);
  // Jobs 166 to 171: record what opened and cleared, and email new alerts.
  return require('./agent-alerts').track(db,workspaceId,account);
}

async function inbox(db,workspaceId,actorId=null){
  // These tables are permanent once migrated. Keep checking older schemas
  // during an upgrade, then reuse the result on subsequent page requests.
  const migrated=migratedInboxDatabases.has(db)||(hasVerifiedMigration(db,'355-agent-stock-discrepancy-checks.sql')&&
    hasVerifiedMigration(db,'356-agent-supplier-payment-runs.sql'));
  const installed=migrated?{stock_checks:true,payment_checks:true}:(await db.query(`SELECT
    to_regclass('stockchief_runtime.agent_stock_discrepancy_checks') IS NOT NULL AS stock_checks,
    to_regclass('stockchief_runtime.agent_supplier_payment_checks') IS NOT NULL
      AND to_regclass('stockchief_runtime.agent_supplier_payment_approvals') IS NOT NULL AS payment_checks`)).rows[0];
  if(!migrated&&installed.stock_checks&&installed.payment_checks)migratedInboxDatabases.add(db);
  const stockChecks=installed.stock_checks?`UNION ALL
    SELECT 3,findings,checked_on::text,NULL::text,0,0 FROM stockchief_runtime.agent_stock_discrepancy_checks
    WHERE workspace_id=$1 AND findings>0`:'';
  const paymentChecks=installed.payment_checks?`UNION ALL
    SELECT 104,p.bill_count,p.checked_on::text,NULL::text,0,0 FROM stockchief_runtime.agent_supplier_payment_checks p
    WHERE p.workspace_id=$1 AND p.bill_count>0 AND NOT EXISTS (
      SELECT 1 FROM stockchief_runtime.agent_supplier_payment_approvals a WHERE a.workspace_id=p.workspace_id
        AND a.week_start=date_trunc('week',p.checked_on::timestamp)::date AND a.digest=p.run_digest)
    UNION ALL
    SELECT 108,discount_count,checked_on::text,NULL::text,0,0 FROM stockchief_runtime.agent_supplier_payment_checks
    WHERE workspace_id=$1 AND discount_count>0`:'';
  const {rows}=await db.query(`SELECT job_id,n,due,history_from,out,oversell FROM (
    SELECT n.job_id,count(*)::int AS n,min(n.due)::text AS due,
      CASE WHEN n.job_id IN (${historyScopedJobs.join(',')}) THEN to_jsonb(n)->>'history_from' END AS history_from,
      count(*) FILTER (WHERE n.kind='Out of stock')::int AS out,
      count(*) FILTER (WHERE n.job_id=169 AND n.kind='Channel quantity exceeds available stock')::int AS oversell
    FROM stockchief_runtime.agent_operational_notices n WHERE n.workspace_id=$1 AND NOT n.resolved GROUP BY n.job_id,4
    ${stockChecks}
    ${paymentChecks}
    ) current WHERE (current.job_id=124 OR $2::text IS NULL OR EXISTS(SELECT 1 FROM users u
      WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner'))`,[workspaceId,actorId]);
  if(!rows.length)return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state))return [];
  const transferNotices=rows.some(r=>Number(r.job_id)===124) && policy.permits(state.plan,124,'automatic')
    ? await transferArrivals.inbox(db,workspaceId,actorId?await transferArrivals.receiver(db,{workspaceId,actorId}):{owner:true,locations:null},state) : [];
  const visible=rows.filter(r=>Number(r.job_id)!==124&&policy.permits(state.plan,Number(r.job_id),noticeOperation(Number(r.job_id)),{trained:Number(r.job_id)===67}));
  const suppressed=new Set();
  for(const {job_id:job} of visible)if([104,108].includes(Number(job))&&await require('./job-modes').restriction(db,workspaceId,Number(job),true))suppressed.add(job);
  const monitorJobs=visible.map(r=>Number(r.job_id)).filter(job=>monitoredJobs.includes(job));
  let monitorHistoryFrom;
  if(monitorJobs.length){
    const active=await enabledMonitors(db,workspaceId,state,monitorJobs);
    for(const {job_id:job} of visible)if(monitorJobs.includes(Number(job))&&!active.has(Number(job)))suppressed.add(job);
    if(historyScopedJobs.some(job=>active.has(job)))monitorHistoryFrom=(await history.access(db,workspaceId)).salesFrom;
  }
  // Job 172: while alerts of a kind wait for an answer, the owner can answer them all here.
  const answerable=actorId&&policy.permits(state.plan,172,'automatic')&&visible.some(r=>Number(r.job_id)>=166&&Number(r.job_id)<=171)
    ?await require('./escalations').answerable(db,workspaceId):new Set();
  const answer=item=>{const job=Number(String(item.sourceId||'').replace('agent-notice-',''));
    if(answerable.has(job))item.dismiss={action:'/autopilot/escalations/answer',label:'I\'m on it',entryId:String(job)};return item;};
  // A prior run may have compared sales outside the plan's current window.
  return visible.filter(r=>!suppressed.has(r.job_id)&&(!historyScopedJobs.includes(Number(r.job_id))||r.history_from===monitorHistoryFrom)).map(r=>{
    if(Number(r.job_id)===3)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'Stock discrepancies need review',
      happened:'The '+r.due+' stock check found '+r.n+' '+(r.n===1?'issue.':'issues.'),why:stockDiscrepancies.summary,
      recommendation:'Review the current stock records.',href:'/autopilot/reviews/stock-exceptions',actionLabel:'Review stock discrepancies',sourceId:'agent-notice-3'};
    if(Number(r.job_id)===104)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'Supplier payment run ready to review',
      happened:r.n+' supplier '+(r.n===1?'bill was':'bills were')+' included in the '+r.due+' check.',
      why:'The run includes upcoming bills and documented discount deadlines.',href:'/autopilot/reviews/payment-run',
      actionLabel:'Review supplier payments',sourceId:'agent-notice-104'};
    if(Number(r.job_id)===108)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'Early-payment discounts available',
      happened:r.n+' supplier '+(r.n===1?'bill had':'bills had')+' an early-payment opportunity at the '+r.due+' check.',
      why:'The recorded supplier terms identify the deadline and possible saving.',href:'/autopilot/reviews/early-discounts',
      actionLabel:'Review supplier discounts',sourceId:'agent-notice-108'};
    if(Number(r.job_id)===110)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'Monthly purchases over budget',
      happened:r.n+' '+(r.n===1?'category budget is':'category budgets are')+' below billed purchases.',
      why:'StockChief compared posted supplier bills with each saved category budget in the same currency.',
      href:'/autopilot/reviews/purchase-budget?filter='+encodeURIComponent(r.due.slice(0,7)),actionLabel:'Review purchase budgets',sourceId:'agent-notice-110'};
    if(Number(r.job_id)===80)return {kind:'accounting',grouped:true,importance:'Important',priority:70,title:'Draft orders need a credit check',
      happened:r.n+' '+(r.n===1?'draft has':'drafts have')+' an over-limit or incomplete credit check.',
      why:'The check compares current draft amounts, unbilled commitments and open invoices with saved customer limits.',
      href:'/autopilot/reviews/order-credit-limits',actionLabel:'Review customer credit',sourceId:'agent-notice-80'};
    if(Number(r.job_id)===88)return {kind:'inventory',grouped:true,importance:'Information',priority:60,title:'Customers with fewer recent purchases',
      happened:r.n+' '+(r.n===1?'customer had':'customers had')+' fewer orders or product units shipped.',
      why:customerHealth.summary,href:customerHealth.path,actionLabel:'Review customer activity',sourceId:'agent-notice-88'};
    if(Number(r.job_id)===116)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'High return rates need review',
      happened:r.n+' '+(r.n===1?'SKU or customer rate is above its peer rate.':'SKU or customer rates are above their peer rates.'),
      why:returnRates.summary,href:'/autopilot/reviews/customer-return-rates',actionLabel:'Review return rates',sourceId:'agent-notice-116'};
    if(Number(r.job_id)===77)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'Review selling prices after a cost increase',
      happened:'A recorded cost rise has a selling price suggestion.',why:marginPrices.summary,
      href:'/autopilot/reviews/margin-prices',actionLabel:'Review selling prices',sourceId:'agent-notice-77'};
    if(Number(r.job_id)===82)return {kind:'inventory',grouped:true,importance:'Important',priority:75,title:'Order prices or discounts need review',
      happened:r.n+' '+(r.n===1?'order has':'orders have')+' a pricing exception.',why:orderPrices.summary,
      href:'/autopilot/reviews/order-price-exceptions',actionLabel:'Review order prices and discounts',sourceId:'agent-notice-82'};
    if(Number(r.job_id)===91)return {kind:'inventory',grouped:true,importance:'Important',priority:75,title:'Higher supplier prices need review',
      happened:r.n+' supplier '+(r.n===1?'document shows':'documents show')+' a higher comparable price.',why:supplierPrices.summary,
      href:'/autopilot/reviews/supplier-price-increases',actionLabel:'Review supplier price increases',sourceId:'agent-notice-91'};
    if(Number(r.job_id)===10)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'Repeated stock losses need review',
      happened:r.n+' '+(r.n===1?'product and shift combination shows':'product and shift combinations show')+' repeated stock corrections.',
      why:'Recorded stock was reduced more than once for the same product, warehouse and local shift.',
      href:'/autopilot/reviews/repeat-loss',actionLabel:'Review stock loss patterns',sourceId:'agent-notice-10'};
    if(Number(r.job_id)===50)return {kind:'inventory',grouped:true,importance:'Information',priority:55,title:'Waiting customer orders now have reserved stock',
      happened:r.n+' previously backordered order'+(r.n===1?' is':'s are')+' confirmed.',why:'The order records show a backorder followed by confirmation, with no queued or sent stock-ready update.',
      recommendation:'Review the current reservation and its customer update.',href:'/autopilot/reviews/stock-ready-updates',actionLabel:'Review ready orders',sourceId:'agent-notice-50'};
    if(Number(r.job_id)===169){
      const risk=Number(r.oversell||0),stopped=r.n-risk;
      return {kind:'sales',grouped:true,importance:risk?'Urgent':'Important',priority:risk?86:78,title:risk?'A sales channel may oversell':'A sales channel stopped syncing',
        happened:[risk?risk+' '+(risk===1?'listing shows':'listings show')+' more stock than you can sell.':null,
          stopped?stopped+' channel sync '+(stopped===1?'problem.':'problems.'):null].filter(Boolean).join(' '),
        why:'A channel that shows more than you have left can take orders you cannot ship, and a stopped sync keeps old stock on the channel.',
        recommendation:'Fix the channel sync, or lower the stock on the channel.',href:require('../connections/agent-channel-alerts').path,
        actionLabel:'Review channel problems',sourceId:'agent-notice-169'};
    }
    if(Number(r.job_id)===170)return {kind:'inventory',grouped:true,importance:'Important',priority:78,title:'Costs went up or margins fell',
      happened:r.n+' cost or margin alert'+(r.n===1?'':'s')+'.',why:'StockChief compares each new cost with the one before it, and gross margins (before fees and shipping) with your minimum, through the day.',
      recommendation:'Review the costs and selling prices. StockChief has not changed any price.',href:require('./cost-alerts').path,actionLabel:'Review cost and margin alerts',sourceId:'agent-notice-170'};
    if(Number(r.job_id)===201){const breaker=require('./circuit-breaker');
      return {kind:'inventory',grouped:true,importance:'Urgent',priority:95,title:'StockChief paused its automatic work',
        happened:'Today’s automatic activity is far above a usual day, so nothing automatic runs.',
        why:'StockChief compares its own purchases, labels, emails, credits, price changes and other automatic work with the last 28 days.',
        recommendation:'Review what it did today. Only you can resume it.',href:breaker.path,actionLabel:'Review and resume',sourceId:'agent-notice-201'};}
    if(Number(r.job_id)===171)return {kind:'inventory',grouped:true,importance:'Important',priority:79,title:'Unusual activity',
      happened:r.n+' unusual change'+(r.n===1?'':'s')+' in the last seven days.',why:'Big stock corrections or price changes, many changes by one person, or changes during the hours you watch.',
      recommendation:'Check who made each change and why. Nothing was blocked.',href:require('./unusual-activity').path,actionLabel:'Review unusual activity',sourceId:'agent-notice-171'};
    const watch=require('./activity-watches').spec[r.job_id];
    if(watch)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:watch.label,happened:r.n+' matching stock or price record'+(r.n===1?'':'s')+'.',
      why:watch.summary,recommendation:'Review the matching records.',href:'/autopilot/reviews/'+watch.key,actionLabel:'Review alerts',sourceId:'agent-notice-'+r.job_id};
    if(Number(r.job_id)===166){
      const out=Number(r.out||0),low=r.n-out,item=n=>n+' '+(n===1?'item is':'items are');
      return {kind:'inventory',grouped:true,importance:out?'Urgent':'Important',priority:out?88:76,title:out?'Items are out of stock':'Items are running low',
        happened:[out?item(out)+' out of stock.':null,low?item(low)+' at or below the level you reorder at.':null].filter(Boolean).join(' '),
        why:'StockChief compares stock on hand with each reorder point, or your own alert level, through the day.',
        recommendation:'Reorder or move stock, or change the reorder point.',href:require('./stock-alerts').path,actionLabel:'Review stock alerts',sourceId:'agent-notice-166'};
    }
    if(Number(r.job_id)===167)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'Your watch rules found something',
      happened:r.n+' product'+(r.n===1?' matches':'s match')+' your watch rules.',why:'StockChief checks your watch rules against stock, sales, prices and expiry dates through the day.',
      recommendation:'Review what matched and act on it.',href:require('./watch-rules').path,actionLabel:'Review watch rule alerts',sourceId:'agent-notice-167'};
    if(Number(r.job_id)===87)return {kind:'inventory',grouped:true,importance:'Important',priority:75,title:'Channel prices need review',
      happened:r.n+' recorded channel price'+(r.n===1?' needs':'s need')+' review.',why:'A comparison found a price difference, MAP issue or older provider observation.',
      recommendation:'Review the recorded prices and their check dates.',href:'/autopilot/reviews/channel-prices',actionLabel:'Review channel prices',sourceId:'agent-notice-87'};
    if(Number(r.job_id)===209)return {kind:'inventory',grouped:true,importance:'Important',priority:65,title:'Your repeated fixes suggest a new rule',
      happened:r.n+' fix'+(r.n===1?' was':'es were')+' made again and again.',why:'The same stock correction, order change, move or declined reorder was recorded at least three times in the last 30 days.',
      recommendation:'See what each rule would have done, then accept it or say not now.',href:require('./correction-rules').path,actionLabel:'Review suggested rules',sourceId:'agent-notice-209'};
    if(Number(r.job_id)===208)return {kind:'inventory',grouped:true,importance:'Information',priority:50,title:'StockChief can stop asking about routines you always approve',
      happened:r.n+' routine'+(r.n===1?' was':'s were')+' approved by you five times in a row without a change.',why:'Each one stays inside your limits and is not on the list that always needs a person.',
      recommendation:'Confirm once to let StockChief do it alone, or keep being asked.',href:require('./approval-learning').path,actionLabel:'Review routines',sourceId:'agent-notice-208',ownerOnly:true};
    if(Number(r.job_id)===180)return {kind:'inventory',grouped:true,importance:'Information',priority:45,title:'Your daily team summary',
      happened:'The summary for '+r.due+' is ready.',why:'Who did what that day, and what is late now, from the recorded work.',
      recommendation:'Read it and follow up on anything late.',href:require('./team-summary').path+'?filter='+encodeURIComponent(r.due),actionLabel:'Read team summary',sourceId:'agent-notice-180'};
    if(Number(r.job_id)===204)return {kind:'inventory',grouped:true,importance:'Information',priority:35,title:'Your daily record of StockChief work',
      happened:'What StockChief did on '+r.due+' is ready.',why:'Each action shows why it was done and what allowed it.',
      recommendation:'Undo anything you do not want in one tap, where nothing changed since.',href:'/autopilot/reviews/daily-work?filter='+encodeURIComponent(r.due),actionLabel:'View completed work',sourceId:'agent-notice-204'};
    if(Number(r.job_id)===21)return {kind:'inventory',grouped:true,importance:'Important',priority:60,title:'Reorder point changes need your approval',
      happened:r.n+' reorder point and target '+(r.n===1?'change is':'changes are')+' ready.',why:'The daily check compared recorded sales, lead time and safety stock with the current settings.',
      recommendation:'Approve the changes or keep the current settings.',href:'/planning/reorder-refresh#waiting',actionLabel:'Review reorder changes',sourceId:'agent-notice-21'};
    if(Number(r.job_id)===67)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'A recurring customer order needs review',
      happened:r.n+' recurring schedule'+(r.n===1?' is':'s are')+' paused.',why:'A current plan, price, customer or authority check requires a decision.',
      recommendation:'Review the schedule and its current order details.',href:'/autopilot/reviews/recurring-customer-orders',actionLabel:'Review recurring orders',sourceId:'agent-notice-67'};
    if(Number(r.job_id)===212)return {kind:'inventory',grouped:true,importance:'Important',priority:62,title:'Rules from your procedures are ready to confirm',
      happened:r.n+' procedure'+(r.n===1?' has':'s have')+' rules waiting for you.',why:'StockChief read each clause and prepared the exact rule where one fits. Clauses it could not match exactly are kept for people.',
      recommendation:'Check each rule against its clause, then confirm it or keep the clause for people.',href:'/autopilot/procedure-originals',actionLabel:'Review procedure rules',sourceId:'agent-notice-212',ownerOnly:true};
    if(Number(r.job_id)===213)return {kind:'inventory',grouped:true,importance:'Important',priority:72,title:'A playbook stopped and needs you',
      happened:r.n+' playbook run'+(r.n===1?' is':'s are')+' waiting for you.',why:'A step failed, left work only a person can do, or is set to ask you first.',
      recommendation:'See where it stopped, deal with what waits, then continue the run.',href:'/autopilot/playbooks',actionLabel:'Review playbooks',sourceId:'agent-notice-213',ownerOnly:true};
    if(Number(r.job_id)===206)return {kind:'inventory',grouped:true,importance:'Information',priority:40,title:'Review this month’s automation opportunities',
      happened:'Repeated owner approvals can become taught routines.',why:'The work stayed inside the same customer, supplier or product scope.',
      recommendation:'Review the examples and choose the limits for each rule.',href:'/autopilot/reviews/automation-opportunities',actionLabel:'Review routines',sourceId:'agent-notice-206'};
    return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'Overdue orders, shipments and invoices',
      happened:r.n+' outstanding orders, shipments or invoices. Earliest due date '+r.due+'.',why:'A scheduled check found work still open past the promised date.',
      recommendation:'Review the overdue records and follow up with the named contact.',
      href:'/autopilot/reviews/overdue-work',actionLabel:'Review overdue records',sourceId:'agent-notice-'+r.job_id,dueDate:r.due};
  }).map(answer).concat(transferNotices);
}

module.exports={transfers,refresh,inbox};
