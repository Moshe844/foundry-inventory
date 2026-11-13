'use strict';

// Job 177: gives staff tasks and checks they are done.
//
// A task points at native work that already exists: a count assignment, a
// pick wave, a put-away sheet, a delivery held for inspection or a bin move.
// It goes to one team member who can do that work and reach its warehouse,
// shows on their phone (Needs you, Warehouse stock and My tasks), and is
// checked off only when the work's own record says it is finished: the count
// saved, the wave scanned, the put-away confirmed, the inspection recorded or
// the move scanned. A task past its due time is flagged once.
//
// Growth: StockChief drafts each assignment and the owner approves it.
// Pro and Custom: StockChief hands work out on its own inside the owner's
// limits (which kinds, how long staff have, how many open tasks per person).
// Pause, Watch only and the first 14 days hand out nothing new; Ask me first
// (for the inventory or this job) drafts instead. Checking finished work and
// flagging late work continue in every mode, because they change nothing.
// The owner can withdraw any task; the work itself is never touched.

const policy=require('../commercial/agent-plan'),P=require('../actions/permissions');
const access=require('./postgres-warehouse-access'),installed=require('../db/schema-installed');
const audit=require('./postgres-security-audit'),modes=require('../autopilot/job-modes');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=177,table='stockchief_runtime.agent_staff_tasks',rules='stockchief_runtime.agent_staff_task_rules',action='team.assign_task',path='/warehouse/staff-tasks';
const physical=[P.OPERATE,P.REQUEST_TRANSFER,P.PICK_TRANSFER,P.DISPATCH_TRANSFER,P.RECEIVE_TRANSFER];
// Each kind: what it is called, who may do it, the job that makes the work,
// whether staff limited to some warehouses can open its page, and that page.
const specs={
  count:{label:'Count this shelf',plural:'Counts',permissions:[P.COUNT_STOCK],job:7,restricted:true,href:id=>'/warehouse/my-counts/'+id,check:'count saved'},
  pick:{label:'Pick this wave',plural:'Picks',permissions:[P.MANAGE_FULFILLMENT_WAVES],job:null,restricted:false,href:id=>'/warehouse/waves/'+id,check:'every line scanned'},
  putaway:{label:'Put away this receipt',plural:'Put-aways',permissions:physical,job:47,restricted:true,href:id=>'/warehouse/putaway/'+id,check:'put-away confirmed'},
  inspect:{label:'Inspect this delivery',plural:'Inspections',permissions:[P.RECEIVE_PO],job:51,restricted:false,href:id=>'/autopilot/delivery-quality/'+id,check:'inspection recorded'},
  move:{label:'Move this stock',plural:'Stock moves',permissions:physical,job:11,restricted:true,href:id=>'/warehouse/bin-corrections/'+id,check:'move scanned'}
};
const kinds=Object.keys(specs),handed=kinds.filter(k=>k!=='count');
const expected=e=>[400,402,403,404,409,422].includes(e?.status);

// Work waiting for a person, by kind. $1 workspace, $2 kinds. Counts are not
// here: a count assignment already names its counter (jobs 7 and 16).
const OPEN_WORK=`SELECT * FROM (
  SELECT 'pick' AS kind,w.id AS source_id,
    'Pick '||CASE WHEN count(DISTINCT o.id)=1 THEN 'order '||min(o.order_number) ELSE count(DISTINCT o.id)||' orders' END||' (wave '||w.wave_number||')' AS title,
    array_agg(DISTINCT l.location_id ORDER BY l.location_id) AS location_ids,w.created_at::timestamptz AS created_at
  FROM fulfillment_waves w JOIN fulfillment_wave_lines l ON l.workspace_id=w.workspace_id AND l.wave_id=w.id
  JOIN sales_shipments sh ON sh.workspace_id=l.workspace_id AND sh.id=l.shipment_id JOIN sales_orders o ON o.workspace_id=sh.workspace_id AND o.id=sh.sales_order_id
  WHERE w.workspace_id=$1 AND 'pick'=ANY($2::text[]) AND w.status IN ('RELEASED','PICKING') GROUP BY w.id
  UNION ALL
  SELECT 'putaway',p.id,'Put away '||(p.source->>'quantity')||' × '||(p.source->>'product')||' to '||(p.source#>>'{to,name}'),
    ARRAY[p.source#>>'{from,id}',p.source#>>'{to,id}'],p.created_at
  FROM stockchief_runtime.agent_putaway_instructions p WHERE p.workspace_id=$1 AND 'putaway'=ANY($2::text[]) AND p.status='READY'
  UNION ALL
  SELECT 'inspect',h.id,'Inspect '||trim_scale(h.quantity-h.returned_quantity-h.written_off_quantity)||' × '||i.name||' at '||l.name,ARRAY[h.location_id],h.created_at
  FROM stockchief_runtime.agent_quality_holds h JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.location_id
  WHERE h.workspace_id=$1 AND 'inspect'=ANY($2::text[]) AND h.status='HELD' AND h.quantity>h.returned_quantity+h.written_off_quantity
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_return_lines r WHERE r.workspace_id=h.workspace_id AND r.receipt_line_id=h.receipt_line_id AND r.hold_active)
  UNION ALL
  SELECT 'move',b.id,'Move '||(b.source->>'quantity')||' × '||coalesce(i.name,b.source->>'sku')||' from '||(b.source#>>'{from,name}')||' to '||(b.source#>>'{to,name}'),
    ARRAY[b.source#>>'{from,id}',b.source#>>'{to,id}'],b.created_at
  FROM stockchief_runtime.agent_bin_corrections b LEFT JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.source->>'skuId' LEFT JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE b.workspace_id=$1 AND 'move'=ANY($2::text[]) AND b.status='OPEN' AND b.kind='MOVE'
) work`;

