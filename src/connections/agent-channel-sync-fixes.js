'use strict';

// Job 182: watches each sales channel's sync and fixes the common errors.
// Starter suggests the fix; Growth, Pro and Custom fix on their own.
//
// The connected channels are Shopify, WooCommerce, BigCommerce, Square and
// Clover. StockChief has no Amazon or eBay connection, so there is nothing to
// watch or fix there. What it watches, and how each problem is fixed:
//  - Sign-in. A sign-in that renews (Shopify app credentials, Square, Clover)
//    is renewed before it runs out. A refused sign-in needs the owner: Needs
//    you asks them to reconnect (job 169's alert and the connection's issue).
//    WooCommerce and BigCommerce keys do not run out; a refused key also needs
//    the owner.
//  - Rate limits. A channel that asks StockChief to wait is checked again after
//    the wait on its own. A stock update that ran out of tries while waiting is
//    tried again after 15 minutes, then 30, then 60, at most three times.
//  - Missing product matches. A channel product with no StockChief match is
//    matched when exactly one active product has the same SKU code, or else the
//    same barcode. Channel orders held for it then go through. Undo removes the
//    match; orders already taken in stay.
//  - A stock update that failed for certain (nothing reached the channel) is
//    sent again with the current stock, while the channel still shows the
//    count StockChief last verified. At most three times.
//  - A lost order webhook is registered again (Shopify, WooCommerce,
//    BigCommerce and Square). Clover sends orders to the address set in
//    StockChief's Clover app, so a person fixes that.
//  - An update the channel may or may not have taken is read back from the
//    channel (agent-channel-recovery.js) and never sent twice.
// Anything else, a fix that keeps failing, or facts that do not match wait for
// a person. Automatic fixes respect the plan, pause, watch mode, the first 14
// days, the job's Watch only and Ask me first, and the saved-rule allowance.
// With Ask me first, or when routine work is off, the owner approves each fix
// on the page. Every fix is audited.

const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');

const JOB=182,ACTION='channel_sync.recover',KIND='channel.sync-fixes.v1',key='channel-sync-fixes',path='/autopilot/reviews/'+key;
const CHANNELS=['shopify','woocommerce','bigcommerce','square','clover'];
const NAMES={shopify:'Shopify',woocommerce:'WooCommerce',bigcommerce:'BigCommerce',square:'Square',clover:'Clover'};
const TRIES=3,PER_RUN=20,LIMIT_ROWS=500,RETRIER='channel-sync-fixes';
const ACTIONS={fixed:'StockChief fixed a channel sync problem',approved:'Channel sync fix approved',failed:'A channel sync fix did not work',undone:'Channel product match undone'};
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const scoped=c=>({query:(s,v)=>c.query(s,v),transaction:fn=>fn(c)});
const expected=e=>e instanceof DomainError||[400,401,402,403,404,409,422,429,503].includes(Number(e?.status));
const parse=v=>{if(v&&typeof v==='object')return v;try{return JSON.parse(v)||{};}catch{return {};}};
const at=v=>{if(v==null||v==='')return NaN;if(v instanceof Date)return v.getTime();const n=Number(v);return Number.isFinite(n)?n:Date.parse(String(v));};
const sentence=v=>String(v||'').trim().replace(/[.\s]+$/,'')+'.';
const clock=ms=>Number.isFinite(ms)?new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC':null;
// Before the next try: none for the first, then 15, 30 and 60 minutes.
const pause=tries=>tries<1?0:15*60000*2**(tries-1);

