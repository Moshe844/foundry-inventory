'use strict';

// Job 180: the daily team summary, alone on Growth, Pro and Custom.
//
// Once a business day the worker's routine check writes the summary of the
// day that just ended, from the records themselves:
//  - who did what: stock receipts, shelf positions counted, pick lines
//    scanned, put-aways confirmed, adjustments, bin moves, inspections,
//    returns and staff tasks done, by person;
//  - what is late now: staff tasks past their due time (job 177), customer
//    orders not shipped by the promised date and purchase orders past their
//    expected date (the job 168 review), and the other overdue records;
//  - exceptions: shortages reported while picking, put-aways into another
//    bin, failed inspections, counts that differ from the records and
//    rejected scans.
// The summary is shown on its page and in Needs you on every mode, because
// it changes nothing. It reaches email from the mailbox the owner chose
// through the shared alert delivery (agent-alerts.js), which waits during
// the first 14 days, pause, Watch only and Ask me first. A replay writes
// nothing new.

const policy=require('../commercial/agent-plan');
const time=require('../lib/business-time');
const installed=require('../db/schema-installed');
const audit=require('../operations/postgres-security-audit');
const {addDays}=require('../accounting/customer-money');
const {ValidationError}=require('../domain/errors');

const JOB=180,key='daily-team-summary',path='/autopilot/reviews/'+key,table='stockchief_runtime.agent_team_summaries';
const labels={receipts:'Stock receipts',counts:'Shelf positions counted',picks:'Pick lines scanned',putaways:'Put-aways confirmed',adjustments:'Count adjustments',
  moves:'Bin moves scanned',inspections:'Deliveries inspected',returns:'Returns inspected',issues:'Stock issues',transfers:'Transfers',tasks:'Staff tasks done'};
const exceptionLabels={shortages:'Shortages reported while picking',wrongBin:'Put away in another bin',failedChecks:'Failed delivery inspections',countDifferences:'Counts that differ from the records',rejectedScans:'Scans refused'};
const one={receipts:'stock receipt',counts:'shelf position counted',picks:'pick line scanned',putaways:'put-away confirmed',adjustments:'count adjustment',moves:'bin move scanned',
  inspections:'delivery inspected',returns:'return inspected',issues:'stock issue',transfers:'transfer',tasks:'staff task done'};
const many={receipts:'stock receipts',counts:'shelf positions counted',picks:'pick lines scanned',putaways:'put-aways confirmed',adjustments:'count adjustments',moves:'bin moves scanned',
  inspections:'deliveries inspected',returns:'returns inspected',issues:'stock issues',transfers:'transfers',tasks:'staff tasks done'};