// What the work's own record says about each open task.
const STATE=`WITH open AS (SELECT id,kind,source_id FROM ${table} WHERE workspace_id=$1 AND status IN ('DRAFT','ASSIGNED'))
  SELECT o.id,CASE WHEN c.observed_at IS NOT NULL THEN 'done' WHEN s.id IS NULL OR s.status<>'DRAFT' THEN 'gone' ELSE 'open' END AS state,c.counter_id AS done_by,
    jsonb_build_object('counted',(SELECT count(counter_quantity) FROM warehouse_count_campaign_lines x WHERE x.workspace_id=$1 AND x.campaign_id=o.source_id),
      'positions',(SELECT count(*) FROM warehouse_count_campaign_lines x WHERE x.workspace_id=$1 AND x.campaign_id=o.source_id)) AS evidence,NULL::text AS exception
  FROM open o LEFT JOIN stockchief_runtime.agent_count_tasks c ON c.workspace_id=$1 AND c.campaign_id=o.source_id
  LEFT JOIN warehouse_count_campaigns s ON s.workspace_id=$1 AND s.id=o.source_id WHERE o.kind='count'
  UNION ALL
  SELECT o.id,CASE WHEN w.id IS NULL OR w.status='CANCELLED' THEN 'gone' WHEN w.status IN ('PACKED','COMPLETED') OR NOT EXISTS(SELECT 1 FROM fulfillment_wave_lines l
      WHERE l.workspace_id=$1 AND l.wave_id=w.id AND l.status<>'PICKED') THEN 'done' ELSE 'open' END,
    (SELECT x.actor_user_id FROM fulfillment_wave_scans x WHERE x.workspace_id=$1 AND x.wave_id=o.source_id AND x.status='ACCEPTED' ORDER BY x.scanned_at DESC,x.id DESC LIMIT 1),
    jsonb_build_object('picked',(SELECT count(*) FROM fulfillment_wave_lines l WHERE l.workspace_id=$1 AND l.wave_id=o.source_id AND l.status='PICKED'),
      'lines',(SELECT count(*) FROM fulfillment_wave_lines l WHERE l.workspace_id=$1 AND l.wave_id=o.source_id),
      'scans',(SELECT count(*) FROM fulfillment_wave_scans x WHERE x.workspace_id=$1 AND x.wave_id=o.source_id AND x.status='ACCEPTED')),
    CASE WHEN EXISTS(SELECT 1 FROM fulfillment_wave_lines l WHERE l.workspace_id=$1 AND l.wave_id=o.source_id AND l.status='SHORT') THEN 'A picker reported a shortage.' END
  FROM open o LEFT JOIN fulfillment_waves w ON w.workspace_id=$1 AND w.id=o.source_id WHERE o.kind='pick'
  UNION ALL
  SELECT o.id,CASE WHEN p.id IS NULL THEN 'gone' WHEN p.status='PUT_AWAY' THEN 'done' ELSE 'open' END,
    (SELECT x.confirmed_by FROM stockchief_runtime.agent_putaway_confirmations x WHERE x.workspace_id=$1 AND x.instruction_id=o.source_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1),
    jsonb_build_object('putAway',trim_scale(p.put_away_quantity)::text,'quantity',p.source->>'quantity',
      'wrongBin',EXISTS(SELECT 1 FROM stockchief_runtime.agent_putaway_confirmations x WHERE x.workspace_id=$1 AND x.instruction_id=o.source_id AND x.location_id<>x.planned_location_id)),NULL
  FROM open o LEFT JOIN stockchief_runtime.agent_putaway_instructions p ON p.workspace_id=$1 AND p.id=o.source_id WHERE o.kind='putaway'
  UNION ALL
  SELECT o.id,CASE WHEN h.id IS NULL OR h.status IN ('PROPOSED','NOT_HELD') THEN 'gone' WHEN h.status IN ('PASSED','FAILED') THEN 'done'
      WHEN h.quantity<=h.returned_quantity+h.written_off_quantity THEN 'gone' ELSE 'open' END,
    h.inspected_by,jsonb_build_object('result',h.status),NULL
  FROM open o LEFT JOIN stockchief_runtime.agent_quality_holds h ON h.workspace_id=$1 AND h.id=o.source_id WHERE o.kind='inspect'
  UNION ALL
  SELECT o.id,CASE WHEN b.id IS NULL OR b.status IN ('CANCELLED','UNDONE','PROPOSED') THEN 'gone' WHEN b.status IN ('SCANNED','COMPLETED') THEN 'done' ELSE 'open' END,
    b.scanned_by,jsonb_build_object('result',b.status),NULL
  FROM open o LEFT JOIN stockchief_runtime.agent_bin_corrections b ON b.workspace_id=$1 AND b.id=o.source_id WHERE o.kind='move'`;

