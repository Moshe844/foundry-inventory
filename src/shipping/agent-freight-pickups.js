'use strict';

const {createHash}=require('node:crypto');
const {AuthorizationError,NotFoundError,ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {userToMinor}=require('../domain/currency');
const policy=require('../commercial/agent-plan');
const operations=require('../commercial/operations');
const effects=require('../operations/postgres-provider-effects');
const access=require('../operations/postgres-warehouse-access');
const accounts=require('./postgres-accounts');
const adapter=require('./shipengine-freight');
const shipping=require('./postgres-service');

const action='shipping.freight_pickup';
const kind='agent.shipping.freight-pickup.v1';
const path='/autopilot/freight-pickups';
const hash=require('../pricing/postgres-promotions').hash;
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const stages=['PENDING','RUNNING','AMBIGUOUS','SUCCEEDED'];
const audit=(db,ctx,verb,pickup)=>require('../operations/postgres-security-audit').record(db,ctx,{
  action:verb,reference:pickup.id,after:{shipmentId:pickup.shipment_id,offer:pickup.approved_offer?.id}});

async function owner(db,ctx,lock=false){
  const row=(await db.query(`SELECT u.id,u.name FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.id=$2 AND u.workspace_id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)
    ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can manage freight pickups.');
  await access.assertInventoryWide(db,ctx);
  return row;
}

async function authorize(db,ctx,{lock=false,automatic=false}={}){
  await owner(db,ctx,lock);
  if(lock){
    await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
    await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=66 FOR SHARE',[ctx.workspaceId]);
  }
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,66,automatic?'automatic':'draft');
  const stop=await policy.stopped(db,ctx.workspaceId,state,action,automatic);
  if(stop)throw new ValidationError(stop);
  if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
    throw new ValidationError('Routine freight booking needs current automatic authority.');
  return state;
}

async function carrierAccount(db,ctx,connectorId,lock=false){
  if(lock)await db.query('SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,connectorId]);
  const connected=connectorId?await accounts.contextFor(db,ctx,{connectorId,provider:'shipengine'}):null;
  if(!connected||process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&!connected.account.testMode)
    throw new ValidationError('Choose the connected ShipStation API account with your active freight provider. Staging requires a sandbox key.');
  const fingerprint=createHash('sha256').update(JSON.stringify([connectorId,connected.account.apiKey])).digest('hex');
  return {...connected,fingerprint};
}

async function source(db,ctx,id,lock=false){
  const row=await shipping.requireShipment(db,ctx.workspaceId,id,lock);
  await access.assertLocations(db,ctx,[row.ship_from_location_id]);
  if(row.status!=='PACKED'||row.customer_return_id||['PURCHASED','PENDING','REVIEW','VOID_PENDING'].includes(row.label_status)||
    row.provider_packages?.some(parcel=>parcel.externalLabel)||row.tracking_number)
    throw new ValidationError('Choose an outbound packed shipment with no purchased label or existing tracking.');
  const address=require('./address');
  const from=address.parse(row.location_address);
  const to=address.parse(row.ship_to_address,row.ship_to_address_fields);
  if(!from.complete||!to.complete)throw new ValidationError('Confirm the complete warehouse and customer shipping addresses first.');
  const company=await require('../operations/postgres-company-profile').get(db,ctx.workspaceId);
  const origin={...from,company:company.legalName||row.location_name,name:row.location_name,
    phone:row.location_phone,email:row.location_shipping_email};
  const destination={...to,company:row.customer_name,name:to.name||row.customer_name,phone:row.customer_phone,email:row.customer_email};
  const basis={id,locationId:row.ship_from_location_id,number:row.shipment_number,order:row.order_number,
    customerId:row.customer_id,origin,destination,updatedAt:row.updated_at};
  return {...basis,fingerprint:hash(basis)};
}

async function read(db,ctx,key,execute){
  return operations.run(db,ctx.workspaceId,{key,provider:'shipengine',operation:'carrier_quote',capability:'shipping.workflow'},execute);
}

async function listAccounts(db,ctx,connectorId){
  await authorize(db,ctx);
  const connected=await carrierAccount(db,ctx,connectorId);
  return read(db,ctx,'freight-accounts:'+newId('read'),()=>adapter.accounts(connected.ctx));
}

async function get(db,ctx,id,lock=false){
  const pickup=(await db.query(`SELECT * FROM stockchief_runtime.agent_freight_pickups WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,
    [ctx.workspaceId,id])).rows[0];
  if(!pickup)throw new NotFoundError('That freight pickup is not in this inventory.');
  return pickup;
}

function palletsFromForm(body){
  const fields=['palletGroup','palletCount','palletLength','palletWidth','palletHeight','palletStackable',
    'commodityName','commodityCount','commodityWeight','commodityClass','commodityNmfc'];
  const values=Object.fromEntries(fields.map(field=>[field,Array.isArray(body[field])?body[field]:[body[field]??'']]));
  const count=values.palletGroup.length;
  if(count>100||fields.some(field=>values[field].length!==count))throw new ValidationError('Reload the pallet form and enter each group and commodity.');
  const groups=new Map();
  for(let index=0;index<count;index++){
    const row=Object.fromEntries(fields.map(field=>[field,String(values[field][index]).trim()]));
    if(!/^[1-9][0-9]?$/.test(row.palletGroup))throw new ValidationError('Enter the pallet group as a number between 1 and 99.');
    const physical={quantity:row.palletCount,length:row.palletLength,width:row.palletWidth,height:row.palletHeight,
      stackable:row.palletStackable==='yes'};
    const group=groups.get(row.palletGroup)||{...physical,commodities:[]};
    if(Object.keys(physical).some(key=>group[key]!==physical[key]))throw new ValidationError('Every commodity in a pallet group must use the same pallet count and dimensions.');
    group.commodities.push({description:row.commodityName,quantity:row.commodityCount,weight:row.commodityWeight,
      freightClass:row.commodityClass,nmfcCode:row.commodityNmfc});
    groups.set(row.palletGroup,group);
  }
  return [...groups.values()];
}

function safeToRequote(effect,pickup){
  return !effect||pickup.receipt?.status==='cancelled'||effect.status==='FAILED'&&effect.errorCode==='freight_pickup_before_dispatch';
}

async function prepare(db,ctx,input){
  await authorize(db,ctx);
  const current=await source(db,ctx,input.shipmentId);
  if(input.sourceFingerprint!==current.fingerprint)throw new ValidationError('The packed shipment changed. Reload its current addresses and details.');
  const connected=await carrierAccount(db,ctx,input.connectorId);
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const facts=adapter.build({...input,from:{...current.origin,locationType:input.fromType},to:{...current.destination,locationType:input.toType},
    pallets:input.pallets||palletsFromForm(input),accessorials:[input.accessorials||[]].flat()});
  if(facts.pickup.pickup_date<today)throw new ValidationError('Choose a pickup date today or later.');
  const available=await read(db,ctx,'freight-accounts:'+newId('read'),()=>adapter.accounts(connected.ctx));
  if(!available.some(x=>x.id===facts.accountId))throw new ValidationError('This freight provider is no longer active on the connected account.');
  const offers=await read(db,ctx,'freight-quotes:'+newId('read'),()=>adapter.quotes(connected.ctx,facts));
  if(!offers.length)throw new ValidationError('No current carrier offer covers this freight, lane and date.');
  return db.transaction(async c=>{
    const tx=scoped(c);
    const state=await authorize(tx,ctx,{lock:true});
    const live=await source(c,ctx,current.id,true);
    const active=await carrierAccount(tx,ctx,input.connectorId,true);
    if(live.fingerprint!==current.fingerprint||active.fingerprint!==connected.fingerprint)
      throw new ValidationError('The shipment or connected account changed while quoting. Request new quotes.');
    const prior=(await c.query('SELECT * FROM stockchief_runtime.agent_freight_pickups WHERE workspace_id=$1 AND shipment_id=$2 FOR UPDATE',
      [ctx.workspaceId,current.id])).rows[0];
    if(prior?.effect_id&&!safeToRequote(await effects.get(c,ctx.workspaceId,prior.effect_id),prior))
      throw new ValidationError('A carrier request already exists for this shipment. Review it before requesting another quote.');
    const id=prior?.id||newId('freight');
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'freight-quote:'+id+':'+(prior?.revision||0),
      Buffer.byteLength(JSON.stringify({facts,offers}))+16384,{finished:true});
    const values=[ctx.workspaceId,id,current.id,input.connectorId,connected.fingerprint,current.fingerprint,
      JSON.stringify(facts),JSON.stringify(offers),ctx.actorId];
    if(prior)await c.query(`UPDATE stockchief_runtime.agent_freight_pickups SET connector_id=$4,account_fingerprint=$5,
      source_fingerprint=$6,facts=$7::jsonb,offers=$8::jsonb,opened_by=$9,effect_id=NULL,approved_offer=NULL,receipt=NULL,rule_revision=NULL,revision=revision+1
      WHERE workspace_id=$1 AND id=$2 AND shipment_id=$3`,values);
    else await c.query(`INSERT INTO stockchief_runtime.agent_freight_pickups
      (workspace_id,id,shipment_id,connector_id,account_fingerprint,source_fingerprint,facts,offers,opened_by)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,values);
    await audit(c,ctx,'Freight quotes ready for review',{id,shipment_id:current.id});
    if(input.useRoutine==='yes'&&!await policy.stopped(tx,ctx.workspaceId,state,action,true)&&
      (await require('../autopilot/postgres-service').getState(tx,ctx.workspaceId)).canAutomate){
      const pickup=await get(c,ctx,id);
      for(const offer of [...offers].sort((a,b)=>a.amountMinor-b.amountMinor||a.id.localeCompare(b.id))){
        if(Date.parse(offer.expiresAt)<=Date.now())continue;
        const standing=await rule(c,ctx,pickup,offer,true);
        if(standing&&Number(standing.maximum_minor)>=offer.amountMinor)return queue(c,ctx,pickup,offer,standing);
      }
    }
    return {id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function scope(pickup,offer){
  const {shipFrom,shipTo,services,handling}=pickup.facts;
  // Routines reuse a reviewed lane and pallet profile. The owner can still
  // confirm the actual pickup date and window for each physical shipment.
  return hash([pickup.account_fingerprint,pickup.facts.accountId,shipFrom,shipTo,services,handling,offer.carrier,offer.service]);
}

async function rule(db,ctx,pickup,offer,lock=false){
  return (await db.query(`SELECT r.* FROM stockchief_runtime.agent_draft_rules r JOIN users u ON u.workspace_id=r.workspace_id
    AND u.id=r.authorized_by AND u.role='owner' WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key=$3
    ${lock?'FOR SHARE OF r,u':''}`,[ctx.workspaceId,action,scope(pickup,offer)])).rows[0];
}

async function exactOffer(db,ctx,id,input,{allowExpired=false}={}){
  const pickup=await get(db,ctx,id,true);
  const offer=pickup.offers.find(q=>q.id===input.offerId);
  if(Number(input.revision)!==pickup.revision||!offer||!allowExpired&&Date.parse(offer.expiresAt)<=Date.now())
    throw new ValidationError('Review an unexpired quote on this current shipment.');
  return {pickup,offer};
}

async function saveRule(db,ctx,id,input){
  return db.transaction(async c=>{
    await authorize(scoped(c),ctx,{lock:true});
    const {pickup,offer}=await exactOffer(c,ctx,id,input,{allowExpired:input.remove==='yes'});
    const prior=await rule(c,ctx,pickup,offer,true),key=scope(pickup,offer);
    if(input.confirmed!=='yes'||Number(input.ruleRevision)!==(prior?.revision||0))
      throw new ValidationError('Confirm this exact route, pallet profile, carrier and maximum quote before saving.');
    if(input.remove==='yes'){
      await c.query('DELETE FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3',
        [ctx.workspaceId,action,key]);
      await audit(c,ctx,'Freight booking rule removed',pickup);
      return;
    }
    const maximum=userToMinor(input.maximum,'USD',{label:'Maximum quoted freight cost'});
    if(maximum<offer.amountMinor)throw new ValidationError('Choose a maximum that covers the reviewed freight quote.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?0:1);
    await c.query(`INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by)
      VALUES($1,$2,$3,$4,'USD',$5,$6) ON CONFLICT(workspace_id,action_type,scope_key) DO UPDATE SET
      maximum_minor=EXCLUDED.maximum_minor,authorized_by=EXCLUDED.authorized_by,revision=agent_draft_rules.revision+1`,
    [ctx.workspaceId,action,key,offer.carrierName+' '+offer.service,maximum,ctx.actorId]);
    await audit(c,ctx,'Freight booking rule authorized',pickup);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function book(db,ctx,id,input){
  return db.transaction(async c=>{
    const tx=scoped(c),automatic=input.useRoutine==='yes';
    await authorize(tx,ctx,{lock:true,automatic});
    // Lock the shipment first, using the same order as parcel purchasing and handoff.
    const first=await get(c,ctx,id);
    if(first.effect_id)return {id,replayed:true};
    const current=await source(c,ctx,first.shipment_id,true);
    const {pickup,offer}=await exactOffer(c,ctx,id,input);
    if(pickup.effect_id)return {id,replayed:true};
    if(current.fingerprint!==pickup.source_fingerprint)throw new ValidationError('The packed shipment changed. Request fresh freight quotes.');
    const standing=automatic?await rule(c,ctx,pickup,offer,true):null;
    if(automatic&&(!standing||Number(standing.maximum_minor)<offer.amountMinor)||!automatic&&input.confirmed!=='yes')
      throw new ValidationError('Approve this exact quote or choose one covered by a saved routine.');
    return queue(c,ctx,pickup,offer,standing);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function queue(c,ctx,pickup,offer,standing){
  const {id,revision}=pickup;
  const {effect}=await effects.enqueueInTransaction(c,{workspaceId:ctx.workspaceId,kind:action,provider:'shipengine',
    aggregateType:'freight_pickup',aggregateId:id,requestedByUserId:ctx.actorId,maxAttempts:3,
    idempotencyKey:'freight-pickup:'+id+':'+revision,payload:{revision}});
  await c.query(`UPDATE stockchief_runtime.agent_freight_pickups SET approved_offer=$3::jsonb,effect_id=$4,rule_revision=$5
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,JSON.stringify(offer),effect.id,standing?.revision||null]);
  await audit(c,ctx,standing?'Freight pickup queued under saved authority':'Freight pickup individually approved',{...pickup,approved_offer:offer});
  return {id,queued:true};
}