// $1 workspace, $2 start, $3 end of the business day.
const ACTIVITY=tasks=>`SELECT person,activity,n FROM (
  SELECT m.actor_user_id AS person,CASE m.operation WHEN 'receive' THEN 'receipts' WHEN 'adjust' THEN 'adjustments' WHEN 'issue' THEN 'issues' ELSE 'transfers' END AS activity,count(DISTINCT m.group_id)::int AS n
   FROM movements m WHERE m.workspace_id=$1 AND m.operation IN ('receive','adjust','issue','transfer') AND m.occurred_at::timestamptz>=$2 AND m.occurred_at::timestamptz<$3 GROUP BY 1,2
  UNION ALL SELECT l.counter_recorded_by,'counts',count(*)::int FROM warehouse_count_campaign_lines l WHERE l.workspace_id=$1 AND l.counter_recorded_at>=$2 AND l.counter_recorded_at<$3 GROUP BY 1
  UNION ALL SELECT x.actor_user_id,'picks',count(DISTINCT x.line_id)::int FROM fulfillment_wave_scans x WHERE x.workspace_id=$1 AND x.status='ACCEPTED' AND x.scanned_at::timestamptz>=$2 AND x.scanned_at::timestamptz<$3 GROUP BY 1
  UNION ALL SELECT c.confirmed_by,'putaways',count(*)::int FROM stockchief_runtime.agent_putaway_confirmations c WHERE c.workspace_id=$1 AND c.created_at>=$2 AND c.created_at<$3 GROUP BY 1
  UNION ALL SELECT b.scanned_by,'moves',count(*)::int FROM stockchief_runtime.agent_bin_corrections b WHERE b.workspace_id=$1 AND b.scanned_at>=$2 AND b.scanned_at<$3 GROUP BY 1
  UNION ALL SELECT h.inspected_by,'inspections',count(*)::int FROM stockchief_runtime.agent_quality_holds h WHERE h.workspace_id=$1 AND h.inspected_at>=$2 AND h.inspected_at<$3 GROUP BY 1
  UNION ALL SELECT r.inspected_by_user_id,'returns',count(*)::int FROM customer_returns r WHERE r.workspace_id=$1 AND r.inspected_at::timestamptz>=$2 AND r.inspected_at::timestamptz<$3 GROUP BY 1
  ${tasks?`UNION ALL SELECT t.done_by,'tasks',count(*)::int FROM stockchief_runtime.agent_staff_tasks t WHERE t.workspace_id=$1 AND t.status='DONE' AND t.done_at>=$2 AND t.done_at<$3 GROUP BY 1`:''}
 ) a WHERE n>0`;
const EXCEPTIONS=`SELECT person,exception,n FROM (
  SELECT x.actor_user_id AS person,'shortages' AS exception,count(*)::int AS n FROM fulfillment_wave_scans x WHERE x.workspace_id=$1 AND x.status='REJECTED' AND x.client_scan_id LIKE 'shortage:%' AND x.scanned_at::timestamptz>=$2 AND x.scanned_at::timestamptz<$3 GROUP BY 1
  UNION ALL SELECT x.actor_user_id,'rejectedScans',count(*)::int FROM fulfillment_wave_scans x WHERE x.workspace_id=$1 AND x.status='REJECTED' AND x.client_scan_id NOT LIKE 'shortage:%' AND x.scanned_at::timestamptz>=$2 AND x.scanned_at::timestamptz<$3 GROUP BY 1
  UNION ALL SELECT c.confirmed_by,'wrongBin',count(*)::int FROM stockchief_runtime.agent_putaway_confirmations c WHERE c.workspace_id=$1 AND c.location_id<>c.planned_location_id AND c.created_at>=$2 AND c.created_at<$3 GROUP BY 1
  UNION ALL SELECT h.inspected_by,'failedChecks',count(*)::int FROM stockchief_runtime.agent_quality_holds h WHERE h.workspace_id=$1 AND h.status='FAILED' AND h.inspected_at>=$2 AND h.inspected_at<$3 GROUP BY 1
  UNION ALL SELECT l.counter_recorded_by,'countDifferences',count(*)::int FROM warehouse_count_campaign_lines l WHERE l.workspace_id=$1 AND l.counter_recorded_at>=$2 AND l.counter_recorded_at<$3 AND l.counter_quantity<>l.before_quantity GROUP BY 1
 ) e WHERE n>0`;