async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
async function owner(db,ctx){
  if(!(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rowCount)
    throw new AuthorizationError('Only the inventory owner can fix channel sync.');
}
// Why automatic fixes wait right now, or null.
async function automaticStop(db,workspaceId,state){
  const stop=await policy.stopped(db,workspaceId,state,ACTION,true);if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return 'Routine work is off for this inventory, so each fix waits for your approval.';
  return null;
}

// Failed fixes in the last day, by problem, and undone matches.
async function history(db,workspaceId,keys){
  const out=new Map();if(!keys.length)return out;
  for(const r of (await db.query(`SELECT reference,action,count(*)::int AS n,max(created_at) AS last FROM security_event_history
    WHERE workspace_id=$1 AND reference=ANY($2::text[]) AND (action=$3 AND created_at>now()-interval '1 day' OR action=$4)
    GROUP BY reference,action`,[workspaceId,keys,ACTIONS.failed,ACTIONS.undone])).rows){
    const h=out.get(r.reference)||{failed:0,last:null,undone:false};
    if(r.action===ACTIONS.undone)h.undone=true;else{h.failed=r.n;h.last=r.last;}
    out.set(r.reference,h);
  }
  return out;
}

// Every channel sync problem StockChief can see now, with its fix or why a person is needed.
async function problems(db,workspaceId,options={}){
  const registry=options.providers||require('./providers/registry'),now=Date.now(),list=[];
  const origin=options.publicOrigin===undefined?require('../config').connections.publicOrigin:options.publicOrigin;
  const add=p=>list.push({fixable:false,waits:null,due:true,data:{},...p});
  const channels=(await db.query(`SELECT c.*,cred.expires_at AS sign_in_expires,
      (SELECT i.detail FROM connection_issues i WHERE i.workspace_id=c.workspace_id AND i.connector_id=c.id AND i.issue_type='PUSH_SETUP_FAILED' AND i.status='OPEN' LIMIT 1) AS events_issue,
      EXISTS(SELECT 1 FROM connection_issues i WHERE i.workspace_id=c.workspace_id AND i.connector_id=c.id AND i.issue_type='PUSH_SETUP_FAILED' AND i.status='OPEN') AS events_stopped
    FROM workspace_connectors c LEFT JOIN connection_credentials cred ON cred.workspace_id=c.workspace_id AND cred.connector_id=c.id AND cred.credential_kind='provider'
    WHERE c.workspace_id=$1 AND c.provider_type=ANY($2::text[]) AND c.setup_status IS DISTINCT FROM 'DUPLICATE_CONNECTION' ORDER BY c.display_name,c.id`,[workspaceId,CHANNELS])).rows;
  for(const c of channels){
    const adapter=registry.get(c.provider_type),config=parse(c.config),active=c.status==='connected'&&!c.paused_at&&config.syncDisabled!==true;
    const base={connectorId:c.id,channel:c.display_name,provider:c.provider_type,link:'/settings/connections/'+c.id};
    if(c.setup_status==='REAUTHORIZATION_REQUIRED'){
      add({...base,kind:'reconnect',key:'reconnect:'+c.id,problem:NAMES[c.provider_type]+' refused StockChief’s sign-in',
        fix:'Sign in to '+NAMES[c.provider_type]+' again on the connection page. StockChief cannot sign in for you.',waits:'Needs you to sign in again.'});
      continue;
    }
    if(!active)continue;
    const expires=at(c.sign_in_expires);
    if(adapter?.refreshCredentials&&Number.isFinite(expires)&&expires<now+3600000)
      add({...base,kind:'sign-in',key:'sign-in:'+c.id+':'+new Date(expires).toISOString(),problem:'The sign-in runs out '+(expires<now?'now':'at '+clock(expires)),
        fix:'Renews the sign-in with '+NAMES[c.provider_type]+'.',fixable:true,data:{expires}});
    const retryAt=at(config.syncRetryAt);
    if(Number.isFinite(retryAt)&&retryAt>now)add({...base,kind:'wait',key:'wait:'+c.id,problem:NAMES[c.provider_type]+' asked StockChief to wait',
      fix:'Checks the channel again at '+clock(retryAt)+', on its own.',fixable:false,retries:true});
    if(c.events_stopped){
      const problem='New orders stopped arriving: '+(c.events_issue||'the order webhook is missing');
      if(!adapter?.registerWebhooks)add({...base,kind:'webhook',key:'webhook:'+c.id,problem,
        fix:NAMES[c.provider_type]+' sends orders to the web address set in StockChief’s '+NAMES[c.provider_type]+' app. Ask StockChief support to check it.',waits:'Needs a person.'});
      else if(!origin||!/^https:\/\//.test(origin)&&process.env.NODE_ENV!=='test')add({...base,kind:'webhook',key:'webhook:'+c.id,problem,
        fix:'StockChief’s public web address is not set, so the order webhook cannot be registered. Ask StockChief support.',waits:'Needs a person.'});
      else add({...base,kind:'webhook',key:'webhook:'+c.id,problem,fix:'Registers the order webhook with '+NAMES[c.provider_type]+' again.',fixable:true});
    }
  }
  // Stock updates that failed, ran out of tries while the channel asked to wait, or were not confirmed.
  const pushes=(await db.query(`SELECT p.id AS position_id,p.connector_id,c.display_name,c.provider_type,s.code,l.name AS location,
      e.id AS effect_id,e.status,e.error_code,e.error_message,e.payload,e.completed_at,e.updated_at,
      j.id AS job_id,j.status AS job_status,j.completed_at AS job_completed,
      (SELECT count(*)::int FROM stockchief_runtime.job_events v WHERE v.job_id=j.id AND v.event_type='MANUAL_RETRY' AND v.detail->>'by'=$3) AS retries,
      r.attempt AS checks,r.outcome AS check_outcome
    FROM connection_commerce_positions p JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=p.workspace_id AND e.id=p.pending_effect_id
    JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
    LEFT JOIN LATERAL (SELECT id,status,completed_at FROM stockchief_runtime.jobs WHERE workspace_id=e.workspace_id AND payload->>'effectId'=e.id
      ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
    LEFT JOIN stockchief_runtime.agent_channel_recovery_checks r ON r.workspace_id=e.workspace_id AND r.effect_id=e.id
    WHERE p.workspace_id=$1 AND p.field='quantity' AND c.provider_type=ANY($2::text[]) AND e.status IN ('FAILED','PENDING','AMBIGUOUS')
    ORDER BY c.display_name,s.code,l.name LIMIT ${LIMIT_ROWS}`,[workspaceId,CHANNELS,RETRIER])).rows;
  for(const e of pushes){
    const c=channels.find(x=>x.id===e.connector_id),active=c&&c.status==='connected'&&!c.paused_at&&parse(c.config).syncDisabled!==true&&c.setup_status!=='REAUTHORIZATION_REQUIRED';
    const base={connectorId:e.connector_id,channel:e.display_name,provider:e.provider_type,link:'/settings/connections/'+e.connector_id,subject:e.code+' at '+e.location};
    if(e.status==='FAILED'){
      const attempt=Number(parse(e.payload).resend?.attempt||0)+1,problem='The stock update for '+base.subject+' failed: '+(e.error_message||'the channel refused it');
      if(attempt>TRIES)add({...base,kind:'resend',key:'resend:'+e.effect_id,problem,fix:'Stock was sent '+TRIES+' times and failed. Check the product on the channel, then save its stock sync again.',waits:'Needs you to check the channel.'});
      else if(!active)add({...base,kind:'resend',key:'resend:'+e.effect_id,problem,fix:'Sends the stock again once the channel is connected and syncing.',waits:'Reconnect or resume the channel first.'});
      else add({...base,kind:'resend',key:'resend:'+e.effect_id,problem,fix:'Sends the current stock again, if the channel still shows the count StockChief last checked.',fixable:true,
        due:at(e.completed_at)+pause(attempt-1)<=now,data:{effectId:e.effect_id,attempt},retryAt:at(e.completed_at)+pause(attempt-1)});
    }else if(e.status==='PENDING'&&e.job_status==='DEAD'&&e.error_code!=='entitlement_required'){
      const problem='The stock update for '+base.subject+' ran out of tries'+(e.error_code==='provider_rate_limited'?' while '+NAMES[e.provider_type]+' asked StockChief to wait':'');
      if(e.retries>=TRIES)add({...base,kind:'retry',key:'retry:'+e.effect_id,problem,fix:'It was tried again '+TRIES+' times. Check the channel’s limits with '+NAMES[e.provider_type]+'.',waits:'Needs a person.'});
      else add({...base,kind:'retry',key:'retry:'+e.effect_id,problem,fix:'Tries the stock update again after a wait.',fixable:true,
        due:at(e.job_completed)+pause(e.retries+1)<=now,retryAt:at(e.job_completed)+pause(e.retries+1),data:{effectId:e.effect_id,jobId:e.job_id}});
    }else if(e.status==='AMBIGUOUS'){
      const readback=['shopify','woocommerce'].includes(e.provider_type),held=e.check_outcome==='HELD'&&Number(e.checks)>=3;
      add({...base,kind:'check',key:'check:'+e.effect_id,problem:NAMES[e.provider_type]+' did not confirm the stock update for '+base.subject,
        fix:readback&&!held?'Reads the stock back from the channel to confirm it, and never sends it twice.':'Compare the stock on the channel with StockChief and correct it there.',
        waits:readback&&!held?null:'Needs you to compare the stock.',retries:readback&&!held});
    }
  }
  // Channel products with no match: from the last catalogue check, or from held channel orders.
  const unmatched=(await db.query(`WITH found AS (
      SELECT r.connector_id,r.external_id,nullif(r.code,'') AS code,nullif(r.provider_data::jsonb->>'barcode','') AS barcode
      FROM connection_external_records r WHERE r.workspace_id=$1 AND r.entity_type='sku' AND r.selected=1 AND r.mapping_status='UNMAPPED'
      UNION
      SELECT i.connector_id,x.external_id,nullif(line->>'skuCode',''),nullif(line->>'barcode','')
      FROM connection_issues i CROSS JOIN LATERAL (SELECT substr(i.fingerprint,length('UNKNOWN_SKU:'||i.connector_id||':')+1) AS external_id) x
      JOIN connector_feed_events e ON e.workspace_id=i.workspace_id AND e.connector_id=i.connector_id AND e.external_event_id=i.external_event_id
      CROSS JOIN LATERAL jsonb_path_query_first(e.normalized_payload::jsonb,'$.** ? (@.externalSku == $id)',jsonb_build_object('id',x.external_id)) line
      WHERE i.workspace_id=$1 AND i.issue_type='UNKNOWN_SKU' AND i.status='OPEN' AND left(i.fingerprint,12)='UNKNOWN_SKU:'
    ), matched AS (
      SELECT f.*,c.display_name AS channel,c.provider_type,c.status,c.paused_at,
        (SELECT array_agg(s.id ORDER BY s.id) FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
          WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND f.code IS NOT NULL AND lower(s.code)=lower(f.code)) AS by_code,
        (SELECT array_agg(s.id ORDER BY s.id) FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
          WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND f.barcode IS NOT NULL AND lower(s.barcode)=lower(f.barcode)) AS by_barcode
      FROM found f JOIN workspace_connectors c ON c.workspace_id=$1 AND c.id=f.connector_id AND c.provider_type=ANY($2::text[])
      WHERE NOT EXISTS(SELECT 1 FROM connection_mappings m WHERE m.workspace_id=$1 AND m.connector_id=f.connector_id AND m.entity_type='sku' AND m.external_id=f.external_id)
        AND NOT EXISTS(SELECT 1 FROM connection_external_records r WHERE r.workspace_id=$1 AND r.connector_id=f.connector_id AND r.entity_type='sku' AND r.external_id=f.external_id AND r.mapping_status IN ('IGNORED','EXCLUDED'))
    ) SELECT m.*,s.code AS target_code FROM matched m
      LEFT JOIN skus s ON s.workspace_id=$1 AND s.id=CASE WHEN cardinality(m.by_code)=1 THEN m.by_code[1] WHEN coalesce(cardinality(m.by_code),0)=0 AND cardinality(m.by_barcode)=1 THEN m.by_barcode[1] END
    ORDER BY m.channel,m.external_id LIMIT ${LIMIT_ROWS}`,[workspaceId,CHANNELS])).rows;
  for(const m of unmatched){
    const base={connectorId:m.connector_id,channel:m.channel,provider:m.provider_type,link:'/settings/connections/'+m.connector_id,subject:m.code||m.barcode||m.external_id};
    const problem='Channel product '+(m.code||m.external_id)+' has no StockChief match';
    if(Number(m.by_code?.length)>1||!m.by_code?.length&&Number(m.by_barcode?.length)>1){
      add({...base,kind:'match',key:'match:'+m.connector_id+':'+m.external_id,problem,fix:'More than one product has the same '+(m.by_code?.length>1?'SKU code':'barcode')+'. Choose the match on the connection page.',waits:'Needs you to choose.'});
      continue;
    }
    if(!m.target_code)continue;// No exact match: the connection page already asks a person.
    const by=m.by_code?.length===1?'same SKU code':'same barcode',active=m.status==='connected'&&!m.paused_at;
    add({...base,kind:'match',key:'match:'+m.connector_id+':'+m.external_id,problem,fix:'Matches it to '+m.target_code+' ('+by+'), so held channel orders go through.',
      fixable:active,waits:active?null:'Reconnect or resume the channel first.',data:{connectorId:m.connector_id,externalId:m.external_id,code:m.code,barcode:m.barcode,target:m.target_code,by}});
  }
  // Failed fixes wait before the next try, and give up for the day after three; an undone match is left to the owner.
  const seen=await history(db,workspaceId,list.map(p=>p.key));
  for(const p of list){
    const h=seen.get(p.key);if(!h||!p.fixable)continue;
    if(h.undone&&p.kind==='match'){p.fixable=false;p.stalled=true;p.waits='You undid this match. Match it yourself on the connection page.';continue;}
    if(h.failed>=TRIES){p.fixable=false;p.stalled=true;p.waits='Tried '+TRIES+' times today without success. Check the channel, then try again on the connection page.';continue;}
    const next=at(h.last)+pause(h.failed);
    if(next>now){p.due=false;p.retryAt=Math.max(p.retryAt||0,next);}
  }
  return list;
}