async function record(db,ctx,effect,receipt,recovered=false){
  return effects.succeed(db,ctx.workspaceId,effect.id,effect.claimToken,{providerReference:{externalId:receipt.id},result:receipt,
    apply:async c=>{
      if(recovered)await operations.completeRetained(scoped(c),ctx.workspaceId,{operation:'freight_pickup_book',key:'freight-dispatch:'+effect.id},{recoveredByReadback:true});
      await c.query('UPDATE stockchief_runtime.agent_freight_pickups SET receipt=$3::jsonb WHERE workspace_id=$1 AND effect_id=$2',
        [ctx.workspaceId,effect.id,JSON.stringify(receipt)]);
    }});
}

async function dispatch(db,job){
  const pending=await effects.get(db,job.workspaceId,job.payload.effectId);
  if(pending.kind!==action)throw new ValidationError('This worker only handles authorized freight pickups.');
  const claimed=await effects.claim(db,job.workspaceId,pending.id);
  if(claimed.replayed)return claimed.effect;
  const effect=claimed.effect,ctx={workspaceId:job.workspaceId,actorId:effect.requestedByUserId};
  let attempted=false;
  try{
    await authorize(db,ctx);
    const pickup=await get(db,ctx,effect.aggregateId);
    const receipt=await operations.run(db,ctx.workspaceId,{operation:'freight_pickup_book',provider:'shipengine',
      capability:'shipping.workflow',key:'freight-dispatch:'+effect.id},async()=>{
      try{
        return await db.transaction(async c=>{
          const tx=scoped(c);
          await authorize(tx,ctx,{lock:true,automatic:pickup.rule_revision!==null});
          const shipment=await source(c,ctx,pickup.shipment_id,true);
          const current=await get(c,ctx,pickup.id,true),offer=current.approved_offer;
          const connected=await carrierAccount(tx,ctx,current.connector_id,true);
          const today=await require('../lib/business-time').today(tx,ctx.workspaceId);
          if(!offer||current.effect_id!==effect.id||current.revision!==effect.payload.revision||
            connected.fingerprint!==current.account_fingerprint||shipment.fingerprint!==current.source_fingerprint||
            Date.parse(offer.expiresAt)<=Date.now()||current.facts.pickup.pickup_date<today)
            throw new ValidationError('The freight quote, packed goods, pickup date or connected account changed. Request fresh quotes.');
          if(current.rule_revision!==null){
            const standing=await rule(c,ctx,current,offer,true);
            if(!standing||standing.revision!==current.rule_revision||Number(standing.maximum_minor)<offer.amountMinor)
              throw new ValidationError('This freight booking no longer has matching routine authority.');
          }
          attempted=true;
          return adapter.book(connected.ctx,current.facts,offer,{reference:current.id,
            onIdentity:id=>effects.checkpoint(db,ctx.workspaceId,effect.id,effect.claimToken,{externalId:id})});
        }); // A dispatch transaction containing one provider write is deliberately not retried.
      }catch(error){
        if(!attempted)error.providerWriteAttempted=false;
        throw error;
      }
    });
    return await record(db,ctx,effect,receipt);
  }catch(error){
    const sent=attempted&&error.providerWriteAttempted!==false;
    const saved=sent?error:Object.assign(new ValidationError(error.message),{code:'freight_pickup_before_dispatch'});
    await effects.finishError(db,ctx.workspaceId,effect.id,effect.claimToken,saved,{ambiguous:sent&&!effects.definiteFailure(error)});
    throw Object.assign(error,{retryable:false});
  }
}

