'use strict';
// Job 189 (Custom only): your other systems start StockChief agent jobs
// through the API and hear back by signed webhook.
//
// An owner-issued token with the agent:run scope starts a registered job:
// the routine of another agent job (the same work a playbook step runs), the
// van route planner, or one of the owner's playbooks. Each runs through that
// job's own service, with its plan, its job mode and the owner's limits, and
// leaves what it may not finish alone in Needs you. Nothing on the "always
// needs a person" list is done here: asking for it comes back as waiting for
// a person, with what the person does. Pause, Watch only and the first 14
// days hold the job without running it.
//
// A start is idempotent by the client's Idempotency-Key, limited to
// HOURLY_STARTS an hour per token, and audited with the API client as the
// actor. When it finishes, holds or fails, StockChief sends one signed
// webhook (agent.job.completed, agent.job.held or agent.job.failed).
const plan=require('../commercial/agent-plan');
const jobs=require('../operations/postgres-job-queue');
const audit=require('../operations/postgres-security-audit');
const reviewApi=require('./agent-review-api');
const playbooks=require('../autopilot/playbooks');
const {ValidationError,NotFoundError,RateLimitError,DomainError}=require('../domain/errors');

const JOB=189,KIND='agent.api_job',HOURLY_STARTS=30;
const EVENTS=Object.freeze({completed:'agent.job.completed',held:'agent.job.held',failed:'agent.job.failed'});
const eventFor=status=>status==='completed'?EVENTS.completed:status==='failed'?EVENTS.failed:EVENTS.held;
const STARTED='Agent job started by your other system',RUN='Agent job run for your other system';
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});

// The work another system may start. `dbFirst` marks routines called as run(db,job).
const work=new Map();
for(const [key,step] of playbooks.steps)if(step.work)work.set(key,{job:step.job,label:step.label,module:step.module,done:step.done,waiting:step.waiting});
work.set('plan-van-routes',{job:71,label:'Plan delivery routes for your own vans',module:'../shipping/agent-van-route-routine',dbFirst:true,
  payload:{now:true},done:r=>r.published,waiting:r=>r.drafted});
work.set('book-repeat-pallet-pickups',{job:66,label:'Book repeat pallet pickups within your booking rules',module:'../shipping/agent-freight-routine',dbFirst:true,
  done:r=>r.queued,waiting:r=>r.quoted+r.held});
work.set('prepare-export-papers',{job:70,label:'Prepare papers for packed international shipments',module:'../shipping/agent-export-paper-routine',dbFirst:true,
  done:r=>r.prepared,waiting:r=>r.proposed+r.held});
work.set('run-playbook',{job:213,label:'Run one of your playbooks',playbook:true});

// Page 13: always needs a person, on every plan. Asked for here, these come
// back as waiting for a person and StockChief does nothing.
const person=new Map([
  ['pay-supplier','Paying suppliers always needs a person. StockChief prepares the payment; a person sends the money.'],
  ['refund-customer','Giving refunds always needs a person. StockChief prepares the refund; a person sends the money.'],
  ['change-selling-price','Changing selling prices always needs a person.'],
  ['accept-supplier-terms','Accepting a supplier’s new price or terms always needs a person.'],
  ['write-off-stock','Writing off or deleting stock always needs a person.'],
  ['confirm-receipt','Saying goods arrived always needs a person. Someone confirms every receipt.'],
  ['cancel-customer-order','Cancelling a customer order always needs a person.'],
  ['raise-credit-limit','Raising a credit limit always needs a person.'],
  ['close-month','Closing a month in your books always needs a person.'],
  ['raise-agent-limits','Only the owner can give StockChief more power, raise limits or turn off the circuit-breaker.']
]);

function inputs(body={}){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new ValidationError('Supply a job name and its inputs as an object.');
  const key=String(body.job??'').trim();
  if(!work.has(key)&&!person.has(key))throw new ValidationError('Choose a registered agent job.');
  if(work.get(key)?.playbook){
    const id=String(body.playbook??'').trim();
    if(!id||id.length>120)throw new ValidationError('Name the playbook to run by its ID.');
    return {job:key,playbook:id};
  }
  return {job:key};
}

async function clientName(db,auth){
  return (await db.query('SELECT name FROM public_api_clients WHERE workspace_id=$1 AND id=$2',[auth.workspaceId,auth.clientId])).rows[0]?.name||null;
}

