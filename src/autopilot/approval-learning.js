'use strict';
// Job 208: learns from your approvals and stops asking about what you always OK.
//
// This is the one place that notices a run of identical approvals, for every
// job your plan lets StockChief do alone once it is taught. Each trained job
// has an adapter (./learning-adapters) that reads that job's own approvals and
// "no"s and saves its teaching through the job's own rule or example path, so
// the job's own limits, rule allowance and audit apply.
//
// A routine is the same kind of work in the same scope: the same customer or
// supplier and currency for a draft routine, the same warehouse for releases
// and waves, the same product and route for transfers, and so on. A run is the
// newest approvals in that scope back to the last time you said no, undid it or
// changed it; five in a row is a run. Approvals of anything on the "always
// needs a person" list never count, and work StockChief did on its own never
// counts.
//
// StockChief then offers to stop asking: it shows the run and what the rule
// would have done with your past answers (job 210), and you confirm once.
// It never offers when:
//  - your plan does not train that job (it is drafted, or done alone already);
//  - you chose Ask me first or Watch only for that job, or Watch only for the
//    whole inventory, or StockChief is still in its first 14 days;
//  - the routine already has a rule (it never raises a limit on its own);
//  - the rule would go past your own limits.
// "Keep asking" holds until a new run of approvals after the ones you saw.
const policy=require('../commercial/agent-plan');
const registry=require('./learning-adapters');
const {day,num}=require('./learning-adapters/common');
const {has}=require('../db/schema-installed');
const {ValidationError}=require('../domain/errors');

const JOB=208,RUN=5,DAYS=90,ROWS=20,path='/autopilot/learning/approvals';
const DECISIONS='stockchief_runtime.agent_learning_decisions',ACCEPTED='Stopped asking about a routine you always approved';
const anchor=(kind,key)=>'routine-'+require('node:crypto').createHash('sha256').update(kind+'|'+key).digest('hex').slice(0,16);
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});

// The owner's earlier answers: nothing up to the newest approval they saw counts again.
async function answered(db,workspaceId){
  if(!await has(db,DECISIONS))return new Map();
  return new Map((await db.query(`SELECT kind,scope_key,through FROM ${DECISIONS} WHERE workspace_id=$1 AND job_id=208`,[workspaceId])).rows
    .map(r=>[r.kind+'\u0000'+r.scope_key,new Date(r.through)]));
}

// Runs of five or more identical approvals, newest first, per scope.
function runsOf(adapter,rows,decided){
  const groups=new Map();
  for(const r of rows){
    const kind=r.kind||adapter.kind,key=kind+'\u0000'+r.scope;
    if(!groups.has(key))groups.set(key,{kind,scope:r.scope,job:r.job??adapter.jobs[0],all:[],through:decided.get(key)});
    groups.get(key).all.push(r);
  }
  const runs=[];
  for(const g of groups.values()){
    g.all.sort((a,b)=>b.at-a.at||(String(b.id)>String(a.id)?1:-1));
    const rows=[];let variant;
    for(const r of g.all){
      if(g.through&&r.at<=g.through)break;
      if(r.declined)break;
      if(r.needsPerson)continue;
      const v=r.variant??null;
      if(variant===undefined)variant=v;else if(v!==variant)break;
      rows.push(r);
    }
    if(rows.length>=RUN)runs.push({...g,rows,latest:rows[0],first:rows.at(-1),variant});
  }
  return runs;
}

// Job 210: what the rule would have done with the answers in this scope.
function replay(offer,run){
  const counted=new Set(run.rows.map(r=>r.id)),limit=num(offer.limitValue);
  const decide=r=>r.declined?'Asked you (you said no or changed it then)':r.needsPerson?'Asked you: this always needs a person':
    (r.variant??null)!==run.variant?'Asked you: a different choice from this routine':limit!==null&&num(r.value)!==null&&num(r.value)>limit?'Asked you: over the rule’s limit':'Done it on its own';
  const answers=run.all,done=answers.filter(r=>decide(r)==='Done it on its own').length,noes=answers.filter(r=>r.declined).length,people=answers.filter(r=>!r.declined&&r.needsPerson).length;
  return {title:offer.label+' on its own',tested:true,more:answers.length>ROWS,
    summary:'You approved this '+run.rows.length+' times in a row since '+day(run.first.at)+'. Of the '+answers.length+' answers in this scope in the last '+DAYS+' days, it would have done '+done+
      ' on its own'+(people?', still asked you about '+people+' that always need a person':'')+(noes?', and asked you about the '+noes+' you said no to or changed':'')+'.',
    rows:answers.slice(0,ROWS).reverse().map(r=>({When:day(r.at),'Would have':decide(r),'What happened':r.declined?'You said no, undid or changed it':counted.has(r.id)?'You approved it':'You approved it earlier'}))};
}
async function rehearse(db,ctx,adapter,offer){
  const run=offer.run_;
  return adapter.rehearse?adapter.rehearse(db,ctx,offer,run):replay(offer,run);
}

