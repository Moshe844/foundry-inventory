'use strict';

const {createHash}=require('node:crypto');
const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const {newId,requireText}=require('../lib/util');
const money=require('../domain/currency');
const policy=require('../commercial/agent-plan');
const operations=require('../commercial/operations');
const effects=require('../operations/postgres-provider-effects');
const access=require('../operations/postgres-warehouse-access');
const accounts=require('./postgres-accounts');
const provider=require('./easypost-claims');
const shipping=require('./postgres-service');

const action='shipping.carrier_claim';
const path='/autopilot/carrier-claims';
const limit=1572864;
const evidenceColumns=new Map([['invoice','invoice'],['correspondence','correspondence'],['supporting','supporting']]);
const digest=value=>createHash('sha256').update(value).digest('hex');
const hash=value=>digest(JSON.stringify(value));
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const audit=(c,ctx,verb,row)=>require('../operations/postgres-security-audit').record(c,ctx,{
  action:verb,reference:row.id,after:{shipmentId:row.shipment_id,amountMinor:row.facts.amountMinor}});

async function owner(db,ctx,lock=false){
  const found=await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId]);
  if(!found.rowCount)throw new AuthorizationError('Only the current inventory owner can manage carrier claims.');
  await access.assertInventoryWide(db,ctx);
}

async function authority(db,ctx,automatic=false,trained=false){
  await owner(db,ctx,true);
  await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  const mode=(await db.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId])).rows[0]?.mode;
  await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=63 FOR SHARE',[ctx.workspaceId]);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,63,automatic?'automatic':'draft',{trained});
  if(automatic&&mode!=='POLICY_AUTOMATED')throw new ValidationError('Filing without individual approval needs current routine authority.');
  const reason=await policy.stopped(db,ctx.workspaceId,state,action,automatic);
  if(reason)throw new ValidationError(reason);
  return state;
}

function evidence(files,required){
  const originals={};
  for(const file of files||[]){
    const {field,buffer}=file;
    if(!evidenceColumns.has(field)||originals[field]||!Buffer.isBuffer(buffer)||buffer.length<8||buffer.length>limit)
      throw new ValidationError('Choose one PDF, JPEG or PNG for each evidence field, up to 1.5 MB each.');
    const signature=buffer.subarray(0,8);
    if(!signature.subarray(0,5).equals(Buffer.from('%PDF-'))&&!signature.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))&&
      !signature.equals(Buffer.from('89504e470d0a1a0a','hex')))
      throw new ValidationError('Choose original PDF, JPEG or PNG evidence files.');
    originals[field]=buffer;
  }
  if(!originals.invoice||!originals.correspondence||required&&!originals.supporting)
    throw new ValidationError('Add the invoice and correspondence. Damage claims also need supporting evidence.');
  return originals;
}

function evidenceHash({invoice,correspondence,supporting}){
  return hash([digest(invoice),digest(correspondence),supporting?digest(supporting):null]);
}

async function parcel(db,ctx,shipmentId,tracking,lock=false){
  const shipment=await shipping.requireShipment(db,ctx.workspaceId,shipmentId,lock);
  await access.assertLocations(db,ctx,[shipment.ship_from_location_id]);
  const boxes=shipment.provider_packages?.length?shipment.provider_packages:
    [{externalId:shipment.provider_shipment_id,trackingNumber:shipment.tracking_number}];
  const matches=boxes.filter(box=>box.trackingNumber===tracking&&/^shp_[a-z0-9]+$/i.test(box.externalId));
  if(shipment.provider!=='easypost'||!shipment.shipping_connector_id||!shipment.shipped_at||shipment.label_status!=='PURCHASED'||
    !['SHIPPED','DELIVERED'].includes(shipment.status)||matches.length!==1||matches[0].externalLabel===true)
    throw new ValidationError('Choose an exact parcel shipped with a purchased EasyPost label from this inventory.');
  const purchase=(await db.query(`SELECT 1 FROM shipping_label_transactions WHERE workspace_id=$1 AND shipment_id=$2
    AND provider='easypost' AND operation='PURCHASE' AND status='SUCCEEDED' AND provider_reference::jsonb ? $3 LIMIT 1`,
  [ctx.workspaceId,shipmentId,matches[0].externalId])).rowCount;
  if(!purchase)throw new ValidationError('The original carrier label purchase could not be verified for this parcel.');
  return {externalId:matches[0].externalId,trackingNumber:tracking,connectorId:shipment.shipping_connector_id,
    number:shipment.shipment_number,location:shipment.ship_from_location_id};
}