async function verify(db,ctx,id){
  await owner(db,ctx);
  const pickup=await get(db,ctx,id);
  if(!pickup.effect_id)throw new ValidationError('This shipment does not have a freight booking to check.');
  const connected=await carrierAccount(db,ctx,pickup.connector_id);
  if(connected.fingerprint!==pickup.account_fingerprint)throw new ValidationError('Use the original connected freight account to check this booking.');
  const effect=await effects.get(db,ctx.workspaceId,pickup.effect_id);
  if(!effect.providerReference?.externalId)throw new ValidationError('The provider did not return a booking reference. Check the saved freight reference in the carrier portal.');
  const held=await effects.claimVerification(db,ctx.workspaceId,effect.id,action);
  try{
    const live=await read(db,ctx,'freight-verify:'+newId('read'),()=>adapter.retrieve(connected.ctx,pickup.facts.accountId,effect.providerReference.externalId));
    const receipt={...pickup.receipt,...live};
    if(!held.replayed)return await record(db,ctx,held.effect,receipt,true);
    await db.query('UPDATE stockchief_runtime.agent_freight_pickups SET receipt=$3::jsonb WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,id,JSON.stringify(receipt)]);
    return receipt;
  }catch(error){
    if(!held.replayed)await effects.finishError(db,ctx.workspaceId,effect.id,held.effect.claimToken,error,{ambiguous:true});
    throw error;
  }
}

async function currentFreight(db,workspaceId,shipmentId){
  const held=(await db.query(`SELECT e.status,p.receipt,p.approved_offer->>'carrier' carrier
    FROM stockchief_runtime.agent_freight_pickups p JOIN stockchief_runtime.provider_effects e
    ON e.workspace_id=p.workspace_id AND e.id=p.effect_id WHERE p.workspace_id=$1 AND p.shipment_id=$2`,[workspaceId,shipmentId])).rows[0];
  return stages.includes(held?.status)&&held.receipt?.status!=='cancelled'?held:null;
}

async function assertNoFreight(db,workspaceId,shipmentId){
  if(await currentFreight(db,workspaceId,shipmentId))
    throw new ValidationError('This shipment has a freight pickup. Review the saved booking before using another carrier or cancelling the shipment.');
}

async function page(db,ctx,{id,shipmentId,connectorId}={}){
  await owner(db,ctx);
  const plan=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(plan)&&policy.permits(plan.plan,66,'draft');
  const blocked=allowed?await policy.stopped(db,ctx.workspaceId,plan,action,false):null;
  const rows=(await db.query(`SELECT p.id,s.shipment_number,p.receipt,e.status
    FROM stockchief_runtime.agent_freight_pickups p JOIN sales_shipments s ON s.workspace_id=p.workspace_id AND s.id=p.shipment_id
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=p.workspace_id AND e.id=p.effect_id
    WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT 100`,[ctx.workspaceId])).rows;
  if(id){
    const selected=await get(db,ctx,id),effect=selected.effect_id?await effects.get(db,ctx.workspaceId,selected.effect_id):null;
    const rules=Object.create(null);
    if(allowed&&!blocked){
      const keys=selected.offers.map(offer=>scope(selected,offer));
      const saved=(await db.query(`SELECT scope_key,maximum_minor,revision FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1
        AND action_type=$2 AND scope_key=ANY($3::text[])`,[ctx.workspaceId,action,keys])).rows;
      for(const offer of selected.offers)rules[offer.id]=saved.find(row=>row.scope_key===scope(selected,offer))||null;
    }
    return {allowed,blocked,rows,selected,effect,rules,canRequote:safeToRequote(effect,selected)};
  }
  const live=allowed&&!blocked;
  const shipments=live?(await db.query(`SELECT id,shipment_number FROM sales_shipments WHERE workspace_id=$1 AND status='PACKED'
    AND customer_return_id IS NULL AND nullif(tracking_number,'') IS NULL AND (label_status IS NULL OR label_status IN('FAILED','VOIDED'))
    ORDER BY updated_at DESC,id LIMIT 100`,[ctx.workspaceId])).rows:[];
  const exact=live&&shipmentId?await source(db,ctx,shipmentId):null;
  const connectors=live?await accounts.connectorsFor(db,ctx.workspaceId,{provider:'shipengine'}):[];
  const freightAccounts=live&&exact&&connectorId?await listAccounts(db,ctx,connectorId):[];
  return {allowed,blocked,rows,selected:null,shipments,exact,connectors,connectorId,freightAccounts,
    locationTypes:[...adapter.locations],freightClasses:[...adapter.freightClasses],accessorials:adapter.accessorials};
}

async function review(db,ctx){
  const {rows}=await page(db,ctx);
  return {rows:rows.map(row=>({Shipment:row.shipment_number,Status:row.receipt?.status||row.status||'Quoted',link:path+'/'+row.id})),
    action:{label:'Open freight pickups',href:path},summary:'Quote measured pallets and book a carrier pickup through the inventory’s connected freight account.'};
}

module.exports={action,kind,path,prepare,book,saveRule,dispatch,verify,assertNoFreight,currentFreight,page,definition:{
  id:66,key:'freight-pickups',label:'Book pallet freight pickups',readPage:review}};
