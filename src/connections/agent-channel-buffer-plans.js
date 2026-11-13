'use strict';

// Job 183: sets stock buffers per channel so you never oversell. Growth drafts
// the buffers; Pro and Custom set them on their own within the owner's rules.
//
// A buffer keeps whole units, or a share of the stock, back from what one
// channel may show (agent-channel-buffers.js). The owner sets one on any
// product, or saves a rule for a channel: "StockChief may keep up to N units
// back per product here". For each product the channel takes stock for,
// StockChief then works out the buffer from:
//  - how fast the product sells elsewhere: the busiest day in the last 28
//    days of customer orders from that warehouse that did not come from this
//    channel (a channel already lowers its own count when it sells); and
//  - how far behind the channel can be: its check interval plus the usual
//    time a stock update takes to reach it.
// Units kept back = what sells elsewhere on the busiest day, spread over the
// day, during that lag, rounded up. No sales elsewhere means no buffer is
// needed. A buffer the owner set themselves is never changed.
//
// Growth drafts each buffer for the owner's approval in Needs you. Pro and
// Custom set it on their own, through the same buffer recipes (each distinct
// buffer per channel and warehouse is one saved rule), when the rule says so;
// a buffer over the owner's limit, a full rule allowance, pause, watch mode,
// the first 14 days, Watch only, Ask me first or routine work being off keep
// it as a draft. Every change is audited and can be undone; an undone or
// dismissed buffer is not proposed again until the facts change.

