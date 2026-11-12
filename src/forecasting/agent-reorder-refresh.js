'use strict';

// Job 21: one business-wide routine recalculates reorder points and targets
// from recorded sales. Starter sees suggestions only. Growth drafts changes
// until the owner saves a rule or approves changes it can learn from. Pro and
// Custom apply changes inside the owner's limits. Each applied change keeps
// the earlier values, so a person can undo it.
const policy=require('../commercial/agent-plan');
const source=require('./location-reorder-source');
const audit=require('../operations/postgres-security-audit');
const queue=require('../operations/postgres-job-queue');
const permissions=require('../actions/permissions');
const exact=require('../domain/exact-quantity');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const {WINDOW_DAYS}=require('../purchasing/replenishment-decision');
const {unitCount}=require('../lib/units');

const JOB=21,KIND='planning.reorder-refresh.v1',CAPABILITY='planning.reorder_refresh',href='/planning/reorder-refresh',PAGE=100;
const rules='stockchief_runtime.agent_reorder_refresh_rules',locks='stockchief_runtime.agent_reorder_locks';
const runs='stockchief_runtime.agent_reorder_refresh_runs',changes='stockchief_runtime.agent_reorder_refresh_changes';
const DAY=86400000;
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const amount=v=>v==null?null:exact.canonical(String(v));
const expected=error=>error instanceof ValidationError||['validation_error','forbidden','entitlement_required'].includes(error?.code);

