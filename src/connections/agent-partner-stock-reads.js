'use strict';
const {ValidationError}=require('../domain/errors'),plans=require('../commercial/agent-plan');

async function setting(db,ctx){
 await require('../autopilot/job-reviews').ownerState(db,ctx);
 await plans.requireWorkspaceJob(db,ctx.workspaceId,123,'automatic');
 const row=(await db.query('SELECT * FROM stockchief_runtime.agent_partner_stock_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 const connector=(await db.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND connector_key='agent-shipbob-sandbox' AND status='connected' AND paused_at IS NULL",[ctx.workspaceId])).rows[0];
 return {enabled:row?.enabled===true,revision:row?.revision||0,connected:Boolean(connector),lastIssue:row?.last_issue||null};
}
async function configure(db,ctx,input){
 return db.transaction(async c=>{
  await require('../autopilot/job-reviews').ownerState(c,ctx);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['partner-stock-setting:'+ctx.workspaceId]);
  const row=(await c.query('SELECT * FROM stockchief_runtime.agent_partner_stock_settings WHERE workspace_id=$1 FOR UPDATE',[ctx.workspaceId])).rows[0];
  if(input.revision==null||!Number.isSafeInteger(Number(input.revision))||Number(input.revision)!==(row?.revision||0))throw new ValidationError('The stock reading setting changed. Open its current settings.');
  if(input.stop==='1'){
   if(row)await c.query('UPDATE stockchief_runtime.agent_partner_stock_settings SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1',[ctx.workspaceId]);
   return;
  }
  await plans.requireWorkspaceJob(c,ctx.workspaceId,123,'automatic');
  const connector=(await c.query("SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND connector_key='agent-shipbob-sandbox' AND status='connected' AND paused_at IS NULL",[ctx.workspaceId])).rows[0];
  if(!connector)throw new ValidationError('Connect the ShipBob sandbox and save each exact product mapping first.');
  await c.query(`INSERT INTO stockchief_runtime.agent_partner_stock_settings(workspace_id,actor_id,connector_id,enabled) VALUES($1,$2,$3,true)
   ON CONFLICT(workspace_id) DO UPDATE SET actor_id=$2,connector_id=$3,enabled=true,revision=agent_partner_stock_settings.revision+1,updated_at=now(),retry_after=now(),last_issue=NULL,last_issue_sku=NULL`,[ctx.workspaceId,ctx.actorId,connector.id]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Enabled hourly partner stock readings',reference:'ShipBob sandbox'});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function authorize(db,job){
 const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
 await require('../autopilot/job-reviews').ownerState(db,ctx);
 await plans.requireWorkspaceJob(db,ctx.workspaceId,123,'automatic');
 const [row]=(await db.query(`SELECT s.code,b.observed_at FROM stockchief_runtime.agent_partner_stock_settings a
  JOIN workspaces w ON w.id=a.workspace_id AND w.deletion_requested_at IS NULL
  JOIN workspace_connectors c ON c.workspace_id=a.workspace_id AND c.id=a.connector_id AND c.status='connected' AND c.paused_at IS NULL
  JOIN stockchief_runtime.shipbob_sandbox_stock b ON b.workspace_id=a.workspace_id AND b.connector_id=c.id
  JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id AND s.is_active=1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  JOIN users u ON u.workspace_id=a.workspace_id AND u.id=a.actor_id AND u.role='owner'
  JOIN accounts account ON account.id=u.account_id LEFT JOIN platform_account_access x ON x.account_id=account.id
  LEFT JOIN platform_account_access billing_access ON billing_access.account_id=w.owner_account_id
  LEFT JOIN workspace_autopilot autopilot ON autopilot.workspace_id=a.workspace_id
  WHERE a.workspace_id=$1 AND a.actor_id=$2 AND a.revision=$3 AND a.enabled AND c.id=$4 AND c.updated_at=$5
   AND b.sku_id=$6 AND b.inventory_id=$7 AND x.disabled_at IS NULL AND billing_access.disabled_at IS NULL AND coalesce(autopilot.paused,0)=0 AND coalesce(autopilot.suspended,0)=0`,
 [ctx.workspaceId,ctx.actorId,job.payload.revision,job.payload.connectorId,job.payload.connectorVersion,job.payload.skuId,job.payload.inventoryId])).rows;
 if(!row)throw new ValidationError('The owner, product mapping, connection or hourly stock reading setting changed, or automatic work is paused.');
 const restriction=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,123,true);
 if(restriction)throw new ValidationError(restriction);
 return {ctx,sku:row.code,observedAt:row.observed_at};
}
async function schedule(c){
 // Work only from explicitly saved partner mappings. No catalogue-wide probes.
 const rows=(await c.query(`SELECT a.workspace_id,a.actor_id,a.revision,c.id connector_id,c.updated_at connector_version,b.sku_id,b.inventory_id,b.observed_at,
  'partner-stock:'||a.revision||':'||b.sku_id||':'||c.updated_at||':'||floor(extract(epoch FROM now())/3600)::text request_key
  FROM stockchief_runtime.agent_partner_stock_settings a JOIN workspace_connectors c ON c.workspace_id=a.workspace_id AND c.id=a.connector_id AND c.status='connected' AND c.paused_at IS NULL
  JOIN stockchief_runtime.shipbob_sandbox_stock b ON b.workspace_id=a.workspace_id AND b.connector_id=c.id
  WHERE a.enabled AND a.retry_after<=now() AND b.observed_at<=now()-interval '1 hour'
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=a.workspace_id AND j.kind='shipbob.sandbox-stock'
    AND j.idempotency_key='partner-stock:'||a.revision||':'||b.sku_id||':'||c.updated_at||':'||floor(extract(epoch FROM now())/3600)::text)
  ORDER BY b.observed_at,a.workspace_id,b.sku_id LIMIT 50`)).rows;
 let queued=0;const held=new Set();
 for(const row of rows){
  if(held.has(row.workspace_id))continue;
  const job={workspaceId:row.workspace_id,payload:{actorId:row.actor_id,revision:row.revision,connectorId:row.connector_id,connectorVersion:row.connector_version,skuId:row.sku_id,inventoryId:row.inventory_id,observedAt:row.observed_at}};
  try{await authorize(c,job);}catch(error){if([400,402,403,404].includes(error.status)){
   await c.query("UPDATE stockchief_runtime.agent_partner_stock_settings SET retry_after=now()+interval '15 minutes',last_issue=$3,last_issue_sku=NULL WHERE workspace_id=$1 AND revision=$2",[row.workspace_id,row.revision,error.message]);held.add(row.workspace_id);continue;
  }throw error;}
  const saved=await require('../operations/postgres-job-queue').enqueue({query:c.query.bind(c),transaction:fn=>fn(c)},{...job,kind:'shipbob.sandbox-stock',idempotencyKey:row.request_key,maxAttempts:3});if(saved.created)queued++;
 }
 return {queued};
}
async function run(db,job,transport){
 const {ctx,sku,observedAt}=await authorize(db,job);
 const queuedAt=Date.parse(job.payload.observedAt);
 if(!Number.isFinite(queuedAt))throw new ValidationError('This stock reading job needs its original saved observation.');
 if(new Date(observedAt).getTime()>queuedAt)return {refreshed:false,alreadyFresh:true,sku};
 await require('./postgres-shipbob-sandbox').stock(db,ctx,{sku,inventoryId:job.payload.inventoryId},transport,c=>authorize(c,job));
 await db.query('UPDATE stockchief_runtime.agent_partner_stock_settings SET last_issue=NULL,last_issue_sku=NULL WHERE workspace_id=$1 AND revision=$2 AND (last_issue_sku IS NULL OR last_issue_sku=$3)',[ctx.workspaceId,job.payload.revision,job.payload.skuId]);
 return {refreshed:true,sku};
}
async function noteIssue(db,job,error){
 await db.query(`UPDATE stockchief_runtime.agent_partner_stock_settings a SET last_issue='Check stock reading for '||s.code||': '||$6,last_issue_sku=s.id
  FROM skus s WHERE a.workspace_id=$1 AND a.revision=$2 AND a.actor_id=$3 AND a.connector_id=$4 AND s.workspace_id=a.workspace_id AND s.id=$5`,
 [job.workspaceId,job.payload.revision,job.payload.actorId,job.payload.connectorId,job.payload.skuId,error.retryable?'The partner did not confirm a reading. StockChief will retry; the saved reading is unchanged.':error.message]);
}
module.exports={setting,configure,schedule,run,noteIssue};