async function account(db,ctx,connectorId,lock=false){
  if(lock)await db.query('SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,connectorId]);
  const held=await accounts.contextFor(db,ctx,{connectorId,provider:'easypost'});
  if(!held||process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&!held.account.testMode)
    throw new ValidationError('Use the original connected EasyPost account. Staging requires its test key.');
  return {...held,fingerprint:hash([connectorId,held.account.provider,held.account.apiKey])};
}

function providerRead(db,ctx,key,run){
  return operations.run(db,ctx.workspaceId,{operation:'carrier_claim_read',provider:'easypost',key,capability:'shipping.workflow'},run);
}

async function get(db,ctx,id,{lock=false,content=false}={}){
  const columns='id,shipment_id,parcel_id,connector_id,scope_key,facts,effect_id,automatic,rule_revision,receipt';
  const row=(await db.query(`SELECT ${columns},${content?'invoice,correspondence,supporting,evidence_hash':'supporting IS NOT NULL AS has_supporting'}
    FROM stockchief_runtime.agent_carrier_claims WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,
    [ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That carrier claim could not be found.');
  return row;
}

async function original(db,ctx,id,field){
  await owner(db,ctx);
  const column=evidenceColumns.get(field);
  if(!column)throw new NotFoundError('That evidence file could not be found.');
  const value=(await db.query(`SELECT ${column} AS content FROM stockchief_runtime.agent_carrier_claims WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id])).rows[0]?.content;
  if(!value)throw new NotFoundError('That evidence file could not be found.');
  const ext=value.subarray(0,5).equals(Buffer.from('%PDF-'))?'pdf':value[0]===0x89?'png':'jpg';
  return {content:value,filename:field+'.'+ext};
}

async function rule(db,ctx,row,lock=false){
  return (await db.query(`SELECT r.* FROM stockchief_runtime.agent_draft_rules r JOIN users u ON u.workspace_id=r.workspace_id
    AND u.id=r.authorized_by AND u.role='owner' WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key=$3
    ${lock?'FOR SHARE OF r,u':''}`,[ctx.workspaceId,action,row.scope_key])).rows[0];
}

async function example(db,ctx,row,maximum){
  return Boolean((await db.query(`SELECT 1 FROM stockchief_runtime.agent_carrier_claims c JOIN stockchief_runtime.provider_effects e
    ON e.workspace_id=c.workspace_id AND e.id=c.effect_id AND e.kind=$3 AND e.status='SUCCEEDED'
    WHERE c.workspace_id=$1 AND c.scope_key=$2 AND c.automatic=false AND c.receipt->>'id'=e.result->>'id'
      AND (c.facts->>'amountMinor')::bigint >= $4 AND c.receipt->>'status' IN('submitted','in_review','approved','approved_partial','needs_action')
    LIMIT 1`,[ctx.workspaceId,row.scope_key,action,maximum])).rowCount);
}