const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const installed=require('../db/schema-installed');
const buffers=require('./agent-channel-buffers');
const {ValidationError,NotFoundError,DomainError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=183,ACTION='channel.set_stock_buffer',KIND='channel.buffer-plans.v1',WINDOW=28,PER_RULE=500;
const RULES='stockchief_runtime.agent_channel_buffer_rules',PLANS='stockchief_runtime.agent_channel_buffer_plans';
const href='/autopilot/channel-buffers';
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const scoped=c=>({query:(s,v)=>c.query(s,v),transaction:fn=>fn(c)});
const expected=e=>e instanceof DomainError||[400,402,403,404,409,422].includes(Number(e?.status));
const ready=async db=>await installed.has(db,RULES)&&await installed.has(db,PLANS);

// Why StockChief may not set a buffer on its own right now, or null.
async function automaticStop(db,workspaceId,state){
  const stop=await policy.stopped(db,workspaceId,state,ACTION,true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return 'Routine work is off for this inventory, so each buffer waits for your approval.';
  return null;
}

// How far behind one channel can be, in minutes, from its records.
async function lag(db,workspaceId,connectorId){
  const c=(await db.query(`SELECT c.expected_interval_minutes,(v.configuration->>'syncIntervalSeconds')::integer AS plan_seconds FROM workspace_connectors c
    JOIN workspaces w ON w.id=c.workspace_id LEFT JOIN account_subscriptions s ON s.account_id=w.owner_account_id
    LEFT JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id WHERE c.workspace_id=$1 AND c.id=$2`,[workspaceId,connectorId])).rows[0];
  const check=Math.max(1,Number(c?.expected_interval_minutes)||1,Math.ceil(Number(c?.plan_seconds||0)/60));
  const d=(await db.query(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-created_at)) AS seconds
    FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='commerce.position.publish' AND status='SUCCEEDED'
      AND payload->>'connectorId'=$2 AND created_at>now()-make_interval(days=>$3)`,[workspaceId,connectorId,WINDOW])).rows[0];
  const delivery=d?.seconds==null?0:Math.round(Number(d.seconds)/60);
  return {checkMinutes:check,deliveryMinutes:delivery,lagMinutes:check+delivery};
}

// The buffer StockChief would keep for each product on one channel.
async function recommend(db,workspaceId,rule){
  const positions=(await db.query(`SELECT p.*,s.code,l.name AS location,to_jsonb(b) AS buffer
    FROM connection_commerce_positions p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
    JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
    LEFT JOIN stockchief_runtime.agent_channel_buffers b ON b.workspace_id=p.workspace_id AND b.position_id=p.id
    WHERE p.workspace_id=$1 AND p.connector_id=$2 AND p.field='quantity' AND p.mode IN ('outbound','two_way')
    ORDER BY s.code,l.name,p.id LIMIT ${PER_RULE}`,[workspaceId,rule.connector_id])).rows;
  if(!positions.length)return [];
  const timing=await lag(db,workspaceId,rule.connector_id),today=await require('../lib/business-time').today(db,workspaceId);
  // Customer orders from each warehouse, by day, that did not come from this channel.
  const sold=(await db.query(`WITH daily AS (
      SELECT l.sku_id,o.fulfillment_location_id AS location_id,o.order_date::date AS day,sum(l.quantity_ordered) AS units
      FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
      WHERE o.workspace_id=$1 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
        AND o.order_date::date BETWEEN $3::date-${WINDOW-1} AND $3::date AND l.sku_id=ANY($4::text[])
        AND NOT EXISTS(SELECT 1 FROM connection_mappings m WHERE m.workspace_id=o.workspace_id AND m.connector_id=$2 AND m.entity_type='sales_order' AND m.foundry_record_id=o.id)
      GROUP BY 1,2,3)
    SELECT sku_id,location_id,sum(units)::text AS total,max(units)::text AS busiest FROM daily GROUP BY sku_id,location_id`,[workspaceId,rule.connector_id,today,[...new Set(positions.map(p=>p.sku_id))]])).rows;
  const byKey=new Map(sold.map(r=>[r.sku_id+'|'+r.location_id,r]));
  const out=[];
  for(const p of positions){
    const base={positionId:p.id,code:p.code,location:p.location,buffer:p.buffer&&p.buffer.enabled?p.buffer:null};
    if(base.buffer?.set_by==='OWNER'){out.push({...base,skip:'You set this buffer yourself, so StockChief leaves it.'});continue;}
    try{await buffers.profile(db,{workspaceId,actorId:rule.authorized_by},p);}catch(error){if(!expected(error))throw error;out.push({...base,skip:error.message});continue;}
    const s=byKey.get(p.sku_id+'|'+p.location_id),busiest=Number(s?.busiest||0);
    if(!busiest){out.push({...base,skip:'No sales from this warehouse elsewhere in the last '+WINDOW+' days, so no buffer is needed.'});continue;}
    if(![busiest,Number(s.total)].every(Number.isSafeInteger)){out.push({...base,skip:'Sales of measured quantities need a person to set the buffer.'});continue;}
    const units=Math.max(1,Math.ceil(busiest*timing.lagMinutes/1440));
    out.push({...base,units,basis:{...timing,busiestDay:busiest,soldElsewhere:Number(s.total),days:WINDOW}});
  }
  return out;
}
const explain=b=>'Sold up to '+b.busiestDay+' a day elsewhere in the last '+b.days+' days; the channel can be '+b.lagMinutes+' minutes behind (checks every '+
  b.checkMinutes+' minutes'+(b.deliveryMinutes?', updates take about '+b.deliveryMinutes:'')+').';
const snapshot=b=>b&&b.enabled?{units:Number(b.buffer_units)||0,percent:Number(b.buffer_percent)||0,automatic:Boolean(b.automatic_enabled),setBy:b.set_by||'OWNER',basis:b.basis||null}:null;

// Save one buffer through the owner's buffer recipes, as StockChief.
async function setBuffer(c,ctx,plan,{automatic}){
  const current=(await c.query('SELECT * FROM stockchief_runtime.agent_channel_buffers WHERE workspace_id=$1 AND position_id=$2 FOR UPDATE',[ctx.workspaceId,plan.position_id])).rows[0];
  if(current?.enabled&&current.set_by!=='AGENT')throw new ValidationError('You set a buffer on this product yourself since StockChief worked this one out.');
  const saved=await buffers.configure(scoped(c),ctx,plan.position_id,{confirmed:'yes',bufferUnits:plan.units,automatic:automatic?'yes':'',revision:current?.revision},
    {setBy:'AGENT',basis:plan.basis});
  return {bufferId:saved.id,prior:snapshot(current)};
}
// A buffer set for a product replaces the one set before it; only the newest can be undone.
const replaced=(c,workspaceId,positionId,id)=>c.query(`UPDATE ${PLANS} SET status='SUPERSEDED' WHERE workspace_id=$1 AND position_id=$2 AND status='APPLIED' AND id<>$3`,[workspaceId,positionId,id]);
// Each buffer is decided in its own savepoint, so one that cannot be set waits without undoing the others.
async function decide(c,ctx,rule,rec,{automatic,stop}){
  const open=(await c.query(`SELECT * FROM ${PLANS} WHERE workspace_id=$1 AND position_id=$2 AND status IN ('DRAFT','HELD') FOR UPDATE`,[ctx.workspaceId,rec.positionId])).rows[0];
  // A draft that waited only for authority is set once StockChief may act again.
  const nowAlone=automatic&&rule.automatic&&!stop&&rec.units<=rule.max_units;
  if(open&&open.units===rec.units&&!(open.status==='DRAFT'&&nowAlone))return 'unchanged';
  const last=(await c.query(`SELECT status,units FROM ${PLANS} WHERE workspace_id=$1 AND position_id=$2 AND status IN ('DISMISSED','UNDONE','APPLIED')
    ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId,rec.positionId])).rows[0];
  if(last&&last.units===rec.units&&(last.status!=='APPLIED'||rec.buffer?.set_by==='AGENT'&&Number(rec.buffer.buffer_units)===rec.units))return 'unchanged';
  if(open)await c.query(`UPDATE ${PLANS} SET status='SUPERSEDED',decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id]);
  const id=newId('buffer-plan'),insert=(status,reason=null,extra={})=>c.query(`INSERT INTO ${PLANS}(id,workspace_id,position_id,connector_id,units,basis,status,automatic,reason,prior,buffer_id,decided_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $7='APPLIED' THEN clock_timestamp() END)`,
    [id,ctx.workspaceId,rec.positionId,rule.connector_id,rec.units,JSON.stringify(rec.basis),status,status==='APPLIED',reason,extra.prior?JSON.stringify(extra.prior):null,extra.bufferId||null]);
  if(rec.units>rule.max_units){await insert('HELD','Over your limit of '+rule.max_units+' units for this channel. Approve it if you agree.');return 'held';}
  if(!automatic||!rule.automatic||stop){await insert('DRAFT',stop||null);return 'drafted';}
  await c.query('SAVEPOINT channel_buffer_plan');
  try{
    const plan={position_id:rec.positionId,units:rec.units,basis:rec.basis},set=await setBuffer(c,ctx,plan,{automatic:true});
    await c.query('RELEASE SAVEPOINT channel_buffer_plan');
    await replaced(c,ctx.workspaceId,rec.positionId,id);
    await insert('APPLIED',null,set);
    await audit.record(c,ctx,{action:'StockChief set a channel stock buffer',reference:id,before:{position:rec.positionId,buffer:set.prior},
      after:{channel:rule.connector_id,sku:rec.code,location:rec.location,units:rec.units,basis:rec.basis}});
    return 'applied';
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT channel_buffer_plan');await c.query('RELEASE SAVEPOINT channel_buffer_plan');
    await insert('HELD',error.message);return 'held';
  }
}

// Worker: work out buffers for every channel with an enabled rule.
async function run(database,workspaceId,{connectorId=null}={}){
  if(!await ready(database))return {skipped:'not_installed'};
  const state=await policy.accountState(database,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return {skipped:'plan'};
  const automatic=policy.permits(state.plan,JOB,'automatic'),out={applied:0,drafted:0,held:0,unchanged:0,skipped:0};
  for(const rule of (await database.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 AND enabled AND ($2::text IS NULL OR connector_id=$2) ORDER BY connector_id`,[workspaceId,connectorId])).rows){
    const ctx={workspaceId,actorId:rule.authorized_by};
    try{await buffers.owner(database,ctx,{lock:false});}catch(error){if(!expected(error))throw error;out.skipped++;continue;}
    const recs=await recommend(database,workspaceId,rule);
    await tx(database,async c=>{
      // A rule changed or stopped meanwhile is worked out again on its next run.
      if(!(await c.query(`SELECT 1 FROM ${RULES} WHERE workspace_id=$1 AND connector_id=$2 AND revision=$3 AND enabled FOR UPDATE`,[workspaceId,rule.connector_id,rule.revision])).rowCount)return;
      const stop=automatic&&rule.automatic?await automaticStop(c,workspaceId,await policy.accountState(c,workspaceId)):null;
      for(const rec of recs){if(rec.skip){out.skipped++;continue;}out[await decide(c,ctx,rule,rec,{automatic,stop})]++;}
      await c.query(`UPDATE ${RULES} SET last_checked_at=clock_timestamp() WHERE workspace_id=$1 AND connector_id=$2`,[workspaceId,rule.connector_id]);
    });
  }
  return out;
}
async function schedule(db,workspaceId){
  if(!await ready(db))return {queued:0};
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return {queued:0};
  if(!(await db.query(`SELECT 1 FROM ${RULES} WHERE workspace_id=$1 AND enabled LIMIT 1`,[workspaceId])).rowCount)return {queued:0};
  const day=await require('../lib/business-time').today(db,workspaceId);
  return {queued:(await jobs.enqueue(db,{workspaceId,kind:KIND,idempotencyKey:'channel-buffer-plans:'+day,payload:{},priority:60,maxAttempts:3})).created?1:0};
}

