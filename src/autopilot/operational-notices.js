'use strict';

const policy=require('../commercial/agent-plan');
const {hasVerifiedMigration}=require('../db/migrate-postgres');
const transferArrivals=require('../transfers/agent-transfer-arrivals');
const purchaseBudgets=require('../purchasing/agent-budgets');
const stockLoss=require('./stock-loss-patterns');
const returnRates=require('./return-rates');
const history=require('../commercial/agent-history');
const exceptionReviews=require('./exception-reviews');
const overdue=exceptionReviews.find(d=>d.id===168);
const stockDiscrepancies=exceptionReviews.find(d=>d.id===3);
const migratedInboxDatabases=new WeakSet();
const monitoredJobs=[10,110,116];
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
  const eligible=jobs.filter(job=>policy.permits(state.plan,job,'automatic'));
  if(!eligible.length)return new Set();
  const {rows}=await db.query(`SELECT requested.job FROM workspaces w
    CROSS JOIN unnest($2::int[]) requested(job)
    LEFT JOIN workspace_autopilot a ON a.workspace_id=w.id
    LEFT JOIN stockchief_runtime.agent_job_modes m ON m.workspace_id=w.id AND m.job_id=requested.job
    WHERE w.id=$1 AND w.deletion_requested_at IS NULL AND a.mode IS DISTINCT FROM 'OBSERVE'
      AND coalesce(a.paused,0)=0 AND coalesce(a.suspended,0)=0
      AND coalesce(m.mode,'inherit') NOT IN ('watch','ask')
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
  const includeReturnRates=monitors.has(116);
  const args=[workspaceId,'',today];
  if(includeTransfers)args.push(timeZone);
  if(includeReturnRates)args.push((await history.access(db,workspaceId)).salesFrom);
  const cutoff=includeReturnRates?'$'+args.length:'NULL';
  if(policy.permits(account.plan,3,'automatic'))await checkStockDiscrepancies(db,workspaceId,today);
  await require('../accounting/agent-cash-planning').preparePaymentChecks(db,workspaceId,account,today);
  const watched=require('./activity-watches').spec;
  const watchQueries=Object.entries(watched).filter(([job])=>policy.permits(account.plan,Number(job),'automatic'))
    .map(([job,d])=>' UNION ALL SELECT '+job+',"Alert",reference,link,$3::date FROM ('+d.sql+') observed').join('');
  const priceChecks=policy.permits(account.plan,87,'automatic')&&(await db.query("SELECT 1 FROM connection_commerce_positions WHERE workspace_id=$1 AND field='price' AND mode<>'off' LIMIT 1",[workspaceId])).rowCount>0;
  const candidates='SELECT 168 AS job,"Type" AS kind,"Reference" AS ref,link,"Due"::date AS due FROM ('+overdue.sql+') x'+
    (policy.permits(account.plan,50,'suggest')?` UNION ALL SELECT 50,'Stock ready',o.order_number,'/autopilot/reviews/stock-ready-updates',$3::date FROM sales_orders o
     WHERE o.workspace_id=$1 AND o.status='CONFIRMED'
      AND EXISTS(SELECT 1 FROM sales_order_events e WHERE e.workspace_id=o.workspace_id AND e.sales_order_id=o.id AND e.event_type='confirmed' AND e.detail::jsonb->>'status'='BACKORDERED')
      AND NOT EXISTS(SELECT 1 FROM customer_communications m WHERE m.workspace_id=o.workspace_id AND m.stock_ready_order_id=o.id AND m.status IN ('QUEUED','SENT'))`:'')+
    (policy.permits(account.plan,204,'automatic')?` UNION ALL SELECT 204,'Daily work',d.report_date,'/autopilot/reviews/daily-work?filter='||d.report_date,d.report_date::date
     FROM workspace_daily_digests d WHERE d.workspace_id=$1 AND d.summary::jsonb->>'format'='agent-brief' AND (d.summary::jsonb->>'actions')::int>0
      AND d.report_date=(SELECT max(report_date) FROM workspace_daily_digests WHERE workspace_id=$1 AND summary::jsonb->>'format'='agent-brief')`:'')+
    (priceChecks?` UNION ALL SELECT 87,'Channel price',reference,link,$3::date FROM (`+require('../pricing/channel-price-review').observed+`) prices WHERE "Finding"<>'Matches recorded catalogue price'`:'')+
    (policy.permits(account.plan,209,'automatic')?` UNION ALL SELECT 209,'Correction',reference,link,$3::date FROM (`+require('./repeated-corrections').sql+`) corrections`:'')+
    ` UNION ALL SELECT 67,'Recurring order',r.id,'/autopilot/reviews/recurring-customer-orders',r.next_date
      FROM stockchief_runtime.recurring_customer_orders r WHERE r.workspace_id=$1 AND r.paused AND r.problem IS NOT NULL`+
    ` UNION ALL SELECT 206,'Automation',s.month,'/autopilot/reviews/automation-opportunities',(s.month||'-01')::date
      FROM stockchief_runtime.agent_automation_opportunities s WHERE s.workspace_id=$1 AND s.month=left($3::text,7)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.rows) opportunity JOIN stockchief_runtime.assistant_action_proposals p
        ON p.workspace_id=s.workspace_id AND '/actions/'||p.id=opportunity->>'link'
        WHERE NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_draft_rules r WHERE r.workspace_id=p.workspace_id
          AND r.action_type=p.action_type AND r.scope_key=p.payload#>>'{training,key}'))`+
    ' UNION ALL SELECT 167,"Brand","SKU",link,$3::date FROM ('+require('./brand-watches').matching+') b'+
    (includeTransfers?' UNION ALL '+transferArrivals.candidates('$4'):'')+
    (monitors.has(110)?' UNION ALL '+purchaseBudgets.overBudgetNotices:'')+
    (includeReturnRates?' UNION ALL SELECT * FROM ('+returnRates.notices(cutoff)+') return_rates':'')+
    (monitors.has(10)?' UNION ALL SELECT 10,\'Stock loss\',reference,link,$3::date FROM ('+stockLoss.sql+') losses':'')+watchQueries;
  await db.query(`WITH current AS MATERIALIZED (${candidates}), upserted AS (
    INSERT INTO stockchief_runtime.agent_operational_notices AS n(workspace_id,job_id,kind,reference,link,due,last_reminded,history_from)
    SELECT $1,job,kind,ref,link,due,$3::date,CASE WHEN job=116 THEN ${cutoff}::text::date END FROM current
    ON CONFLICT(workspace_id,job_id,kind,reference,link) DO UPDATE SET due=excluded.due,last_reminded=excluded.last_reminded,
      reminders=n.reminders+CASE WHEN n.last_reminded<excluded.last_reminded OR (n.resolved AND n.job_id<>124) THEN 1 ELSE 0 END,
      resolved=false,history_from=excluded.history_from
    WHERE n.resolved OR (n.job_id IN (124,168) AND (n.last_reminded<excluded.last_reminded OR n.due<>excluded.due))
      OR (n.job_id=116 AND n.history_from IS DISTINCT FROM excluded.history_from)
    RETURNING job_id)
    UPDATE stockchief_runtime.agent_operational_notices n SET resolved=true WHERE n.workspace_id=$1 AND NOT n.resolved
      AND NOT EXISTS(SELECT 1 FROM current c WHERE c.job=n.job_id AND c.kind=n.kind AND c.ref=n.reference AND c.link=n.link)`,
  args);
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
    SELECT 3,findings,checked_on::text,NULL::text FROM stockchief_runtime.agent_stock_discrepancy_checks
    WHERE workspace_id=$1 AND findings>0`:'';
  const paymentChecks=installed.payment_checks?`UNION ALL
    SELECT 104,p.bill_count,p.checked_on::text,NULL::text FROM stockchief_runtime.agent_supplier_payment_checks p
    WHERE p.workspace_id=$1 AND p.bill_count>0 AND NOT EXISTS (
      SELECT 1 FROM stockchief_runtime.agent_supplier_payment_approvals a WHERE a.workspace_id=p.workspace_id
        AND a.week_start=date_trunc('week',p.checked_on::timestamp)::date AND a.digest=p.run_digest)
    UNION ALL
    SELECT 108,discount_count,checked_on::text,NULL::text FROM stockchief_runtime.agent_supplier_payment_checks
    WHERE workspace_id=$1 AND discount_count>0`:'';
  const {rows}=await db.query(`SELECT job_id,n,due,history_from FROM (
    SELECT n.job_id,count(*)::int AS n,min(n.due)::text AS due,
      CASE WHEN n.job_id=116 THEN to_jsonb(n)->>'history_from' END AS history_from
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
  const visible=rows.filter(r=>Number(r.job_id)!==124&&policy.permits(state.plan,Number(r.job_id),Number(r.job_id)===50?'suggest':'automatic',{trained:Number(r.job_id)===67}));
  const suppressed=new Set();
  for(const {job_id:job} of visible)if([104,108].includes(Number(job))&&await require('./job-modes').restriction(db,workspaceId,Number(job),true))suppressed.add(job);
  const monitorJobs=visible.map(r=>Number(r.job_id)).filter(job=>monitoredJobs.includes(job));
  let returnHistoryFrom;
  if(monitorJobs.length){
    const active=await enabledMonitors(db,workspaceId,state,monitorJobs);
    for(const {job_id:job} of visible)if(monitorJobs.includes(Number(job))&&!active.has(Number(job)))suppressed.add(job);
    if(active.has(116))returnHistoryFrom=(await history.access(db,workspaceId)).salesFrom;
  }
  // A prior run may have compared sales outside the plan's current window.
  return visible.filter(r=>!suppressed.has(r.job_id)&&(Number(r.job_id)!==116||r.history_from===returnHistoryFrom)).map(r=>{
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
    if(Number(r.job_id)===116)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'High return rates need review',
      happened:r.n+' '+(r.n===1?'SKU or customer rate is above its peer rate.':'SKU or customer rates are above their peer rates.'),
      why:returnRates.summary,href:'/autopilot/reviews/customer-return-rates',actionLabel:'Review return rates',sourceId:'agent-notice-116'};
    if(Number(r.job_id)===10)return {kind:'inventory',grouped:true,importance:'Important',priority:70,title:'Repeated stock losses need review',
      happened:r.n+' '+(r.n===1?'product and shift combination shows':'product and shift combinations show')+' repeated stock corrections.',
      why:'Recorded stock was reduced more than once for the same product, warehouse and local shift.',
      href:'/autopilot/reviews/repeat-loss',actionLabel:'Review stock loss patterns',sourceId:'agent-notice-10'};
    if(Number(r.job_id)===50)return {kind:'inventory',grouped:true,importance:'Information',priority:55,title:'Waiting customer orders now have reserved stock',
      happened:r.n+' previously backordered order'+(r.n===1?' is':'s are')+' confirmed.',why:'The order records show a backorder followed by confirmation, with no queued or sent stock-ready update.',
      recommendation:'Review the current reservation and its customer update.',href:'/autopilot/reviews/stock-ready-updates',actionLabel:'Review ready orders',sourceId:'agent-notice-50'};
    const watch=require('./activity-watches').spec[r.job_id];
    if(watch)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:watch.label,happened:r.n+' matching stock or price record'+(r.n===1?'':'s')+'.',
      why:watch.summary,recommendation:'Review the matching records.',href:'/autopilot/reviews/'+watch.key,actionLabel:'Review alerts',sourceId:'agent-notice-'+r.job_id};
    if(Number(r.job_id)===167)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'Stock below a brand watch level',
      happened:r.n+' SKU'+(r.n===1?' is':'s are')+' at a watched stock level.',why:'The physical quantity across your inventory meets a saved brand rule.',
      recommendation:'Review the flagged products and their current stock.',href:'/autopilot/reviews/brand-watches',actionLabel:'View watched stock',sourceId:'agent-notice-167'};
    if(Number(r.job_id)===87)return {kind:'inventory',grouped:true,importance:'Important',priority:75,title:'Channel prices need review',
      happened:r.n+' recorded channel price'+(r.n===1?' needs':'s need')+' review.',why:'A comparison found a price difference, MAP issue or older provider observation.',
      recommendation:'Review the recorded prices and their check dates.',href:'/autopilot/reviews/channel-prices',actionLabel:'Review channel prices',sourceId:'agent-notice-87'};
    if(Number(r.job_id)===209)return {kind:'inventory',grouped:true,importance:'Important',priority:65,title:'Repeated corrections suggest a count rule',
      happened:r.n+' product and warehouse combination'+(r.n===1?' has':'s have')+' repeated corrections.',why:'At least three non-opening stock corrections were recorded in the last 30 days.',
      recommendation:'Review a recurring blind count before teaching a new rule.',href:'/autopilot/reviews/repeated-corrections',actionLabel:'Review suggested rule',sourceId:'agent-notice-209'};
    if(Number(r.job_id)===204)return {kind:'inventory',grouped:true,importance:'Information',priority:35,title:'Your daily record of StockChief work',
      happened:'Completed agent work is ready to review.',why:'The daily briefing recorded completed actions for '+r.due+'.',
      recommendation:'Review completed work and available undo actions.',href:'/autopilot/reviews/daily-work?filter='+encodeURIComponent(r.due),actionLabel:'View completed work',sourceId:'agent-notice-204'};
    if(Number(r.job_id)===67)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'A recurring customer order needs review',
      happened:r.n+' recurring schedule'+(r.n===1?' is':'s are')+' paused.',why:'A current plan, price, customer or authority check requires a decision.',
      recommendation:'Review the schedule and its current order details.',href:'/autopilot/reviews/recurring-customer-orders',actionLabel:'Review recurring orders',sourceId:'agent-notice-67'};
    if(Number(r.job_id)===206)return {kind:'inventory',grouped:true,importance:'Information',priority:40,title:'Review this month’s automation opportunities',
      happened:'Repeated owner approvals can become taught routines.',why:'The work stayed inside the same customer, supplier or product scope.',
      recommendation:'Review the examples and choose the limits for each rule.',href:'/autopilot/reviews/automation-opportunities',actionLabel:'Review routines',sourceId:'agent-notice-206'};
    return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'Overdue orders, shipments and invoices',
      happened:r.n+' outstanding orders, shipments or invoices. Earliest due date '+r.due+'.',why:'A scheduled check found work still open past the promised date.',
      recommendation:'Review the overdue records and follow up with the named contact.',
      href:'/autopilot/reviews/overdue-work',actionLabel:'Review overdue records',sourceId:'agent-notice-'+r.job_id,dueDate:r.due};
  }).concat(transferNotices);
}

module.exports={transfers,refresh,inbox};