// ---- Fixes ------------------------------------------------------------------------------

async function renewSignIn(db,ctx,p,{providers}){
  const c=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.connectorId])).rows[0];
  const adapter=(providers||require('./providers/registry')).get(c.provider_type);
  await require('./postgres-provider-service').loadProviderCredentials(db,c,adapter);
  const expires=(await db.query("SELECT expires_at FROM connection_credentials WHERE workspace_id=$1 AND connector_id=$2 AND credential_kind='provider'",[ctx.workspaceId,c.id])).rows[0]?.expires_at;
  if(!(at(expires)>p.data.expires))throw new ValidationError(NAMES[c.provider_type]+' did not renew the sign-in. Reconnect the channel if this keeps happening.');
  return {renewedUntil:expires?new Date(expires).toISOString():null};
}
async function retryUpdate(db,ctx,p){
  const job=await jobs.retryDead(db,p.data.jobId,ctx.workspaceId,{by:RETRIER});
  if(!job)throw new ValidationError('That stock update is already being tried again.');
  return {jobId:job.id};
}
async function resendStock(db,ctx,p,{providers}){
  const sync=require('./postgres-commerce-sync'),effect=await require('../operations/postgres-provider-effects').get(db,ctx.workspaceId,p.data.effectId);
  const position=(await db.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,effect.payload.positionId])).rows[0];
  if(!position)throw new NotFoundError('That channel product is no longer synced.');
  const c=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,position.connector_id])).rows[0];
  const adapter=(providers||require('./providers/registry')).get(c.provider_type);
  if(!adapter?.readSyncPosition)throw new ValidationError('This channel cannot be read back.');
  const remote=await sync.readForReview(db,{workspaceId:ctx.workspaceId,actorId:position.authorized_by_user_id},position,adapter);
  if(!Number.isSafeInteger(remote.value)||remote.value<0)throw new ValidationError('The channel did not give a whole-unit stock count. Check the product on the channel.');
  return tx(db,c2=>sync.resendFailedInTransaction(c2,c,effect.id,remote.value,p.data.attempt).then(r=>{if(r.held)throw new ValidationError(r.reason);return {...r,channelShowed:remote.value};}));
}
async function matchProduct(db,ctx,p){
  return tx(db,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['provider-sync:'+p.data.connectorId]);
    const connection=(await c.query("SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL",[ctx.workspaceId,p.data.connectorId])).rows[0];
    if(!connection)throw new ValidationError('Reconnect or resume the channel first.');
    if((await c.query("SELECT 1 FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku' AND external_id=$3",[ctx.workspaceId,connection.id,p.data.externalId])).rowCount)
      return {alreadyMatched:true};
    const find=async(column,value)=>value?(await c.query(`SELECT s.id,s.code FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND lower(s.${column})=lower($2) LIMIT 2`,[ctx.workspaceId,value])).rows:[];
    const byCode=await find('code',p.data.code),target=byCode.length?(byCode.length===1?byCode[0]:null):((rows=>rows.length===1?rows[0]:null)(await find('barcode',p.data.barcode)));
    if(!target||target.code!==p.data.target)throw new ValidationError('The matching product changed. Choose the match on the connection page.');
    const id=newId('cmap'),now=nowIso();
    await c.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'sku',$4,$5,'exact',$6,$7,$7)`,[id,ctx.workspaceId,connection.id,p.data.externalId,target.id,ctx.actorId,now]);
    await c.query(`UPDATE connection_external_records SET mapping_status='MAPPED',updated_at=$4 WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku' AND external_id=$3`,
      [ctx.workspaceId,connection.id,p.data.externalId,now]);
    await require('./postgres-provider-sync').resolveMappingIssues(c,connection,'sku',p.data.externalId,now);
    const replayed=await require('./postgres-webhook-inbox').scheduleMappedInTransaction(c,ctx.workspaceId,connection.id);
    if(!(await c.query("SELECT 1 FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2 AND selected=1 AND mapping_status='UNMAPPED' LIMIT 1",[ctx.workspaceId,connection.id])).rowCount)
      await c.query("UPDATE workspace_connectors SET setup_status='CONNECTED',updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND status='connected' AND setup_status='MAPPING'",[ctx.workspaceId,connection.id,now]);
    return {mappingId:id,externalId:p.data.externalId,skuId:target.id,code:target.code,by:p.data.by,ordersReplayed:replayed.scheduled};
  });
}
async function registerWebhook(db,ctx,p,{providers,publicOrigin}){
  const origin=publicOrigin===undefined?require('../config').connections.publicOrigin:publicOrigin;
  await require('./postgres-provider-service').setupWebhookDelivery(db,ctx,p.connectorId,origin,{providers,publicOrigin:origin,operationKey:'channel-sync-fix:'+newId('webhook')});
  const still=(await db.query("SELECT detail FROM connection_issues WHERE workspace_id=$1 AND fingerprint=$2 AND status='OPEN'",[ctx.workspaceId,'push-setup:'+p.connectorId])).rows[0];
  if(still)throw new ValidationError(still.detail||'The channel did not accept the order webhook.');
  return {registered:true};
}
const FIXES={'sign-in':renewSignIn,retry:retryUpdate,resend:resendStock,match:matchProduct,webhook:registerWebhook};