async function queue(c,ctx,row,automatic,standing){
  const {effect}=await effects.enqueueInTransaction(c,{workspaceId:ctx.workspaceId,kind:action,provider:'easypost',
    aggregateType:'carrier_claim',aggregateId:row.id,requestedByUserId:ctx.actorId,
    idempotencyKey:'carrier-claim:'+row.id+(row.effect_id?':after:'+row.effect_id:''),
    maxAttempts:3});
  await c.query(`UPDATE stockchief_runtime.agent_carrier_claims SET effect_id=$3,automatic=$4,rule_revision=$5
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,effect.id,automatic,standing?.revision||null]);
  await audit(c,ctx,automatic?'Carrier claim queued under a saved rule':'Carrier claim individually approved',row);
  return {id:row.id,queued:true,automatic};
}

async function prepare(db,ctx,input,files,adapter=provider){
  await owner(db,ctx);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,63,'draft');
  const blocked=await policy.stopped(db,ctx.workspaceId,state,action,false);
  if(blocked)throw new ValidationError(blocked);
  const {type}=input;
  if(input.confirmed!=='yes'||!['loss','damage'].includes(type))throw new ValidationError('Confirm whether this parcel was lost or damaged and verify the facts.');
  const amountMinor=money.userToMinor(input.amount,'USD',{label:'Claim amount'});
  if(!amountMinor)throw new ValidationError('Enter a positive claim amount.');
  const originals=evidence(files,type==='damage');
  const originalsHash=evidenceHash(originals);
  const description=requireText(input.description,'What happened',{max:1600});
  const recipient=requireText(input.recipient,'Business receiving reimbursement',{max:150});
  const contactEmail=requireText(input.contactEmail,'Business email',{max:240}).toLowerCase();
  if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(contactEmail))throw new ValidationError('Enter the business email for claim updates.');
  const shipmentId=requireText(input.shipmentId,'Shipment',{max:150});
  const tracking=requireText(input.trackingNumber,'Tracking number',{max:240});
  const insuranceId=requireText(input.insuranceId,'EasyPost insurance number',{max:100});
  const exact=await parcel(db,ctx,shipmentId,tracking);
  const held=await account(db,ctx,exact.connectorId);
  const coverage=await providerRead(db,ctx,'carrier-claim-coverage:'+newId('read'),()=>adapter.coverage(held.ctx,{...exact,insuranceId}));
  if(amountMinor>coverage.limitMinor)throw new ValidationError('The claim exceeds the verified parcel insurance. Review the amount.');
  const facts={...exact,insuranceId,coverageMinor:coverage.limitMinor,mode:coverage.mode,accountFingerprint:held.fingerprint,
    type,amountMinor,description,recipient,contactEmail};
  const key=hash([held.fingerprint,type,exact.location,recipient,contactEmail]);
  return db.transaction(async c=>{
    const tx=scoped(c);
    const currentState=await authority(tx,ctx);
    const now=await parcel(c,ctx,shipmentId,tracking,true),connected=await account(tx,ctx,exact.connectorId,true);
    if(hash(now)!==hash(exact)||connected.fingerprint!==held.fingerprint)throw new ValidationError('The parcel or connected account changed. Prepare a fresh claim.');
    const prior=(await c.query('SELECT id FROM stockchief_runtime.agent_carrier_claims WHERE workspace_id=$1 AND parcel_id=$2',
      [ctx.workspaceId,exact.externalId])).rows[0];
    if(prior)return {id:prior.id,replayed:true};
    const id=newId('claim');
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'carrier-claim-originals:'+id,
      originals.invoice.length+originals.correspondence.length+(originals.supporting?.length||0)+16384,{finished:true});
    const row=(await c.query(`INSERT INTO stockchief_runtime.agent_carrier_claims
      (workspace_id,id,shipment_id,parcel_id,connector_id,scope_key,opened_by,facts,evidence_hash,invoice,correspondence,supporting)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) ON CONFLICT(workspace_id,parcel_id) DO NOTHING RETURNING *`,
    [ctx.workspaceId,id,shipmentId,exact.externalId,exact.connectorId,key,ctx.actorId,JSON.stringify({...facts,reference:'stockchief-'+id}),originalsHash,
      originals.invoice,originals.correspondence,originals.supporting||null])).rows[0];
    if(!row){
      throw new ValidationError('A claim for this parcel has already been opened. Refresh your claim list.');
    }
    await audit(c,ctx,'Carrier claim facts confirmed',row);
    if(input.useRoutine==='yes'){
      const saved=await rule(c,ctx,row,true);
      const trained=Boolean(saved&&Number(saved.maximum_minor)>=amountMinor&&
        (currentState.plan==='enterprise'||await example(c,ctx,row,Number(saved.maximum_minor))));
      const automated=(await c.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.mode==='POLICY_AUTOMATED';
      if(trained&&automated&&policy.permits(currentState.plan,63,'automatic',{trained})&&!await policy.stopped(tx,ctx.workspaceId,currentState,action,true))
        return queue(c,ctx,row,true,saved);
    }
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function approve(db,ctx,id,input){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm filing this exact claim with the shipping account.');
  return db.transaction(async c=>{
    await authority(scoped(c),ctx);
    const row=await get(c,ctx,id,{lock:true});
    if(row.effect_id&&!mayReapprove(await effects.get(c,ctx.workspaceId,row.effect_id)))return {id,replayed:true};
    return queue(c,ctx,row,false,null);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function mayReapprove(effect){
  return effect?.status==='FAILED'&&effect.errorCode==='carrier_claim_before_dispatch';
}

async function saveRule(db,ctx,id,input){
  return db.transaction(async c=>{
    const tx=scoped(c),state=await authority(tx,ctx),row=await get(c,ctx,id,{lock:true});
    const revision=Number(input.revision);
    if(input.revision==null||!Number.isSafeInteger(revision)||revision<0)throw new ValidationError('Reload the current rule.');
    const prior=await rule(c,ctx,row,true);
    if((prior?.revision||0)!==revision)throw new ValidationError('This rule has changed. Reload it before editing.');
    if(input.remove==='yes'){
      await c.query('DELETE FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3',[ctx.workspaceId,action,row.scope_key]);
      await audit(c,ctx,'Carrier claim rule removed',row);
      return;
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the exact carrier claim rule and maximum amount.');
    const maximum=money.userToMinor(input.maximum,'USD',{label:'Maximum per claim'});
    if(maximum<=0||maximum>row.facts.coverageMinor)throw new ValidationError('Enter a positive maximum within this parcel’s verified insurance.');
    if(state.plan==='pro'&&!await example(c,ctx,row,maximum))throw new ValidationError('File a matching claim individually and wait for the carrier to confirm it before teaching Pro.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
    await c.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by)
      VALUES($1,$2,$3,$4,'USD',$5,$6) ON CONFLICT(workspace_id,action_type,scope_key) DO UPDATE SET
      maximum_minor=EXCLUDED.maximum_minor,authorized_by=EXCLUDED.authorized_by,revision=agent_draft_rules.revision+1`,
    [ctx.workspaceId,action,row.scope_key,'EasyPost '+row.facts.type+' at '+row.facts.number,maximum,ctx.actorId]);
    await audit(c,ctx,'Carrier claim rule saved',row);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function liveFacts(db,ctx,row,lock=false){
  const exact=await parcel(db,ctx,row.shipment_id,row.facts.trackingNumber,lock);
  const held=await account(db,ctx,row.connector_id,lock);
  if(exact.externalId!==row.parcel_id||exact.connectorId!==row.connector_id||exact.location!==row.facts.location||
    held.fingerprint!==row.facts.accountFingerprint||row.evidence_hash!==evidenceHash(row))
    throw new ValidationError('The account, shipment or saved evidence changed. Review this claim before filing.');
  return held;
}