async function owner(c,ctx,lock=false){
  const row=(await c.query(`SELECT a.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF w,u,a':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the inventory owner can hand out staff tasks.');
  if(lock)await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[row.id]);
  return row.id;
}
// Kinds StockChief hands out that the current plan makes work for.
function planKinds(plan){return handed.filter(k=>!specs[k].job||policy.permits(plan,specs[k].job,'draft'));}

// Active team members, other than the owner, who may do this kind of work at
// every one of its locations. Fewest open tasks first.
async function people(db,workspaceId,kind,locationIds,{only=null}={}){
  const spec=specs[kind];
  const rows=(await db.query(`SELECT u.id,u.name,u.role,u.permissions,u.warehouse_location_ids,
      (SELECT count(*)::int FROM ${table} t WHERE t.workspace_id=u.workspace_id AND t.assignee_id=u.id AND t.status IN ('DRAFT','ASSIGNED')) AS open
    FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.deletion_requested_at IS NULL
    WHERE u.workspace_id=$1 AND u.role<>'owner' AND ($2::text IS NULL OR u.id=$2)
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY 6,u.name,u.id`,[workspaceId,only])).rows;
  const out=[];
  for(const u of rows){
    if(!spec.permissions.every(p=>P.can(u,p)))continue;
    if(u.warehouse_location_ids!==null){
      if(!spec.restricted)continue;
      const allowed=new Set((await access.locations(db,workspaceId,u.warehouse_location_ids)).map(l=>l.id));
      if(!locationIds.length||locationIds.some(id=>!allowed.has(id)))continue;
    }
    out.push({id:u.id,name:u.name,open:u.open});
  }
  return out;
}

async function work(db,workspaceId,kindList,{sourceId=null,kind=null,unassigned=false,neverHanded=false,limit=50}={}){
  const filters=[];const args=[workspaceId,kindList];
  if(kind){args.push(kind,sourceId);filters.push(`kind=$3 AND source_id=$4`);}
  if(unassigned)filters.push(`NOT EXISTS(SELECT 1 FROM ${table} t WHERE t.workspace_id=$1 AND t.kind=work.kind AND t.source_id=work.source_id AND t.status IN ('DRAFT','ASSIGNED','DONE'))`);
  if(neverHanded)filters.push(`NOT EXISTS(SELECT 1 FROM ${table} t WHERE t.workspace_id=$1 AND t.kind=work.kind AND t.source_id=work.source_id
    AND (t.status IN ('DRAFT','ASSIGNED','DONE') OR t.closed_by IS NOT NULL))`);
  return (await db.query(`${OPEN_WORK} ${filters.length?'WHERE '+filters.join(' AND '):''} ORDER BY created_at,kind,source_id LIMIT ${Number(limit)}`,args)).rows;
}

async function insert(c,workspaceId,w,{assigneeId,status,automatic,hours,createdBy=null,approvedBy=null,requestKey=null}){
  const id=newId('stafftask');
  await c.query(`INSERT INTO ${table}(id,workspace_id,kind,source_id,title,location_ids,assignee_id,status,automatic,due_at,created_by,approved_by,approved_at,request_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()+make_interval(hours=>$10::int),$11,$12,CASE WHEN $12::text IS NOT NULL THEN clock_timestamp() END,$13)`,
  [id,workspaceId,w.kind,w.source_id,String(w.title).slice(0,300),w.location_ids.filter(Boolean),assigneeId,status,automatic,hours,createdBy,approvedBy,requestKey]);
  return id;
}

// Count assignments are made by the owner, by job 7 schedules and by job 16
// stocktakes. Each becomes a count task for its counter.
async function mirrorCounts(c,workspaceId){
  const added=await c.query(`INSERT INTO ${table}(id,workspace_id,kind,source_id,title,location_ids,assignee_id,status,automatic,due_at,created_by,approved_by,approved_at)
    SELECT 'stafftask_count_'||md5(t.workspace_id||':'||t.campaign_id),t.workspace_id,'count',t.campaign_id,left(s.title,300),
      ARRAY(SELECT jsonb_array_elements_text(s.scope->'locationIds')),t.counter_id,'ASSIGNED',t.scheduled,
      s.created_at+make_interval(hours=>coalesce(r.due_hours,24)),s.created_by_user_id,
      CASE WHEN NOT t.scheduled THEN s.created_by_user_id END,CASE WHEN NOT t.scheduled THEN s.created_at END
    FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
    JOIN users creator ON creator.workspace_id=s.workspace_id AND creator.id=s.created_by_user_id
    LEFT JOIN ${rules} r ON r.workspace_id=t.workspace_id
    WHERE t.workspace_id=$1 AND t.observed_at IS NULL AND s.status='DRAFT'
      AND NOT EXISTS(SELECT 1 FROM ${table} x WHERE x.workspace_id=t.workspace_id AND x.kind='count' AND x.source_id=t.campaign_id)
    ON CONFLICT DO NOTHING RETURNING id,assignee_id`,[workspaceId]);
  return added.rowCount;
}

// Checks every open task against its work's record and flags late ones.
async function followUp(c,workspaceId){
  const out={done:0,closed:0,late:0};
  const person=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE w.id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  const ctx={workspaceId,actorId:person?.id||null};
  for(const r of (await c.query(STATE,[workspaceId])).rows){
    if(r.state==='open')continue;
    const task=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 AND status IN ('DRAFT','ASSIGNED') FOR UPDATE`,[workspaceId,r.id])).rows[0];
    if(!task)continue;
    if(r.state==='done'&&task.status==='ASSIGNED'){
      await c.query(`UPDATE ${table} SET status='DONE',done_at=clock_timestamp(),done_by=$3,evidence=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,
        [workspaceId,task.id,r.done_by,{...r.evidence,checked:specs[task.kind].check}]);
      await audit.record(c,ctx,{action:'Staff task done',reference:task.id,
        after:{kind:task.kind,source:task.source_id,assignee:task.assignee_id,doneBy:r.done_by,late:Boolean(task.overdue_at),evidence:r.evidence}});
      out.done++;continue;
    }
    // The work finished before the draft was approved, or its record closed.
    const reason=r.state==='done'?'The work was finished before this assignment was approved.':'The work was closed or cancelled in its own record.';
    await c.query(`UPDATE ${table} SET status='CANCELLED',closed_reason=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[workspaceId,task.id,reason]);
    await audit.record(c,ctx,{action:'Staff task closed',reference:task.id,after:{kind:task.kind,source:task.source_id,reason}});
    out.closed++;
  }
  const late=(await c.query(`UPDATE ${table} SET overdue_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND status='ASSIGNED' AND overdue_at IS NULL
    AND due_at<clock_timestamp() RETURNING id,kind,source_id,assignee_id,due_at`,[workspaceId])).rows;
  for(const t of late)await audit.record(c,ctx,{action:'Staff task late',reference:t.id,after:{kind:t.kind,source:t.source_id,assignee:t.assignee_id,due:t.due_at}});
  out.late=late.length;
  return out;
}