async function watchOnly(db,workspaceId){
  return (await db.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0]?.mode==='OBSERVE';
}

// Offers to stop asking, newest first. Each comes with its past-data test.
async function offers(db,ctx,{test=true,only=null}={}){
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic');
  if(state.shadow||await watchOnly(db,ctx.workspaceId))return [];
  const modes=require('./job-modes'),decided=await answered(db,ctx.workspaceId),found=[];
  for(const adapter of registry.adapters){
    if(only&&adapter.kind!==only)continue;
    const jobs=[];
    for(const job of adapter.jobs)if(policy.allowance(state.plan,job)==='trained'&&!await modes.restriction(db,ctx.workspaceId,job,true))jobs.push(job);
    if(!jobs.length)continue;
    let ready=true;for(const table of adapter.tables||[])if(!await has(db,table)){ready=false;break;}
    if(!ready)continue;
    for(const run of runsOf(adapter,await adapter.history(db,ctx,{days:DAYS,state,jobs}),decided)){
      if(!jobs.includes(run.job))continue;
      // A record the job itself would refuse (a stopped page, a changed
      // supplier) means no offer; it never stops the other offers.
      let o;
      try{o=await adapter.offer(db,ctx,{state,run});}catch(error){if(![400,402,403,404,409,422].includes(error?.status))throw error;o=null;}
      if(!o)continue;
      const offer={...o,source:adapter.kind,anchor:anchor(run.kind,run.scope),action:run.kind,job:run.job,key:run.scope,run:run.rows.length,
        first:day(run.first.at),last:run.latest.at,latestId:run.latest.id,ids:run.rows.map(r=>r.id),example:o.href,
        maximum:o.maximum||o.limit,runMaximum:o.runMaximum||null,capped:o.capped||null};
      Object.defineProperty(offer,'run_',{value:run});
      if(test)offer.test={sections:[await rehearse(db,ctx,adapter,offer)]};
      found.push(offer);
    }
  }
  return found.sort((a,b)=>b.last-a.last);
}

async function owner(db,ctx){return require('./job-reviews').ownerState(db,ctx);}
// The owner's answer, up to the newest approval they saw.
async function decide(c,ctx,offer,decision,rule){
  if(!await has(c,DECISIONS))return;
  await c.query(`INSERT INTO ${DECISIONS}(workspace_id,job_id,kind,scope_key,decision,through,rule_reference,decided_by) VALUES($1,208,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(workspace_id,job_id,kind,scope_key) DO UPDATE SET decision=EXCLUDED.decision,through=greatest(${DECISIONS}.through,EXCLUDED.through),
      rule_reference=EXCLUDED.rule_reference,decided_by=EXCLUDED.decided_by,decided_at=clock_timestamp()`,
  [ctx.workspaceId,offer.action,offer.key,decision,offer.last,rule,ctx.actorId]);
}
// A repeated confirmation finds the answer it already saved.
async function alreadyAccepted(c,ctx,latestId){
  if(!await has(c,DECISIONS))return null;
  return (await c.query(`SELECT d.kind,e.after_state->>'routine' AS routine FROM ${DECISIONS} d
    LEFT JOIN LATERAL (SELECT after_state FROM security_event_history e WHERE e.workspace_id=d.workspace_id AND e.action=$3 AND e.reference=d.rule_reference
      ORDER BY e.created_at DESC LIMIT 1) e ON true
    WHERE d.workspace_id=$1 AND d.job_id=208 AND d.decision='accepted' AND d.rule_reference=$2 LIMIT 1`,[ctx.workspaceId,latestId,ACCEPTED])).rows[0]||null;
}

