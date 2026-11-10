'use strict';

const policy=require('../commercial/agent-plan');
const {AuthorizationError,ValidationError}=require('../domain/errors');

const jobId=182;
const kind='provider.commerce-recovery.v1';
const action='channel_sync.recover';
const checks='stockchief_runtime.agent_channel_recovery_checks';
const scopeSql=`
  SELECT p.id,p.connector_id FROM connection_commerce_positions p
  JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
  WHERE p.workspace_id=$1 AND p.id=$2 AND p.pending_effect_id=$3 AND p.revision=$4
    AND p.provider_account_id=$5 AND c.provider_account_id=$5 AND c.provider_type IN ('shopify','woocommerce')
    AND c.status='connected' AND c.paused_at IS NULL AND c.config::jsonb->>'syncDisabled' IS DISTINCT FROM 'true'
    AND p.mode IN ('outbound','two_way') AND p.external_id=$6 AND p.external_location_id=$7
    AND p.parent_external_id IS NOT DISTINCT FROM $8 AND p.field=$9
    AND EXISTS(SELECT 1 FROM connection_mappings m WHERE m.workspace_id=p.workspace_id AND m.connector_id=p.connector_id
      AND m.entity_type='sku' AND m.external_id=p.external_id AND m.foundry_record_id=p.sku_id)
    AND EXISTS(SELECT 1 FROM connection_mappings m WHERE m.workspace_id=p.workspace_id AND m.connector_id=p.connector_id
      AND m.entity_type='location' AND m.external_id=p.external_location_id AND m.foundry_record_id=p.location_id)`;

async function owner(db,ctx){
  const current=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,
  [ctx.workspaceId,ctx.actorId])).rowCount;
  if(!current)throw new AuthorizationError('Only the current owner can authorize this channel recovery.');
}

async function grant(db,workspaceId,{lock=false}={}){
  return (await db.query(`SELECT m.updated_by AS actor_id,m.revision FROM stockchief_runtime.agent_job_modes m
    JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
    JOIN workspaces w ON w.id=m.workspace_id AND w.owner_account_id=u.account_id AND w.deletion_requested_at IS NULL
    JOIN workspace_autopilot a ON a.workspace_id=m.workspace_id
    JOIN account_subscriptions s ON s.account_id=w.owner_account_id
    WHERE m.workspace_id=$1 AND m.job_id=$2 AND m.mode='routine'
      AND NOT EXISTS(SELECT 1 FROM platform_account_access p WHERE p.account_id=w.owner_account_id AND p.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF m,u,w,a,s':''}`,[workspaceId,jobId])).rows[0];
}

async function authorized(db,workspaceId,expected,{lock=false}={}){
  const current=await grant(db,workspaceId,{lock});
  if(!current||current.actor_id!==expected.actorId||current.revision!==expected.revision)
    throw new ValidationError('The owner’s channel recovery setting changed.');
  const account=await policy.requireWorkspaceJob(db,workspaceId,jobId,'automatic');
  const stopped=await policy.stopped(db,workspaceId,account,action,true);
  if(stopped)throw new ValidationError(stopped);
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    throw new ValidationError('Routine work is paused for this inventory.');
}

async function scope(db,workspaceId,e,{lock=false}={}){
  const p=e?.payload;
  if(!p||e.kind!=='commerce.position.publish'||e.providerReference?.externalId!==p.externalId)
    throw new ValidationError('The original provider delivery does not have a verified channel identity.');
  const active=(await db.query(scopeSql+(lock?' FOR SHARE OF p,c':''),[workspaceId,p.positionId,e.id,p.revision,
    p.providerAccountId,p.externalId,p.externalLocationId,p.parentExternalId||null,p.field])).rowCount;
  if(!active)throw new ValidationError('The original channel account, product or location changed. Review it before further work.');
}

