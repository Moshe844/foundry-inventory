'use strict';
// Job 208: learns from your approvals and stops asking about what you always OK.
//
// This is the one place that notices a run of identical approvals. A routine
// is identical when StockChief prepared the same kind of work in the same
// scope: the same customer or supplier, currency and kind of change (the
// "training" scope every taught routine already carries), or released orders
// at the same warehouse for pick releases (job 56). A run is the newest
// approvals in that scope back to the last time you said no or changed the
// draft; five in a row is a run. Work StockChief did on its own does not count.
//
// StockChief then offers to stop asking: it shows the run and what the rule
// would have done with your past approvals (job 210), and you confirm once.
// Confirming saves that routine's taught rule, the same rule you can teach on
// an example's page, so the rule counts against your rule allowance, and from
// then on StockChief does that routine alone inside the rule and every other
// check it runs each time.
//
// It only offers where a taught rule is what stops the asking: jobs your plan
// lets StockChief do alone after it is taught. It never offers when:
//  - you chose Ask me first or Watch only for that job;
//  - any approval in the run is on the "always needs a person" list;
//  - the routine already has a rule (it never raises a limit on its own);
//  - the run's amount is in a different currency from your own limit.
// The rule's amount is the largest amount you approved in the run, and never
// more than your own limits (your plan's per-order purchase limit, or the
// amount over which two people must approve).
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const draft=require('./draft-authority');
const {has}=require('../db/schema-installed');
const {ValidationError}=require('../domain/errors');

const JOB=208,RUN=5,DAYS=90,path='/autopilot/learning/approvals';
const DECISIONS='stockchief_runtime.agent_learning_decisions';
// Owner-typed orders start from a person's request rather than a prepared
// routine, and a first-time customer or new address always needs a person.
const SKIPPED=new Set(['sales_order.create']);
const PURCHASES=new Set(['purchase_order.reorder_drafts','purchasing.select_supplier']);
const anchor=(action,key)=>'routine-'+require('node:crypto').createHash('sha256').update(action+'|'+key).digest('hex').slice(0,16);
const day=value=>new Date(value).toISOString().slice(0,10);