// The owner's rule for one channel.
async function saveRule(database,ctx,input={}){
  return tx(database,async c=>{
    await buffers.owner(c,ctx);
    if(!await ready(c))throw new ValidationError('Channel buffer rules are being upgraded. Try again shortly.');
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const connector=(await c.query("SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND provider_type IN ('shopify','woocommerce')",[ctx.workspaceId,String(input.connectorId||'')])).rows[0];
    if(!connector)throw new ValidationError('Choose a Shopify or WooCommerce channel.');
    const prior=(await c.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 AND connector_id=$2 FOR UPDATE`,[ctx.workspaceId,connector.id])).rows[0];
    if(prior&&String(input.revision??'')!==String(prior.revision))throw new ValidationError('This rule changed. Reload the page before saving it.');
    if(input.stop==='yes'){
      if(!prior?.enabled)throw new ValidationError('There is no rule to stop on this channel.');
      await c.query(`UPDATE ${RULES} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND connector_id=$2`,[ctx.workspaceId,connector.id]);
      await c.query(`UPDATE ${PLANS} SET status='SUPERSEDED',decided_at=clock_timestamp() WHERE workspace_id=$1 AND connector_id=$2 AND status IN ('DRAFT','HELD')`,[ctx.workspaceId,connector.id]);
      await audit.record(c,ctx,{action:'Channel buffer rule stopped',reference:connector.id,before:{maxUnits:prior.max_units,automatic:prior.automatic}});
      return {stopped:true};
    }
    const text=String(input.maxUnits??'').trim();
    if(!/^\d{1,6}$/.test(text)||Number(text)<1||Number(text)>100000)throw new ValidationError('Choose the most StockChief may keep back, from 1 to 100,000 units.');
    const automatic=input.automatic==='yes';
    if(automatic)await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    if(!prior?.enabled)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    await c.query(`INSERT INTO ${RULES} AS r(workspace_id,connector_id,max_units,automatic,authorized_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,connector_id) DO UPDATE SET max_units=excluded.max_units,automatic=excluded.automatic,enabled=true,authorized_by=excluded.authorized_by,
        revision=r.revision+1,updated_at=clock_timestamp()`,[ctx.workspaceId,connector.id,Number(text),automatic,ctx.actorId]);
    await audit.record(c,ctx,{action:'Channel buffer rule saved',reference:connector.id,before:prior?{maxUnits:prior.max_units,automatic:prior.automatic,enabled:prior.enabled}:{},
      after:{maxUnits:Number(text),automatic}});
    await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:KIND,idempotencyKey:'channel-buffer-plans:rule:'+newId('rule'),payload:{connectorId:connector.id},priority:55,maxAttempts:3});
    return {saved:true};
  });
}

async function plan(c,ctx,id,statuses){
  const row=(await c.query(`SELECT * FROM ${PLANS} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row||!statuses.includes(row.status))throw new NotFoundError('That buffer is no longer waiting.');
  return row;
}
// The owner approves a drafted or held buffer. Only the owner can approve one over their own limit.
async function approve(database,ctx,id){
  return tx(database,async c=>{
    await buffers.owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
    const row=await plan(c,ctx,id,['DRAFT','HELD']);
    // Pro and Custom keep applying an approved buffer on their own when routine work allows it.
    const automatic=policy.permits(state.plan,JOB,'automatic')&&!await automaticStop(c,ctx.workspaceId,state);
    const set=await setBuffer(c,ctx,row,{automatic});
    await replaced(c,ctx.workspaceId,row.position_id,row.id);
    await c.query(`UPDATE ${PLANS} SET status='APPLIED',prior=$3,buffer_id=$4,decided_by=$5,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,row.id,set.prior?JSON.stringify(set.prior):null,set.bufferId,ctx.actorId]);
    await audit.record(c,ctx,{action:'Channel stock buffer approved',reference:row.id,before:{buffer:set.prior},after:{units:row.units,basis:row.basis,automatic}});
    return {applied:true,units:row.units};
  });
}
async function dismiss(database,ctx,id){
  return tx(database,async c=>{
    await buffers.owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const row=await plan(c,ctx,id,['DRAFT','HELD']);
    await c.query(`UPDATE ${PLANS} SET status='DISMISSED',decided_by=$3,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Channel stock buffer dismissed',reference:row.id,after:{units:row.units}});
    return {dismissed:true};
  });
}
// Undo a buffer StockChief set or the owner approved: the buffer before it comes back.
async function undo(database,ctx,id){
  return tx(database,async c=>{
    await buffers.owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const row=await plan(c,ctx,id,['APPLIED']);
    const current=(await c.query('SELECT * FROM stockchief_runtime.agent_channel_buffers WHERE workspace_id=$1 AND position_id=$2 FOR UPDATE',[ctx.workspaceId,row.position_id])).rows[0];
    if(!current?.enabled||current.set_by!=='AGENT'||Number(current.buffer_units)!==row.units)throw new ValidationError('This buffer changed since. Change it on the product instead.');
    const prior=row.prior,scope=scoped(c);
    if(prior)await buffers.configure(scope,ctx,row.position_id,{confirmed:'yes',revision:current.revision,automatic:prior.automatic?'yes':'',
      ...(prior.percent?{bufferPercent:prior.percent}:{bufferUnits:prior.units})},{setBy:prior.setBy,basis:prior.basis});
    else await buffers.configure(scope,ctx,row.position_id,{stop:'yes',confirmed:'yes',revision:current.revision});
    await c.query(`UPDATE ${PLANS} SET status='UNDONE',decided_by=$3,decided_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Channel stock buffer undone',reference:row.id,before:{units:row.units},after:{buffer:prior}});
    return {undone:true};
  });
}

// What the buffer page shows: each channel's rule and the buffers StockChief worked out.
async function panel(db,ctx,state){
  if(!await ready(db))return null;
  const ruleRows=(await db.query(`SELECT c.id,c.display_name,r.max_units,r.automatic,r.enabled,r.revision,r.last_checked_at FROM workspace_connectors c
    LEFT JOIN ${RULES} r ON r.workspace_id=c.workspace_id AND r.connector_id=c.id
    WHERE c.workspace_id=$1 AND c.provider_type IN ('shopify','woocommerce') AND EXISTS(SELECT 1 FROM connection_commerce_positions p WHERE p.workspace_id=c.workspace_id AND p.connector_id=c.id AND p.field='quantity')
    ORDER BY c.display_name,c.id`,[ctx.workspaceId])).rows;
  const planRows=(await db.query(`SELECT x.*,c.display_name,s.code,l.name AS location,
      (x.status='APPLIED' AND coalesce(b.enabled,false) AND b.set_by='AGENT' AND b.buffer_units=x.units) AS undoable
    FROM ${PLANS} x JOIN workspace_connectors c ON c.workspace_id=x.workspace_id AND c.id=x.connector_id
    LEFT JOIN stockchief_runtime.agent_channel_buffers b ON b.workspace_id=x.workspace_id AND b.position_id=x.position_id
    JOIN connection_commerce_positions p ON p.workspace_id=x.workspace_id AND p.id=x.position_id JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
    JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
    WHERE x.workspace_id=$1 AND (x.status IN ('DRAFT','HELD') OR x.created_at>now()-interval '30 days' AND x.status IN ('APPLIED','UNDONE','DISMISSED'))
    ORDER BY (x.status IN ('DRAFT','HELD')) DESC,x.created_at DESC,x.id LIMIT 100`,[ctx.workspaceId])).rows
    .map(x=>({...x,why:explain(x.basis)}));
  const automatic=policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');
  const ownerStop=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  return {rules:ruleRows,plans:planRows,automatic,stop:automatic?await automaticStop(db,ctx.workspaceId,state):null,ownerStop};
}

// Needs you: buffers that wait for the owner.
async function inbox(db,workspaceId){
  if(!await ready(db))return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return [];
  const r=(await db.query(`SELECT count(*)::int AS n,count(*) FILTER (WHERE status='HELD')::int AS held,max(created_at) AS at FROM ${PLANS} WHERE workspace_id=$1 AND status IN ('DRAFT','HELD')`,[workspaceId])).rows[0];
  if(!r.n)return [];
  return [{kind:'sales',grouped:true,importance:'Needs You',priority:74,title:r.n+' channel stock '+(r.n===1?'buffer waits':'buffers wait')+' for your approval',
    happened:r.held?r.held+' '+(r.held===1?'is':'are')+' over your limit or could not be set on its own.':'StockChief worked them out from sales elsewhere and how far behind each channel can be.',
    why:'A buffer keeps a few units back from a channel so it cannot sell stock that is already gone.',recommendation:'Approve the buffers, or dismiss them.',
    href:href+'#buffer-plans',actionLabel:'Review buffers',sourceId:'channel-buffer-plans',createdAt:r.at,at:r.at}];
}

module.exports={JOB,KIND,lag,recommend,run,schedule,saveRule,approve,dismiss,undo,panel,inbox,explain};