async function ownerUser(db,workspaceId,lock=false){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    ORDER BY u.created_at,u.id LIMIT 1${lock?' FOR SHARE OF u,w':''}`,[workspaceId])).rows[0]?.id||null;
}
async function member(db,ctx,{owner=false,lock=false}={}){
  const row=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(owner){
    if(!row||row.role!=='owner'||await ownerUser(db,ctx.workspaceId,lock)!==ctx.actorId)
      throw new AuthorizationError('Only the business owner can give StockChief this authority.');
    return row;
  }
  permissions.assertCan(row,permissions.MANAGE_REPLENISHMENT,'review reorder settings');
  return row;
}

// The current plan, owner modes and saved rule decide how far a run may go:
// suggest, watch (shadow), draft for a person, or apply on its own.
async function authority(db,workspaceId,{lock=false}={}){
  const account=await policy.accountState(db,workspaceId);
  const plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan||!policy.permits(plan,JOB,'suggest'))return {plan:null,account};
  if(lock){
    await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[account.accountId]);
    await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
    await db.query('SELECT workspace_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2 FOR SHARE',[workspaceId,JOB]);
  }
  const rule=(await db.query(`SELECT r.* FROM ${rules} r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id AND w.deletion_requested_at IS NULL
    WHERE r.workspace_id=$1 AND r.enabled${lock?' FOR SHARE OF r':''}`,[workspaceId])).rows[0]||null;
  const draftable=policy.permits(plan,JOB,'draft');
  const watch=draftable?await policy.stopped(db,workspaceId,account,CAPABILITY,false):null;
  const level=!draftable?'suggest':watch?(account.shadow?'watch':'suggest'):'draft';
  let hold=null;
  if(level==='draft'){
    hold=await policy.stopped(db,workspaceId,account,CAPABILITY,true);
    if(!hold&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
      hold='Routine work is off. Choose Handle routine work in StockChief AI to let it apply changes on its own.';
  }
  return {account,plan,level,rule,watch,hold,automatic:level==='draft'&&!hold&&policy.permits(plan,JOB,'automatic',{trained:true})};
}

function combine(list){
  if(!list.length)return null;
  const weights=list.filter(r=>r.sold_weight!=null);
  return {issued:list.reduce((sum,r)=>exact.add(sum,r.issued),'0'),
    sold_weight:weights.length?weights.reduce((sum,r)=>exact.add(sum,r.sold_weight),'0'):null,
    first_seq:String(Math.min(...list.map(r=>Number(r.first_seq)))),last_seq:String(Math.max(...list.map(r=>Number(r.last_seq)))),
    events:list.reduce((sum,r)=>sum+Number(r.events),0),incomplete:list.reduce((sum,r)=>sum+Number(r.incomplete),0)};
}
function days(from,to){const n=Math.max(0,Math.floor((to-from)/DAY));return n+' day'+(n===1?'':'s');}

// Every stocked position for these products with either fresh values from
// recorded sales or the reason the facts are not good enough to use.
async function positions(db,workspaceId,skuIds){
  if(!skuIds.length)return [];
  const {clock,start,recorded}=await source.sales(db,workspaceId,skuIds);
  const rows=await require('../purchasing/postgres-replenishment-state').rows(db,workspaceId,{onlySkuIds:skuIds});
  const args=[workspaceId,skuIds];
  const products=new Map((await db.query(`SELECT s.id sku_id,s.created_at,i.unit_label,i.quantity_precision,i.quantity_increment::text,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment::text,i.tracking_mode
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1`,args)).rows.map(r=>[r.sku_id,r]));
  const first=new Map((await db.query(`SELECT sku_id,location_id,min(occurred_at::timestamptz) AS first FROM movements
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) GROUP BY sku_id,location_id`,args)).rows.map(r=>[source.key(r.sku_id,r.location_id),Date.parse(r.first)]));
  const locked=new Set((await db.query(`SELECT sku_id,location_id FROM ${locks} WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,args))
    .rows.map(r=>source.key(r.sku_id,r.location_id)));
  const ceilings=new Map((await db.query(`SELECT sku_id,location_id,ceiling::text FROM stockchief_runtime.location_reorder_rules
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[])`,args)).rows.map(r=>[source.key(r.sku_id,r.location_id),amount(r.ceiling)]));
  const supplierLead=new Set((await db.query(`SELECT DISTINCT sku_id FROM stockchief_runtime.supplier_planning_leads
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND coalesce(observed_lead,configured_lead) IS NOT NULL`,args)).rows.map(r=>r.sku_id));
  const now=Date.parse(clock.instant),opened=Date.parse(start),bySku=new Map(),result=[];
  for(const row of rows){if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}
  for(const [skuId,list] of bySku){
    const product=products.get(skuId);
    if(!product)continue;
    const {created_at:createdAt,...profile}=product,created=Date.parse(createdAt);
    const sites=list.filter(r=>r.location_id);
    const global=list.find(r=>r.scope==='workspace');
    const local=sites.filter(r=>!r.planning_suppressed&&(Number(r.on_hand)!==0||r.policy_location_id===r.location_id||Number(r.issue_events)>0));
    for(const row of [...(global?[global]:[]),...local]){
      const locationId=row.location_id||null,k=source.key(skuId,locationId);
      const base={skuId,locationId,code:row.code,name:row.item_name,location:locationId?row.location_name:'All locations',unit:profile.unit_label,
        current:{minimum:amount(row.reorder_point),maximum:amount(row.target_stock)}};
      const stocked=locationId?first.get(k):Math.min(...sites.map(r=>first.get(source.key(skuId,r.location_id))).filter(Number.isFinite));
      const sold=locationId?recorded.get(k):combine(sites.map(r=>recorded.get(source.key(skuId,r.location_id))).filter(Boolean));
      let skip=null;
      if(locked.has(k))skip='You locked these settings.';
      else if(created>opened&&!(stocked<=opened))skip='Added '+days(created,now)+' ago. It needs '+WINDOW_DAYS+' days of sales history.';
      else if(!Number.isFinite(stocked))skip='No stock or sales recorded '+(locationId?'here':'for this product')+' yet.';
      else if(stocked>opened)skip='First stocked '+(locationId?'here ':'')+days(stocked,now)+' ago. It needs '+WINDOW_DAYS+' days of sales history.';
      else if(!sold)skip='No sales '+(locationId?'here ':'')+'in the last '+WINDOW_DAYS+' days.';
      if(skip){result.push({...base,skip});continue;}
      const facts=locationId?{...row,...profile}:{...row,...profile,local_lead:null,
        lead_time_assumed:row.global_policy?.lead_time_days==null&&!supplierLead.has(skuId)};
      try{result.push({...base,estimate:source.estimate(facts,sold,clock),ceiling:locationId?ceilings.get(k)??null:null});}
      catch(error){if(!(error instanceof ValidationError))throw error;result.push({...base,skip:error.message});}
    }
  }
  return result;
}
async function position(db,workspaceId,skuId,locationId){
  return (await positions(db,workspaceId,[skuId])).find(p=>p.locationId===(locationId||null))||null;
}

