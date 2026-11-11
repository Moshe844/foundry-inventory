
'use strict';

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const source=require('./customer-checkin-evidence');
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const jobs=require('../operations/postgres-job-queue');
const audit=require('../operations/postgres-security-audit');
const KIND='agent.customer.check-in.v1',ACTION='customer.check_in',JOB=78;
const rules='stockchief_runtime.agent_customer_checkin_rules',drafts='stockchief_runtime.agent_customer_checkin_drafts';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=db=>({query:(...args)=>db.query(...args),transaction:fn=>fn(db)});
const path='/autopilot/customer-check-ins';
const expected=error=>[400,402,403,404,409,422].includes(error.status);

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const actor=(await db.query(`SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)`+
    (lock?' FOR SHARE OF u,w':''),[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)throw new AuthorizationError('Only the current inventory owner can prepare check-ins and authorize their routine.');
  permissions.assertCan(actor,permissions.MANAGE_SALES,'prepare customer check-ins');
}
async function access(db,ctx,{lock=false,stop=false,automatic=false,trained=false}={}){
  await owner(db,ctx,{lock});
  if(stop&&lock){
    await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2 FOR SHARE',[ctx.workspaceId,JOB]);
  }
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,automatic?'automatic':'draft',{trained});
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'sales_orders.core');
  if(stop){
    const reason=await policy.stopped(db,ctx.workspaceId,account,ACTION,automatic);
    if(reason)throw new ValidationError(reason);
    if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate){
      throw new ValidationError('Routine customer check-ins are paused.');
    }
  }
  return account;
}

async function rule(db,workspaceId,{lock=false}={}){
  return (await db.query('SELECT * FROM '+rules+' WHERE workspace_id=$1'+(lock?' FOR UPDATE':''),[workspaceId])).rows[0];
}
async function nativeDraft(db,workspaceId,id){
  return (await db.query(`SELECT d.*,m.recipient,m.subject,m.body,m.status,m.message_kind,m.connector_id
    FROM ${drafts} d JOIN customer_communications m ON m.workspace_id=d.workspace_id AND m.id=d.id AND m.customer_id=d.customer_id
    WHERE d.workspace_id=$1 AND d.id=$2`,[workspaceId,id])).rows[0];
}
function intact(d){
  return d?.status==='PREPARED'&&d.message_kind===source.messageKind&&!d.connector_id&&
    hash(d.evidence)===d.evidence_hash&&hash({recipient:d.recipient,subject:d.subject,body:d.body})===d.draft_hash;
}
async function individualExample(db,ctx,id){
  const example=await nativeDraft(db,ctx.workspaceId,id);
  if(!intact(example)||example.authority_kind!=='INDIVIDUAL'||example.drafted_by!==ctx.actorId){
    throw new ValidationError('Complete an individually approved customer check-in with the current owner before teaching this routine.');
  }
  return example;
}

async function configure(database,ctx,input){
  return tx(database,async db=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['customer-check-in-rule:'+ctx.workspaceId]);
    const prior=await rule(db,ctx.workspaceId,{lock:true}),revision=Number(input.revision);
    if(!Number.isSafeInteger(revision)||revision!==(prior?.revision||0))throw new ValidationError('The routine changed. Reload its current settings.');
    if(input.stop==='yes'){
      // Owners can remove a previously granted authority after a plan change.
      await owner(db,ctx,{lock:true});
      if(!prior?.enabled)return {stopped:true,replayed:true};
      await db.query('UPDATE '+rules+' SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1',[ctx.workspaceId]);
      await audit.record(db,ctx,{action:'Stopped customer check-in drafting',reference:String(prior.revision)});
      return {stopped:true};
    }
    const state=await access(db,ctx,{lock:true});
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the routine may draft private check-ins for existing customers with recorded purchases.');
    const trained=policy.allowance(state.plan,JOB)==='trained';
    const example=trained?await individualExample(db,ctx,input.exampleId):null;
    policy.requireJob(state.plan,JOB,'automatic',{trained:Boolean(example)});
    await require('../manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],prior?.enabled?0:1);
    const authorityKind=trained?'TRAINED':'CUSTOM';
    await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'customer-check-in-rule:'+(revision+1),4096,{finished:true});
    await db.query(`INSERT INTO ${rules}(workspace_id,authorized_by,authority_kind,example_id,revision,enabled)
      VALUES($1,$2,$3,$4,1,true) ON CONFLICT(workspace_id) DO UPDATE
      SET authorized_by=EXCLUDED.authorized_by,authority_kind=EXCLUDED.authority_kind,example_id=EXCLUDED.example_id,
      revision=agent_customer_checkin_rules.revision+1,enabled=true,updated_at=now()`,[ctx.workspaceId,ctx.actorId,authorityKind,example?.id||null]);
    await audit.record(db,ctx,{action:'Authorized routine customer check-in drafts',reference:example?.id||null,
      after:{authority:authorityKind,revision:revision+1,inactiveDays:source.inactivityDays,privateDrafts:true}});
    const queued=await schedule(scoped(db),ctx.workspaceId);
    return {revision:revision+1,queued:queued.queued};
  });
}

