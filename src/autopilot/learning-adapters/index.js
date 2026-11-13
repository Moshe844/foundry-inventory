'use strict';
// Job 208: one adapter per way a trained job is taught. Each adapter says how
// to read that job's own approvals and how to save its teaching through the
// job's own rule or example path, so the job's limits, rule allowance and
// audit apply. A job that is trained on some plan either has an adapter, rides
// on another job's taught rule, or says here why approvals cannot teach it.
//
// An adapter has:
//  - kind: a fixed name for the owner's answers ("keep asking" and accepted);
//  - jobs: the agent jobs it teaches;
//  - tables: what it reads, checked before reading on older databases;
//  - history(db,ctx,{days,state,jobs}): the owner's approvals and "no"s, as rows
//    {id,scope,at,declined,needsPerson,variant,value,data};
//  - offer(db,ctx,{state,run}): what the taught rule would be, or null;
//  - teach(db,ctx,offer): saves it through the job's own path;
//  - rehearse(db,ctx,offer), optional: the job's own past-data test (job 210).
const policy=require('../../commercial/agent-plan');
const {T,day,maximum,amount,money}=require('./common');

const SKIPPED=new Set(['sales_order.create']);
const PURCHASES=new Set(['purchase_order.reorder_drafts','purchasing.select_supplier']);

// The owner's own limit for a routine's amount, or why there is none to use.
async function ownerLimit(db,workspaceId,state,action,currency){
  if(PURCHASES.has(action)){
    const cap=policy.purchaseLimits(state);
    if(!cap)return {stop:'Your plan has no agreed automatic purchase limit.'};
    if(cap.currency!==currency)return {stop:'These orders are in '+currency+', and your purchase limit is in '+cap.currency+'.'};
    return {minor:money.toMinor(String(cap.perOrder),cap.currency),label:'your per-order purchase limit'};
  }
  if(action==='landed_cost.apply'){
    const rule=await require('../../purchasing/dual-approval').setting(db,workspaceId);
    if(rule?.amount_minor!=null){
      if(rule.currency!==currency)return {stop:'Two people approve amounts in other currencies than '+rule.currency+'.'};
      return {minor:Number(rule.amount_minor),label:'the amount over which two people must approve'};
    }
  }
  return {};
}