function size(estimate){
  const m=Number(estimate.current.minimum),t=Number(estimate.current.maximum);
  if(estimate.current.minimum==null||estimate.current.maximum==null||!(m>0)||!(t>0))return {first:true,percent:null};
  const change=Math.max(Math.abs(Number(estimate.minimum)-m)/m,Math.abs(Number(estimate.maximum)-t)/t)*100;
  return {first:false,percent:Math.ceil(change*100-1e-9)/100};
}
const valueKey=p=>hash([p.skuId,p.locationId,p.estimate.current.minimum,p.estimate.current.maximum,p.estimate.minimum,p.estimate.maximum]);
function evidence(p){
  const e=p.estimate;
  return {code:p.code,name:p.name,location:p.location,unit:p.unit,...(e?{issued:e.issued,events:e.events,lead:e.lead,cover:e.cover,
    safety:e.safety,soldWeight:e.soldWeight,secondaryUnit:e.secondaryUnit,day:e.day}:{})};
}

function decide(auth,p,learned){
  if(auth.level==='suggest')return {status:'SUGGESTED',reason:auth.watch||null};
  if(auth.level==='watch')return {status:'WATCHED',reason:auth.watch};
  if(!auth.automatic)return {status:'DRAFT',reason:auth.hold};
  const {first,percent}=p.size,rule=auth.rule;
  if(p.ceiling!=null&&Number(p.estimate.maximum)>Number(p.ceiling))
    return {status:'DRAFT',reason:'The new target is above your saved maximum of '+unitCount(Number(p.ceiling),p.unit)+' here.'};
  if(rule&&(first?rule.fill_missing:percent<=rule.max_change_percent))return {status:'APPLY',authority:'RULE'};
  if(!first&&learned!=null&&percent<=learned)return {status:'APPLY',authority:'LEARNED'};
  if(first)return {status:'DRAFT',reason:'This sets a first reorder point and target here.'+(rule?' Your rule asks you to approve those.':'')};
  if(rule)return {status:'DRAFT',reason:'This changes the settings by '+percent+'%, more than your '+rule.max_change_percent+'% limit.'};
  if(learned!=null)return {status:'DRAFT',reason:'This changes the settings by '+percent+'%, more than the '+learned+'% you approved here before.'};
  return {status:'DRAFT',reason:auth.plan==='growth'?'Approve a change here or save a rule to teach it.':'Save your change limit to let it apply changes on its own.'};
}

// Owner approvals teach a product and location: later changes there no
// bigger than the largest approved change apply on their own. A later
// decline or undo there cancels what it learned.
async function learnedLimits(db,workspaceId,skuIds){
  const {rows}=await db.query(`SELECT c.sku_id,c.location_id,max(c.change_percent)::text AS learned FROM ${changes} c
    JOIN users u ON u.workspace_id=c.workspace_id AND u.id=c.decided_by AND u.role='owner'
    JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE c.workspace_id=$1 AND c.sku_id=ANY($2::text[]) AND c.status='APPLIED' AND c.authority='PERSON' AND c.change_percent IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ${changes} d WHERE d.workspace_id=c.workspace_id AND d.sku_id=c.sku_id
        AND d.location_id IS NOT DISTINCT FROM c.location_id
        AND ((d.status='DECLINED' AND d.decided_at>c.decided_at) OR (d.status='UNDONE' AND d.undone_at>c.decided_at)))
    GROUP BY c.sku_id,c.location_id`,[workspaceId,skuIds]);
  return new Map(rows.map(r=>[source.key(r.sku_id,r.location_id),Number(r.learned)]));
}

async function insert(c,workspaceId,runId,p,status,fields={}){
  const id=newId('reorder-change'),e=p.estimate;
  await c.query(`INSERT INTO ${changes}(id,run_id,workspace_id,sku_id,location_id,status,reason,before_minimum,before_maximum,
    after_minimum,after_maximum,change_percent,value_key,evidence,authority,rule_revision,policy_id,created_policy,before_source,decided_by,decided_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21)`,
  [id,runId,workspaceId,p.skuId,p.locationId,status,fields.reason||null,e?.current.minimum??p.current.minimum,e?.current.maximum??p.current.maximum,
    e?.minimum??null,e?.maximum??null,p.size?.percent??null,e?valueKey(p):null,JSON.stringify(evidence(p)),fields.authority||null,
    fields.ruleRevision??null,fields.policyId||null,fields.created===true,fields.beforeSource||null,fields.decidedBy||null,fields.decidedAt||null]);
  return id;
}