async function activeRoutine(db,workspaceId,revision,{lock=false}={}){
  const active=await rule(db,workspaceId,{lock});
  if(!active?.enabled||(revision!=null&&active.revision!==revision))throw new ValidationError('The owner’s current check-in routine changed.');
  const ctx={workspaceId,actorId:active.authorized_by};
  await access(db,ctx,{lock,stop:true,automatic:true,trained:active.authority_kind==='TRAINED'});
  if(active.authority_kind==='TRAINED')await individualExample(db,ctx,active.example_id);
  return {ctx,active};
}

async function save(db,ctx,current,{active=null}={}){
  if(current.draftId){
    const draft=await nativeDraft(db,ctx.workspaceId,current.draftId);
    if(!intact(draft)||draft.evidence_hash!==current.evidenceHash)throw new ValidationError('A draft already records this inactive period. Review its saved evidence.');
    return {draftId:draft.id,customerId:draft.customer_id,replayed:true};
  }
  const id=newId('customer-check-in'),at=nowIso(),message=current.message;
  const authorityKind=active?.authority_kind||'INDIVIDUAL';
  await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'customer-check-in:'+id,
    Buffer.byteLength(JSON.stringify({message,evidence:current.evidence}))*2+8192,{finished:true});
  await db.query(`INSERT INTO customer_communications(id,workspace_id,customer_id,channel,recipient,subject,body,status,message_kind,
    idempotency_key,created_at,updated_at) VALUES($1,$2,$3,'email',$4,$5,$6,'PREPARED',$7,$8,$9,$9)`,
  [id,ctx.workspaceId,current.recordId,message.recipient,message.subject,message.body,source.messageKind,'customer-check-in:'+current.episode,at]);
  await db.query(`INSERT INTO ${drafts}(id,workspace_id,customer_id,episode,evidence_hash,evidence,draft_hash,drafted_by,authority_kind,rule_revision)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,[id,ctx.workspaceId,current.recordId,current.episode,current.evidenceHash,
    JSON.stringify(current.evidence),hash(message),ctx.actorId,authorityKind,active?.revision||null]);
  await audit.record(db,ctx,{action:'Prepared a private customer check-in',reference:id,
    after:{customerId:current.recordId,episode:current.episode,evidenceHash:current.evidenceHash,authority:authorityKind}});
  return {draftId:id,customerId:current.recordId,automatic:Boolean(active)};
}

async function lockCustomer(db,workspaceId,id){
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['customer-check-in:'+workspaceId+':'+id]);
  await db.query('SELECT id FROM customers WHERE workspace_id=$1 AND id=$2 FOR SHARE',[workspaceId,id]);
}

async function build(db,ctx,row){
  await access(db,ctx);
  const current=await source.current(db,ctx,row.id);
  const {evidenceHash,message,evidence,episode}=current;
  return {payload:{recordId:row.id,evidenceHash,message,evidence,episode},summary:'Save a private check-in draft for '+evidence.customer+
    ', whose latest recorded purchase was '+evidence.lastPurchase+'.'};
}
async function execute(db,ctx,p){
  await access(db,ctx,{lock:true,stop:true});
  await lockCustomer(db,ctx.workspaceId,p.recordId);
  const current=await source.current(db,ctx,p.recordId);
  if(current.evidenceHash!==p.evidenceHash||current.episode!==p.episode||hash(current.message)!==hash(p.message)){
    throw new ValidationError('The customer contact or purchase evidence changed. Review the current check-in.');
  }
  return save(db,ctx,current);
}
async function verify(db,ctx,result,p){
  const d=await nativeDraft(db,ctx.workspaceId,result.draftId);
  return intact(d)&&d.customer_id===p.recordId&&d.episode===p.episode&&d.evidence_hash===p.evidenceHash&&d.draft_hash===hash(p.message);
}

function enqueue(db,workspaceId,{revision,slot,anchor,after=''}){
  return jobs.enqueue(db,{workspaceId,kind:KIND,idempotencyKey:'customer-check-ins:'+revision+':'+slot+':'+anchor+':'+after,
    payload:{revision,slot,anchor,after},priority:55,maxAttempts:8});
}

async function schedule(db,workspaceId){
  try{
    const {active}=await activeRoutine(db,workspaceId);
    const today=await require('../lib/business-time').today(db,workspaceId);
    const [next]=await source.list(db,workspaceId,{today,undrafted:true,limit:1});
    if(!next)return {queued:false};
    const slot=Math.floor(Date.now()/(15*60000));
    return {queued:true,id:(await enqueue(db,workspaceId,{revision:active.revision,slot,anchor:next.episode})).job.id};
  }catch(error){
    if(!expected(error))throw error;
    return {queued:false,reason:error.message};
  }
}

async function run(db,workspaceId,{revision,slot,anchor,after}){
  let found;
  try{
    await activeRoutine(db,workspaceId,revision);
    found=await source.list(db,workspaceId,{today:await require('../lib/business-time').today(db,workspaceId),after,undrafted:true});
  }catch(error){
    if(!expected(error))throw error;
    return {state:'HELD',reason:error.message};
  }
  const result={drafted:0,held:0,replayed:0};
  for(const candidate of found){
    try{
      const drafted=await tx(db,async c=>{
        const {ctx,active}=await activeRoutine(c,workspaceId,revision,{lock:true});
        await lockCustomer(c,workspaceId,candidate.customer_id);
        const current=await source.current(c,ctx,candidate.customer_id);
        if(current.episode!==candidate.episode)throw new ValidationError('A newer customer purchase changed this inactive period.');
        return save(c,ctx,current,{active});
      });
      result[drafted.replayed?'replayed':'drafted']++;
    }catch(error){
      if(!expected(error))throw error;
      result.held++;
    }
  }
  if(found.length===source.batchSize)await enqueue(db,workspaceId,{revision,slot,anchor,after:found.at(-1).customer_id});
  return result;
}

async function review(db,ctx,{filter='',page=1,today}={}){
  await access(db,ctx);
  const date=today||await require('../lib/business-time').today(db,ctx.workspaceId);
  const rows=await source.list(db,ctx.workspaceId,{today:date,filter,limit:101,offset:(page-1)*100});
  return {rows:rows.slice(0,100).map(row=>({Customer:row.customer_name,'Last purchase':row.last_purchase,
    'Previous orders':row.prior_orders,Draft:row.draft_id?'Open the saved check-in.':source.compose(row).body,Status:row.draft_id?'Draft saved':row.email?'Ready to review':'Email needed',
    link:path+'?customer='+encodeURIComponent(row.customer_id)})),more:rows.length>100,
  summary:'Find customers with at least two retained purchases, no open order and no shipment in 90 days. Open an exact customer to save or read a check-in draft.'};
}

async function page(db,ctx,{customerId=null,selectedId=null,page=1}={}){
  await owner(db,ctx);
  const setting=await rule(db,ctx.workspaceId);
  let state;
  try{state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'draft');}
  catch(error){
    if(error.code!=='entitlement_required'||!setting?.enabled)throw error;
    return {locked:true,problem:error.message,setting,current:null,selected:null};
  }
  let current=null,problem=null,selected=null;
  if(customerId){
    try{current=await source.current(db,ctx,customerId);}
    catch(error){if(!expected(error))throw error;problem=error.message;}
  }
  if(selectedId){
    const draft=await nativeDraft(db,ctx.workspaceId,selectedId);
    if(!intact(draft))throw new NotFoundError('That saved check-in draft is unavailable.');
    selected=draft;
    try{selected.current=(await source.current(db,ctx,draft.customer_id)).evidenceHash===draft.evidence_hash;}
    catch(error){if(!expected(error))throw error;selected.current=false;}
  }
  const rows=(await db.query(`SELECT id,evidence->>'customer' customer,evidence->>'lastPurchase' purchase,authority_kind,created_at
    FROM ${drafts} WHERE workspace_id=$1 AND ($2::text IS NULL OR customer_id=$2)
    ORDER BY created_at DESC,id DESC LIMIT 51 OFFSET $3`,[ctx.workspaceId,customerId,(page-1)*50])).rows;
  const examples=policy.allowance(state.plan,JOB)==='trained'?(await db.query(`SELECT id,evidence->>'customer' customer,evidence->>'lastPurchase' purchase
    FROM ${drafts} WHERE workspace_id=$1 AND drafted_by=$2 AND authority_kind='INDIVIDUAL' ORDER BY created_at DESC,id DESC LIMIT 50`,
  [ctx.workspaceId,ctx.actorId])).rows:[];
  return {locked:false,current,selected,problem,setting,examples,rows:rows.slice(0,50),more:rows.length>50,page,customerId,
    canTeach:policy.allowance(state.plan,JOB)==='trained',shadow:state.shadow};
}

module.exports={KIND,ACTION,JOB,path,configure,schedule,run,page,definition:{id:JOB,key:'customer-check-in',
  label:'Draft check-ins for inactive customers',filterLabel:'Exact customer name or email',readPage:review},
spec:{name:ACTION,description:'Prepare a private customer check-in from exact inactive purchase history. Supply the existing customer.',
  record:'customer',fields:['recordReference'],permission:permissions.MANAGE_SALES,ownerOnly:true,capability:'sales_orders.core',
  resultingRecords:['customer_communications','stockchief_runtime.agent_customer_checkin_drafts'],build,execute,verify}};