async function saveReceipt(db,ctx,effect,receipt,recovered=false){
  return effects.succeed(db,ctx.workspaceId,effect.id,effect.claimToken,{
    providerReference:{externalId:receipt.reference},result:receipt,
    apply:async c=>{
      if(recovered)await operations.completeRetained(scoped(c),ctx.workspaceId,{operation:'carrier_claim_submit',key:'carrier-claim-submit:'+effect.id},{recoveredByReadback:true});
      await c.query('UPDATE stockchief_runtime.agent_carrier_claims SET receipt=$3::jsonb WHERE workspace_id=$1 AND effect_id=$2',
        [ctx.workspaceId,effect.id,JSON.stringify(receipt)]);
    }
  });
}

async function submit(db,job,adapter=provider){
  const pending=await effects.get(db,job.workspaceId,job.payload?.effectId);
  if(pending.kind!==action)throw new ValidationError('This worker can only file a saved carrier claim.');
  const claimed=await effects.claim(db,job.workspaceId,pending.id);
  if(claimed.replayed)return claimed.effect;
  const effect=claimed.effect,ctx={workspaceId:job.workspaceId,actorId:effect.requestedByUserId};
  let attempted=false;
  try{
    await owner(db,ctx);
    const row=await get(db,ctx,effect.aggregateId,{content:true});
    await policy.requireWorkspaceJob(db,ctx.workspaceId,63,'draft');
    const held=await liveFacts(db,ctx,row);
    const coverage=await providerRead(db,ctx,'carrier-claim-dispatch:'+effect.id,()=>adapter.coverage(held.ctx,row.facts));
    if(coverage.mode!==row.facts.mode||coverage.limitMinor<row.facts.amountMinor)throw new ValidationError('The carrier insurance no longer covers this claim amount.');
    await effects.checkpoint(db,ctx.workspaceId,effect.id,effect.claimToken,{externalId:row.facts.reference});
    const receipt=await operations.run(db,ctx.workspaceId,{operation:'carrier_claim_submit',provider:'easypost',
      key:'carrier-claim-submit:'+effect.id,capability:'shipping.workflow'},async()=>{
      try{
        // This transaction holds the relevant authority until the single bounded provider request returns.
        // It must never be retried by the database wrapper.
        return await db.transaction(async c=>{
          const tx=scoped(c);
          const draftState=await authority(tx,ctx);
          const current=await get(c,ctx,row.id,{lock:true,content:true});
          const saved=current.automatic?await rule(c,ctx,current,true):null;
          const trained=Boolean(saved&&saved.revision===current.rule_revision&&Number(saved.maximum_minor)>=current.facts.amountMinor);
          const state=current.automatic?await authority(tx,ctx,true,trained):draftState;
          if(current.effect_id!==effect.id||current.automatic&&(!trained||state.plan==='pro'&&!await example(c,ctx,current,Number(saved.maximum_minor))))
            throw new ValidationError('The saved carrier claim authority changed. This claim was held.');
          const connected=await liveFacts(tx,ctx,current,true);
          attempted=true;
          return adapter.submit(connected.ctx,{...current.facts,invoice:current.invoice,emailEvidence:current.correspondence,supporting:current.supporting});
        });
      }catch(error){
        if(!attempted)error.providerWriteAttempted=false;
        throw error;
      }
    });
    return await saveReceipt(db,ctx,effect,receipt);
  }catch(error){
    const recorded=attempted?error:Object.assign(new ValidationError(error.message),{code:'carrier_claim_before_dispatch'});
    await effects.finishError(db,ctx.workspaceId,effect.id,effect.claimToken,recorded,{ambiguous:attempted&&!effects.definiteFailure(error)});
    throw Object.assign(error,{retryable:false});
  }
}