async function apply(c,ctx,p,{runId,changeId=null,authority,ruleRevision=null,decidedBy=null}){
  const {skuId,locationId}=p,e=p.estimate;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,skuId,locationId])]);
  const saved=(await c.query(`SELECT id,reorder_point::text,target_stock::text,source FROM reorder_policies
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NOT DISTINCT FROM $3 FOR UPDATE`,[ctx.workspaceId,skuId,locationId])).rows[0];
  if(amount(saved?.reorder_point)!==e.current.minimum||amount(saved?.target_stock)!==e.current.maximum)
    throw new ValidationError('The reorder point or target changed since this check. The next check starts from the new values.');
  if(!locationId&&!saved)throw new ValidationError('The reorder point for all locations was removed.');
  const at=nowIso(),note='Kept up to date from recorded sales';
  let policyId=saved?.id,created=false;
  if(saved)await c.query(`UPDATE reorder_policies SET reorder_point=$3,target_stock=$4,source='foundry',notes=$5,updated_at=$6
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,policyId,e.minimum,e.maximum,note,at]);
  else{
    policyId=newId('rpol');created=true;
    await c.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,notes,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'foundry',$7,$8,$8)`,[policyId,ctx.workspaceId,skuId,locationId,e.minimum,e.maximum,note,at]);
  }
  const fields={authority,ruleRevision,policyId,created,beforeSource:saved?.source||null,decidedBy,decidedAt:decidedBy?at:null};
  let id=changeId;
  if(changeId)await c.query(`UPDATE ${changes} SET status='APPLIED',reason=NULL,authority=$3,rule_revision=$4,policy_id=$5,created_policy=$6,
    before_source=$7,decided_by=$8,decided_at=$9 WHERE workspace_id=$1 AND id=$2`,
  [ctx.workspaceId,changeId,authority,ruleRevision,policyId,created,fields.beforeSource,decidedBy,at]);
  else id=await insert(c,ctx.workspaceId,runId,p,'APPLIED',{...fields,decidedAt:at});
  await audit.record(c,ctx,{action:'Updated reorder point and target from sales',reference:id,
    before:{skuId,locationId,reorderPoint:e.current.minimum,target:e.current.maximum},
    after:{skuId,locationId,reorderPoint:e.minimum,target:e.maximum,unit:e.unit,issued:e.issued,lead:e.lead,
      percent:p.size?.percent??null,authority,ruleRevision,runId,routine:!decidedBy}});
  return {id,policyId};
}

async function replace(c,workspaceId,ids,reason){
  if(ids.length)await c.query(`UPDATE ${changes} SET status='REPLACED',reason=$3 WHERE workspace_id=$1 AND id=ANY($2::text[]) AND status='DRAFT'`,
    [workspaceId,ids,reason]);
}