// Every start by one token counts, reviews included: at most HOURLY_STARTS an hour.
async function limit(c,auth){
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['api-agent-starts:'+auth.clientId]);
  const {rows:[row]}=await c.query(`SELECT count(*)::int AS n FROM public_api_commands WHERE client_id=$1 AND command_type=ANY($2::text[])
    AND created_at::timestamptz>now()-interval '1 hour'`,[auth.clientId,[KIND,reviewApi.kind]]);
  if(row.n>=HOURLY_STARTS)throw new RateLimitError('This token started '+HOURLY_STARTS+' agent jobs in the last hour. Wait before starting another.');
}

async function start(db,auth,body,key){
  const input=inputs(body),def=work.get(input.job);
  await reviewApi.authorize(db,auth.workspaceId,auth.clientId);
  // The job itself must be on the plan; its own routine decides what it may do alone.
  if(def){
    const state=await plan.accountState(db,auth.workspaceId);
    plan.requireJob(plan.usesAgentTerms(state)?state.plan:null,def.job,'draft');
    if(def.playbook&&!(await db.query('SELECT 1 FROM stockchief_runtime.agent_playbooks WHERE workspace_id=$1 AND id=$2',[auth.workspaceId,input.playbook])).rowCount)
      throw new NotFoundError('This inventory has no such playbook.');
  }
  const result=await require('./postgres-public-api').executeCommand(db,auth,{idempotencyKey:key,commandType:KIND,body:input},async(c,operationKey)=>{
    await reviewApi.authorize(c,auth.workspaceId,auth.clientId);
    await limit(c,auth);
    const {job}=await jobs.enqueue(scoped(c),{workspaceId:auth.workspaceId,kind:KIND,idempotencyKey:operationKey,
      payload:{...input,clientId:auth.clientId},maxAttempts:3});
    await audit.record(c,{workspaceId:auth.workspaceId,actorId:auth.clientId},{action:STARTED,reference:job.id,
      after:{work:def?.label||input.job,system:await clientName(c,auth)}});
    return {jobId:job.id,job:input.job,status:'queued'};
  });
  return {...result.result,replayed:result.replayed};
}

// Why StockChief holds the job now instead of running it.
async function held(db,workspaceId,def){
  const account=await plan.accountState(db,workspaceId);
  if(account.shadow)return plan.SHADOW_REASON;
  const config=(await db.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(config?.mode==='OBSERVE')return 'StockChief is in watch-only mode, so it changes nothing.';
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(state.paused||state.suspended)return 'Automatic work is paused.';
  return require('../autopilot/job-modes').restriction(db,workspaceId,def.job,false);
}

const count=value=>Number.isFinite(Number(value))?Number(value):0;
async function runRoutine(db,ctx,def){
  const routine=require(def.module);
  const call={workspaceId:ctx.workspaceId,kind:routine.kind||routine.KIND,payload:{requestedBy:ctx.actorId,api:true,...(def.payload||{})}};
  const raw=def.dbFirst?await routine.run(db,call):await routine.run(call,db);
  if(!raw||raw.skipped){
    const why=typeof raw?.skipped==='string'&&!['plan','owner','not_installed'].includes(raw.skipped)?raw.skipped:null;
    return why?{status:'held',reason:why,done:0,waiting:0,link:routine.path||null}
      :{status:'failed',reason:'This job is not available to this inventory right now.',done:0,waiting:0,link:routine.path||null};
  }
  const counts=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,count(v)]));
  const done=count(def.done(counts)),waiting=count(def.waiting(counts));
  return {status:waiting?'waiting_for_person':'completed',done,waiting,link:routine.path||null,
    reason:waiting?(waiting===1?'One item waits':waiting+' items wait')+' for a person in Needs you.':null};
}

async function runPlaybook(db,ctx,job){
  const requestKey='api:'+job.id;
  const result=await playbooks.run(db,ctx,job.payload.playbook,requestKey,{scheduled:true});
  const row=(await db.query(`SELECT status,reason,result FROM stockchief_runtime.agent_playbook_runs WHERE workspace_id=$1 AND playbook_id=$2 AND request_key=$3`,
    [ctx.workspaceId,job.payload.playbook,requestKey])).rows[0];
  const steps=(row?.result||[]).length;
  if(row?.status==='DONE')return {status:'completed',done:steps,waiting:0,link:playbooks.path,reason:null};
  return {status:'waiting_for_person',done:steps,waiting:1,link:playbooks.path,
    reason:row?.reason||result?.reason||'The playbook stopped and waits for you.'};
}