async function names(db,workspaceId,ids){
  const rows=(await db.query('SELECT id,name FROM users WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,ids.filter(Boolean)])).rows;
  return new Map(rows.map(r=>[r.id,r.name]));
}

// The summary of one finished business day, from the records.
async function collect(db,workspaceId,day,{calendarDate,timeZone}){
  const bounds=[workspaceId,time.dayBoundary(day,timeZone),time.dayBoundary(addDays(day,1),timeZone)];
  const hasTasks=await installed.has(db,'stockchief_runtime.agent_staff_tasks');
  const [activity,exceptions,overdue,lateTasks]=await Promise.all([
    db.query(ACTIVITY(hasTasks),bounds).then(r=>r.rows),
    db.query(EXCEPTIONS,bounds).then(r=>r.rows),
    db.query(`SELECT * FROM (${require('./exception-reviews').find(d=>d.id===168).sql}) x`,[workspaceId,'',calendarDate]).then(r=>r.rows),
    hasTasks?db.query(`SELECT t.id,t.title,t.assignee_id AS person,t.due_at FROM stockchief_runtime.agent_staff_tasks t WHERE t.workspace_id=$1 AND t.status='ASSIGNED' AND t.due_at<clock_timestamp()
      ORDER BY t.due_at,t.id LIMIT 200`,[workspaceId]).then(r=>r.rows):[]]);
  const who=await names(db,workspaceId,[...activity,...exceptions,...lateTasks].map(r=>r.person));
  const name=id=>who.get(id)||'Former team member';
  const people=new Map();
  for(const r of activity){const key=r.person||'';if(!people.has(key))people.set(key,{id:r.person,name:name(r.person),did:{},exceptions:{}});people.get(key).did[r.activity]=(people.get(key).did[r.activity]||0)+r.n;}
  for(const r of exceptions){const key=r.person||'';if(!people.has(key))people.set(key,{id:r.person,name:name(r.person),did:{},exceptions:{}});people.get(key).exceptions[r.exception]=(people.get(key).exceptions[r.exception]||0)+r.n;}
  const count=type=>overdue.filter(r=>r.Type===type).length;
  return {format:'team-summary',day,deliveredOn:calendarDate,asOf:new Date().toISOString(),
    people:[...people.values()].sort((a,b)=>a.name.localeCompare(b.name)||String(a.id).localeCompare(String(b.id))),
    late:{tasks:lateTasks.map(t=>({id:t.id,title:t.title,person:name(t.person),personId:t.person,due:new Date(t.due_at).toISOString()})),
      customerOrders:count('Customer order'),purchaseOrders:count('Purchase order'),other:overdue.length-count('Customer order')-count('Purchase order'),
      overdue:overdue.length,items:overdue.slice(0,20).map(r=>({type:r.Type,reference:r.Reference,contact:r.Contact,problem:r.Problem,due:r.Due,daysLate:Number(r['Days late']),link:r.link}))}};
}

// The worker writes yesterday's summary once. Starter and accounts on older
// terms get none.
async function deliver(db,workspaceId,{now=new Date()}={}){
  if(!await installed.has(db,table))return {skipped:'not_installed'};
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {skipped:'plan'};
  const clock=await time.forWorkspace(db,workspaceId,now),day=addDays(clock.calendarDate,-1);
  if((await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,day])).rowCount)return {replayed:true,day};
  const summary=await collect(db,workspaceId,day,clock);
  const saved=await db.query(`INSERT INTO ${table}(workspace_id,report_date,summary) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING report_date`,[workspaceId,day,summary]);
  if(!saved.rowCount)return {replayed:true,day};
  const owner=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE w.id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  await audit.record(db,{workspaceId,actorId:owner?.id||null},{action:'Daily team summary prepared',reference:day,
    after:{people:summary.people.length,lateTasks:summary.late.tasks.length,overdue:summary.late.overdue,exceptions:summary.people.reduce((n,p)=>n+Object.values(p.exceptions).reduce((a,b)=>a+b,0),0)}});
  return {day,people:summary.people.length};
}

const plural=(n,a,b)=>n+' '+(n===1?a:b);
function sentences(s){
  const out=[];
  for(const p of s.people){
    const did=Object.entries(p.did).map(([k,n])=>plural(n,one[k],many[k]));
    const odd=Object.entries(p.exceptions).map(([k,n])=>exceptionLabels[k].toLowerCase()+': '+n);
    out.push(p.name+': '+(did.length?did.join(', '):'no recorded work')+(odd.length?'. Exceptions: '+odd.join(', '):'')+'.');
  }
  if(!s.people.length)out.push('No team work was recorded that day.');
  const late=[s.late.tasks.length?plural(s.late.tasks.length,'staff task','staff tasks'):null,s.late.customerOrders?plural(s.late.customerOrders,'customer order','customer orders'):null,
    s.late.purchaseOrders?plural(s.late.purchaseOrders,'purchase order','purchase orders'):null,s.late.other?plural(s.late.other,'other overdue record','other overdue records'):null].filter(Boolean);
  out.push(late.length?'Late now: '+late.join(', ')+'.':'Nothing is late.');
  for(const t of s.late.tasks.slice(0,10))out.push('Late task: '+t.title+' ('+t.person+').');
  return out;
}

