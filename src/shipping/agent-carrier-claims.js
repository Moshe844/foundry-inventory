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
  const columns='id,shipment_id,parcel_id,connector_id,scope_key,facts,effect_id,automatic,rule_revision,receipt,route,source,filed_reference,filed_at,outcome,paid_minor,outcome_note,outcome_at,created_at';
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
      const filed=await fileAlone(c,ctx,row,currentState);
      if(filed)return filed;
    }
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function approve(db,ctx,id,input){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm filing this exact claim with the shipping account.');
  return db.transaction(async c=>{
    await authority(scoped(c),ctx);
    const row=await get(c,ctx,id,{lock:true});
    if(row.route==='portal')throw new ValidationError('File this claim on the carrier’s claim page, then record its claim number here.');
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
    if(row.route==='portal')throw new ValidationError('Claims filed on a carrier’s own page are always filed by a person.');
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
          // Filed on its own: the taught rule (or, on Custom, the owner's limit) must still cover it unchanged.
          const found=current.automatic?await standing(c,ctx,current,draftState):null;
          const trained=Boolean(found&&(found.rule?found.rule.revision===current.rule_revision:current.rule_revision==null));
          if(current.automatic)await authority(tx,ctx,true,trained);
          if(current.effect_id!==effect.id||current.automatic&&!trained)
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
  let receipt,saved;
  try{
    receipt=await providerRead(db,ctx,'carrier-claim-verify:'+newId('read'),()=>adapter.retrieve(held.ctx,row.facts));
    if(!checked.replayed)saved=await saveReceipt(db,ctx,checked.effect,receipt,true);
  }catch(error){
    if(!checked.replayed)await effects.finishError(db,ctx.workspaceId,checked.effect.id,checked.effect.claimToken,error,{ambiguous:true});
    throw error;
  }
  // The carrier's answer, when it has one: paid, denied or cancelled.
  await settle(db,ctx,row,receipt);
  return saved||receipt;
}

// ---- Job 63: claims that start from the carrier's evidence or a report ----
const settingsTable='stockchief_runtime.agent_claim_settings';
// Where each carrier takes claims from shippers when no claim API is connected.
const CLAIM_PAGES={ups:'https://www.ups.com/us/en/support/file-a-claim.page',fedex:'https://www.fedex.com/en-us/customer-support/claims.html',
  usps:'https://www.usps.com/help/claims.htm',dhl:'https://www.dhl.com/us-en/home/customer-service.html'};
const OUTCOMES={approved:'PAID',approved_partial:'PAID',rejected:'DENIED',cancelled:'CANCELLED'};

async function settings(db,workspaceId){
  return (await db.query(`SELECT * FROM ${settingsTable} WHERE workspace_id=$1`,[workspaceId])).rows[0]||null;
}
async function saveSettings(db,ctx,input){
  return db.transaction(async c=>{
    await owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,63,'draft');
    const claimant=requireText(input.claimant,'Business receiving claim payments',{max:150});
    const email=requireText(input.contactEmail,'Email for claim updates',{max:240}).toLowerCase();
    if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email))throw new ValidationError('Enter the business email for claim updates.');
    let limit=null;
    if(String(input.autoLimit||'').trim()){
      if(state.plan!=='enterprise')throw new ValidationError('Filing on its own up to an amount needs Custom. On Pro, file one claim yourself and save a rule from it.');
      limit=money.userToMinor(input.autoLimit,'USD',{label:'Most to claim on its own'});
      if(!limit||limit<=0)throw new ValidationError('Enter a positive amount, or leave it empty.');
    }
    const prior=await settings(c,ctx.workspaceId);
    await c.query(`INSERT INTO ${settingsTable}(workspace_id,claimant,contact_email,auto_limit_minor,updated_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id) DO UPDATE SET claimant=EXCLUDED.claimant,contact_email=EXCLUDED.contact_email,auto_limit_minor=EXCLUDED.auto_limit_minor,
      updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,[ctx.workspaceId,claimant,email,limit,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Carrier claim details saved',
      before:prior?{claimant:prior.claimant,contactEmail:prior.contact_email,autoLimitMinor:prior.auto_limit_minor}:{},after:{claimant,contactEmail:email,autoLimitMinor:limit}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// What may file this claim with no person: Pro within a taught rule, Custom
// within a rule or the owner's own limit.
async function standing(c,ctx,row,state){
  const saved=await rule(c,ctx,row,true);
  if(saved&&Number(saved.maximum_minor)>=row.facts.amountMinor&&(state.plan==='enterprise'||await example(c,ctx,row,Number(saved.maximum_minor))))return {rule:saved};
  if(state.plan==='enterprise'&&row.route==='api'){
    const limit=(await settings(c,ctx.workspaceId))?.auto_limit_minor;
    if(limit!=null&&Number(limit)>=row.facts.amountMinor&&(row.facts.currency||'USD')==='USD')return {rule:null,limit:Number(limit)};
  }
  return null;
}
async function fileAlone(c,ctx,row,state){
  if(row.route!=='api')return null;
  const found=await standing(c,ctx,row,state);
  const automated=(await c.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.mode==='POLICY_AUTOMATED';
  if(!found||!automated||!policy.permits(state.plan,63,'automatic',{trained:true})||await policy.stopped(scoped(c),ctx.workspaceId,state,action,true))return null;
  return queue(c,ctx,row,true,found.rule);
}

async function ownerId(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// The value of what was in the parcel, from the order's own prices.
async function shippedValue(db,workspaceId,s){
  const rows=(await db.query(`SELECT l.quantity,o.unit_price_minor,k.code,i.name FROM sales_shipment_lines l
    JOIN sales_order_lines o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_line_id
    JOIN skus k ON k.workspace_id=l.workspace_id AND k.id=l.sku_id JOIN items i ON i.workspace_id=k.workspace_id AND i.id=k.item_id
    WHERE l.workspace_id=$1 AND l.shipment_id=$2 ORDER BY l.id`,[workspaceId,s.id])).rows;
  if(!rows.length||rows.some(r=>r.unit_price_minor==null))return null;
  const line=r=>Math.round(Number(r.quantity)*Number(r.unit_price_minor));
  return {currency:s.order_currency,amountMinor:rows.reduce((sum,r)=>sum+line(r),0),
    lines:rows.map(r=>({Item:r.name,SKU:r.code,Quantity:String(r.quantity),'Unit price':money.format(Number(r.unit_price_minor),s.order_currency),Value:money.format(line(r),s.order_currency)}))};
}

// The claim pack: the invoice (or the shipped value), the carrier's tracking
// record with the report, and the photo when there is one.
async function evidencePack(db,workspaceId,s,value,report){
  const exports=require('../reports/exports');
  let invoice=null;
  const posted=(await db.query(`SELECT id FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2 AND status NOT IN ('DRAFT','VOID')
    ORDER BY created_at,id LIMIT 1`,[workspaceId,s.sales_order_id])).rows[0];
  if(posted){const document=require('../accounting/postgres-invoice-document');
    try{invoice=await document.pdf(await document.load(db,workspaceId,posted.id));}catch(error){if(!(error instanceof ValidationError))throw error;}}
  if(!invoice)invoice=await exports.pdf({config:{title:'Value of shipment '+s.shipment_number},sourceLabel:'Order '+s.order_number+', from its own prices',
    columns:['Item','SKU','Quantity','Unit price','Value'],rows:value.lines});
  const scans=(await db.query(`SELECT occurred_at,status,detail,location FROM shipment_tracking_events WHERE workspace_id=$1 AND shipment_id=$2
    ORDER BY occurred_at,id LIMIT 200`,[workspaceId,s.id])).rows.map(e=>({When:String(e.occurred_at).slice(0,16).replace('T',' '),
    'What happened':e.detail||String(e.status).toLowerCase().replaceAll('_',' '),Where:e.location||''}));
  if(report)scans.push({When:new Date().toISOString().slice(0,16).replace('T',' '),'What happened':report,Where:''});
  const correspondence=await exports.pdf({config:{title:'Tracking record '+s.tracking_number},sourceLabel:'Shipment '+s.shipment_number+' for order '+s.order_number,
    columns:['When','What happened','Where'],rows:scans.length?scans:[{When:'','What happened':'The carrier has recorded no scans.',Where:''}]});
  return {invoice,correspondence};
}

function photoFile(file){
  if(!file)return null;
  const buffer=file.buffer,signature=Buffer.isBuffer(buffer)?buffer.subarray(0,8):Buffer.alloc(0);
  if(!Buffer.isBuffer(buffer)||buffer.length<8||buffer.length>limit||!(signature.subarray(0,5).equals(Buffer.from('%PDF-'))||
    signature.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))||signature.equals(Buffer.from('89504e470d0a1a0a','hex'))))
    throw new ValidationError('Choose one JPEG, PNG or PDF of the damage, up to 1.5 MB.');
  return buffer;
}

// Open a claim from evidence: the carrier's own "lost" scan (job 62), or a
// staff or customer report. EasyPost-insured labels use the claim API; any
// other parcel gets the claim pack and the carrier's claim steps.
async function open(database,ctx,shipmentId,input,{photo=null,adapter=provider}={}){
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,63,'draft');
  const blocked=await policy.stopped(database,ctx.workspaceId,state,action,false);
  if(blocked)throw new ValidationError(blocked);
  const type=input.type,source=input.source;
  if(!['loss','damage'].includes(type)||!['carrier','staff','customer'].includes(source))throw new ValidationError('Say whether the parcel was lost or damaged, and who reported it.');
  const s=(await database.query(`SELECT s.*,o.order_number,o.currency order_currency FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    WHERE s.workspace_id=$1 AND s.id=$2`,[ctx.workspaceId,shipmentId])).rows[0];
  if(!s||s.customer_return_id||s.return_outbound_shipment_id||s.handover!=='CARRIER'||!['SHIPPED','DELIVERED'].includes(s.status)||!s.tracking_number)
    throw new ValidationError('Only a parcel that left with a carrier and has a tracking number can be claimed.');
  await access.assertLocations(database,ctx,[s.ship_from_location_id]);
  const prior=(await database.query('SELECT id FROM stockchief_runtime.agent_carrier_claims WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY created_at LIMIT 1',[ctx.workspaceId,s.id])).rows[0];
  if(prior)return {id:prior.id,replayed:true};
  const supporting=photoFile(photo);
  if(type==='damage'&&!supporting)throw new ValidationError('Add a photo of the damage. A damage claim needs it.');
  const who=await settings(database,ctx.workspaceId);
  if(!who)throw new ValidationError('Add the business that receives claim payments and the email for claim updates in Carrier claims first.');
  const value=await shippedValue(database,ctx.workspaceId,s);
  if(!value||value.amountMinor<=0)throw new ValidationError('A price is missing on this order, so the value of the parcel is unknown. Add the price before claiming.');
  const description=requireText(input.description,'What happened',{max:1600});
  const owned=await ownerId(database,ctx.workspaceId);if(!owned)throw new ValidationError('This inventory has no owner to approve claims.');
  const ownerCtx={workspaceId:ctx.workspaceId,actorId:owned};
  let route='portal',facts,connectorId=null,parcelId='tracking:'+s.tracking_number,key;
  if(s.provider==='easypost'&&s.label_status==='PURCHASED'&&value.currency==='USD'){
    try{
      const exact=await parcel(database,ownerCtx,s.id,s.tracking_number),held=await account(database,ownerCtx,exact.connectorId);
      const cover=await providerRead(database,ownerCtx,'carrier-claim-coverage:'+newId('read'),()=>adapter.findCoverage(held.ctx,exact));
      if(cover){
        route='api';connectorId=exact.connectorId;parcelId=exact.externalId;
        facts={...exact,insuranceId:cover.insuranceId,coverageMinor:cover.limitMinor,mode:cover.mode,accountFingerprint:held.fingerprint,
          type,amountMinor:Math.min(value.amountMinor,cover.limitMinor),valueMinor:value.amountMinor,currency:'USD',description,recipient:who.claimant,contactEmail:who.contact_email};
        key=hash([held.fingerprint,type,exact.location,who.claimant,who.contact_email]);
      }
    }catch(error){if(!(error instanceof ValidationError))throw error;}
  }
  if(route==='portal'){
    const carriers=require('../sales/carriers'),code=carriers.lookup(s.carrier)?.code||s.carrier||null;
    facts={number:s.shipment_number,trackingNumber:s.tracking_number,location:s.ship_from_location_id,carrier:code,carrierName:carriers.displayName(s.carrier)||'the carrier',
      claimPage:CLAIM_PAGES[code]||null,type,amountMinor:value.amountMinor,valueMinor:value.amountMinor,currency:value.currency,description,recipient:who.claimant,contactEmail:who.contact_email};
    key=hash(['portal',code,type,s.ship_from_location_id,who.claimant,who.contact_email]);
  }
  const pack=await evidencePack(database,ctx.workspaceId,s,value,source==='carrier'?null:(source==='customer'?'The customer reported: ':'Our staff reported: ')+description);
  const originals={invoice:pack.invoice,correspondence:pack.correspondence,supporting};
  return database.transaction(async c=>{
    const id=newId('claim');
    await require('../commercial/storage-capacity').reserve(scoped(c),ctx.workspaceId,'carrier-claim-originals:'+id,
      originals.invoice.length+originals.correspondence.length+(supporting?.length||0)+16384,{finished:true});
    const row=(await c.query(`INSERT INTO stockchief_runtime.agent_carrier_claims
      (workspace_id,id,shipment_id,parcel_id,connector_id,scope_key,opened_by,facts,evidence_hash,invoice,correspondence,supporting,route,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14) ON CONFLICT(workspace_id,parcel_id) DO NOTHING RETURNING *`,
    [ctx.workspaceId,id,s.id,parcelId,connectorId,key,ctx.actorId,JSON.stringify({...facts,reference:'stockchief-'+id}),evidenceHash(originals),
      originals.invoice,originals.correspondence,supporting,route,source])).rows[0];
    if(!row)return {id:(await c.query('SELECT id FROM stockchief_runtime.agent_carrier_claims WHERE workspace_id=$1 AND parcel_id=$2',[ctx.workspaceId,parcelId])).rows[0]?.id,replayed:true};
    await audit(c,ctx,'Carrier claim prepared from '+(source==='carrier'?'the carrier’s report':source==='customer'?'a customer report':'a staff report'),row);
    const filed=await fileAlone(c,ownerCtx,row,state);
    return filed?{...filed,route}:{id,route,automatic:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Job 62 found a parcel the carrier itself reports lost.
async function fromWatch(database,workspaceId,s,found){
  const state=await policy.accountState(database,workspaceId);
  if(found.problem!=='lost'||!policy.usesAgentTerms(state)||!policy.permits(state.plan,63,'draft'))return null;
  if(await policy.stopped(database,workspaceId,state,action,false)||!await settings(database,workspaceId))return null;
  const owned=await ownerId(database,workspaceId);if(!owned)return null;
  try{return await open(database,{workspaceId,actorId:owned},s.id,{type:'loss',source:'carrier',description:'The carrier reports the parcel lost: '+found.detail});}
  catch(error){if(error instanceof ValidationError||error?.code==='entitlement_required')return null;throw error;}
}

// A staff member records what they or the customer saw, with the photo.
async function report(database,ctx,shipmentId,input,files=[]){
  const user=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  require('../actions/permissions').assertCan(user,require('../actions/permissions').OPERATE,'report damaged or lost parcels');
  if(input.confirmed!=='yes')throw new ValidationError('Confirm that this is what happened to the parcel.');
  const photo=(files||[]).find(f=>f.field==='photo')||null;
  return open(database,ctx,shipmentId,{type:input.type,source:input.reportedBy==='customer'?'customer':'staff',description:input.description},{photo});
}

// A person filed a claim on the carrier's own page, and later its answer.
async function recordFiled(db,ctx,id,input){
  if(input.confirmed!=='yes')throw new ValidationError('Confirm that you filed this claim with the carrier.');
  const reference=requireText(input.reference,'The carrier’s claim number',{max:120});
  return db.transaction(async c=>{
    await authority(scoped(c),ctx);
    const row=await get(c,ctx,id,{lock:true});
    if(row.route!=='portal')throw new ValidationError('This claim is filed through the shipping account.');
    if(row.filed_at)return {id,replayed:true};
    await c.query(`UPDATE stockchief_runtime.agent_carrier_claims SET filed_reference=$3,filed_at=clock_timestamp(),filed_by=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,reference,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Carrier claim filed on the carrier’s page',reference:id,
      after:{shipmentId:row.shipment_id,claimNumber:reference,amountMinor:row.facts.amountMinor}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function recordOutcome(db,ctx,id,input){
  return db.transaction(async c=>{
    await owner(c,ctx,true);await policy.requireWorkspaceJob(c,ctx.workspaceId,63,'draft');
    const row=await get(c,ctx,id,{lock:true});
    if(row.route!=='portal'||!row.filed_at)throw new ValidationError('Record the carrier’s answer once the claim is filed.');
    if(row.outcome)return {id,replayed:true};
    const outcome=input.outcome==='paid'?'PAID':input.outcome==='denied'?'DENIED':null;
    if(!outcome)throw new ValidationError('Choose whether the carrier paid or denied the claim.');
    const paid=outcome==='PAID'?money.userToMinor(input.amount,row.facts.currency||'USD',{label:'Amount paid'}):null;
    if(outcome==='PAID'&&!(paid>0))throw new ValidationError('Enter the amount the carrier paid.');
    const note=String(input.note||'').trim().slice(0,500)||null;
    await c.query(`UPDATE stockchief_runtime.agent_carrier_claims SET outcome=$3,paid_minor=$4,outcome_note=$5,outcome_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,outcome,paid,note]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:outcome==='PAID'?'Carrier claim paid':'Carrier claim denied',reference:id,
      before:{outcome:null},after:{shipmentId:row.shipment_id,paidMinor:paid,currency:row.facts.currency||'USD',note}});
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Follow a filed claim to the carrier's answer: paid, denied or cancelled.
async function settle(db,ctx,row,receipt){
  const outcome=OUTCOMES[receipt.status]||null;
  const paid=outcome==='PAID'?(receipt.approvedMinor??(receipt.status==='approved'?receipt.amountMinor:null)):null;
  const decided=outcome&&(outcome!=='PAID'||paid!=null)?outcome:null;
  const done=(await db.query(`UPDATE stockchief_runtime.agent_carrier_claims SET receipt=$3::jsonb,checked_at=clock_timestamp(),
      outcome=$4,paid_minor=$5,outcome_note=$6,outcome_at=CASE WHEN $4::text IS NULL THEN NULL ELSE clock_timestamp() END
    WHERE workspace_id=$1 AND id=$2 AND outcome IS NULL RETURNING outcome`,
  [ctx.workspaceId,row.id,JSON.stringify(receipt),decided,decided==='PAID'?paid:null,decided?receipt.detail:null])).rows[0];
  if(done?.outcome)await require('../operations/postgres-security-audit').record(db,{workspaceId:ctx.workspaceId},{
    action:{PAID:'Carrier claim paid',DENIED:'Carrier claim denied',CANCELLED:'Carrier claim cancelled'}[done.outcome],
    reference:row.id,before:{outcome:null},after:{shipmentId:row.shipment_id,status:receipt.status,paidMinor:decided==='PAID'?paid:null,currency:'USD'}});
  return done?.outcome||null;
}
async function followUp(database,job,adapter=provider){
  const workspaceId=job.workspaceId,state=await policy.accountState(database,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,63,'draft'))return {skipped:'plan'};
  const owned=await ownerId(database,workspaceId);if(!owned)return {skipped:'owner'};
  const ctx={workspaceId,actorId:owned},result={checked:0,decided:0};
  const due=(await database.query(`SELECT c.id FROM stockchief_runtime.agent_carrier_claims c JOIN stockchief_runtime.provider_effects e
      ON e.workspace_id=c.workspace_id AND e.id=c.effect_id AND e.status='SUCCEEDED'
    WHERE c.workspace_id=$1 AND c.route='api' AND c.outcome IS NULL AND (c.checked_at IS NULL OR c.checked_at<now()-interval '12 hours')
    ORDER BY c.checked_at NULLS FIRST,c.id LIMIT 25`,[workspaceId])).rows;
  for(const {id} of due){
    const row=await get(database,ctx,id);
    try{
      const held=await account(database,ctx,row.connector_id);
      if(held.fingerprint!==row.facts.accountFingerprint)throw new ValidationError('The shipping account changed.');
      const receipt=await providerRead(database,ctx,'carrier-claim-follow-up:'+id+':'+newId('read'),()=>adapter.retrieve(held.ctx,row.facts));
      result.checked++;if(await settle(database,ctx,row,receipt))result.decided++;
    }catch(error){
      if(!(error instanceof ValidationError)&&error?.code!=='entitlement_required')throw error;
      await database.query('UPDATE stockchief_runtime.agent_carrier_claims SET checked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[workspaceId,id]);
    }
  }
  return result;
}
async function schedule(c,workspaceId,cycleId){
  if(!await require('../db/schema-installed').has(c,settingsTable))return {queued:false};
  const state=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,63,'draft'))return {queued:false};
  if(!(await c.query(`SELECT 1 FROM stockchief_runtime.agent_carrier_claims WHERE workspace_id=$1 AND route='api' AND outcome IS NULL AND effect_id IS NOT NULL
    AND (checked_at IS NULL OR checked_at<now()-interval '12 hours') LIMIT 1`,[workspaceId])).rowCount)return {queued:false};
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId,kind:'agent.carrier-claim-follow-up.v1',
    idempotencyKey:'carrier-claims:cycle:'+cycleId,payload:{cycleId},priority:60,maxAttempts:3});
  return {queued:true};
}

function statusOf(row){
  if(row.outcome)return {PAID:'Paid',DENIED:'Denied',CANCELLED:'Cancelled'}[row.outcome];
  if(row.route==='portal')return row.filed_at?'Filed, waiting for the carrier':'Ready for you to file with the carrier';
  if(row.receipt)return {submitted:'Filed, waiting for the carrier',in_review:'Being reviewed by the carrier',needs_action:'The carrier needs more from you',
    approved:'Approved',approved_partial:'Partly approved'}[row.receipt]||'Filed';
  return {PENDING:'Being filed',RUNNING:'Being filed',FAILED:'Held for review',AMBIGUOUS:'Waiting for the carrier to confirm',SUCCEEDED:'Filed'}[row.effect]||'Ready for you to file';
}

// What a shipment page shows: the claim for this parcel, or the report form.
async function forShipment(db,ctx,shipment){
  if(shipment.handover!=='CARRIER'||!['SHIPPED','DELIVERED'].includes(shipment.status)||shipment.customer_return_id||!shipment.tracking_number)return null;
  const state=await policy.accountState(db,ctx.workspaceId);
  if(!policy.usesAgentTerms(state))return null;
  if(!policy.permits(state.plan,63,'draft'))return {available:false};
  if(!await require('../db/schema-installed').has(db,settingsTable))return null;
  const claim=(await db.query(`SELECT c.id,c.route,c.outcome,c.filed_at,c.receipt->>'status' receipt,e.status effect FROM stockchief_runtime.agent_carrier_claims c
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=c.workspace_id AND e.id=c.effect_id
    WHERE c.workspace_id=$1 AND c.shipment_id=$2 ORDER BY c.created_at LIMIT 1`,[ctx.workspaceId,shipment.id])).rows[0]||null;
  return {available:true,claim,status:claim?statusOf(claim):null,blocked:await policy.stopped(db,ctx.workspaceId,state,action,false),
    settingsMissing:!await settings(db,ctx.workspaceId)};
}

// Needs you: claims a person must file, act on, or record the answer to.
async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,63,'draft'))return [];
  const {rows}=await db.query(`SELECT c.id,c.route,c.filed_at,c.created_at,c.facts->>'carrierName' carrier,(c.facts->>'amountMinor')::bigint amount,c.facts->>'currency' currency,
      c.receipt->>'status' receipt,e.status effect,o.order_number
    FROM stockchief_runtime.agent_carrier_claims c JOIN sales_shipments s ON s.workspace_id=c.workspace_id AND s.id=c.shipment_id
    JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=c.workspace_id AND e.id=c.effect_id
    WHERE c.workspace_id=$1 AND c.outcome IS NULL AND (
      (c.route='api' AND (c.effect_id IS NULL OR e.status='FAILED' OR c.receipt->>'status'='needs_action'))
      OR (c.route='portal' AND (c.filed_at IS NULL OR c.filed_at<now()-interval '14 days')))
    ORDER BY c.created_at,c.id LIMIT 25`,[workspaceId]);
  return rows.map(r=>{
    const amount=money.format(Number(r.amount),r.currency||'USD'),carrier=r.carrier||'the carrier';
    const [title,happened,next,label]=r.route==='portal'&&!r.filed_at
      ?['File the carrier claim for order '+r.order_number,'The claim pack for '+amount+' is ready.','File it on '+carrier+'’s claim page, then record the claim number.','Open the claim']
      :r.route==='portal'?['Record the carrier’s answer for order '+r.order_number,'The claim for '+amount+' was filed over two weeks ago.','Record whether '+carrier+' paid or denied it.','Record the answer']
      :r.receipt==='needs_action'?['The carrier needs more for the claim on order '+r.order_number,'The claim for '+amount+' is waiting on you.','Open the claim and answer the carrier in your shipping account.','Open the claim']
      :['File the carrier claim for order '+r.order_number,'The claim for '+amount+' is ready with its evidence.','One tap files it with the shipping account.','File the claim'];
    return {kind:'shipping',importance:'Needs You',priority:72,title,happened,why:'A lost or damaged parcel can be paid for by the carrier.',recommendation:next,
      href:path+'/'+r.id,actionLabel:label,sourceId:'carrier-claim:'+r.id,at:r.created_at,createdAt:r.created_at};
  });
}

async function page(db,ctx,id,search=''){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,63,'draft');
  const blocked=allowed?await policy.stopped(db,ctx.workspaceId,state,action,false):null;
  const rows=(await db.query(`SELECT c.id,c.route,c.outcome,c.filed_at,c.facts->>'number' number,c.facts->>'type' type,
    c.facts->>'trackingNumber' tracking,c.receipt->>'status' receipt,e.status effect
    FROM stockchief_runtime.agent_carrier_claims c LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=c.workspace_id
      AND e.id=c.effect_id WHERE c.workspace_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 100`,[ctx.workspaceId])).rows.map(r=>({...r,label:statusOf(r)}));
  const common={allowed,blocked,rows,details:allowed?await settings(db,ctx.workspaceId):null,custom:state.plan==='enterprise'};
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
    return {...common,parcels,search:exact,selected:null};
  }
  const row=await get(db,ctx,id);
  const effect=row.effect_id?await effects.get(db,ctx.workspaceId,row.effect_id):null;
  return {...common,selected:{id,row,standing:row.route==='api'?await rule(db,ctx,row):null,status:effect?.status||'DRAFT',
    label:statusOf({...row,receipt:row.receipt?.status,effect:effect?.status}),problem:effect?.errorMessage,canReapprove:mayReapprove(effect),
    canTeach:allowed&&row.route==='api'&&(state.plan==='enterprise'||await example(db,ctx,row,1))}};
}

async function review(db,ctx){
  const {rows}=await page(db,ctx);
  return {rows:rows.map(row=>({Shipment:row.number,Tracking:row.tracking,Type:row.type,Status:row.label,link:path+'/'+row.id})),
    action:{label:'Open carrier claims',href:path},
    summary:'Lost and damaged parcel claims: filed through the shipping account where it has a claim API, otherwise packed for a person to file, and followed until the carrier pays or denies them.'};
}

module.exports={path,action,limit,prepare,approve,saveRule,submit,verify,page,original,settings,saveSettings,open,fromWatch,report,recordFiled,recordOutcome,
  settle,followUp,schedule,forShipment,inbox,CLAIM_PAGES,definition:{id:63,key:'carrier-claims',label:'File lost or damaged parcel claims',readPage:review}};