// Draft routines taught by an amount (draft-authority): quotes, statements,
// payment matches, reservations, purchase drafts and more. A routine is the
// same kind of work in the same customer or supplier, currency and kind of
// change: the "training" scope every one of them carries.
const draftRoutines={kind:'draft-routines',label:'Draft routines taught by an amount',
 get jobs(){return [...new Set(require('../draft-authority').jobs.values())].filter(Boolean);},
 tables:[T('agent_draft_rules')],
 async history(db,ctx,{days,state,jobs}){
  const draft=require('../draft-authority');
  const actions=[...draft.jobs.keys()].filter(a=>!SKIPPED.has(a)&&draft.eligible(state.plan,a)&&jobs.includes(draft.jobs.get(a)));
  if(!actions.length)return [];
  return (await db.query(`SELECT * FROM (SELECT p.id,p.action_type,p.payload#>>'{training,key}' AS key,p.payload#>>'{training,currency}' AS currency,
      p.payload#>>'{training,amountMinor}' AS amount,p.payload#>>'{training,label}' AS label,p.payload,p.created_at,p.status='CANCELLED' AS declined,
      row_number() OVER(PARTITION BY p.action_type,p.payload#>>'{training,key}' ORDER BY p.created_at DESC,p.id DESC) AS n
    FROM ${T('assistant_action_proposals')} p
    WHERE p.workspace_id=$1 AND p.action_type=ANY($2::text[]) AND p.payload#>>'{training,key}' IS NOT NULL AND p.status IN ('EXECUTED','CANCELLED')
      AND p.created_at>=now()-make_interval(days=>$3)
      AND (p.status='CANCELLED' OR (p.result->>'replayed' IS DISTINCT FROM 'true' AND p.result->>'automatic' IS DISTINCT FROM 'true'
        AND p.result#>>'{executionAuthority,kind}' IS DISTINCT FROM 'standing_job_rule'))
      AND NOT EXISTS(SELECT 1 FROM ${T('agent_draft_rules')} r WHERE r.workspace_id=p.workspace_id AND r.action_type=p.action_type AND r.scope_key=p.payload#>>'{training,key}')
    ) x WHERE n<=60`,[ctx.workspaceId,actions,days])).rows.map(r=>({id:r.id,kind:r.action_type,job:draft.jobs.get(r.action_type),scope:r.key,at:new Date(r.created_at),
     declined:r.declined,needsPerson:!r.declined&&policy.needsPerson(r.action_type,r.payload,state),variant:null,label:r.label,value:r.amount,
     data:{payload:r.payload,currency:r.currency}}));
 },
 async offer(db,ctx,{state,run}){
  const draft=require('../draft-authority'),action=run.kind,currencies=new Set(run.rows.map(r=>r.data.currency)),currency=run.latest.data.currency;
  if(currencies.size!==1||!/^[A-Z]{3}$/.test(String(currency||'')))return null;
  if(action==='sales_order.repeat'&&(await Promise.all(run.rows.slice(0,5).map(r=>policy.customerOrderNeedsPerson(db,ctx.workspaceId,action,r.data.payload,null,state)))).some(Boolean))return null;
  const runMaximum=maximum(run.rows,r=>r.value);
  if(!Number.isSafeInteger(runMaximum)||runMaximum<=0)return null;
  const limit=await ownerLimit(db,ctx.workspaceId,state,action,currency);
  if(limit.stop)return null;
  const most=limit.minor!=null?Math.min(runMaximum,limit.minor):runMaximum;
  if(most<=0)return null;
  const settings=await draft.settings(db,ctx,run.latest.id,money.fromMinor(most,currency));
  if(!settings?.canTeach||settings.rule)return null;
  return {label:run.latest.label||settings.bound.label,limit:'up to '+amount(most,currency)+' each time',maximum:amount(most,currency),
   runMaximum:amount(runMaximum,currency),capped:most<runMaximum?limit.label:null,currency,maximumMinor:most,href:'/actions/'+run.latest.id,token:String(most),
   teach:{id:run.latest.id,maximum:money.fromMinor(most,currency)}};
 },
 async rehearse(db,ctx,offer){
  return require('../rule-rehearsal').routine(db,ctx,{action:offer.action,key:offer.key,currency:offer.currency,maximumMinor:offer.maximumMinor,latestId:offer.latestId,label:offer.label});
 },
 async teach(s,ctx,offer){await require('../draft-authority').save(s,ctx,offer.teach.id,{mode:'save',maximum:offer.teach.maximum,revision:0});}
};