// One worker page: up to 100 stocked products, each position recorded once
// per run. A retried or repeated page skips what this run already recorded.
async function process(c,workspaceId,payload={}){
  const runKey=String(payload.runKey||'');
  if(!runKey||runKey.length>80)throw Object.assign(new ValidationError('A reorder check needs its run key.'),{retryable:false});
  const auth=await authority(c,workspaceId,{lock:true});
  if(!auth.plan)return {skipped:'plan'};
  const actorId=await ownerUser(c,workspaceId,true);
  if(!actorId)return {skipped:'owner'};
  const ctx={workspaceId,actorId},day=await require('../lib/business-time').today(c,workspaceId);
  let run=(await c.query(`INSERT INTO ${runs}(id,workspace_id,run_key,business_date,plan,requested_by) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(workspace_id,run_key) DO NOTHING RETURNING *`,[newId('reorder-run'),workspaceId,runKey,day,auth.plan,payload.requestedBy||null])).rows[0];
  if(run){
    // Suggestions and skip reasons describe only the latest run; decisions stay.
    await c.query(`DELETE FROM ${changes} WHERE workspace_id=$1 AND run_id<>$2 AND status IN('SUGGESTED','WATCHED','SKIPPED','REPLACED')`,[workspaceId,run.id]);
    await c.query(`DELETE FROM ${runs} r WHERE r.workspace_id=$1 AND r.id<>$2 AND r.started_at<now()-interval '90 days'
      AND NOT EXISTS(SELECT 1 FROM ${changes} c WHERE c.run_id=r.id)`,[workspaceId,run.id]);
  }else run=(await c.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND run_key=$2 FOR UPDATE`,[workspaceId,runKey])).rows[0];
  if(run.finished_at)return {runId:run.id,replayed:true};
  const after=payload.afterSkuId||null;
  const skuIds=(await c.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2::text IS NULL OR s.id>$2)
      AND (EXISTS(SELECT 1 FROM balances b WHERE b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.on_hand<>0)
        OR EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id)
        OR EXISTS(SELECT 1 FROM stockchief_runtime.replenishment_demand_events d WHERE d.workspace_id=s.workspace_id AND d.sku_id=s.id))
    ORDER BY s.id LIMIT $3`,[workspaceId,after,PAGE+1])).rows.map(r=>r.id);
  const page=skuIds.slice(0,PAGE),counts={suggested:0,watched:0,drafted:0,applied:0,skipped:0,current:0};
  const list=await positions(c,workspaceId,page);
  if(list.length)await require('../commercial/storage-capacity').reserve(c,workspaceId,'reorder-refresh:'+run.id+':'+(after||'start'),list.length*3072+4096,{finished:true});
  const learned=await learnedLimits(c,workspaceId,page);
  const history=await c.query(`SELECT id,sku_id,location_id,status,value_key,run_id FROM ${changes}
    WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND (status IN('DRAFT','DECLINED','UNDONE') OR run_id=$3)`,[workspaceId,page,run.id]);
  const declined=new Map(history.rows.filter(r=>['DECLINED','UNDONE'].includes(r.status)).map(r=>[r.value_key,r.status]));
  const done=new Set(history.rows.filter(r=>r.run_id===run.id).map(r=>source.key(r.sku_id,r.location_id)));
  const open=new Map();
  for(const r of history.rows.filter(r=>r.status==='DRAFT')){const k=source.key(r.sku_id,r.location_id);open.set(k,[...(open.get(k)||[]),r]);}
  for(const p of list){
    const k=source.key(p.skuId,p.locationId),drafts=open.get(k)||[];
    if(done.has(k))continue;
    if(p.skip){await replace(c,workspaceId,drafts.map(d=>d.id),p.skip);await insert(c,workspaceId,run.id,p,'SKIPPED',{reason:p.skip});counts.skipped++;continue;}
    if(!p.estimate.changed){await replace(c,workspaceId,drafts.map(d=>d.id),'Already up to date.');counts.current++;continue;}
    p.size=size(p.estimate);
    const key=valueKey(p),prior=declined.get(key);
    let decision=decide(auth,p,learned.get(k));
    if(prior&&['DRAFT','APPLY'].includes(decision.status))decision={status:'SKIPPED',reason:(prior==='UNDONE'?'You undid':'You declined')+' this change. It will suggest again when sales or settings change.'};
    const kept=decision.status==='DRAFT'&&drafts.find(d=>d.value_key===key);
    await replace(c,workspaceId,drafts.filter(d=>d!==kept).map(d=>d.id),'Replaced by a newer check.');
    if(kept){
      await c.query(`UPDATE ${changes} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,kept.id,decision.reason||null]);
      counts.drafted++;continue;
    }
    if(decision.status==='APPLY'){
      await c.query('SAVEPOINT reorder_refresh');
      try{
        await apply(c,ctx,p,{runId:run.id,authority:decision.authority,ruleRevision:decision.authority==='RULE'?auth.rule.revision:null});
        await c.query('RELEASE SAVEPOINT reorder_refresh');counts.applied++;continue;
      }catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT reorder_refresh');await c.query('RELEASE SAVEPOINT reorder_refresh');
        decision={status:'DRAFT',reason:error.message};
      }
    }
    await insert(c,workspaceId,run.id,p,decision.status,{reason:decision.reason});
    counts[{SUGGESTED:'suggested',WATCHED:'watched',DRAFT:'drafted',SKIPPED:'skipped'}[decision.status]]++;
  }
  const total=Object.fromEntries(Object.keys(counts).map(name=>[name,Number(run.counts?.[name]||0)+counts[name]]));
  const more=skuIds.length>PAGE;
  await c.query(`UPDATE ${runs} SET counts=$3::jsonb,finished_at=CASE WHEN $4 THEN NULL ELSE now() END WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,run.id,JSON.stringify(total),more]);
  if(more)await queue.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'reorder-refresh:'+runKey+':'+page.at(-1),
    payload:{runKey,afterSkuId:page.at(-1),requestedBy:payload.requestedBy||null},priority:65,maxAttempts:3});
  return {runId:run.id,level:auth.level,...counts,more};
}

