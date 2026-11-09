'use strict';

const policy=require('../commercial/agent-plan');
const overdue=require('./exception-reviews').find(d=>d.id===168);
const transfers=`WITH positions AS (
    SELECT t.id,t.transfer_number,t.status,t.expected_arrival_date::date AS due,src.name AS source,dst.name AS destination,
      sum(l.shipped_quantity) AS shipped,sum(l.received_quantity) AS received,sum(l.lost_quantity+l.damaged_quantity) AS exceptions,
      sum(l.shipped_quantity-l.received_quantity-l.lost_quantity-l.damaged_quantity) AS outstanding
    FROM inventory_transfers t JOIN inventory_transfer_lines l ON l.workspace_id=t.workspace_id AND l.transfer_id=t.id
    JOIN locations src ON src.workspace_id=t.workspace_id AND src.id=t.source_location_id
    JOIN locations dst ON dst.workspace_id=t.workspace_id AND dst.id=t.destination_location_id
    WHERE t.workspace_id=$1 AND t.status IN ('SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED','RECEIVED')
      AND ($2='' OR lower(t.transfer_number)=lower($2) OR lower(src.name)=lower($2) OR lower(dst.name)=lower($2))
    GROUP BY t.id,src.name,dst.name)
  SELECT p.transfer_number AS "Transfer",p.source AS "From",p.destination AS "To",p.due::text AS "Due",p.shipped AS "Dispatched",
    p.received AS "Received",p.outstanding AS "Still in transit",p.exceptions AS "Lost or damaged",
    CASE WHEN p.outstanding>0 AND p.due<$3::date THEN 'Past expected arrival' WHEN p.outstanding>0 THEN 'In transit'
      WHEN p.exceptions>0 THEN 'Closed with a difference' ELSE 'Received complete' END AS "Result",
    coalesce(n.reminders,0) AS "In-app reminders",'/transfers/'||p.id AS link
    FROM positions p LEFT JOIN stockchief_runtime.agent_operational_notices n ON n.workspace_id=$1 AND n.job_id=124
      AND n.kind='Transfer' AND n.reference=p.transfer_number AND n.link='/transfers/'||p.id
    ORDER BY (p.outstanding>0 AND p.due<$3::date) DESC NULLS LAST,p.due NULLS LAST,p.transfer_number`;

async function refresh(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,168,'automatic'))return;
  const today=await require('../lib/business-time').today(db,workspaceId);
  const includeTransfers=policy.permits(account.plan,124,'automatic');
  const watched=require('./activity-watches').spec;
  const watchQueries=Object.entries(watched).filter(([job])=>policy.permits(account.plan,Number(job),'automatic'))
    .map(([job,d])=>' UNION ALL SELECT '+job+',"Alert",reference,link,$3::date FROM ('+d.sql+') observed').join('');
  const priceChecks=policy.permits(account.plan,87,'automatic')&&(await db.query("SELECT 1 FROM connection_commerce_positions WHERE workspace_id=$1 AND field='price' AND mode<>'off' LIMIT 1",[workspaceId])).rowCount>0;
  const candidates='SELECT 168 AS job,"Type" AS kind,"Reference" AS ref,link,"Due"::date AS due FROM ('+overdue.sql+') x'+
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
    (includeTransfers?' UNION ALL SELECT 124,\'Transfer\',"Transfer",link,"Due"::date FROM ('+transfers+') t WHERE "Result"=\'Past expected arrival\'':'')+watchQueries;
  await db.query(`WITH current AS MATERIALIZED (${candidates}), upserted AS (
    INSERT INTO stockchief_runtime.agent_operational_notices AS n(workspace_id,job_id,kind,reference,link,due,last_reminded)
    SELECT $1,job,kind,ref,link,due,$3::date FROM current
    ON CONFLICT(workspace_id,job_id,kind,reference,link) DO UPDATE SET due=excluded.due,last_reminded=excluded.last_reminded,
      reminders=n.reminders+CASE WHEN n.last_reminded<excluded.last_reminded OR n.resolved THEN 1 ELSE 0 END,resolved=false
    WHERE n.resolved OR (n.job_id IN (124,168) AND (n.last_reminded<excluded.last_reminded OR n.due<>excluded.due))
    RETURNING job_id)
    UPDATE stockchief_runtime.agent_operational_notices n SET resolved=true WHERE n.workspace_id=$1 AND NOT n.resolved
      AND NOT EXISTS(SELECT 1 FROM current c WHERE c.job=n.job_id AND c.kind=n.kind AND c.ref=n.reference AND c.link=n.link)`,[workspaceId,'',today]);
}

async function inbox(db,workspaceId,actorId=null){
  const {rows}=await db.query(`SELECT n.job_id,count(*)::int AS n,min(n.due)::text AS due
    FROM stockchief_runtime.agent_operational_notices n WHERE n.workspace_id=$1 AND NOT n.resolved
      AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=n.workspace_id AND u.id=$2 AND u.role='owner'))
    GROUP BY n.job_id`,[workspaceId,actorId]);
  if(!rows.length)return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state))return [];
  return rows.filter(r=>policy.permits(state.plan,Number(r.job_id),'automatic',{trained:Number(r.job_id)===67})).map(r=>{
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
    if(Number(r.job_id)===67)return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:'A recurring customer order needs review',
      happened:r.n+' recurring schedule'+(r.n===1?' is':'s are')+' paused.',why:'A current plan, price, customer or authority check requires a decision.',
      recommendation:'Review the schedule and its current order details.',href:'/autopilot/reviews/recurring-customer-orders',actionLabel:'Review recurring orders',sourceId:'agent-notice-67'};
    if(Number(r.job_id)===206)return {kind:'inventory',grouped:true,importance:'Information',priority:40,title:'Review this month’s automation opportunities',
      happened:'Repeated owner approvals can become taught routines.',why:'The work stayed inside the same customer, supplier or product scope.',
      recommendation:'Review the examples and choose the limits for each rule.',href:'/autopilot/reviews/automation-opportunities',actionLabel:'Review routines',sourceId:'agent-notice-206'};
    const transfer=Number(r.job_id)===124,name=transfer?'warehouse transfers':'orders, shipments or invoices';
    return {kind:'inventory',grouped:true,importance:'Important',priority:80,title:transfer?'Overdue warehouse transfers':'Overdue orders, shipments and invoices',
      happened:r.n+' outstanding '+name+'. Earliest due date '+r.due+'.',why:'A scheduled check found work still open past the promised date.',
      recommendation:transfer?'Check with the receiving location and confirm the units physically received.':'Review the overdue records and follow up with the named contact.',
      href:'/autopilot/reviews/'+(transfer?'transfer-arrivals':'overdue-work'),actionLabel:'Review overdue records',sourceId:'agent-notice-'+r.job_id,dueDate:r.due};
  });
}

module.exports={transfers,refresh,inbox};