async function verify(db,ctx,id,adapter=provider){
  await owner(db,ctx);
  const row=await get(db,ctx,id);
  if(!row.effect_id)throw new ValidationError('File this claim before checking its carrier receipt.');
  const held=await account(db,ctx,row.connector_id);
  if(held.fingerprint!==row.facts.accountFingerprint)throw new ValidationError('Reconnect the original shipping account before checking this claim.');
  const effect=await effects.get(db,ctx.workspaceId,row.effect_id);
  if(!['AMBIGUOUS','SUCCEEDED'].includes(effect.status))throw new ValidationError('This claim has no provider result available to check yet.');
  const checked=await effects.claimVerification(db,ctx.workspaceId,row.effect_id,action);
  try{
    const receipt=await providerRead(db,ctx,'carrier-claim-verify:'+newId('read'),()=>adapter.retrieve(held.ctx,row.facts));
    if(!checked.replayed)return await saveReceipt(db,ctx,checked.effect,receipt,true);
    await db.query('UPDATE stockchief_runtime.agent_carrier_claims SET receipt=$3::jsonb WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,id,JSON.stringify(receipt)]);
    return receipt;
  }catch(error){
    if(!checked.replayed)await effects.finishError(db,ctx.workspaceId,checked.effect.id,checked.effect.claimToken,error,{ambiguous:true});
    throw error;
  }
}

async function page(db,ctx,id,search=''){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,63,'draft');
  const blocked=allowed?await policy.stopped(db,ctx.workspaceId,state,action,false):null;
  const rows=(await db.query(`SELECT c.id,c.facts->>'number' number,c.facts->>'type' type,
    c.facts->>'trackingNumber' tracking,c.receipt->>'status' receipt,e.status
    FROM stockchief_runtime.agent_carrier_claims c LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=c.workspace_id
      AND e.id=c.effect_id WHERE c.workspace_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,[ctx.workspaceId])).rows;
  if(!id){
    const exact=String(search||'').trim().slice(0,240);
    const parcels=allowed&&!blocked?(await db.query(`SELECT s.id,s.shipment_number number,p->>'trackingNumber' tracking
      FROM sales_shipments s JOIN workspace_connectors c ON c.workspace_id=s.workspace_id AND c.id=s.shipping_connector_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(s.provider_packages)>0 THEN s.provider_packages
        ELSE jsonb_build_array(jsonb_build_object('trackingNumber',s.tracking_number)) END) p
      WHERE s.workspace_id=$1 AND s.provider='easypost' AND s.label_status='PURCHASED' AND s.shipped_at IS NOT NULL
        AND s.status IN ('SHIPPED','DELIVERED') AND c.status='connected' AND c.paused_at IS NULL
        AND nullif(p->>'trackingNumber','') IS NOT NULL
        AND ($2='' OR lower(s.shipment_number)=lower($2) OR p->>'trackingNumber'=$2)
      ORDER BY s.shipped_at DESC,s.id,p->>'trackingNumber' LIMIT 100`,[ctx.workspaceId,exact])).rows:[];
    return {allowed,blocked,rows,parcels,search:exact,selected:null};
  }
  const row=await get(db,ctx,id);
  const effect=row.effect_id?await effects.get(db,ctx.workspaceId,row.effect_id):null;
  const standing=await rule(db,ctx,row);
  return {allowed,blocked,rows,selected:{id,row,standing,status:effect?.status||'DRAFT',problem:effect?.errorMessage,canReapprove:mayReapprove(effect),
    canTeach:allowed&&(state.plan==='enterprise'||await example(db,ctx,row,1))}};
}

async function review(db,ctx){
  const {rows}=await page(db,ctx);
  return {rows:rows.map(row=>({Shipment:row.number,Tracking:row.tracking,Type:row.type,
    Status:row.receipt||row.status||'Draft',link:path+'/'+row.id})),action:{label:'Open carrier claims',href:path},
    summary:'Review, file and check lost or damaged parcel claims for existing EasyPost-insured shipments.'};
}

module.exports={path,action,limit,prepare,approve,saveRule,submit,verify,page,original,definition:{id:63,key:'carrier-claims',label:'File lost or damaged parcel claims',readPage:review}};