// Why StockChief is not handing out new work now, if it is not.
async function hold(db,workspaceId,account){
  const settings=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(settings.paused||settings.suspended)return {why:'StockChief is paused, so it is not handing out new work.'};
  if(account.shadow)return {why:'StockChief is watching during your first 14 days. It shows who it would choose but hands out nothing.'};
  if(settings.mode==='OBSERVE')return {why:'StockChief is set to Watch only. It shows who it would choose but hands out nothing.'};
  const job=await modes.restriction(db,workspaceId,JOB,false);
  if(job)return {why:job};
  if(!policy.permits(account.plan,JOB,'automatic'))return {draft:'StockChief drafts each assignment for you to approve.'};
  const stop=settings.canAutomate?await policy.stopped(db,workspaceId,account,action,true):'StockChief is set to Ask me first for this inventory, so it drafts each assignment for you to approve.';
  return stop?{draft:stop}:{};
}

// Hands out waiting work within the owner's limits: on its own on Pro and
// Custom, as drafts for approval on Growth or under Ask me first.
async function handOut(c,workspaceId,account){
  const rule=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND enabled FOR UPDATE`,[workspaceId])).rows[0];
  if(!rule)return {assigned:0,drafted:0};
  const held=await hold(c,workspaceId,account);
  if(held.why)return {assigned:0,drafted:0,held:held.why};
  const automatic=!held.draft,allowed=planKinds(account.plan).filter(k=>rule.kinds.includes(k));
  const out={assigned:0,drafted:0,unstaffed:0},made=[];
  for(const w of await work(c,workspaceId,allowed,{neverHanded:true})){
    await c.query('SAVEPOINT staff_task');
    try{
      const choice=(await people(c,workspaceId,w.kind,w.location_ids)).find(p=>p.open<rule.max_open);
      if(!choice){out.unstaffed++;await c.query('RELEASE SAVEPOINT staff_task');continue;}
      const id=await insert(c,workspaceId,w,{assigneeId:choice.id,status:automatic?'ASSIGNED':'DRAFT',automatic,hours:rule.due_hours,createdBy:rule.authorized_by});
      made.push({id,kind:w.kind,source:w.source_id,assignee:choice.id});automatic?out.assigned++:out.drafted++;
      await c.query('RELEASE SAVEPOINT staff_task');
    }catch(error){
      await c.query('ROLLBACK TO SAVEPOINT staff_task');await c.query('RELEASE SAVEPOINT staff_task');
      if(!expected(error)&&error.code!=='23505')throw error;
    }
  }
  const issue=out.unstaffed?out.unstaffed+(out.unstaffed===1?' piece of work has':' pieces of work have')+' no team member who can do it and reach its warehouse, or everyone is at your limit.':null;
  if((rule.last_issue||null)!==issue)await c.query(`UPDATE ${rules} SET last_issue=$2 WHERE workspace_id=$1`,[workspaceId,issue]);
  if(made.length)await audit.record(c,{workspaceId,actorId:rule.authorized_by},{action:automatic?'Staff tasks handed out':'Staff task assignments drafted',
    after:{tasks:made,dueHours:rule.due_hours,maxOpen:rule.max_open,...(held.draft?{why:held.draft}:{})}});
  return out;
}

// The worker's routine: mirror counts, check work, flag late tasks, hand out.
async function run(db,workspaceId){
  if(!await installed.has(db,table))return {skipped:'not_installed'};
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {skipped:'plan'};
  const go=c=>(async()=>{
    const counts=await mirrorCounts(c,workspaceId);
    const followed=await followUp(c,workspaceId);
    return {counts,...followed,...await handOut(c,workspaceId,account)};
  })();
  return typeof db.transaction==='function'?db.transaction(go,{isolation:'SERIALIZABLE',retrySafe:true}):go(db);
}

function hours(value,fallback){
  const text=String(value??'').trim();if(!text)return fallback;
  const n=Number(text);if(!Number.isInteger(n)||n<1||n>168)throw new ValidationError('Choose a due time from 1 to 168 hours.');
  return n;
}

// The owner's limits for handing out work.
async function saveRule(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('These task limits changed. Reload the page to see them.');
    if(input.stop==='yes'){
      if(!prior?.enabled)return {unchanged:true};
      await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
      await audit.record(c,ctx,{action:'Staff task handing out stopped',before:{kinds:prior.kinds}});return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const chosen=[...new Set([input.kinds].flat().filter(Boolean).map(String))];
    if(!chosen.length||chosen.some(k=>!handed.includes(k)))throw new ValidationError('Choose at least one kind of work StockChief may hand out.');
    const due=hours(input.dueHours,null),max=Number(input.maxOpen);
    if(due==null)throw new ValidationError('Choose a due time from 1 to 168 hours.');
    if(!Number.isInteger(max)||max<1||max>50)throw new ValidationError('Choose from 1 to 50 open tasks per person.');
    if(!prior?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    await c.query(`INSERT INTO ${rules} AS r(workspace_id,kinds,due_hours,max_open,enabled,authorized_by) VALUES($1,$2,$3,$4,true,$5)
      ON CONFLICT(workspace_id) DO UPDATE SET kinds=excluded.kinds,due_hours=excluded.due_hours,max_open=excluded.max_open,enabled=true,
        authorized_by=excluded.authorized_by,last_issue=NULL,revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,chosen,due,max,ctx.actorId]);
    await audit.record(c,ctx,{action:'Staff task limits saved',before:prior?{kinds:prior.kinds,dueHours:prior.due_hours,maxOpen:prior.max_open,enabled:prior.enabled}:{},
      after:{kinds:chosen,dueHours:due,maxOpen:max}});
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The owner gives one piece of waiting work to one person.
async function assign(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const key=String(input.requestKey||'');if(!/^[\w:-]{8,160}$/.test(key))throw new ValidationError('Open the staff task page again before assigning.');
    const prior=(await c.query(`SELECT id,kind,source_id,assignee_id FROM ${table} WHERE workspace_id=$1 AND request_key=$2`,[ctx.workspaceId,key])).rows[0];
    if(prior){
      if(prior.kind!==input.kind||prior.source_id!==input.sourceId||prior.assignee_id!==input.assigneeId)throw new ValidationError('This form was used for a different task.');
      return {id:prior.id,replayed:true};
    }
    if(!planKinds(account.plan).includes(input.kind))throw new ValidationError('Choose work your plan includes.');
    const w=(await work(c,ctx.workspaceId,[input.kind],{kind:input.kind,sourceId:String(input.sourceId||''),limit:1}))[0];
    if(!w)throw new ValidationError('This work is finished or no longer waiting. Reload the page.');
    const live=(await c.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND kind=$2 AND source_id=$3 AND status IN ('DRAFT','ASSIGNED','DONE') FOR UPDATE`,[ctx.workspaceId,w.kind,w.source_id])).rowCount;
    if(live)throw new ValidationError('This work already has a task. Withdraw it first to give it to someone else.');
    const person=(await people(c,ctx.workspaceId,w.kind,w.location_ids,{only:String(input.assigneeId||'')}))[0];
    if(!person)throw new ValidationError('Choose a team member who can do this work and reach its warehouse.');
    const rule=(await c.query(`SELECT due_hours FROM ${rules} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    const due=hours(input.dueHours,rule?.due_hours||24);
    const id=await insert(c,ctx.workspaceId,w,{assigneeId:person.id,status:'ASSIGNED',automatic:false,hours:due,createdBy:ctx.actorId,approvedBy:ctx.actorId,requestKey:key});
    await audit.record(c,ctx,{action:'Staff task assigned',reference:id,after:{kind:w.kind,source:w.source_id,assignee:person.id,dueHours:due}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The owner approves drafted assignments, one or all. The work and the person
// are checked again; a draft that no longer fits is closed with the reason.
async function approve(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const ids=input.all==='yes'?null:[input.ids].flat().filter(Boolean).map(String);
    if(ids&&!ids.length)throw new ValidationError('Choose the assignments to approve.');
    const drafts=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND status='DRAFT' AND ($2::text[] IS NULL OR id=ANY($2)) ORDER BY created_at,id FOR UPDATE`,
      [ctx.workspaceId,ids])).rows;
    const out={approved:0,closed:0};
    for(const d of drafts){
      const w=planKinds(account.plan).includes(d.kind)?(await work(c,ctx.workspaceId,[d.kind],{kind:d.kind,sourceId:d.source_id,limit:1}))[0]:null;
      const person=w&&(await people(c,ctx.workspaceId,d.kind,w.location_ids,{only:d.assignee_id}))[0];
      if(!person){
        const reason=w?'The person can no longer do this work or reach its warehouse.':'The work is finished or no longer waiting.';
        await c.query(`UPDATE ${table} SET status='CANCELLED',closed_reason=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,d.id,reason]);
        await audit.record(c,ctx,{action:'Staff task closed',reference:d.id,after:{kind:d.kind,source:d.source_id,reason}});out.closed++;continue;
      }
      await c.query(`UPDATE ${table} SET status='ASSIGNED',approved_by=$3,approved_at=clock_timestamp(),due_at=clock_timestamp()+(due_at-created_at),revision=revision+1
        WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,d.id,ctx.actorId]);
      await audit.record(c,ctx,{action:'Staff task approved',reference:d.id,after:{kind:d.kind,source:d.source_id,assignee:d.assignee_id}});out.approved++;
    }
    return out;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Undo: the owner declines a draft or withdraws an assigned task. The work
// itself is untouched; StockChief will not hand it out again on its own.
async function withdraw(db,ctx,id,input={}){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    const t=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];
    if(!t)throw new NotFoundError('That staff task is not in this inventory.');
    if(t.status==='CANCELLED')return {replayed:true};
    if(t.status==='DONE')throw new ValidationError('This task is already done. Its work is recorded.');
    if(input.revision!=null&&Number(input.revision)!==t.revision)throw new ValidationError('This task changed. Reload the page.');
    const reason=t.status==='DRAFT'?'Declined by the owner.':'Withdrawn by the owner.';
    await c.query(`UPDATE ${table} SET status='CANCELLED',closed_reason=$3,closed_by=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,reason,ctx.actorId]);
    await audit.record(c,ctx,{action:t.status==='DRAFT'?'Staff task declined':'Staff task withdrawn',reference:id,before:{status:t.status,assignee:t.assignee_id},after:{kind:t.kind,source:t.source_id}});
    return {withdrawn:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

const describe=t=>{
  const e=t.evidence||{};
  if(t.kind==='count')return e.positions!=null?e.counted+' of '+e.positions+' positions counted':'Count saved';
  if(t.kind==='pick')return e.lines!=null?e.picked+' of '+e.lines+' lines scanned':'Wave scanned';
  if(t.kind==='putaway')return e.quantity!=null?e.putAway+' of '+e.quantity+' put away'+(e.wrongBin?' · some in another bin':''):'Put-away confirmed';
  if(t.kind==='inspect')return e.result==='FAILED'?'Inspection failed · goods stay held':'Inspection passed';
  return e.result==='COMPLETED'?'Move scanned and booked':'Move scanned';
};
const SELECT=`SELECT t.*,u.name AS person,d.name AS finisher,t.status='ASSIGNED' AND t.due_at<clock_timestamp() AS late FROM ${table} t
  JOIN users u ON u.workspace_id=t.workspace_id AND u.id=t.assignee_id LEFT JOIN users d ON d.workspace_id=t.workspace_id AND d.id=t.done_by`;
const present=t=>({...t,href:specs[t.kind].href(t.source_id),label:specs[t.kind].label,done:t.status==='DONE'?describe(t):null});

async function planState(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  return {state,locked:!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft')};
}

// The owner's page.
async function page(db,ctx){
  await owner(db,ctx);
  const {state,locked}=await planState(db,ctx.workspaceId);
  if(locked)policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,JOB,'draft');
  const [rule,drafts,open,done]=await Promise.all([
    db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1`,[ctx.workspaceId]).then(r=>r.rows[0]||null),
    db.query(`${SELECT} WHERE t.workspace_id=$1 AND t.status='DRAFT' ORDER BY t.created_at,t.id LIMIT 100`,[ctx.workspaceId]).then(r=>r.rows.map(present)),
    db.query(`${SELECT} WHERE t.workspace_id=$1 AND t.status='ASSIGNED' ORDER BY t.due_at,t.id LIMIT 100`,[ctx.workspaceId]).then(r=>r.rows.map(present)),
    db.query(`${SELECT} WHERE t.workspace_id=$1 AND t.status='DONE' ORDER BY t.done_at DESC,t.id DESC LIMIT 20`,[ctx.workspaceId]).then(r=>r.rows.map(present))]);
  const waiting=[];
  for(const w of await work(db,ctx.workspaceId,planKinds(state.plan),{unassigned:true,limit:30})){
    const team=await people(db,ctx.workspaceId,w.kind,w.location_ids);
    waiting.push({...w,label:specs[w.kind].label,href:specs[w.kind].href(w.source_id),team,suggested:team.find(p=>!rule||p.open<rule.max_open)||null});
  }
  const held=await hold(db,ctx.workspaceId,state);
  const automatic=policy.permits(state.plan,JOB,'automatic');
  return {plan:state.plan,shadow:state.shadow,automatic,held,rule,drafts,open,done,waiting,kinds:Object.fromEntries(planKinds(state.plan).map(k=>[k,specs[k]])),allKinds:specs};
}

// A team member's own tasks.
async function mine(db,ctx){
  const {locked}=await planState(db,ctx.workspaceId);
  if(locked||!await installed.has(db,table))return {locked:true,tasks:[]};
  const tasks=(await db.query(`${SELECT} WHERE t.workspace_id=$1 AND t.assignee_id=$2 AND (t.status='ASSIGNED' OR t.status='DONE' AND t.done_at>clock_timestamp()-interval '1 day')
    ORDER BY t.status='DONE',t.due_at,t.id LIMIT 100`,[ctx.workspaceId,ctx.actorId])).rows.map(present);
  return {locked:false,tasks};
}

async function inbox(db,workspaceId,actorId){
  if(!actorId||!await installed.has(db,table))return [];
  const rows=(await db.query(`SELECT t.id,t.kind,t.source_id,t.title,t.status,t.due_at,t.created_at,t.assignee_id,t.due_at<clock_timestamp() AS late,u.role
    FROM ${table} t JOIN users u ON u.workspace_id=t.workspace_id AND u.id=$2
    WHERE t.workspace_id=$1 AND (t.status='DRAFT' AND u.role='owner' OR t.status='ASSIGNED' AND (t.assignee_id=$2 OR u.role='owner' AND t.due_at<clock_timestamp()))
    ORDER BY t.due_at,t.id LIMIT 200`,[workspaceId,actorId])).rows;
  if(!rows.length)return [];
  const {locked}=await planState(db,workspaceId);
  if(locked)return [];
  const items=[],role=rows[0].role;
  if(role==='owner'){
    const drafts=rows.filter(r=>r.status==='DRAFT'),late=rows.filter(r=>r.status==='ASSIGNED'&&r.late);
    if(drafts.length)items.push({kind:'inventory',grouped:true,importance:'Needs You',priority:70,title:'Approve staff tasks',
      happened:drafts.length+(drafts.length===1?' task assignment is':' task assignments are')+' ready for your approval.',
      why:'StockChief chose a team member who can do each piece of work and reach its warehouse.',recommendation:'Approve them in one tap, or change who does what.',
      href:path+'#drafts',actionLabel:'Review staff tasks',sourceId:'staff-tasks-drafts',at:drafts[0].created_at,createdAt:drafts[0].created_at});
    if(late.length)items.push({kind:'inventory',grouped:true,importance:'Important',priority:72,title:'Staff tasks are late',
      happened:late.length+(late.length===1?' task is':' tasks are')+' past the time it was due.',why:'Each task is checked against its own record, and this work is not finished there yet.',
      recommendation:'Check with the person, or give the work to someone else.',href:path+'#open',actionLabel:'Review late tasks',sourceId:'staff-tasks-late',at:late[0].due_at,createdAt:late[0].due_at,dueDate:late[0].due_at});
  }
  // Counts already reach the counter as Open my count.
  for(const r of rows.filter(r=>r.status==='ASSIGNED'&&r.assignee_id===actorId&&r.kind!=='count'))
    items.push({kind:'inventory',importance:r.late?'Important':'Needs You',priority:r.late?70:64,title:(r.late?'Late: ':'')+r.title,
      happened:r.late?'This task is past the time it was due.':'This task is yours.',why:specs[r.kind].label+'. It is checked off when its '+specs[r.kind].check.replace(/ (saved|scanned|confirmed|recorded)$/,'')+' is recorded.',
      href:specs[r.kind].href(r.source_id),actionLabel:'Open task',sourceId:'staff-task-'+r.id,at:r.created_at,createdAt:r.created_at,dueDate:r.due_at});
  return items;
}

// The agent review behind Ask and the review list.
async function review(db,ctx){
  const rows=(await db.query(`${SELECT} WHERE t.workspace_id=$1 AND t.status IN ('DRAFT','ASSIGNED','DONE') ORDER BY t.status='DONE',t.due_at,t.id LIMIT 101`,[ctx.workspaceId])).rows.map(present);
  return {rows:rows.slice(0,100).map(t=>({Task:t.title,Person:t.person,Status:t.status==='DRAFT'?'Waiting for your approval':t.status==='DONE'?'Done: '+t.done:t.late?'Late':'Assigned',
    Due:t.due_at,link:path})),more:rows.length>100,
    summary:'Counts, picks, put-aways, inspections and stock moves given to your team. Each is checked off only when its own record shows the work is finished.'};
}
const definition={id:JOB,key:'staff-tasks',label:'Staff tasks and whether they are done',readPage:(db,ctx)=>review(db,ctx)};

module.exports={JOB,path,specs,handed,run,mirrorCounts,followUp,handOut,saveRule,assign,approve,withdraw,page,mine,inbox,definition,people,work,action,table};