// Called on the first page of each scheduled autopilot evaluation: one run a
// business day, through the worker.
async function schedule(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'suggest'))return {queued:false};
  const day=await require('../lib/business-time').today(db,workspaceId);
  return {queued:(await queue.enqueue(db,{workspaceId,kind:KIND,idempotencyKey:'reorder-refresh:'+day,payload:{runKey:day},priority:65,maxAttempts:3})).created};
}
async function requestCheck(db,ctx){
  await member(db,ctx);
  const auth=await authority(db,ctx.workspaceId);
  if(!auth.plan)policy.requireJob(null,JOB,'suggest');
  const slot=Math.floor(Date.now()/900000);
  const job=await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:KIND,idempotencyKey:'reorder-refresh:manual:'+slot,
    payload:{runKey:'manual-'+slot,requestedBy:ctx.actorId},priority:60,maxAttempts:3});
  return {queued:job.created};
}

async function get(c,ctx,id){
  const row=(await c.query(`SELECT * FROM ${changes} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That reorder change is not in this inventory.');
  return row;
}
async function decisionAuthority(c,ctx){
  await member(c,ctx);
  const auth=await authority(c,ctx.workspaceId,{lock:true});
  policy.requireJob(auth.plan,JOB,'draft');
  return auth;
}
async function approveOne(c,ctx,auth,id){
  if(auth.watch)throw new ValidationError(auth.watch);
  const change=await get(c,ctx,id);
  if(change.status==='APPLIED'&&change.authority==='PERSON'&&change.decided_by===ctx.actorId)return {id,replayed:true};
  if(change.status!=='DRAFT')throw new ValidationError('This change is no longer waiting for approval.');
  const p=await position(c,ctx.workspaceId,change.sku_id,change.location_id);
  if(!p||p.skip)throw new ValidationError(p?.skip||'This product and location no longer has the facts for a change.');
  if(!p.estimate.changed||valueKey(p)!==change.value_key)
    throw new ValidationError('Sales or settings changed since this was drafted. The next check drafts a fresh change.');
  p.size=size(p.estimate);
  return apply(c,ctx,p,{runId:change.run_id,changeId:id,authority:'PERSON',decidedBy:ctx.actorId});
}
async function approve(db,ctx,id){
  return tx(db,async c=>approveOne(c,ctx,await decisionAuthority(c,ctx),id));
}
async function approveAll(db,ctx){
  return tx(db,async c=>{
    const auth=await decisionAuthority(c,ctx);
    if(auth.watch)throw new ValidationError(auth.watch);
    const ids=(await c.query(`SELECT id FROM ${changes} WHERE workspace_id=$1 AND status='DRAFT' ORDER BY created_at,id LIMIT 100`,[ctx.workspaceId])).rows.map(r=>r.id);
    const held=[];let approved=0;
    for(const id of ids){
      await c.query('SAVEPOINT reorder_refresh_approve');
      try{await approveOne(c,ctx,auth,id);await c.query('RELEASE SAVEPOINT reorder_refresh_approve');approved++;}
      catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT reorder_refresh_approve');await c.query('RELEASE SAVEPOINT reorder_refresh_approve');
        held.push({id,reason:error.message});
      }
    }
    return {approved,held};
  });
}
async function decline(db,ctx,id){
  return tx(db,async c=>{
    await decisionAuthority(c,ctx);
    const change=await get(c,ctx,id);
    if(change.status==='DECLINED')return {id,replayed:true};
    if(change.status!=='DRAFT')throw new ValidationError('This change is no longer waiting for approval.');
    await c.query(`UPDATE ${changes} SET status='DECLINED',decided_by=$3,decided_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Declined reorder point change',reference:id,
      before:{skuId:change.sku_id,locationId:change.location_id,reorderPoint:amount(change.before_minimum),target:amount(change.before_maximum)},
      after:{reorderPoint:amount(change.after_minimum),target:amount(change.after_maximum)}});
    return {id};
  });
}