// One plain line per part of the summary, for the alert email.
async function lines(db,workspaceId,keys){
  const out=[];
  for(const k of keys){
    const s=(await db.query(`SELECT summary FROM ${table} WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,k.reference])).rows[0]?.summary;
    if(!s){out.push('Team summary for '+k.reference+'.');continue;}
    out.push('Team summary for '+s.day+'.',...sentences(s));
  }
  return out;
}

// The page and Ask's review: rows by person, then what is late.
async function report(db,ctx,{filter,page=1}){
  if(filter&&(!/^\d{4}-\d{2}-\d{2}$/.test(filter)||!Number.isFinite(Date.parse(filter))||new Date(filter).toISOString().slice(0,10)!==filter))throw new ValidationError('Choose a date in YYYY-MM-DD format.');
  if(!await installed.has(db,table))return {rows:[],more:false,summary:'The team summary appears after the next scheduled check.'};
  const s=(await db.query(`SELECT summary FROM ${table} WHERE workspace_id=$1 AND ($2='' OR report_date=$2::date) ORDER BY report_date DESC LIMIT 1`,[ctx.workspaceId,filter||''])).rows[0]?.summary;
  if(!s)return {rows:[],more:false,summary:'A team summary appears here after the scheduled check for a completed day.'};
  const dates='from='+s.day+'&to='+s.day,rows=[];
  for(const p of s.people){
    for(const [k,n] of Object.entries(p.did))rows.push({'Team member':p.name,Activity:labels[k],Count:n,
      link:['receipts','adjustments','issues','transfers'].includes(k)&&p.id?'/activity?'+dates+'&user='+encodeURIComponent(p.id)+'&operation='+({receipts:'receive',adjustments:'adjust',issues:'issue',transfers:'transfer'})[k]:'/warehouse/staff-tasks'});
    for(const [k,n] of Object.entries(p.exceptions))rows.push({'Team member':p.name,Activity:exceptionLabels[k],Count:n,link:'/warehouse/staff-tasks'});
  }
  const late={};for(const t of s.late.tasks)late[t.person]=(late[t.person]||0)+1;
  for(const [person,n] of Object.entries(late))rows.push({'Team member':person,Activity:'Late staff tasks',Count:n,link:'/warehouse/staff-tasks#open'});
  rows.push({'Team member':'Inventory',Activity:'Late customer orders',Count:s.late.customerOrders,link:'/autopilot/reviews/overdue-work'},
    {'Team member':'Inventory',Activity:'Late purchase orders',Count:s.late.purchaseOrders,link:'/autopilot/reviews/overdue-work'},
    {'Team member':'Inventory',Activity:'Overdue orders, shipments and invoices',Count:s.late.overdue,link:'/autopilot/reviews/overdue-work'});
  return {rows:rows.slice((page-1)*100,page*100),more:rows.length>page*100,
    summary:'Team work on '+s.day+', by person, and what was late when the summary was written on '+s.deliveredOn+'. '+sentences(s).find(l=>/^(Late now|Nothing is late)/.test(l))};
}

const definition={id:JOB,key,label:'Daily team summary: who did what and what is late',filterLabel:'Business date (YYYY-MM-DD)',readPage:(db,ctx,o)=>report(db,ctx,o)};
module.exports={JOB,key,path,table,deliver,collect,lines,report,sentences,definition};