async function schedule(db,workspaceId){
  const permission=await grant(db,workspaceId);
  if(!permission)return {queued:0};
  const payload={actorId:permission.actor_id,revision:permission.revision};
  try{await authorized(db,workspaceId,payload);}
  catch(e){if(['validation_error','entitlement_required','forbidden'].includes(e.code))return {queued:0};throw e;}
  return db.transaction(async tx=>{
    const due=(await tx.query(`SELECT e.id FROM stockchief_runtime.provider_effects e
      JOIN connection_commerce_positions p ON p.workspace_id=e.workspace_id AND p.id=e.payload->>'positionId' AND p.pending_effect_id=e.id
      JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
      LEFT JOIN ${checks} old ON old.workspace_id=e.workspace_id AND old.effect_id=e.id
      WHERE e.workspace_id=$1 AND e.kind='commerce.position.publish' AND e.status='AMBIGUOUS'
        AND e.updated_at<=clock_timestamp()-interval '15 minutes' AND e.provider_reference->>'externalId'=e.payload->>'externalId'
        AND c.provider_type IN ('shopify','woocommerce') AND c.status='connected' AND c.paused_at IS NULL
        AND (old.effect_id IS NULL OR old.attempt<3 AND old.queued_at<=clock_timestamp()-interval '6 hours')
        AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.workspace_id=e.workspace_id
          AND j.kind IN ('provider.commerce-verify',$2) AND j.payload->>'effectId'=e.id AND j.status IN ('PENDING','RUNNING','RETRY'))
      ORDER BY e.updated_at,e.id LIMIT 10 FOR UPDATE OF e SKIP LOCKED`,[workspaceId,kind])).rows;
    const jobs=require('../operations/postgres-job-queue'),scoped={query:(...args)=>tx.query(...args),transaction:fn=>fn(tx)};
    for(const row of due){
      const attempt=(await tx.query(`INSERT INTO ${checks} AS prior(workspace_id,effect_id,attempt) VALUES($1,$2,1)
        ON CONFLICT(workspace_id,effect_id) DO UPDATE SET attempt=prior.attempt+1,queued_at=clock_timestamp(),
          checked_at=NULL,outcome='QUEUED' RETURNING attempt`,[workspaceId,row.id])).rows[0].attempt;
      await jobs.enqueue(scoped,{workspaceId,kind,idempotencyKey:row.id+':'+attempt,
        payload:{...payload,effectId:row.id,attempt},maxAttempts:1,priority:35});
    }
    return {queued:due.length};
  },{isolation:'READ COMMITTED'});
}

async function run(db,job,{providers}={}){
  const {workspaceId,payload}=job;
  let result='HELD',unexpected;
  try{
    await authorized(db,workspaceId,payload);
    const effect=await require('../operations/postgres-provider-effects').get(db,workspaceId,payload.effectId);
    if(effect?.status==='SUCCEEDED')result='VERIFIED';
    else{
      await scope(db,workspaceId,effect);
      await require('./postgres-commerce-sync').verifyDelivery(db,workspaceId,payload.effectId,{providers,
        guard:async(client,current,{lock=false}={})=>{
          await authorized(client,workspaceId,payload,{lock});
          await scope(client,workspaceId,current,{lock});
        }});
      result='VERIFIED';
    }
  }catch(e){if(![400,401,402,403,404,409,422,429,500,502,503,504].includes(e.status))unexpected=e;}
  await db.query(`UPDATE ${checks} SET outcome=$4,checked_at=clock_timestamp() WHERE workspace_id=$1 AND effect_id=$2 AND attempt=$3`,
  [workspaceId,payload.effectId,payload.attempt,result]);
  if(unexpected)throw unexpected;
  return {verified:result==='VERIFIED'};
}

async function readPage(db,ctx,{filter='',page=1}={}){
  await owner(db,ctx);
  await policy.requireWorkspaceJob(db,ctx.workspaceId,jobId,'suggest');
  const rows=(await db.query(`SELECT c.display_name AS "Channel",p.field AS "Field",
    CASE WHEN e.status='SUCCEEDED' THEN 'Provider confirmed' WHEN r.outcome='QUEUED' THEN 'Waiting for readback'
      WHEN e.status='AMBIGUOUS' THEN 'Compare with provider' ELSE 'Needs review' END AS "Review",
    r.attempt AS "Recovery checks",r.checked_at AS "Last check",'/settings/connections/'||c.id AS link
    FROM stockchief_runtime.provider_effects e
    JOIN connection_commerce_positions p ON p.workspace_id=e.workspace_id AND p.id=e.payload->>'positionId'
    JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
    LEFT JOIN ${checks} r ON r.workspace_id=e.workspace_id AND r.effect_id=e.id
    WHERE e.workspace_id=$1 AND e.kind='commerce.position.publish' AND c.provider_type IN ('shopify','woocommerce')
      AND (e.status='AMBIGUOUS' OR r.effect_id IS NOT NULL) AND ($2='' OR lower(c.display_name)=lower($2))
    ORDER BY e.updated_at DESC,e.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
  return {rows:rows.slice(0,100),more:rows.length>100,summary:'Shows retained Shopify and WooCommerce stock and price updates. Growth and above can check the exact provider value after you enable routine work for this job. A verification never repeats the earlier publish.'};
}

module.exports={action,kind,schedule,run,definition:{id:jobId,key:'channel-sync-recovery',label:'Review and recover channel sync',filterLabel:'Channel name',readPage}};