// Record what happened once: the audit entry with the API client as the
// actor, and the signed webhook.
async function finish(db,job,outcome){
  const key=job.payload.job,label=work.get(key)?.label||key;
  const body={jobId:job.id,job:key,status:outcome.status,done:outcome.done||0,waiting:outcome.waiting||0,reason:outcome.reason||null,link:outcome.link||null};
  await db.transaction(async c=>{
    const ctx={workspaceId:job.workspaceId,actorId:job.payload.clientId};
    if(!(await c.query('SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND reference=$3',[job.workspaceId,RUN,job.id])).rowCount)
      await audit.record(c,ctx,{action:RUN,reference:job.id,after:{work:label,status:{completed:'Done',waiting_for_person:'Waiting for a person',held:'Held',failed:'Failed'}[outcome.status],
        done:body.done,waiting:body.waiting,reason:body.reason,system:await clientName(c,{workspaceId:job.workspaceId,clientId:job.payload.clientId})}});
    await c.query('SELECT stockchief_capture_webhook_events($1::jsonb)',[JSON.stringify([{id:'agent-job:'+job.id,workspace_id:job.workspaceId,
      event_type:eventFor(outcome.status),created_at:new Date().toISOString(),payload:body}])]);
  },{isolation:'READ COMMITTED'});
  return body;
}

async function execute(job,db){
  const def=work.get(job.payload?.job),needsPerson=person.get(job.payload?.job);
  let owner;
  try{owner=await reviewApi.authorize(db,job.workspaceId,job.payload.clientId);}
  catch(error){
    // A plan change pauses the job until the plan allows it again.
    if(error.code==='entitlement_required'||!(error instanceof DomainError))throw error;
    return finish(db,job,{status:'failed',reason:error.message});
  }
  if(needsPerson)return finish(db,job,{status:'waiting_for_person',reason:needsPerson,done:0,waiting:0});
  if(!def)return finish(db,job,{status:'failed',reason:'This job is no longer registered.'});
  const ctx={workspaceId:job.workspaceId,actorId:owner};
  const hold=await held(db,job.workspaceId,def);
  if(hold)return finish(db,job,{status:'held',reason:hold,done:0,waiting:0});
  let outcome;
  try{outcome=def.playbook?await runPlaybook(db,ctx,job):await runRoutine(db,ctx,def);}
  catch(error){
    if(error.code==='entitlement_required')throw error;
    if(error instanceof DomainError&&error.status<500)return finish(db,job,{status:'failed',reason:error.message});
    if(Number(job.attemptCount)>=Number(job.maxAttempts))
      await finish(db,job,{status:'failed',reason:'StockChief could not finish this job. Start it again later.'});
    throw error;
  }
  return finish(db,job,outcome);
}

const phase={PENDING:'queued',RETRY:'queued',RUNNING:'running',PAUSED:'paused',CANCELLED:'failed',DEAD:'failed'};
// The status of a review or job this token started.
async function status(db,auth,id){
  await reviewApi.authorize(db,auth.workspaceId,auth.clientId);
  const {rows:[row]}=await db.query(`SELECT id,kind,status,result,payload FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND kind=ANY($2::text[]) AND id=$3 AND payload->>'clientId'=$4`,[auth.workspaceId,[reviewApi.kind,KIND],id,auth.clientId]);
  if(!row)throw new NotFoundError('This token has no such agent job.');
  if(row.kind===reviewApi.kind)return reviewApi.status(db,auth,id);
  if(row.status==='COMPLETED')return {...row.result,jobId:row.id};
  return {jobId:row.id,job:row.payload.job,status:phase[row.status]||'queued',
    ...(row.status==='PAUSED'?{reason:'Your plan does not include this job now.'}:{}),
    ...(row.status==='DEAD'?{reason:'StockChief could not finish this job. Start it again later.'}:{})};
}

module.exports={JOB,KIND,EVENTS,HOURLY_STARTS,STARTED,RUN,work,person,inputs,start,execute,status,limit};