// Apply one fix and audit it. A fix that does not work is audited too, so it waits before the next try.
async function apply(db,ctx,p,options){
  const action=options.automatic?ACTIONS.fixed:ACTIONS.approved;
  try{
    const result=await FIXES[p.kind](db,ctx,p,options);
    await audit.record(db,ctx,{action,reference:p.key,before:{kind:p.kind,channel:p.channel,connectorId:p.connectorId,problem:p.problem},after:{fix:p.fix,...result}});
    return {fixed:true,result};
  }catch(error){
    if(!expected(error))throw error;
    await audit.record(db,ctx,{action:ACTIONS.failed,reference:p.key,before:{kind:p.kind,channel:p.channel,connectorId:p.connectorId,problem:p.problem},after:{reason:String(error.message).slice(0,300),automatic:Boolean(options.automatic)}});
    return {fixed:false,reason:error.message};
  }
}

// Worker: fix what is due on its own.
async function run(database,workspaceId,options={}){
  const state=await policy.accountState(database,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return {skipped:'plan'};
  const actorId=await currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const stop=await automaticStop(database,workspaceId,state);if(stop)return {held:stop};
  const ctx={workspaceId,actorId},out={fixed:0,notFixed:0};
  for(const p of (await problems(database,workspaceId,options)).filter(x=>x.fixable&&x.due).slice(0,PER_RUN)){
    // Authority is checked again before each fix: a pause or Ask me first can arrive mid-run.
    if(await automaticStop(database,workspaceId,await policy.accountState(database,workspaceId)))break;
    (await apply(database,ctx,p,{...options,automatic:true})).fixed?out.fixed++:out.notFixed++;
  }
  return out;
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return {queued:0};
  if(!(await db.query('SELECT 1 FROM workspace_connectors WHERE workspace_id=$1 AND provider_type=ANY($2::text[]) LIMIT 1',[workspaceId,CHANNELS])).rowCount)return {queued:0};
  const slot=Math.floor(Date.now()/(15*60000));
  return {queued:(await jobs.enqueue(db,{workspaceId,kind:KIND,idempotencyKey:'channel-sync-fixes:'+slot,payload:{},priority:40,maxAttempts:3})).created?1:0};
}

// The owner approves one fix now (Ask me first, routine work off, or pause).
async function fixNow(database,ctx,problemKey,options={}){
  await owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(database,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
  const p=(await problems(database,ctx.workspaceId,options)).find(x=>x.key===String(problemKey||''));
  if(!p)throw new NotFoundError('That problem is already fixed or no longer shows.');
  if(!p.fixable)throw new ValidationError(p.waits||'StockChief cannot fix this one. '+p.fix);
  const done=await apply(database,ctx,p,{...options,automatic:false});
  if(!done.fixed)throw new ValidationError(done.reason);
  return done;
}

// Undo a product match StockChief made. Orders it let through stay.
async function undo(database,ctx,auditId){
  return tx(database,async c=>{
    await owner(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const entry=(await c.query('SELECT * FROM security_event_history WHERE workspace_id=$1 AND id=$2 AND action=ANY($3::text[])',[ctx.workspaceId,String(auditId||''),[ACTIONS.fixed,ACTIONS.approved]])).rows[0];
    if(!entry||entry.before_state?.kind!=='match'||!entry.after_state?.mappingId)throw new NotFoundError('That product match is not one StockChief made.');
    if((await c.query('SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND reference=$3 AND after_state->>\'undid\'=$4',[ctx.workspaceId,ACTIONS.undone,entry.reference,entry.id])).rowCount)return {replayed:true};
    const m=entry.after_state,mapping=(await c.query("SELECT * FROM connection_mappings WHERE workspace_id=$1 AND id=$2 AND entity_type='sku' FOR UPDATE",[ctx.workspaceId,m.mappingId])).rows[0];
    if(!mapping||mapping.external_id!==m.externalId||mapping.foundry_record_id!==m.skuId)throw new ValidationError('This match was changed on the connection page. Change it there.');
    if((await c.query('SELECT 1 FROM connection_commerce_positions WHERE workspace_id=$1 AND connector_id=$2 AND external_id=$3 LIMIT 1',[ctx.workspaceId,mapping.connector_id,mapping.external_id])).rowCount)
      throw new ValidationError('Stock or price sync uses this match. Turn that sync off on the connection page first.');
    await c.query('DELETE FROM connection_mappings WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,mapping.id]);
    await c.query("UPDATE connection_external_records SET mapping_status='UNMAPPED',updated_at=$4 WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku' AND external_id=$3",[ctx.workspaceId,mapping.connector_id,mapping.external_id,nowIso()]);
    await audit.record(c,ctx,{action:ACTIONS.undone,reference:entry.reference,before:{mappingId:mapping.id,code:m.code},after:{undid:entry.id}});
    return {undone:true};
  });
}

// ---- Page and Needs you ---------------------------------------------------------------------

async function recent(db,workspaceId){
  return (await db.query(`SELECT h.id,h.action,h.reference,h.before_state,h.after_state,h.created_at,
      EXISTS(SELECT 1 FROM security_event_history u WHERE u.workspace_id=h.workspace_id AND u.action=$3 AND u.after_state->>'undid'=h.id) AS undone
    FROM security_event_history h WHERE h.workspace_id=$1 AND h.action=ANY($2::text[]) AND h.created_at>now()-interval '30 days'
    ORDER BY h.created_at DESC,h.id LIMIT 50`,[workspaceId,[ACTIONS.fixed,ACTIONS.approved],ACTIONS.undone])).rows;
}
async function readPage(db,ctx,{filter='',page=1,adviceOnly=false}={}){
  const state=await policy.accountState(db,ctx.workspaceId),list=await problems(db,ctx.workspaceId);
  const alone=policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');
  const stop=alone?await automaticStop(db,ctx.workspaceId,state):null,ownerStop=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  const text=String(filter||'').trim().toLowerCase();
  const status=p=>p.waits?'Needs you':p.retries?'Retries on its own':!p.fixable?'Needs you':adviceOnly?'Suggested':stop?(ownerStop?'Watching only':'Waits for your approval'):p.due?'Fixing now':'Tries again at '+clock(p.retryAt);
  const rows=list.filter(p=>!text||p.channel.toLowerCase()===text).map(p=>({Channel:p.channel,Problem:sentence(p.problem),
    [adviceOnly?'Suggestion':'What StockChief does']:adviceOnly?(p.fixable||p.kind==='check'?suggestion(p):p.fix):p.stalled?p.waits:p.fix,Status:status(p),link:p.link}));
  const done=adviceOnly?[]:(await recent(db,ctx.workspaceId)).map(h=>({Channel:h.before_state?.channel||'',Problem:sentence(h.before_state?.problem),
    'What StockChief does':(h.undone?'Undone. ':'')+String(h.after_state?.fix||''),Status:(h.action===ACTIONS.fixed?'Fixed on its own ':'Fixed with your approval ')+clock(at(h.created_at)),link:'/settings/connections/'+(h.before_state?.connectorId||'')}));
  const all=rows.concat(done);
  const fixForm=adviceOnly?null:{approve:stop&&!ownerStop?list.filter(p=>p.fixable).slice(0,50).map(p=>({key:p.key,label:p.channel+': '+p.problem,fix:p.fix})):[],
    undo:(await recent(db,ctx.workspaceId)).filter(h=>h.before_state?.kind==='match'&&!h.undone&&h.after_state?.mappingId).slice(0,20)
      .map(h=>({id:h.id,label:(h.before_state?.channel||'')+': '+h.after_state.externalId+' matched to '+h.after_state.code})),stop,ownerStop};
  return {rows:all.slice((page-1)*100,page*100),more:all.length>page*100,syncFixForm:fixForm,
    summary:'StockChief watches the sync with Shopify, WooCommerce, BigCommerce, Square and Clover and fixes the common errors: it renews a sign-in that runs out, tries again after a channel asks it to wait, '+
      'matches a channel product to the one StockChief product with the same SKU code or barcode, sends a failed stock update again, and registers a lost order webhook again. '+
      'Anything else waits for you. StockChief has no Amazon or eBay connection.'+(adviceOnly?' On Starter it suggests each fix; Growth and above fix on their own.':stop?' Fixes wait now: '+stop:'')};
}
function suggestion(p){
  return {'sign-in':'Renew the sign-in on the connection page before it runs out.',retry:'Try the stock update again from the connection page.',
    resend:'Check the product on the channel, then send the stock again from the connection page.',
    match:'Match it to '+(p.data.target||'the product')+' ('+(p.data.by||'exact match')+') on the connection page.',
    webhook:'Retry order updates (event setup) on the connection page.',check:'Compare the stock on the channel with StockChief and correct it there.'}[p.kind]||p.fix;
}
async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'automatic'))return [];
  const stop=await automaticStop(db,workspaceId,state);if(!stop||await policy.stopped(db,workspaceId,state,ACTION,false))return [];
  const waiting=(await problems(db,workspaceId)).filter(p=>p.fixable);if(!waiting.length)return [];
  return [{kind:'connection',grouped:true,importance:'Needs You',priority:72,title:waiting.length+' channel sync '+(waiting.length===1?'fix waits':'fixes wait')+' for your approval',
    happened:'First: '+waiting[0].channel+': '+waiting[0].problem+'.',why:stop,recommendation:'Approve the fixes, or fix the channel yourself.',href:path,actionLabel:'Review channel fixes',sourceId:'channel-sync-fixes'}];
}

const definition={id:JOB,key,label:'Watch channel sync and fix common errors',filterLabel:'Channel name',readPage};
module.exports={JOB,KIND,ACTIONS,key,path,problems,run,schedule,fixNow,undo,readPage,inbox,definition};