// The owner confirms once: the offer becomes that job's own taught rule.
async function confirm(db,ctx,input={}){
  const latestId=String(input.latestId||''),token=String(input.maximum??''),only=input.source?String(input.source):null;
  if(!latestId||latestId.length>300||!/^[A-Za-z0-9._:-]{1,80}$/.test(token))throw new ValidationError('Review the offer before confirming it.');
  if(only&&!registry.adapters.some(a=>a.kind===only))throw new ValidationError('Review the offer before confirming it.');
  return db.transaction(async c=>{
    const s=scoped(c);await owner(s,ctx);
    await policy.requireWorkspaceJob(s,ctx.workspaceId,JOB,'automatic');
    const offer=(await offers(s,ctx,{test:false,only})).find(o=>o.latestId===latestId);
    if(!offer){
      const prior=await alreadyAccepted(c,ctx,latestId);
      if(prior)return {replayed:true,label:prior.routine||'this routine'};
      throw new ValidationError('This offer changed since you saw it. Review it again before StockChief stops asking.');
    }
    if(token!==offer.token)throw new ValidationError('The amount changed since you saw it. Review the offer again.');
    const adapter=registry.adapters.find(a=>a.kind===offer.source),test=await rehearse(s,ctx,adapter,offer);
    await adapter.teach(s,ctx,offer);
    await decide(c,ctx,offer,'accepted',latestId);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:ACCEPTED,reference:latestId,
      after:{job:offer.job,routine:offer.label,approvals:offer.run,since:offer.first,limit:offer.limit,limitedBy:offer.capped,examples:offer.ids.slice(0,20),test:test.summary}});
    return {replayed:false,label:offer.label,limit:offer.limit};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// "Keep asking": the offer stays away until a new run of approvals.
async function dismiss(db,ctx,input={}){
  const latestId=String(input.latestId||''),only=input.source&&registry.adapters.some(a=>a.kind===String(input.source))?String(input.source):null;
  return db.transaction(async c=>{
    const s=scoped(c);await owner(s,ctx);
    if(!await has(s,DECISIONS))throw new ValidationError('This inventory is being upgraded. Try again in a few minutes.');
    const offer=(await offers(s,ctx,{test:false,only})).find(o=>o.latestId===latestId);
    if(!offer)return {replayed:true};
    await decide(c,ctx,offer,'declined',null);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Kept asking about a routine',reference:latestId,after:{job:offer.job,routine:offer.label,approvals:offer.run}});
    return {replayed:false,label:offer.label};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The page: offers to stop asking, and the routines it already learned.
async function page(db,ctx){
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic'),money=require('../domain/currency');
  const learned=(await db.query(`SELECT r.scope_label,r.currency,r.maximum_minor FROM stockchief_runtime.agent_draft_rules r
    WHERE r.workspace_id=$1 ORDER BY r.scope_label,r.action_type LIMIT 50`,[ctx.workspaceId])).rows
    .map(r=>({label:r.scope_label,limit:'Up to '+money.format(r.maximum_minor,r.currency)}));
  const releases='stockchief_runtime.agent_pick_release_rules';
  if(await has(db,releases))learned.push(...(await db.query(`SELECT l.name,x.batch_orders FROM ${releases} x JOIN locations l ON l.workspace_id=x.workspace_id AND l.id=x.location_id
    WHERE x.workspace_id=$1 AND x.enabled AND x.automatic ORDER BY l.name LIMIT 50`,[ctx.workspaceId])).rows.map(r=>({label:'Release ready orders at '+r.name,limit:r.batch_orders+' orders at a time'})));
  // Other jobs keep their rules on their own pages; this lists what was learned here.
  if(await has(db,DECISIONS))learned.push(...(await db.query(`SELECT e.after_state->>'routine' AS routine,e.after_state->>'limit' AS lim,d.decided_at FROM ${DECISIONS} d
    JOIN LATERAL (SELECT after_state FROM security_event_history e WHERE e.workspace_id=d.workspace_id AND e.action=$2 AND e.reference=d.rule_reference
      ORDER BY e.created_at DESC LIMIT 1) e ON true
    WHERE d.workspace_id=$1 AND d.job_id=208 AND d.decision='accepted' AND d.kind LIKE 'job:%' ORDER BY d.decided_at DESC LIMIT 50`,[ctx.workspaceId,ACCEPTED])).rows
    .map(r=>({label:r.routine,limit:r.lim?r.lim.charAt(0).toUpperCase()+r.lim.slice(1):'Learned '+day(r.decided_at),since:day(r.decided_at)})));
  const routineOff=!state.shadow&&!(await require('./postgres-service').getState(db,ctx.workspaceId)).canAutomate;
  const watching=!state.shadow&&await watchOnly(db,ctx.workspaceId);
  return {shadow:Boolean(state.shadow),shadowEndsAt:state.shadowEndsAt,routineOff,watching,run:RUN,days:DAYS,offers:await offers(db,ctx),learned};
}

// Needs you: one notice per offer, while it stands. Read by the notices refresh.
async function notices(db,workspaceId,account){
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic')||account.shadow||!await has(db,DECISIONS))return [];
  const ownerId=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id;
  if(!ownerId)return [];
  return (await offers(db,{workspaceId,actorId:ownerId},{test:false})).map(o=>({kind:'Learning',ref:o.action+':'+o.key,link:path}));
}

module.exports={JOB,RUN,DAYS,path,offers,runsOf,ownerLimit:registry.ownerLimit,confirm,dismiss,page,notices};
