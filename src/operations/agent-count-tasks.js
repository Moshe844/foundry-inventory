'use strict';
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const access=require('./postgres-warehouse-access'),campaigns=require('./postgres-count-campaigns');
const dates=require('../accounting/customer-money'),time=require('../lib/business-time');
const exact=require('../domain/exact-quantity'),quantities=require('../domain/stock-quantity');
const scoped=c=>({query:c.query.bind(c),transaction:work=>work(c)});
async function owner(c,ctx){
  const row=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(row?.role!=='owner')throw new AuthorizationError('Only the inventory owner can assign stock counts.');
}
async function counter(c,ctx,locationIds){
  const row=(await c.query(`SELECT u.role,u.permissions FROM users u JOIN accounts a ON a.id=u.account_id
    LEFT JOIN platform_account_access x ON x.account_id=a.id WHERE u.workspace_id=$1 AND u.id=$2 AND x.disabled_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row||!permissions.can(row,permissions.COUNT_STOCK))throw new AuthorizationError('Choose an active team member who can perform stock counts.');
  await access.assertLocations(c,ctx,locationIds);
}
async function create(c,ctx,{locationId,counterId,requestKey},automatic){
  const location=(await c.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1',[ctx.workspaceId,locationId])).rows[0];
  if(!location)throw new ValidationError('Choose an active location in this inventory.');
  if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>180)throw new ValidationError('Open the current count assignment form before sending it.');
  const prior=(await c.query('SELECT campaign_id,counter_id,location_id FROM stockchief_runtime.agent_count_tasks WHERE workspace_id=$1 AND request_key=$2',[ctx.workspaceId,requestKey])).rows[0];
  if(prior){
    if(prior.location_id!==locationId||prior.counter_id!==counterId)throw new ValidationError('This form was used for a different assignment.');
    return prior.campaign_id;
  }
  await policy.requireWorkspaceJob(c,ctx.workspaceId,7,automatic?'automatic':'draft',{trained:automatic});
  const zones=await access.locations(c,ctx.workspaceId,[locationId]);
  await counter(c,{workspaceId:ctx.workspaceId,actorId:counterId},zones.map(l=>l.id));
  const {id}=await campaigns.create(scoped(c),ctx,{locationId,title:'Count '+location.name});
  const positions=(await c.query('SELECT 1 FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2 LIMIT 1',[ctx.workspaceId,id])).rowCount;
  if(!positions)throw new ValidationError('This location has no quantity-stock positions to count.');
  await c.query('INSERT INTO stockchief_runtime.agent_count_tasks(workspace_id,campaign_id,counter_id,request_key,location_id) VALUES($1,$2,$3,$4,$5)',[ctx.workspaceId,id,counterId,requestKey,locationId]);
  return id;
}
async function assign(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,177,'draft');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['count-assign:'+ctx.workspaceId]);
    return create(c,ctx,input,false);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function schedule(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,7,'draft');
    if(input.remove==='1'){
      await c.query('DELETE FROM stockchief_runtime.agent_count_schedules WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,input.locationId]);return;
    }
    const days=Number(input.days),day=String(input.firstDay||''),today=await time.today(c,ctx.workspaceId);
    if(!Number.isInteger(days)||days<1||days>366||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day||day<today)
      throw new ValidationError('Choose a first date from today and a repeat interval from 1 to 366 days.');
    const zones=await access.locations(c,ctx.workspaceId,[input.locationId]);
    if(!zones.length)throw new ValidationError('Choose an active location from this inventory.');
    await counter(c,{workspaceId:ctx.workspaceId,actorId:input.counterId},zones.map(l=>l.id));
    const present=await c.query('SELECT 1 FROM stockchief_runtime.agent_count_schedules WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,input.locationId]);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],present.rowCount?0:1);
    await c.query(`INSERT INTO stockchief_runtime.agent_count_schedules(workspace_id,location_id,counter_id,owner_id,interval_days,next_due)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,location_id) DO UPDATE SET counter_id=$3,owner_id=$4,interval_days=$5,next_due=$6,last_issue=NULL`,
      [ctx.workspaceId,input.locationId,input.counterId,ctx.actorId,days,day]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function runSchedules(c,workspaceId){
  const due=(await c.query(`SELECT r.*,r.next_due::text AS day FROM stockchief_runtime.agent_count_schedules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.owner_id AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.next_due<=(now() AT TIME ZONE (SELECT coalesce(w.time_zone,a.time_zone,'UTC') FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1))::date
    ORDER BY r.location_id FOR UPDATE OF r`,[workspaceId])).rows;
  if(!due.length)return;
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,7,'automatic',{trained:true})||account.shadow)return;
  const settings=await require('../autopilot/postgres-service').getState(c,workspaceId);
  if(settings.mode!=='POLICY_AUTOMATED'||settings.paused||settings.suspended)return;
  const today=await time.today(c,workspaceId);
  for(const r of due){
    // Isolate invalidated staff, locations and empty worksheets from other warehouses' due work.
    await c.query('SAVEPOINT count_assignment');
    try{
      const pending=(await c.query(`SELECT 1 FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
        WHERE t.workspace_id=$1 AND s.scope->'locationIds' ? $2 AND s.status IN ('DRAFT','APPLYING') LIMIT 1`,[workspaceId,r.location_id])).rowCount;
      if(!pending)await create(c,{workspaceId,actorId:r.owner_id},{locationId:r.location_id,counterId:r.counter_id,requestKey:'schedule:'+r.location_id+':'+r.day},true);
      await c.query('UPDATE stockchief_runtime.agent_count_schedules SET next_due=$3,last_issue=NULL WHERE workspace_id=$1 AND location_id=$2',[workspaceId,r.location_id,dates.addDays(today,r.interval_days)]);
    }catch(error){
      if(!(error instanceof ValidationError||error instanceof AuthorizationError)||error.code==='entitlement_required')throw error;
      await c.query('ROLLBACK TO SAVEPOINT count_assignment');
      await c.query('UPDATE stockchief_runtime.agent_count_schedules SET last_issue=$3 WHERE workspace_id=$1 AND location_id=$2',[workspaceId,r.location_id,error.message]);
    }
    await c.query('RELEASE SAVEPOINT count_assignment');
  }
}
async function task(c,ctx,id,lock=false){
  await policy.requireWorkspaceJob(c,ctx.workspaceId,7,'draft');
  const row=(await c.query(`SELECT t.*,s.title,s.scope,s.status,s.revision FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s
    ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id WHERE t.workspace_id=$1 AND t.campaign_id=$2 AND t.counter_id=$3`+(lock?' FOR UPDATE OF t,s':''),[ctx.workspaceId,id,ctx.actorId])).rows[0];
  if(!row)throw new NotFoundError('This count is not assigned to you.');
  await counter(c,ctx,row.scope.locationIds);await require('./agent-annual-stocktakes').assertCampaign(c,ctx,id,{lock});
  return row;
}
async function page(db,ctx,id){
  const assigned=await task(db,ctx,id);
  const {rows}=await db.query(`SELECT l.location_id,l.sku_id,loc.name AS location,i.name AS product,s.code FROM warehouse_count_campaign_lines l
    JOIN locations loc ON loc.id=l.location_id JOIN skus s ON s.id=l.sku_id JOIN items i ON i.id=s.item_id
    LEFT JOIN stockchief_runtime.product_class_values abc ON abc.workspace_id=l.workspace_id AND abc.item_id=i.id AND abc.month_start=date_trunc('month',$3::date)::date
    WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.counter_quantity IS NULL ORDER BY loc.name,CASE abc.class WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,s.code,l.sku_id LIMIT 25`,[ctx.workspaceId,id,await time.today(db,ctx.workspaceId)]);
  const progress=(await db.query('SELECT count(*)::int total,count(counter_quantity)::int done FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2',[ctx.workspaceId,id])).rows[0];
  return {assigned,rows,progress};
}
async function record(db,ctx,id,input){
  return db.transaction(async c=>{
    const assigned=await task(c,ctx,id,true);
    const row=(await c.query(`SELECT l.counter_quantity,i.quantity_precision,i.quantity_increment FROM warehouse_count_campaign_lines l
      JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE l.workspace_id=$1 AND l.campaign_id=$2 AND l.location_id=$3 AND l.sku_id=$4 FOR UPDATE OF l`,[ctx.workspaceId,id,input.locationId,input.skuId])).rows[0];
    if(!row)throw new NotFoundError('That stock position is not on your assigned count.');
    const quantity=exact.canonical(quantities.validate(row,input.quantity,{positive:false}));
    if(row.counter_quantity!=null){
      if(exact.canonical(row.counter_quantity)===quantity)return;
      throw new ValidationError('This position already has a count. Ask the owner to review the difference.');
    }
    if(assigned.status!=='DRAFT'||assigned.observed_at)throw new ValidationError('This count is already closed.');
    await c.query('UPDATE warehouse_count_campaign_lines SET counter_quantity=$5,counter_recorded_by=$6,counter_recorded_name=(SELECT name FROM users WHERE workspace_id=$1 AND id=$6),counter_recorded_at=clock_timestamp() WHERE workspace_id=$1 AND campaign_id=$2 AND location_id=$3 AND sku_id=$4',[ctx.workspaceId,id,input.locationId,input.skuId,quantity,ctx.actorId]);
    await c.query(`UPDATE stockchief_runtime.agent_count_tasks SET observed_at=now() WHERE workspace_id=$1 AND campaign_id=$2 AND NOT EXISTS(
      SELECT 1 FROM warehouse_count_campaign_lines WHERE workspace_id=$1 AND campaign_id=$2 AND counter_quantity IS NULL)`,[ctx.workspaceId,id]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function inbox(db,workspaceId,actorId){
  const rows=(await db.query(`SELECT t.campaign_id,t.observed_at,s.title,s.scope,s.created_at FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id
    WHERE t.workspace_id=$1 AND s.status='DRAFT' AND ((t.counter_id=$2 AND t.observed_at IS NULL) OR
      (t.observed_at IS NOT NULL AND EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=t.workspace_id AND u.id=$2 AND u.role='owner')))`,[workspaceId,actorId])).rows;
  if(!rows.length)return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,7,'draft'))return [];
  const visible=[];
  for(const r of rows){
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
    await owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,177,'draft');
    const row=(await c.query(`SELECT s.status,s.revision,t.observed_at FROM stockchief_runtime.agent_count_tasks t
      JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id WHERE t.workspace_id=$1 AND t.campaign_id=$2 FOR UPDATE OF s,t`,[ctx.workspaceId,id])).rows[0];
    if(!row)throw new NotFoundError();
    if(row.status!=='DRAFT'||!row.observed_at||row.revision!==Number(revision))throw new ValidationError('Review the current completed count list first.');
    let current=row.revision;
    for(;;){
      const {rows}=await c.query(`SELECT sku_id AS "skuId",location_id AS "locationId",counter_quantity AS quantity FROM warehouse_count_campaign_lines
        WHERE workspace_id=$1 AND campaign_id=$2 AND counter_quantity IS NOT NULL AND counted_quantity IS NULL ORDER BY location_id,sku_id LIMIT 500`,[ctx.workspaceId,id]);
      if(!rows.length)return;
      current=(await campaigns.save(scoped(c),ctx,id,{revision:current,lines:rows})).revision;
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function setup(db,ctx){
  const [locations,team,schedules]=await Promise.all([access.locations(db,ctx.workspaceId,null),db.query(`SELECT u.id,u.name,u.role,u.permissions FROM users u
    JOIN accounts a ON a.id=u.account_id LEFT JOIN platform_account_access x ON x.account_id=a.id WHERE u.workspace_id=$1 AND x.disabled_at IS NULL ORDER BY u.name,u.id`,[ctx.workspaceId]),
    db.query(`SELECT l.id,l.name,u.name AS counter,r.next_due::text AS due,r.interval_days,r.last_issue FROM stockchief_runtime.agent_count_schedules r
      JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.counter_id
      WHERE r.workspace_id=$1 ORDER BY l.name,l.id`,[ctx.workspaceId])]);
  return {locations,people:team.rows.filter(p=>permissions.can(p,permissions.COUNT_STOCK)),schedules:schedules.rows,today:await time.today(db,ctx.workspaceId)};
}
async function activity(db,ctx){
  const {rows}=await db.query(`SELECT s.title AS "Count",u.name AS "Assigned to",count(l.sku_id)::int AS "Positions",count(l.counter_quantity)::int AS "Counted",
    CASE WHEN t.observed_at IS NULL THEN 'Counting' ELSE 'Counted' END AS "Staff progress",s.status AS "Worksheet",'/warehouse/counts/campaigns/'||s.id AS link
    FROM stockchief_runtime.agent_count_tasks t JOIN warehouse_count_campaigns s ON s.workspace_id=t.workspace_id AND s.id=t.campaign_id JOIN users u ON u.workspace_id=t.workspace_id AND u.id=t.counter_id
    JOIN warehouse_count_campaign_lines l ON l.workspace_id=t.workspace_id AND l.campaign_id=s.id WHERE t.workspace_id=$1 GROUP BY s.id,u.name,t.observed_at ORDER BY s.created_at DESC,s.id`,[ctx.workspaceId]);
  return {rows,summary:'Staff enter physical quantities from their assigned count list. The owner reviews differences before posting stock.'};
}
const definitions=[{id:7,key:'staff-count-lists',label:'Assign and schedule mobile stock counts',read:activity},
  {id:177,key:'staff-count-progress',label:'Check assigned stock count progress',read:activity}];
module.exports={assign,schedule,runSchedules,page,record,inbox,setup,importObserved,definitions};
