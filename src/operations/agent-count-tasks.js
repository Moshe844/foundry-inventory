'use strict';
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const access=require('./postgres-warehouse-access'),campaigns=require('./postgres-count-campaigns');
const dates=require('../accounting/customer-money'),time=require('../lib/business-time');
const exact=require('../domain/exact-quantity'),quantities=require('../domain/stock-quantity');
const observations=require('./agent-count-observations');
const modes=require('../autopilot/job-modes');
const {hash}=require('../pricing/postgres-promotions');
const storage=require('../commercial/storage-capacity');
const scoped=c=>({query:c.query.bind(c),transaction:work=>work(c)});
async function owner(c,ctx,lock=false){
  const row=(await c.query(`SELECT a.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF w,u,a':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can assign stock counts.');
  if(lock)await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[row.id]);
  return row.id;
}
async function counter(c,ctx,locationIds,lock=false){
  const row=(await c.query(`SELECT u.role,u.permissions FROM users u JOIN accounts a ON a.id=u.account_id
    JOIN workspaces w ON w.id=u.workspace_id AND w.deletion_requested_at IS NULL
    LEFT JOIN platform_account_access x ON x.account_id=a.id WHERE u.workspace_id=$1 AND u.id=$2 AND x.disabled_at IS NULL
    ${lock?'FOR SHARE OF u,a,w':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row||!permissions.can(row,permissions.COUNT_STOCK))throw new AuthorizationError('Choose an active team member who can perform stock counts.');
  await access.assertLocations(c,ctx,locationIds);
}
function includeTracking(input){
  if(input.stockScope==null||input.stockScope==='quantity')return false;
  if(input.stockScope!=='all')throw new ValidationError('Choose all stock or quantity-only stock.');
  return true;
}

async function teaching(c,ctx,{locationId,counterId,includesTracking,locationIds,exampleId=null}){
  return (await c.query(`SELECT t.campaign_id FROM stockchief_runtime.agent_count_tasks t
    JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
    WHERE t.workspace_id=$1 AND t.location_id=$2 AND t.counter_id=$3 AND t.includes_tracking=$4
    AND NOT t.scheduled AND t.observed_at IS NOT NULL AND s.status='COMPLETED'
    AND s.created_by_user_id=$5 AND s.approved_by_user_id=$5
    AND s.scope->'locationIds' @> $6::jsonb AND s.scope->'locationIds' <@ $6::jsonb
    AND ($7::text IS NULL OR t.campaign_id=$7)
    ORDER BY s.completed_at DESC,t.campaign_id LIMIT 1`,
    [ctx.workspaceId,locationId,counterId,includesTracking,ctx.actorId,JSON.stringify(locationIds),exampleId])).rows[0]?.campaign_id;
}

async function create(c,ctx,{locationId,counterId,requestKey,includesTracking},automatic,trained=false){
  const location=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL FOR SHARE',[ctx.workspaceId,locationId])).rows[0];
  if(!location)throw new ValidationError('Choose an active location in this inventory.');
  if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>180)throw new ValidationError('Open the current count assignment form before sending it.');
  const prior=(await c.query('SELECT campaign_id,counter_id,location_id,includes_tracking,scheduled FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,requestKey])).rows[0];
  if(prior){
    if(prior.location_id!==locationId||prior.counter_id!==counterId||prior.scheduled!==automatic)throw new ValidationError('This form was used for a different assignment.');
    if(prior.includes_tracking!==includesTracking)throw new ValidationError('This form was used for a different stock scope.');
    return prior.campaign_id;
  }
  await policy.requireWorkspaceJob(c,ctx.workspaceId,7,automatic?'automatic':'draft',{trained});
  const zones=await access.locations(c,ctx.workspaceId,[locationId]);
  await counter(c,{workspaceId:ctx.workspaceId,actorId:counterId},zones.map(l=>l.id),true);
  const {id}=await campaigns.create(scoped(c),ctx,{locationId,title:'Count '+location.name},{includeTracking:includesTracking});
  const {rows:[sheet]}=await c.query(`SELECT count(*)::int n,coalesce(sum(octet_length(convert_to(to_jsonb(l)::text,'UTF8'))),0) bytes
    FROM warehouse_count_campaign_lines l WHERE workspace_id=$1 AND campaign_id=$2`,[ctx.workspaceId,id]);
  if(!sheet.n)throw new ValidationError('This location has no stock positions to count in the selected scope.');
  const evidenceBytes=includesTracking?await observations.capture(c,ctx.workspaceId,id):0;
  await storage.reserve(c,ctx.workspaceId,'phone-count:'+hash([id]),8192+Number(sheet.bytes)+evidenceBytes,{finished:true});
  await c.query(`INSERT INTO stockchief_runtime.agent_count_tasks(workspace_id,campaign_id,counter_id,request_key,location_id,scheduled,includes_tracking)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[ctx.workspaceId,id,counterId,requestKey,locationId,automatic,includesTracking]);
  return id;
}
async function assign(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,177,'draft');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['count-assign:'+ctx.workspaceId]);
    const stop=await modes.restriction(c,ctx.workspaceId,7,false);
    if(stop)throw new ValidationError(stop);
    if(String(input.requestKey||'').startsWith('schedule:'))throw new ValidationError('Open a fresh assignment form.');
    return create(c,ctx,{...input,includesTracking:includeTracking(input)},false);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function schedule(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx,true);
    if(input.remove==='1'){
      await c.query('DELETE FROM stockchief_runtime.agent_count_schedules WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,input.locationId]);return;
    }
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,7,'draft');
    const days=Number(input.days),day=String(input.firstDay||''),today=await time.today(c,ctx.workspaceId);
    if(!Number.isInteger(days)||days<1||days>366||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||day<today)
      throw new ValidationError('Choose a first date from today and a repeat interval from 1 to 366 days.');
    const zones=await access.locations(c,ctx.workspaceId,[input.locationId]);
    if(!zones.length)throw new ValidationError('Choose an active location from this inventory.');
    const locationIds=zones.map(l=>l.id),includesTracking=includeTracking(input);
    await counter(c,{workspaceId:ctx.workspaceId,actorId:input.counterId},locationIds,true);
    const exampleId=account.plan==='growth'?await teaching(c,ctx,{...input,includesTracking,locationIds}):null;
    if(account.plan==='growth'&&!exampleId)throw new ValidationError('Complete and approve one manually assigned count for this counter, location and stock scope before scheduling it on Growth.');
    const present=await c.query('SELECT 1 FROM stockchief_runtime.agent_count_schedules WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,input.locationId]);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],present.rowCount?0:1);
    if(!present.rowCount)await storage.reserve(c,ctx.workspaceId,'phone-count-schedule:'+hash([input.locationId]),8192,{finished:true});
    await c.query(`INSERT INTO stockchief_runtime.agent_count_schedules(workspace_id,location_id,counter_id,owner_id,interval_days,next_due,includes_tracking,example_campaign_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,location_id) DO UPDATE SET counter_id=$3,owner_id=$4,interval_days=$5,next_due=$6,
      includes_tracking=$7,example_campaign_id=$8,last_issue=NULL`,[ctx.workspaceId,input.locationId,input.counterId,ctx.actorId,days,day,includesTracking,exampleId]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function runSchedules(c,workspaceId){
  const due=(await c.query(`SELECT r.*,r.next_due::text AS day FROM stockchief_runtime.agent_count_schedules r
    WHERE r.workspace_id=$1 AND r.next_due<=(now() AT TIME ZONE (SELECT coalesce(w.time_zone,a.time_zone,'UTC') FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1))::date
    ORDER BY r.location_id FOR UPDATE OF r`,[workspaceId])).rows;
  if(!due.length)return;
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,7,'automatic',{trained:true})||account.shadow)return;
  await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
  const settings=await require('../autopilot/postgres-service').getState(c,workspaceId);
  if(settings.mode!=='POLICY_AUTOMATED'||settings.paused||settings.suspended||
    await modes.restriction(c,workspaceId,7,true)||await require('../commercial/agent-rule-quota').restriction(c,account))return;
  const today=await time.today(c,workspaceId);
  for(const r of due){
    // Isolate invalidated staff, locations and empty worksheets from other warehouses' due work.
    await c.query('SAVEPOINT count_assignment');
    try{
      const ctx={workspaceId,actorId:r.owner_id},locationId=r.location_id,counterId=r.counter_id,includesTracking=r.includes_tracking;
      await owner(c,ctx,true);
      const current=await policy.accountState(c,workspaceId);
      if(!policy.usesAgentTerms(current)||!policy.permits(current.plan,7,'automatic',{trained:true})||current.shadow){
        await c.query('RELEASE SAVEPOINT count_assignment');
        return;
      }
      const zones=await access.locations(c,workspaceId,[locationId]);
      const exampleId=current.plan==='growth'?await teaching(c,ctx,{locationId,counterId,includesTracking,
        locationIds:zones.map(l=>l.id),exampleId:r.example_campaign_id}):null;
      if(current.plan==='growth'&&!exampleId)throw new ValidationError('Complete an approved manual example for the current counter, locations and stock scope.');
      const pending=(await c.query(`SELECT 1 FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
        WHERE t.workspace_id=$1 AND s.scope->'locationIds' ?| $2::text[] AND s.status IN ('DRAFT','APPLYING') LIMIT 1`,[workspaceId,zones.map(l=>l.id)])).rowCount;
      if(!pending){
        await create(c,ctx,{locationId,counterId,includesTracking,requestKey:'schedule:'+r.location_id+':'+r.day},true,Boolean(exampleId));
        await c.query('UPDATE stockchief_runtime.agent_count_schedules SET next_due=$3,last_issue=NULL,example_campaign_id=coalesce($4,example_campaign_id) WHERE workspace_id=$1 AND location_id=$2',
          [workspaceId,r.location_id,dates.addDays(today,r.interval_days),exampleId]);
      }
    }catch(error){
      if(!(error instanceof ValidationError||error instanceof AuthorizationError)||error.code==='entitlement_required')throw error;
      await c.query('ROLLBACK TO SAVEPOINT count_assignment');
      await c.query('UPDATE stockchief_runtime.agent_count_schedules SET last_issue=$3 WHERE workspace_id=$1 AND location_id=$2',[workspaceId,r.location_id,error.message]);
    }
    await c.query('RELEASE SAVEPOINT count_assignment');
  }
}
async function task(c,ctx,id,lock=false){
  if(lock){
    const workspace=(await c.query(`SELECT a.id FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
      WHERE w.id=$1 AND w.deletion_requested_at IS NULL FOR SHARE OF w,a`,[ctx.workspaceId])).rows[0];
    if(!workspace)throw new NotFoundError('This count is not assigned to you.');
    await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[workspace.id]);
  }
  await policy.requireWorkspaceJob(c,ctx.workspaceId,7,'draft');
  const row=(await c.query(`SELECT t.*,s.title,s.scope,s.status,s.revision FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s
    ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id WHERE t.workspace_id=$1 AND t.campaign_id=$2 AND t.counter_id=$3`+(lock?' FOR UPDATE OF t,s':''),[ctx.workspaceId,id,ctx.actorId])).rows[0];
  if(!row)throw new NotFoundError('This count is not assigned to you.');
  await counter(c,ctx,row.scope.locationIds,lock);await require('./agent-annual-stocktakes').assertCampaign(c,ctx,id,{lock});
  return row;
}
async function page(db,ctx,id){
  const assigned=await task(db,ctx,id);
  const {rows}=await db.query(`SELECT l.location_id,l.sku_id,loc.name AS location,i.name AS product,s.code,
    i.unit_label,i.tracking_mode,i.secondary_unit_label,
    coalesce(jsonb_array_length(e.observation->'entries'),0) AS entered
    FROM warehouse_count_campaign_lines l JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN stockchief_runtime.agent_count_position_evidence e ON e.workspace_id=l.workspace_id AND e.campaign_id=l.campaign_id
      AND e.location_id=l.location_id AND e.sku_id=l.sku_id
    LEFT JOIN stockchief_runtime.product_class_values abc ON abc.workspace_id=l.workspace_id AND abc.item_id=i.id AND abc.month_start=date_trunc('month',$3::date)::date
    WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.counter_quantity IS NULL ORDER BY loc.name,CASE abc.class WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,s.code,l.sku_id LIMIT 25`,[ctx.workspaceId,id,await time.today(db,ctx.workspaceId)]);
  const progress=(await db.query('SELECT count(*)::int total,count(counter_quantity)::int done FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2',[ctx.workspaceId,id])).rows[0];
  return {assigned,rows,progress};
}
async function record(db,ctx,id,input){
  return db.transaction(async c=>{
    const assigned=await task(c,ctx,id,true);
    const row=(await c.query(`SELECT l.counter_quantity,l.sku_id,l.location_id,${observations.profileSql},
      e.before_count IS NOT NULL AS has_evidence,e.observation FROM warehouse_count_campaign_lines l
      JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      LEFT JOIN stockchief_runtime.agent_count_position_evidence e ON e.workspace_id=l.workspace_id AND e.campaign_id=l.campaign_id
        AND e.sku_id=l.sku_id AND e.location_id=l.location_id
      WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.location_id=$3 AND l.sku_id=$4 FOR UPDATE OF l`,[ctx.workspaceId,id,input.locationId,input.skuId])).rows[0];
    if(!row)throw new NotFoundError('That stock position is not on your assigned count.');
    if(row.counter_quantity==null&&(assigned.status!=='DRAFT'||assigned.observed_at))throw new ValidationError('This count is already closed.');
    let quantity;
    if(row.has_evidence){
      const observed=await observations.collect(c,ctx,id,row,input);
      if(!observed.done||observed.replayed)return;
      quantity=observed.quantity;
    }else{
      if(input.quantity==null||String(input.quantity).trim()==='')throw new ValidationError('Enter the physical quantity you counted.');
      quantity=exact.canonical(quantities.validate(row,input.quantity,{positive:false,total:true}));
      if(row.counter_quantity!=null){
        if(exact.canonical(row.counter_quantity)===quantity)return;
        throw new ValidationError('This position already has a count. Ask the owner to review the difference.');
      }
    }
    await c.query('UPDATE warehouse_count_campaign_lines SET counter_quantity=$5,counter_recorded_by=$6,counter_recorded_name=(SELECT name FROM users WHERE workspace_id=$1 AND id=$6),counter_recorded_at=clock_timestamp() WHERE workspace_id=$1 AND campaign_id=$2 AND location_id=$3 AND sku_id=$4',[ctx.workspaceId,id,input.locationId,input.skuId,quantity,ctx.actorId]);
    const finished=await c.query(`UPDATE stockchief_runtime.agent_count_tasks SET observed_at=now() WHERE workspace_id=$1 AND campaign_id=$2 AND NOT EXISTS(
      SELECT 1 FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2 AND counter_quantity IS NULL)`,[ctx.workspaceId,id]);
    if(finished.rowCount)await smallDifferences(c,ctx,id);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
// Job 6 for phone counts: when the counter finishes, differences within the owner's count
// limit post on their own, through exactly the owner's review and approval, on a plan,
// mode and autonomy that allow it (the count rule decides, as for every count). Lots,
// serials and weights seen on the phone go to the owner whenever they differ from the
// records: their identities and measures need a person. Anything the owner's review would
// refuse (a missing purchase cost, a changed position) also leaves the count for a person.
async function smallDifferences(c,ctx,id){
  const {rows:[rule]}=await c.query('SELECT authorized_by FROM stockchief_runtime.agent_count_rules WHERE workspace_id=$1 AND automatic',[ctx.workspaceId]);
  if(!rule)return;
  const evidence=(await c.query(`SELECT observation,before_count FROM stockchief_runtime.agent_count_position_evidence
    WHERE workspace_id=$1 AND campaign_id=$2`,[ctx.workspaceId,id])).rows;
  if(evidence.some(e=>!observations.matches(e.observation,e.before_count)))return;
  const asOwner={...ctx,actorId:rule.authorized_by},revision=async()=>(await c.query('SELECT revision FROM warehouse_count_campaigns WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0].revision;
  await c.query('SAVEPOINT agent_small_count');
  try{
    await importObserved(scoped(c),asOwner,id,await revision());
    const {rows:[books]}=await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId]);
    const lines=(await c.query(`SELECT counted_quantity,before_quantity,cost_delta_minor FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2`,
      [ctx.workspaceId,id])).rows.map(l=>({delta:exact.safeNumber(exact.subtract(l.counted_quantity,l.before_quantity),{signed:true}),costDeltaMinor:Number(l.cost_delta_minor)||0}));
    const decision=books&&await require('../autopilot/count-rules').evaluate(c,asOwner,{currency:books.base_currency,lines},[]);
    if(decision?.action!=='post'){await c.query('ROLLBACK TO SAVEPOINT agent_small_count');return;}
    await campaigns.approve(scoped(c),asOwner,id,await revision());
    await require('./postgres-security-audit').record(c,asOwner,{action:'Phone count posted under the count limit',reference:id,
      after:{exposureMinor:decision.exposureMinor,limitMinor:decision.limitMinor,currency:decision.currency}});
    await c.query('RELEASE SAVEPOINT agent_small_count');
  }catch(error){
    await c.query('ROLLBACK TO SAVEPOINT agent_small_count');
    if(!(error instanceof require('../domain/errors').DomainError))throw error;
  }
}
async function inbox(db,workspaceId,actorId){
  const rows=(await db.query(`SELECT t.campaign_id,t.observed_at::text,s.title,s.scope,s.created_at::text,'assigned' type,
    NULL::text location_id,NULL::text role,NULL::text permissions
    FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
    WHERE t.workspace_id=$1 AND s.status='DRAFT' AND ((t.counter_id=$2 AND t.observed_at IS NULL) OR
      (t.observed_at IS NOT NULL AND EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=t.workspace_id AND u.id=$2 AND u.role='owner')))
    UNION ALL
    SELECT p.id,p.recounted_at::text,p.payload#>>'{location,name}',NULL,p.created_at::text,'recount',p.payload#>>'{location,id}',
      u.role,u.permissions
    FROM physical_count_reviews p JOIN users u ON u.workspace_id=p.workspace_id AND u.id=$2
    WHERE p.workspace_id=$1 AND p.status='PENDING' AND p.recount_required
      AND (u.role='owner' OR (p.created_by_user_id=u.id AND p.recounted_at IS NULL))`,[workspaceId,actorId])).rows;
  if(!rows.length)return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state))return [];
  const visible=[];
  for(const r of rows){
    if(r.type==='recount'){
      if(!policy.permits(state.plan,8,'automatic')||!permissions.can(r,permissions.ADJUST))continue;
      try{await access.assertLocations(db,{workspaceId,actorId},[r.location_id]);}catch(e){if(e instanceof AuthorizationError)continue;throw e;}
      visible.push({kind:'approval',importance:'Important',priority:75,
        title:r.observed_at?'Review the recount at '+r.title:'Recount stock at '+r.title,
        happened:r.observed_at?'The physical recount is ready for the owner.':'A recorded difference exceeds the owner’s stock count limit.',
        actionLabel:r.observed_at?'Review physical count':'Open blind recount',
        sourceId:'count-recount-'+r.campaign_id,href:'/warehouse/counts/reviews/'+r.campaign_id,createdAt:r.created_at,at:r.observed_at||r.created_at});
      continue;
    }
    if(!policy.permits(state.plan,7,'draft'))continue;
    if(r.observed_at){
      visible.push({kind:'approval',importance:'Important',priority:75,title:'Review '+r.title,happened:'Your counter recorded every stock position.',actionLabel:'Review counted quantities',
        sourceId:'count-check-'+r.campaign_id,href:'/warehouse/counts/campaigns/'+r.campaign_id,createdAt:r.observed_at,at:r.observed_at});continue;
    }
    try{await counter(db,{workspaceId,actorId},r.scope.locationIds);}catch(e){if(e instanceof AuthorizationError)continue;throw e;}
    visible.push({kind:'inventory',importance:'Important',priority:65,title:r.title,happened:'Your count list is ready. Record each physical quantity as you go.',actionLabel:'Open my count',
      sourceId:'count-task-'+r.campaign_id,href:'/warehouse/my-counts/'+r.campaign_id,createdAt:r.created_at,at:r.created_at});}
  return visible;
}
async function importObserved(db,ctx,id,revision){
  return db.transaction(async c=>{
    await owner(c,ctx,true);await policy.requireWorkspaceJob(c,ctx.workspaceId,177,'draft');
    const row=(await c.query(`SELECT s.status,s.revision,t.observed_at FROM stockchief_runtime.agent_count_tasks t
      JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id WHERE t.workspace_id=$1 AND t.campaign_id=$2 FOR UPDATE OF s,t`,[ctx.workspaceId,id])).rows[0];
    if(!row)throw new NotFoundError();
    if(row.status!=='DRAFT'||!row.observed_at||row.revision!==Number(revision))throw new ValidationError('Review the current completed count list first.');
    let current=row.revision;
    for(;;){
      const {rows}=await c.query(`SELECT l.sku_id AS "skuId",l.location_id AS "locationId",l.counter_quantity AS quantity FROM warehouse_count_campaign_lines l
        WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.counter_quantity IS NOT NULL AND l.counted_quantity IS NULL
        AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_count_position_evidence e WHERE e.campaign_id=l.campaign_id AND e.location_id=l.location_id AND e.sku_id=l.sku_id)
        ORDER BY l.location_id,l.sku_id LIMIT 500`,[ctx.workspaceId,id]);
      if(!rows.length)break;
      current=(await campaigns.save(scoped(c),ctx,id,{revision:current,lines:rows})).revision;
    }
    const reviewed=await c.query(`UPDATE stockchief_runtime.agent_count_position_evidence SET reviewed_at=now()
      WHERE workspace_id=$1 AND campaign_id=$2 AND observation IS NOT NULL AND reviewed_at IS NULL`,[ctx.workspaceId,id]);
    if(reviewed.rowCount){
      await c.query(`UPDATE warehouse_count_campaign_lines l SET counted_quantity=l.counter_quantity,cost_delta_minor=0
        FROM stockchief_runtime.agent_count_position_evidence e WHERE l.workspace_id=$1 AND l.campaign_id=$2
        AND e.workspace_id=l.workspace_id AND e.campaign_id=l.campaign_id AND e.location_id=l.location_id AND e.sku_id=l.sku_id
        AND e.reviewed_at IS NOT NULL AND l.counted_quantity IS NULL`,[ctx.workspaceId,id]);
      await c.query('UPDATE warehouse_count_campaigns SET revision=revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function setup(db,ctx){
  const [locations,team,schedules]=await Promise.all([access.locations(db,ctx.workspaceId,null),db.query(`SELECT u.id,u.name,u.role,u.permissions FROM users u
    JOIN accounts a ON a.id=u.account_id LEFT JOIN platform_account_access x ON x.account_id=a.id WHERE u.workspace_id=$1 AND x.disabled_at IS NULL ORDER BY u.name,u.id`,[ctx.workspaceId]),
    db.query(`SELECT l.id,l.name,u.name AS counter,r.next_due::text AS due,r.interval_days,r.last_issue,r.includes_tracking,r.example_campaign_id FROM stockchief_runtime.agent_count_schedules r
      JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.counter_id
      WHERE r.workspace_id=$1 ORDER BY l.name,l.id`,[ctx.workspaceId])]);
  return {locations,people:team.rows.filter(p=>permissions.can(p,permissions.COUNT_STOCK)),schedules:schedules.rows,today:await time.today(db,ctx.workspaceId)};
}
async function activity(db,ctx){
  const {rows}=await db.query(`SELECT s.title AS "Count",u.name AS "Assigned to",count(l.sku_id)::int AS "Positions",count(l.counter_quantity)::int AS "Counted",
    CASE WHEN t.observed_at IS NULL THEN 'Counting' ELSE 'Counted' END AS "Staff progress",s.status AS "Worksheet",'/warehouse/counts/campaigns/'||s.id AS link
    FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id JOIN users u ON u.workspace_id=t.workspace_id AND u.id=t.counter_id
    JOIN warehouse_count_campaign_lines l ON l.workspace_id=t.workspace_id AND l.campaign_id=s.id WHERE t.workspace_id=$1 GROUP BY s.id,u.name,t.observed_at ORDER BY s.created_at DESC,s.id`,[ctx.workspaceId]);
  return {rows,summary:'Staff enter physical quantities, identifiers and measurements from their assigned count list. The owner reviews differences before any stock changes.'};
}
const definitions=[{id:7,key:'staff-count-lists',label:'Assign and schedule mobile stock counts',read:activity},
  {id:177,key:'staff-count-progress',label:'Check assigned stock count progress',read:activity}];
module.exports={assign,schedule,runSchedules,page,record,inbox,setup,importObserved,definitions,assertOwner:owner};