// The newest approvals per routine scope, back to the last "no".
async function runs(db,workspaceId,actions){
  const decided=await has(db,DECISIONS);
  return (await db.query(`WITH decided AS (
      SELECT p.id,p.action_type,p.payload#>>'{training,key}' AS key,p.payload#>>'{training,currency}' AS currency,
        (p.payload#>>'{training,amountMinor}')::numeric AS amount,p.payload#>>'{training,label}' AS label,p.payload,p.created_at,
        p.status='CANCELLED' AS declined
      FROM stockchief_runtime.assistant_action_proposals p
      WHERE p.workspace_id=$1 AND p.action_type=ANY($2::text[]) AND p.payload#>>'{training,key}' IS NOT NULL AND p.status IN ('EXECUTED','CANCELLED')
        AND p.created_at>=now()-make_interval(days=>$3)
        AND (p.status='CANCELLED' OR (p.result->>'replayed' IS DISTINCT FROM 'true' AND p.result->>'automatic' IS DISTINCT FROM 'true'
          AND p.result#>>'{executionAuthority,kind}' IS DISTINCT FROM 'standing_job_rule'))
        ${decided?`AND NOT EXISTS(SELECT 1 FROM ${DECISIONS} d WHERE d.workspace_id=p.workspace_id AND d.job_id=208
          AND d.kind=p.action_type AND d.scope_key=p.payload#>>'{training,key}' AND p.created_at<=d.through)`:''}
    ), counted AS (
      SELECT d.*,count(*) FILTER(WHERE declined) OVER(PARTITION BY action_type,key ORDER BY created_at DESC,id DESC ROWS UNBOUNDED PRECEDING) AS noes
      FROM decided d
    )
    SELECT action_type,key,min(currency) AS currency,count(*)::int AS run,max(amount)::text AS maximum,min(created_at) AS first,max(created_at) AS last,
      (array_agg(id ORDER BY created_at DESC,id DESC))[1] AS latest_id,(array_agg(label ORDER BY created_at DESC,id DESC))[1] AS label,
      (array_agg(id ORDER BY created_at DESC,id DESC))[1:50] AS ids,(array_agg(payload ORDER BY created_at DESC,id DESC))[1:50] AS payloads,
      count(DISTINCT currency)::int AS currencies
    FROM counted c WHERE noes=0
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_draft_rules r WHERE r.workspace_id=$1 AND r.action_type=c.action_type AND r.scope_key=c.key)
    GROUP BY action_type,key HAVING count(*)>=$4 ORDER BY max(created_at) DESC LIMIT 100`,
  [workspaceId,actions,DAYS,RUN])).rows;
}

// The owner's own limit for this routine's amount, or why there is none to use.
async function ownerLimit(db,workspaceId,state,action,currency){
  if(PURCHASES.has(action)){
    const cap=policy.purchaseLimits(state);
    if(!cap)return {stop:'Your plan has no agreed automatic purchase limit.'};
    if(cap.currency!==currency)return {stop:'These orders are in '+currency+', and your purchase limit is in '+cap.currency+'.'};
    return {minor:money.toMinor(String(cap.perOrder),cap.currency),label:'your per-order purchase limit'};
  }
  if(action==='landed_cost.apply'){
    const rule=await require('../purchasing/dual-approval').setting(db,workspaceId);
    if(rule?.amount_minor!=null){
      if(rule.currency!==currency)return {stop:'Two people approve amounts in other currencies than '+rule.currency+'.'};
      return {minor:Number(rule.amount_minor),label:'the amount over which two people must approve'};
    }
  }
  return {};
}

// Pick releases (job 56) keep their own approvals: each release a person
// approved at a warehouse, and each one discarded or undone.
const RELEASES='stockchief_runtime.agent_pick_releases',RELEASE_RULES='stockchief_runtime.agent_pick_release_rules',RELEASE='warehouse.release_orders';
async function releaseRuns(db,workspaceId){
  if(!await has(db,RELEASES))return [];
  const decided=await has(db,DECISIONS);
  return (await db.query(`WITH decided AS (
      SELECT r.id,r.location_id,coalesce(r.released_at,r.created_at) AS at,jsonb_array_length(coalesce(r.plan->'orders','[]'::jsonb)) AS orders,
        r.status IN ('DISCARDED','UNDONE') AS declined
      FROM ${RELEASES} r WHERE r.workspace_id=$1 AND r.created_at>=now()-make_interval(days=>$2)
        AND ((r.status='RELEASED' AND r.authorization_kind='INDIVIDUAL') OR r.status IN ('DISCARDED','UNDONE'))
        ${decided?`AND NOT EXISTS(SELECT 1 FROM ${DECISIONS} d WHERE d.workspace_id=r.workspace_id AND d.job_id=208 AND d.kind='${RELEASE}'
          AND d.scope_key=r.location_id AND coalesce(r.released_at,r.created_at)<=d.through)`:''}
    ), counted AS (
      SELECT d.*,count(*) FILTER(WHERE declined) OVER(PARTITION BY location_id ORDER BY at DESC,id DESC ROWS UNBOUNDED PRECEDING) AS noes FROM decided d
    )
    SELECT c.location_id,l.name AS location,count(*)::int AS run,min(c.at) AS first,max(c.at) AS last,(array_agg(c.id ORDER BY c.at DESC,c.id DESC))[1] AS latest_id,
      (array_agg(c.orders ORDER BY c.at DESC,c.id DESC))[1] AS latest_orders,array_agg(c.id ORDER BY c.at DESC,c.id DESC) AS ids,
      jsonb_agg(jsonb_build_object('at',c.at,'orders',c.orders) ORDER BY c.at) AS examples
    FROM counted c JOIN locations l ON l.workspace_id=$1 AND l.id=c.location_id AND l.is_active=1
    WHERE c.noes=0 AND NOT EXISTS(SELECT 1 FROM ${RELEASE_RULES} x WHERE x.workspace_id=$1 AND x.location_id=c.location_id AND x.enabled AND x.automatic)
    GROUP BY c.location_id,l.name HAVING count(*)>=$3 ORDER BY max(c.at) DESC LIMIT 50`,[workspaceId,DAYS,RUN])).rows;
}
async function releaseOffers(db,ctx,state){
  const release=require('../warehouse/agent-pick-release');
  if(policy.allowance(state.plan,release.JOB)!=='trained'||await require('./job-modes').restriction(db,ctx.workspaceId,release.JOB,true))return [];
  const found=[];
  for(const r of await releaseRuns(db,ctx.workspaceId)){
    const prior=await release.read(db,ctx.workspaceId,r.location_id);
    // The owner's own batch size stays; otherwise the latest release's size.
    const batch=prior?.enabled?Number(prior.batch_orders):Math.min(Math.max(Number(r.latest_orders)||1,1),release.MAX_BATCH);
    const label='Release ready orders at '+r.location;
    found.push({source:'release',anchor:anchor(RELEASE,r.location_id),action:RELEASE,job:release.JOB,key:r.location_id,label,run:r.run,first:day(r.first),last:r.last,
      latestId:r.latest_id,ids:r.ids,currency:null,maximumMinor:0,maximum:batch+' orders at a time',runMaximum:Math.max(...r.examples.map(e=>Number(e.orders)))+' orders',capped:null,
      example:release.href,test:{sections:[{title:label+' on its own',tested:true,more:false,
        summary:'You released orders at '+r.location+' '+r.run+' times in a row without discarding or undoing one. It would have released each of those batches on its own, '+batch+' orders at a time.',
        rows:r.examples.slice(-20).map(e=>({When:day(e.at),'Would have':'Released '+e.orders+(Number(e.orders)===1?' order':' orders')+' on its own','What happened':'You released them'}))}]}});
  }
  return found;
}

// Offers to stop asking, newest first. Each comes with its past-data test.
async function offers(db,ctx,{test=true}={}){
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  if(state.shadow)return [];
  const modes=require('./job-modes'),actions=[...draft.jobs.keys()].filter(a=>!SKIPPED.has(a)&&draft.eligible(state.plan,a)&&
    policy.allowance(state.plan,draft.jobs.get(a))==='trained');
  const found=await releaseOffers(db,ctx,state);
  if(!actions.length)return found;
  for(const r of await runs(db,ctx.workspaceId,actions)){
    const job=draft.jobs.get(r.action_type);
    if(r.currencies!==1||!/^[A-Z]{3}$/.test(String(r.currency||'')))continue;
    if(await modes.restriction(db,ctx.workspaceId,job,true))continue;
    if(r.payloads.some(p=>policy.needsPerson(r.action_type,p,state)))continue;
    if(r.action_type==='sales_order.repeat'&&(await Promise.all(r.payloads.slice(0,RUN).map(p=>policy.customerOrderNeedsPerson(db,ctx.workspaceId,r.action_type,p,null,state)))).some(Boolean))continue;
    const runMaximum=Number(r.maximum);
    if(!Number.isSafeInteger(runMaximum)||runMaximum<=0)continue;
    const limit=await ownerLimit(db,ctx.workspaceId,state,r.action_type,r.currency);
    if(limit.stop)continue;
    const maximum=limit.minor!=null?Math.min(runMaximum,limit.minor):runMaximum;
    if(maximum<=0)continue;
    const settings=await draft.settings(db,ctx,r.latest_id,money.fromMinor(maximum,r.currency));
    if(!settings?.canTeach||settings.rule)continue;
    const label=r.label||settings.bound.label;
    const offer={source:'routine',anchor:anchor(r.action_type,r.key),action:r.action_type,job,key:r.key,label,run:r.run,first:day(r.first),last:r.last,latestId:r.latest_id,
      ids:r.ids,currency:r.currency,maximumMinor:maximum,maximum:money.format(maximum,r.currency),runMaximum:money.format(runMaximum,r.currency),
      capped:maximum<runMaximum?limit.label:null,example:'/actions/'+r.latest_id};
    if(test)offer.test={sections:[await require('./rule-rehearsal').routine(db,ctx,{action:r.action_type,key:r.key,currency:r.currency,maximumMinor:maximum,latestId:r.latest_id,label})]};
    found.push(offer);
  }
  return found;
}

async function owner(db,ctx){return require('./job-reviews').ownerState(db,ctx);}
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
// The owner's answer, up to the newest approval they saw.
async function decide(c,ctx,offer,decision,rule){
  if(!await has(c,DECISIONS))return;
  await c.query(`INSERT INTO ${DECISIONS}(workspace_id,job_id,kind,scope_key,decision,through,rule_reference,decided_by) VALUES($1,208,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(workspace_id,job_id,kind,scope_key) DO UPDATE SET decision=EXCLUDED.decision,through=greatest(${DECISIONS}.through,EXCLUDED.through),
      rule_reference=EXCLUDED.rule_reference,decided_by=EXCLUDED.decided_by,decided_at=clock_timestamp()`,
  [ctx.workspaceId,offer.action,offer.key,decision,offer.last,rule,ctx.actorId]);
}

// The owner confirms once: the offer becomes the routine's taught rule.
async function confirm(db,ctx,input={}){
  const latestId=String(input.latestId||''),maximum=String(input.maximum||'');
  if(!latestId||!/^\d+$/.test(maximum))throw new ValidationError('Review the offer before confirming it.');
  return db.transaction(async c=>{
    const s=scoped(c);await owner(s,ctx);
    await policy.requireWorkspaceJob(s,ctx.workspaceId,JOB,'automatic');
    const offer=(await offers(s,ctx,{test:false})).find(o=>o.latestId===latestId);
    if(!offer){
      // A repeated confirmation finds the rule it already saved.
      const p=(await c.query('SELECT action_type,payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,latestId])).rows[0];
      if(p?.payload?.training?.key&&(await c.query('SELECT 1 FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3',
        [ctx.workspaceId,p.action_type,p.payload.training.key])).rowCount)return {replayed:true,label:p.payload.training.label};
      if(!p&&await has(c,RELEASES)&&(await c.query(`SELECT 1 FROM ${RELEASES} r JOIN ${RELEASE_RULES} x ON x.workspace_id=r.workspace_id AND x.location_id=r.location_id
        WHERE r.workspace_id=$1 AND r.id=$2 AND x.enabled AND x.automatic`,[ctx.workspaceId,latestId])).rowCount)return {replayed:true,label:'these releases'};
      throw new ValidationError('This offer changed since you saw it. Review it again before StockChief stops asking.');
    }
    if(Number(maximum)!==offer.maximumMinor)throw new ValidationError('The amount changed since you saw it. Review the offer again.');
    if(offer.source==='release'){
      await require('../warehouse/agent-pick-release').teach(s,ctx,latestId);
      await decide(c,ctx,offer,'accepted',latestId);
      await require('../operations/postgres-security-audit').record(c,ctx,{action:'Stopped asking about a routine you always approved',reference:latestId,
        after:{job:offer.job,routine:offer.label,approvals:offer.run,since:offer.first,batch:offer.maximum,examples:offer.ids.slice(0,20)}});
      return {replayed:false,label:offer.label.charAt(0).toLowerCase()+offer.label.slice(1),maximum:offer.maximum};
    }
    const test=await require('./rule-rehearsal').routine(s,ctx,{action:offer.action,key:offer.key,currency:offer.currency,maximumMinor:offer.maximumMinor,latestId,label:offer.label});
    await draft.save(s,ctx,latestId,{mode:'save',maximum:money.fromMinor(offer.maximumMinor,offer.currency),revision:0});
    await decide(c,ctx,offer,'accepted',latestId);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Stopped asking about a routine you always approved',reference:latestId,
      after:{job:offer.job,routine:offer.label,approvals:offer.run,since:offer.first,maximum:offer.maximum,limitedBy:offer.capped,examples:offer.ids.slice(0,20),test:test.summary}});
    return {replayed:false,label:offer.label,maximum:offer.maximum};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// "Keep asking": the offer stays away until a new run of approvals.
async function dismiss(db,ctx,input={}){
  const latestId=String(input.latestId||'');
  return db.transaction(async c=>{
    const s=scoped(c);await owner(s,ctx);
    if(!await has(s,DECISIONS))throw new ValidationError('This inventory is being upgraded. Try again in a few minutes.');
    const offer=(await offers(s,ctx,{test:false})).find(o=>o.latestId===latestId);
    if(!offer)return {replayed:true};
    await decide(c,ctx,offer,'declined',null);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Kept asking about a routine',reference:latestId,after:{routine:offer.label,approvals:offer.run}});
    return {replayed:false,label:offer.label};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The page: offers to stop asking, and the routines it already learned.
async function page(db,ctx){
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  const learned=(await db.query(`SELECT r.scope_label,r.currency,r.maximum_minor,r.action_type FROM stockchief_runtime.agent_draft_rules r
    WHERE r.workspace_id=$1 ORDER BY r.scope_label,r.action_type LIMIT 50`,[ctx.workspaceId])).rows
    .map(r=>({label:r.scope_label,limit:'Up to '+money.format(r.maximum_minor,r.currency)}));
  if(await has(db,RELEASE_RULES))learned.push(...(await db.query(`SELECT l.name,x.batch_orders FROM ${RELEASE_RULES} x JOIN locations l ON l.workspace_id=x.workspace_id AND l.id=x.location_id
    WHERE x.workspace_id=$1 AND x.enabled AND x.automatic ORDER BY l.name LIMIT 50`,[ctx.workspaceId])).rows.map(r=>({label:'Release ready orders at '+r.name,limit:r.batch_orders+' orders at a time'})));
  const routineOff=!state.shadow&&!(await require('./postgres-service').getState(db,ctx.workspaceId)).canAutomate;
  return {shadow:Boolean(state.shadow),shadowEndsAt:state.shadowEndsAt,routineOff,run:RUN,days:DAYS,offers:await offers(db,ctx),learned};
}

// Needs you: one notice per offer, while it stands. Read by the notices refresh.
async function notices(db,workspaceId,account){
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic')||account.shadow||!await has(db,DECISIONS))return [];
  const ownerId=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id;
  if(!ownerId)return [];
  return (await offers(db,{workspaceId,actorId:ownerId},{test:false})).map(o=>({kind:'Learning',ref:o.action+':'+o.key,link:path}));
}

module.exports={JOB,RUN,DAYS,path,offers,ownerLimit,confirm,dismiss,page,notices};
