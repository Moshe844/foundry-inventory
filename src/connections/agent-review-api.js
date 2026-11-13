'use strict';

const plan=require('../commercial/agent-plan');
const reviews=require('../autopilot/job-reviews');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const jobs=require('../operations/postgres-job-queue');
const kind='agent.api_review';
const eventType='agent.review.completed';
const savedReport='saved-report';

async function check(db,workspaceId){
  await plan.requireWorkspaceJob(db,workspaceId,189,'automatic');
}
async function available(db,workspaceId){
  const state=await plan.accountState(db,workspaceId);
  return plan.usesAgentTerms(state)&&plan.permits(state.plan,189,'automatic');
}
async function issuer(db,ctx){
  await check(db,ctx.workspaceId);
  const result=await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner' FOR SHARE",[ctx.workspaceId,ctx.actorId]);
  if(!result.rowCount)throw new AuthorizationError('Only the business owner can issue a token for Agent reviews.');
}

async function authorize(db,workspaceId,clientId){
  await check(db,workspaceId);
  const {rows:[row]}=await db.query(`SELECT c.created_by_user_id AS owner FROM public_api_clients c
    JOIN users u ON u.id=c.created_by_user_id AND u.workspace_id=c.workspace_id AND u.role='owner'
    WHERE c.workspace_id=$1 AND c.id=$2 AND c.revoked_at IS NULL AND c.scopes::jsonb ? 'agent:run'`,[workspaceId,clientId]);
  if(!row)throw new AuthorizationError('This job needs an active owner-issued API token with the agent:run scope.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,{workspaceId,actorId:row.owner});
  return row.owner;
}

function inputs(body={}){
  if(!body||typeof body!=='object'||Array.isArray(body))throw new ValidationError('Supply a review name and its inputs as an object.');
  const review=body.review===savedReport?{key:savedReport}:reviews.definitions.find(d=>d.key===body.review);
  if(!review)throw new ValidationError('Choose a registered Agent review.');
  const filter=String(body.filter??'').trim(),page=Number(body.page??1);
  if(filter.length>150||!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid review filter and page.');
  if(review.requiresFilter&&!filter)throw new ValidationError('This review requires an exact SKU or record reference.');
  const demandScenario=review.key==='demand-scenario';
  const hasChange=body.change!=null&&String(body.change).trim()!=='';
  if(review.requiresChange&&(!hasChange&&!(demandScenario&&body.supplierDelayDays!=null)||hasChange&&(!Number.isFinite(Number(body.change))||
    Number(body.change)<(review.minChange??-100)||Number(body.change)>(review.maxChange??1000))))throw new ValidationError('Supply the percentage required by this review.');
  const supplierDelayDays=body.supplierDelayDays==null?null:Number(body.supplierDelayDays);
  if(supplierDelayDays!==null&&(review.key!=='demand-scenario'||String(body.supplierDelayDays).trim()===''||
    !Number.isSafeInteger(supplierDelayDays)||supplierDelayDays<-365||supplierDelayDays>365))
    throw new ValidationError('Choose a whole-number supplier lead-time change between -365 and 365 days for the demand scenario.');
  const quarter=body.quarter==null?null:String(body.quarter);
  if(quarter!==null&&(review.key!=='quarterly-supplier-pack'||!/^\d{4}-Q[1-4]$/.test(quarter)))
    throw new ValidationError('Choose a finished quarter as YYYY-Q1 through YYYY-Q4 for the supplier report.');
  const reportId=body.reportId==null?null:String(body.reportId);
  if(review.key===savedReport){
    if(!reportId||!/^report_[A-Za-z0-9_-]{1,150}$/.test(reportId)||filter||hasChange)
      throw new ValidationError('Supply the saved report ID and optional page number.');
    if(page>10001)throw new ValidationError('Choose a saved report page up to 10001.');
  }else if(reportId!==null)throw new ValidationError('A saved report ID is only used with the saved-report job.');
  return {review:review.key,page,filter,...(review.requiresChange&&hasChange?{change:String(body.change)}:{}),
    ...(supplierDelayDays!==null?{supplierDelayDays}:{}),...(quarter!==null?{quarter}:{}),...(reportId?{reportId}:{})};
}

async function start(db,auth,body,key){
  const input=inputs(body);
  await authorize(db,auth.workspaceId,auth.clientId);
  const result=await require('./postgres-public-api').executeCommand(db,auth,{idempotencyKey:key,commandType:kind,body:input},async(c,operationKey)=>{
    const actorId=await authorize(c,auth.workspaceId,auth.clientId);
    let reportRevision;
    if(input.reportId){
      const ctx={workspaceId:auth.workspaceId,actorId};
      const actor=await require('../reports/ask-schedules').actor(c,ctx);
      reportRevision=Number((await require('../reports/postgres-service').load(c,ctx,actor,input.reportId)).revision);
    }
    const transaction={query:c.query.bind(c),transaction:fn=>fn(c)};
    const {job}=await jobs.enqueue(transaction,{workspaceId:auth.workspaceId,kind,idempotencyKey:operationKey,
      payload:{...input,clientId:auth.clientId,...(input.reportId?{reportRevision}:{})},maxAttempts:3});
    return {jobId:job.id,review:input.review};
  });
  return {...result.result,replayed:result.replayed};
}

async function status(db,auth,id){
  await authorize(db,auth.workspaceId,auth.clientId);
  const {rows:[row]}=await db.query(`SELECT id,status,result,payload->>'review' AS review FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND kind=$2 AND id=$3 AND payload->>'clientId'=$4`,[auth.workspaceId,kind,id,auth.clientId]);
  if(!row)throw new NotFoundError('This token has no such review job.');
  return {jobId:row.id,status:row.status,review:row.review,...(row.status==='COMPLETED'?{result:row.result}:{}),
    ...(row.status==='DEAD'?{message:'StockChief could not finish this review. Check the token and current plan.'}:{})};
}

async function execute(job,db){
  const actorId=await authorize(db,job.workspaceId,job.payload.clientId);
  const input=inputs(job.payload),ctx={workspaceId:job.workspaceId,actorId};
  let result;
  if(input.reportId){
    const reports=require('../reports/postgres-service'),actor=await require('../reports/ask-schedules').actor(db,ctx);
    const report=await reports.load(db,ctx,actor,input.reportId);
    if(Number(report.revision)!==job.payload.reportRevision)throw Object.assign(new ValidationError('The saved report changed. Submit a new job for its current version.'),{retryable:false});
    const transaction=typeof db.transaction==='function'?db:{query:db.query.bind(db),transaction:fn=>fn(db)};
    const page=await reports.run(transaction,ctx,actor,report.definition,{limit:101,offset:(input.page-1)*100});
    result={summary:report.title,rows:page.rows,more:page.hasMore};
  }else result=await reviews.run(db,ctx,input.review,
    {filter:input.filter,page:input.page,change:input.change,supplierDelayDays:input.supplierDelayDays,quarter:input.quarter,scheduled:true});
  const completed={review:input.review,summary:result.summary,rows:result.rows,page:input.page,more:result.more===true};
  await db.query('SELECT stockchief_capture_webhook_events($1::jsonb)',[JSON.stringify([{id:'agent-review:'+job.id,workspace_id:job.workspaceId,
    event_type:eventType,created_at:new Date().toISOString(),payload:{jobId:job.id,review:input.review,status:'completed'}}])]);
  return completed;
}

module.exports={start,status,execute,check,available,issuer,eventType,kind};