// Undo restores the exact earlier values, but only while the settings still
// hold what this change wrote. A person may undo on any plan.
async function undo(db,ctx,id){
  return tx(db,async c=>{
    await member(c,ctx);
    const change=await get(c,ctx,id);
    if(change.status==='UNDONE')return {id,replayed:true};
    if(change.status!=='APPLIED')throw new ValidationError('Only an applied change can be undone.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,change.sku_id,change.location_id])]);
    const saved=(await c.query('SELECT id,reorder_point::text,target_stock::text FROM reorder_policies WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId,change.policy_id])).rows[0];
    if(!saved||amount(saved.reorder_point)!==amount(change.after_minimum)||amount(saved.target_stock)!==amount(change.after_maximum))
      throw new ValidationError('The reorder point or target changed after this update. Review the current settings instead.');
    await c.query(`UPDATE reorder_policies SET reorder_point=$3,target_stock=$4,source=$5,notes=$6,updated_at=$7 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,saved.id,change.before_minimum,change.before_maximum,change.before_source||'foundry','Earlier values restored by undo',nowIso()]);
    await c.query(`UPDATE ${changes} SET status='UNDONE',undone_by=$3,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Undid reorder point change',reference:id,
      before:{skuId:change.sku_id,locationId:change.location_id,reorderPoint:amount(change.after_minimum),target:amount(change.after_maximum)},
      after:{skuId:change.sku_id,locationId:change.location_id,reorderPoint:amount(change.before_minimum),target:amount(change.before_maximum)}});
    return {id};
  });
}

async function setLock(db,ctx,input){
  return tx(db,async c=>{
    await member(c,ctx);
    const skuId=String(input.skuId||''),locationId=input.locationId?String(input.locationId):null;
    const found=(await c.query(`SELECT s.id FROM skus s WHERE s.workspace_id=$1 AND s.id=$2
      AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM locations l WHERE l.workspace_id=s.workspace_id AND l.id=$3))`,[ctx.workspaceId,skuId,locationId])).rows[0];
    if(!found)throw new ValidationError('Choose a product and location from this inventory.');
    const where=`workspace_id=$1 AND sku_id=$2 AND location_id IS NOT DISTINCT FROM $3`;
    if(input.locked==='yes'){
      const added=await c.query(`INSERT INTO ${locks}(id,workspace_id,sku_id,location_id,locked_by) VALUES($4,$1,$2,$3,$5) ON CONFLICT DO NOTHING`,
        [ctx.workspaceId,skuId,locationId,newId('reorder-lock'),ctx.actorId]);
      await c.query(`UPDATE ${changes} SET status='REPLACED',reason='You locked these settings.' WHERE ${where} AND status='DRAFT'`,[ctx.workspaceId,skuId,locationId]);
      if(added.rowCount)await audit.record(c,ctx,{action:'Locked reorder settings',reference:skuId,after:{skuId,locationId}});
      return {locked:true};
    }
    const removed=await c.query(`DELETE FROM ${locks} WHERE ${where}`,[ctx.workspaceId,skuId,locationId]);
    if(removed.rowCount)await audit.record(c,ctx,{action:'Unlocked reorder settings',reference:skuId,before:{skuId,locationId}});
    return {locked:false};
  });
}

async function configure(db,ctx,input){
  return tx(db,async c=>{
    await member(c,ctx,{owner:true,lock:true});
    const prior=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    const revision=Number(input.revision??0);
    if(!Number.isSafeInteger(revision)||revision!==(prior?.revision||0))throw new ValidationError('The reorder rule changed. Reload it before saving.');
    if(input.remove==='1'){
      if(prior?.enabled){
        await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(c,ctx,{action:'Stopped routine reorder point updates',reference:ctx.workspaceId,
          before:{maxChangePercent:prior.max_change_percent,fillMissing:prior.fill_missing}});
      }
      return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic',{trained:true});
    const percent=Number(input.maxChangePercent);
    if(!Number.isInteger(percent)||percent<1||percent>500)throw new ValidationError('Choose a change limit from 1 to 500 percent.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the change limit before saving it.');
    const fill=input.fillMissing==='yes';
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'reorder-refresh-rule:'+((prior?.revision||0)+1),4096,{finished:true});
    await c.query(`INSERT INTO ${rules}(workspace_id,authorized_by,max_change_percent,fill_missing) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,max_change_percent=EXCLUDED.max_change_percent,
        fill_missing=EXCLUDED.fill_missing,enabled=true,revision=agent_reorder_refresh_rules.revision+1,updated_at=now()`,
    [ctx.workspaceId,ctx.actorId,percent,fill]);
    await audit.record(c,ctx,{action:'Authorized routine reorder point updates',reference:ctx.workspaceId,
      before:prior?{maxChangePercent:prior.max_change_percent,fillMissing:prior.fill_missing,enabled:prior.enabled}:{},
      after:{maxChangePercent:percent,fillMissing:fill}});
    return {saved:true};
  });
}

async function page(db,ctx,{number=1}={}){
  const who=await member(db,ctx);
  const auth=await authority(db,ctx.workspaceId);
  if(!auth.plan)policy.requireJob(null,JOB,'suggest');
  number=Number(number);
  if(!Number.isSafeInteger(number)||number<1||number>100000)throw new ValidationError('Choose a valid page.');
  const run=(await db.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0]||null;
  const select=`SELECT c.*,c.before_minimum::text,c.before_maximum::text,c.after_minimum::text,c.after_maximum::text,c.change_percent::text FROM ${changes} c WHERE c.workspace_id=$1`;
  const drafts=(await db.query(select+` AND c.status='DRAFT' ORDER BY c.created_at DESC,c.id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(number-1)*50])).rows;
  const history=(await db.query(select+` AND c.status IN('APPLIED','UNDONE','DECLINED')
    ORDER BY coalesce(c.undone_at,c.decided_at,c.created_at) DESC,c.id LIMIT 50`,[ctx.workspaceId])).rows;
  const latest=async statuses=>run?(await db.query(select+` AND c.run_id=$2 AND c.status=ANY($3::text[])
    ORDER BY c.evidence->>'code',c.evidence->>'location',c.id LIMIT 100`,[ctx.workspaceId,run.id,statuses])).rows:[];
  const suggestions=await latest(['SUGGESTED','WATCHED']),skipped=await latest(['SKIPPED']);
  const applied=history.filter(r=>r.status==='APPLIED'&&r.policy_id);
  const policies=new Map(applied.length?(await db.query('SELECT id,reorder_point::text,target_stock::text FROM reorder_policies WHERE workspace_id=$1 AND id=ANY($2::text[])',
    [ctx.workspaceId,applied.map(r=>r.policy_id)])).rows.map(r=>[r.id,r]):[]);
  for(const r of applied){const p=policies.get(r.policy_id);r.undoable=Boolean(p)&&amount(p.reorder_point)===amount(r.after_minimum)&&amount(p.target_stock)===amount(r.after_maximum);}
  const locked=(await db.query(`SELECT l.sku_id,l.location_id,s.code,coalesce(loc.name,'All locations') AS location FROM ${locks} l
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id LEFT JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id
    WHERE l.workspace_id=$1 ORDER BY s.code,location LIMIT 100`,[ctx.workspaceId])).rows;
  const isOwner=who.role==='owner'&&await ownerUser(db,ctx.workspaceId)===ctx.actorId;
  return {plan:auth.plan,level:auth.level,watch:auth.watch,hold:auth.hold,automatic:auth.automatic,rule:auth.rule,run,
    drafts:drafts.slice(0,50),more:drafts.length>50,number,history,suggestions,skipped,locked,isOwner,
    canTeach:isOwner&&policy.permits(auth.plan,JOB,'automatic',{trained:true}),trained:policy.allowance(auth.plan,JOB)==='trained'};
}

module.exports={JOB,KIND,CAPABILITY,href,authority,positions,process,schedule,requestCheck,approve,approveAll,decline,undo,setLock,configure,page};