// Job 56: releases of ready orders a person approved at the same warehouse.
// Discarding or undoing one is a "no".
const RELEASES=T('agent_pick_releases'),RELEASE_RULES=T('agent_pick_release_rules');
const pickReleases={kind:'warehouse.release_orders',jobs:[56],label:'Pick releases',tables:[RELEASES,RELEASE_RULES],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT r.id,r.location_id,r.status,coalesce(r.released_at,r.created_at) AS at,jsonb_array_length(coalesce(r.plan->'orders','[]'::jsonb)) AS orders,l.name AS place
    FROM ${RELEASES} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id AND l.is_active=1
    WHERE r.workspace_id=$1 AND r.created_at>=now()-make_interval(days=>$2)
      AND ((r.status='RELEASED' AND r.authorization_kind='INDIVIDUAL') OR r.status IN ('DISCARDED','UNDONE'))
      AND NOT EXISTS(SELECT 1 FROM ${RELEASE_RULES} x WHERE x.workspace_id=r.workspace_id AND x.location_id=r.location_id AND x.enabled AND x.automatic)`,
  [ctx.workspaceId,days])).rows.map(r=>({id:r.id,scope:r.location_id,at:new Date(r.at),declined:r.status!=='RELEASED',needsPerson:false,variant:null,value:r.orders,data:r}));
 },
 async offer(db,ctx,{run}){
  const release=require('../../warehouse/agent-pick-release'),prior=await release.read(db,ctx.workspaceId,run.scope);
  // The owner's own batch size stays; otherwise the latest release's size.
  const batch=prior?.enabled?Number(prior.batch_orders):Math.min(Math.max(Number(run.latest.value)||1,1),release.MAX_BATCH);
  return {label:'Release ready orders at '+run.latest.data.place,limit:batch+' orders at a time',maximum:batch+' orders at a time',
   runMaximum:maximum(run.rows,r=>r.value)+' orders',maximumMinor:0,href:release.href,token:'0',teach:{id:run.latest.id},batch};
 },
 rehearse(db,ctx,offer,run){
  const label=offer.label,place=run.latest.data.place;
  return {title:label+' on its own',tested:true,more:run.rows.length>20,
   summary:'You released orders at '+place+' '+run.rows.length+' times in a row without discarding or undoing one. It would have released each of those batches on its own, '+offer.batch+' orders at a time.',
   rows:run.rows.slice(0,20).reverse().map(r=>({When:day(r.at),'Would have':'Released '+r.value+(Number(r.value)===1?' order':' orders')+' on its own','What happened':'You released them'}))};
 },
 async teach(s,ctx,offer){await require('../../warehouse/agent-pick-release').teach(s,ctx,offer.teach.id);}
};

const adapters=[draftRoutines,pickReleases,...require('./stock'),...require('./buying'),...require('./selling')];

// Jobs taught by another job's rule: the same approvals, the same taught rule.
const via={
 23:{kind:'draft-routines',reason:'Supplier minimums and free-shipping top-ups are part of the reorder drafts of job 19; the reorder routine learned from your approvals teaches them too.'},
 27:{kind:'draft-routines',reason:'Full cases and packs are part of the reorder drafts of job 19; the reorder routine learned from your approvals teaches them too.'},
 213:{kind:'steps',reason:'A Growth playbook runs only steps whose own jobs are taught; each step learns through its own job here.'}
};

// Jobs whose approvals cannot teach them, and why.
const cannot={
 7:'Staff count lists are the owner’s own assignments, not drafts StockChief prepares for approval, and a count schedule needs a cadence and first day that no assignment carries.',
 21:'One approved reorder point change already teaches that product and location, and the only saved rule covers the whole business, so five approvals add nothing safe to learn.',
 58:'One approved shipping rate already teaches it to choose rates up to that price, and the only saved rule has no price limit, so learning it from approvals would raise a limit.',
 67:'A standing order has no draft per order to approve: the owner’s saved schedule is the approval, and it needs a cadence and dates no approval carries.',
 72:'The first answer you approve and the mailbox sends already teaches that customer and those topics, so five approvals in a row never build up.',
 89:'On Growth, approve and send one prepared date request, then select it on the supplier date request rule. Approve other one-off supplier emails individually.',
 94:'Before a rule exists every approval is a negotiation email you start yourself; the routine it can learn is a different lead-time note whose rule needs no example and a cadence you choose.',
 102:'The first reminder you approve and the mailbox sends already teaches that customer and mailbox, so five approvals in a row never build up, and a reminder schedule needs wording and days approvals do not carry.',
 140:'A shelf photo teaches only while a person confirms it on its page; a photo confirmed earlier cannot be turned into a rule through the job’s own path.',
 184:'The first approved invoice or bill confirmed by the connected books already teaches that document kind for that connection.'
};

// How each trained job learns: an adapter, another job's rule, or why not.
function coverage(job){
  const adapter=adapters.find(a=>a.jobs.includes(job));
  if(adapter)return {how:'adapter',kind:adapter.kind};
  if(via[job])return {how:'via',...via[job]};
  if(cannot[job])return {how:'cannot',reason:cannot[job]};
  return null;
}

module.exports={adapters,via,cannot,coverage,ownerLimit,draftRoutines,pickReleases};
