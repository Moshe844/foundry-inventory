'use strict';

const crypto=require('node:crypto');
const { ValidationError,NotFoundError,InvariantError }=require('../domain/errors');
const { newId,nowIso }=require('../lib/util');
const addresses=require('./address');
const accounts=require('./postgres-accounts');
const defaultProviders=require('./provider');
const workflows=require('../operations/postgres-business-workflows');
const providerEffects=require('../operations/postgres-provider-effects');
const commercialControl=require('../commercial/control-service');

const RANK={UNKNOWN:0,PRE_TRANSIT:1,IN_TRANSIT:2,OUT_FOR_DELIVERY:3,FAILURE:3,DELIVERED:4,RETURNED:4,CANCELLED:4};

async function requireShipment(queryable,workspaceId,shipmentId,lock=false){
  const result=await queryable.query(`SELECT shipment.*,orders.order_number,orders.needed_by,orders.customer_id,orders.delivery_method,
      customer.name AS customer_name,orders.contact_email AS customer_email,orders.contact_phone AS customer_phone,
      location.name AS location_name,location.address AS location_address,location.phone AS location_phone,location.shipping_email AS location_shipping_email,
      original.carrier AS original_carrier
    FROM sales_shipments shipment JOIN sales_orders orders ON orders.id=shipment.sales_order_id
    LEFT JOIN customers customer ON customer.id=orders.customer_id
    LEFT JOIN locations location ON location.id=shipment.ship_from_location_id
    LEFT JOIN sales_shipments original ON original.id=shipment.return_outbound_shipment_id AND original.workspace_id=shipment.workspace_id
    WHERE shipment.workspace_id=$1 AND shipment.id=$2${lock?' FOR UPDATE OF shipment':''}`,[workspaceId,shipmentId]);
  if(!result.rows.length)throw new NotFoundError('That shipment could not be found.');
  return result.rows[0];
}

async function prepare(database,ctx,salesOrderId,input={}){
  if(!Array.isArray(input.lines)||!input.lines.length)throw new ValidationError('Choose at least one allocated line to pack.');
  const key=String(input.idempotencyKey||'').trim();
  if(!key)throw new ValidationError('A durable idempotency key is required.');
  return database.transaction(async(client)=>{
    const operation=await client.query(`INSERT INTO stockchief_runtime.business_operations
      (id,workspace_id,kind,idempotency_key) VALUES($1,$2,'shipping.prepare',$3)
      ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,[newId('pgop'),ctx.workspaceId,key]);
    if(!operation.rows.length){
      const prior=await client.query(`SELECT status,result FROM stockchief_runtime.business_operations
        WHERE workspace_id=$1 AND kind='shipping.prepare' AND idempotency_key=$2 FOR UPDATE`,[ctx.workspaceId,key]);
      if(prior.rows[0]?.status==='COMPLETED')return {...prior.rows[0].result,replayed:true};
      throw new InvariantError('That parcel preparation is already running.','operation_in_progress');
    }
    const order=(await client.query(`SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.workspaceId,salesOrderId])).rows[0];
    if(!order)throw new NotFoundError('That sales order was not found.');
    if(order.delivery_method!=='SHIP')throw new ValidationError('Only orders marked for shipping need a carrier parcel.');
    const destination=input.shipToAddress||order.ship_to_address;
    if(!addresses.parse(destination).complete)throw new ValidationError(addresses.why(addresses.parse(destination)));
    const actor=await client.query('SELECT id FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId]);
    if(!actor.rows.length)throw new ValidationError('The acting user does not belong to this inventory.');
    const shipmentId=newId('shp');
    const shipmentNumber=await require('../operations/postgres-business-numbers').next(client,ctx.workspaceId,'sales_shipments','SHP');
    const at=nowIso();
    await client.query(`INSERT INTO sales_shipments
      (id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,ship_to_address,
       handover,package_count,weight_grams,currency,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$11,$5,$6,'CARRIER',1,$7,$8,$9,$10,$10)`,[shipmentId,ctx.workspaceId,
      salesOrderId,shipmentNumber,input.shipFromLocationId||order.fulfillment_location_id,destination,
      input.weightGrams?Math.round(Number(input.weightGrams)):null,order.currency||'USD',ctx.actorId,at,input.startPicking?'PICKING':'PACKED']);
    for(const [index,line] of input.lines.entries()){
      const quantity=Number(line.quantity);
      if(!Number.isSafeInteger(quantity)||quantity<=0)throw new ValidationError(`Parcel line ${index+1} quantity must be a whole number above zero.`);
      const allocation=(await client.query(`SELECT allocation.*,order_line.sku_id
        FROM sales_order_allocations allocation JOIN sales_order_lines order_line ON order_line.id=allocation.sales_order_line_id
        WHERE allocation.workspace_id=$1 AND allocation.sales_order_line_id=$2 AND allocation.location_id=$3
          AND order_line.sales_order_id=$4 FOR UPDATE`,[ctx.workspaceId,line.lineId,line.locationId,salesOrderId])).rows[0];
      if(!allocation||quantity>Number(allocation.quantity))throw new ValidationError(`Parcel line ${index+1} exceeds its confirmed allocation.`);
      await client.query(`INSERT INTO sales_shipment_lines
        (id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[newId('shpl'),ctx.workspaceId,shipmentId,line.lineId,
        allocation.sku_id,line.locationId,quantity,at]);
    }
    if(!input.weightGrams){const weights=(await client.query(`SELECT sum(l.quantity*s.weight_grams)::bigint AS grams,count(*) FILTER(WHERE s.weight_grams IS NULL)::int AS missing FROM sales_shipment_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id WHERE l.workspace_id=$1 AND l.shipment_id=$2`,[ctx.workspaceId,shipmentId])).rows[0];
      if(!weights.missing&&Number(weights.grams)>0){await client.query('UPDATE sales_shipments SET weight_grams=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,shipmentId,weights.grams]);await client.query(`INSERT INTO shipment_packages(id,workspace_id,shipment_id,position,weight_grams,weight_source,created_at,updated_at) VALUES($1,$2,$3,1,$4,'ESTIMATED',$5,$5)`,[newId('pkg'),ctx.workspaceId,shipmentId,weights.grams,at]);}}
    const result={shipmentId,shipmentNumber,status:input.startPicking?'PICKING':'PACKED'};
    await client.query(`UPDATE stockchief_runtime.business_operations SET status='COMPLETED',result=$2::jsonb,
      completed_at=now() WHERE id=$1`,[operation.rows[0].id,JSON.stringify(result)]);
    return {...result,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function packagesFor(database,workspaceId,shipmentId){
  const existing=await database.query(`SELECT * FROM shipment_packages WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY position`,
    [workspaceId,shipmentId]);
  if(existing.rows.length)return existing.rows.map((row)=>({id:row.id,position:Number(row.position),weightGrams:Number(row.weight_grams),
    lengthMm:row.length_mm===null?null:Number(row.length_mm),widthMm:row.width_mm===null?null:Number(row.width_mm),
    heightMm:row.height_mm===null?null:Number(row.height_mm),estimated:row.weight_source==='ESTIMATED'}));
  const shipment=await requireShipment(database,workspaceId,shipmentId);
  return [{id:null,position:1,weightGrams:shipment.weight_grams?Number(shipment.weight_grams):null,
    lengthMm:null,widthMm:null,heightMm:null,estimated:false}];
}

function assertParcelEditable(shipment){
  if(!['PICKING','PACKED'].includes(shipment.status))
    throw new ValidationError('Only an unshipped parcel can be changed or cancelled.');
  if(['PURCHASED','PENDING','REVIEW','VOID_PENDING'].includes(shipment.label_status))
    throw new ValidationError('Resolve or void the saved label before changing or cancelling this parcel.');
  if(shipment.provider_packages?.some(p=>p.externalLabel===true))throw new ValidationError('This parcel has a label managed in an external shipping account. Resolve that label before changing the parcel.');
}

async function setPackages(database,ctx,shipmentId,boxes,options={}){
  return database.transaction(client=>setPackagesInTransaction(client,ctx,shipmentId,boxes,options),{isolation:'SERIALIZABLE',retrySafe:true});
}
async function setPackagesInTransaction(client,ctx,shipmentId,boxes,options={}){
  boxes=require('./parcel-contract').boxes(boxes);
    await require('./postgres-parcel-options').actor(client,ctx);
    const shipment=await requireShipment(client,ctx.workspaceId,shipmentId,true);
    assertParcelEditable(shipment);
    require('./postgres-parcel-options').unchanged(shipment,options.expectedUpdatedAt);
    await client.query('DELETE FROM shipment_packages WHERE workspace_id=$1 AND shipment_id=$2',[ctx.workspaceId,shipmentId]);
    await client.query('DELETE FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2',[ctx.workspaceId,shipmentId]);
    const now=nowIso();let total=0;
    for(const [index,box] of boxes.entries()){
      const weight=Math.round(Number(box.weightGrams));
      if(!Number.isSafeInteger(weight)||weight<=0)throw new ValidationError(`Package ${index+1} needs a positive weight in grams.`);
      total+=weight;
      await client.query(`INSERT INTO shipment_packages
        (id,workspace_id,shipment_id,position,weight_grams,length_mm,width_mm,height_mm,weight_source,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$10,$9,$9)`,[newId('pkg'),ctx.workspaceId,shipmentId,index+1,weight,
        box.lengthMm?Math.round(Number(box.lengthMm)):null,box.widthMm?Math.round(Number(box.widthMm)):null,
        box.heightMm?Math.round(Number(box.heightMm)):null,now,options.weightSource==='ESTIMATED'?'ESTIMATED':'MEASURED']);
    }
    await client.query(`UPDATE sales_shipments SET package_count=$3,weight_grams=$4,updated_at=$5
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentId,boxes.length,total,now]);
    return boxes;
}

async function state(database,workspaceId,shipmentId){
  const shipment=await requireShipment(database,workspaceId,shipmentId);
  let to=addresses.parse(shipment.ship_to_address);
  to.name=shipment.customer_name||to.name;to.email=shipment.customer_email;to.phone=shipment.customer_phone;
  let from=addresses.parse(shipment.location_address);
  from.name=shipment.location_name||from.name;from.phone=shipment.location_phone;from.email=shipment.location_shipping_email;
  if(shipment.customer_return_id){to={...to,name:shipment.location_name,phone:shipment.location_phone,email:shipment.location_shipping_email};from=shipment.return_origin||{};}
  const boxes=await packagesFor(database,workspaceId,shipmentId);
  const shippingAccounts=await accounts.allForWorkspace(database,workspaceId);
  const account=shippingAccounts[0]||null;
  const blocked=[];
  if(shipment.customer_return_id)try{await require('./postgres-return-parcels').assertCurrent(database,workspaceId,shipment);}catch(error){blocked.push(error.message);}
  if(!to.complete)blocked.push(addresses.why(to));
  if(!from.complete)blocked.push(`Add an address to ${shipment.location_name||'the dispatch warehouse'} (ship-from). ${addresses.why(from,'The dispatch address')}`);
  if(!to.phone)blocked.push('The customer needs a shipping phone number. StockChief will not invent one.');
  if(!from.phone)blocked.push('The ship-from location needs a shipping contact phone.');
  if(boxes.some((box)=>!(box.weightGrams>0)))blocked.push('Enter a measured package weight before requesting rates.');
  if(boxes.some(box=>box.estimated))blocked.push('Confirm the actual weight of every package. Saved package defaults are not a fresh measurement.');
  if(!account)blocked.push('Connect this inventory’s own postage account before requesting live rates.');
  const rates=await ratesFor(database,workspaceId,shipmentId);
  const quoteProblems=Array.isArray(shipment.shipping_quote_problems)?shipment.shipping_quote_problems:[];
  const events=(await database.query(`SELECT * FROM shipment_tracking_events
    WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY occurred_at DESC,id DESC`,[workspaceId,shipmentId])).rows;
  const labelOperation=(await database.query(`SELECT transaction.*,effect.status AS effect_status,
      effect.error_message AS effect_error_message,effect.id AS effect_id
    FROM shipping_label_transactions transaction
    LEFT JOIN stockchief_runtime.provider_effects effect ON effect.workspace_id=transaction.workspace_id
      AND effect.kind='shipping.label.purchase' AND effect.aggregate_id=transaction.shipment_id
      AND effect.payload->>'transactionId'=transaction.id
    WHERE transaction.workspace_id=$1 AND transaction.shipment_id=$2
    ORDER BY transaction.requested_at DESC,transaction.id DESC LIMIT 1`,[workspaceId,shipmentId])).rows[0]||null;
  return {shipment,to,from,boxes,account,shippingAccounts,blocked,ready:blocked.length===0,rates,events,labelOperation,quoteProblems};
}

function accountFingerprint(account){return crypto.createHash('sha256').update(JSON.stringify([
  account.connectorId,account.provider,account.apiKey])).digest('hex');}

function quoteFingerprint(view){
  const shipment=view.shipment||{};
  const payload={status:shipment.status,labelStatus:shipment.label_status,
    address:shipment.ship_to_address,locationId:shipment.ship_from_location_id,
    to:view.to,from:view.from,boxes:view.boxes,options:shipment.shipping_options||{},
    accounts:(view.shippingAccounts||(view.account?[view.account]:[])).map(accountFingerprint).sort()};
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function ratesFor(database,workspaceId,shipmentId){
  const result=await database.query(`SELECT * FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2
    ORDER BY amount_minor,delivery_days NULLS LAST,id`,[workspaceId,shipmentId]);
  const seen=new Set();
  return result.rows.filter((row)=>{const key=[row.connector_id,row.provider,row.carrier,row.service,row.currency,row.delivery_date||row.delivery_days,
    row.delivery_guaranteed].join('|');if(seen.has(key))return false;seen.add(key);return true;})
    .map((row)=>({...row,amountMinor:Number(row.amount_minor),deliveryDays:row.delivery_days===null?null:Number(row.delivery_days),
      guaranteed:Boolean(Number(row.delivery_guaranteed))}));
}

async function quote(database,ctx,shipmentId,options={}){
  const current=await state(database,ctx.workspaceId,shipmentId);
  if(!current.ready)return {...current,rates:[]};
  if(!['PACKED','PICKING'].includes(current.shipment.status)||['PURCHASED','PENDING','REVIEW','VOID_PENDING'].includes(current.shipment.label_status)||current.labelOperation?.status==='REVIEW')
    throw new ValidationError('Rates cannot change while a label is pending, purchased or already shipped.');
  const fingerprint=quoteFingerprint(current),key=options.idempotencyKey||newId('quote');
  const results=await Promise.allSettled(current.shippingAccounts.map(async account=>{
    const provider=options.providerResolver?options.providerResolver(account.provider):options.provider||defaultProviders.get(account.provider);
    const answer=await require('../commercial/operations').run(database,ctx.workspaceId,{capability:'shipping.rates',
      key:`${key}:${account.connectorId}`,provider:account.provider,operation:'carrier_quote'},
      ()=>provider.quote({...ctx,[accounts.KEY_FIELD[account.provider]]:account.apiKey},
        {to:current.to,from:current.from,packages:current.boxes,currency:current.shipment.currency,isReturn:Boolean(current.shipment.customer_return_id),originalCarrier:current.shipment.original_carrier,options:require('./parcel-contract').options(current.shipment.shipping_options||{})}));
    const sourceRates=Array.isArray(answer?.rates)?answer.rates:[],eligible=sourceRates.filter(rate=>require('./service-eligibility').allowed(rate,current.shipment.shipping_options||{})),supported=eligible.filter(rate=>
      typeof rate.amountMinor==='number'&&Number.isSafeInteger(rate.amountMinor)&&rate.amountMinor>=0&&
      (rate.rateId||rate.rateIds?.length)&&rate.carrier&&rate.service&&
      String(rate.currency||'').toUpperCase()===current.shipment.currency);
    const differentCurrency=sourceRates.some(rate=>String(rate.currency||'').toUpperCase()!==current.shipment.currency);
    const message=differentCurrency?'Offers in a different currency were excluded. No currency conversion was assumed.':sourceRates.length!==eligible.length?'Content-qualified postal services were excluded. Confirm eligibility in label preferences only if this parcel meets the carrier’s requirements.':
      supported.length!==sourceRates.length?'Unsupported provider rate details were excluded.':
      !supported.length?'This account has no available services for this parcel.':null;
    return {account,answer:{...answer,rates:supported},problem:message?{provider:account.provider,message}:null};
  }));
  const successful=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  const quoteProblems=results.flatMap((result,i)=>result.status==='rejected'?
    [{provider:current.shippingAccounts[i].provider,message:result.reason instanceof ValidationError?
      String(result.reason.message).replaceAll(current.shippingAccounts[i].apiKey,'[redacted]')
        .replaceAll(Buffer.from(current.shippingAccounts[i].apiKey+':').toString('base64'),'[redacted]').slice(0,500):
      'This shipping account could not return rates. Its offers are not included.'}]:
    result.value.problem?[result.value.problem]:[]);
  await database.transaction(async(client)=>{
    await requireShipment(client,ctx.workspaceId,shipmentId,true);
    const fresh=await state(client,ctx.workspaceId,shipmentId);
    if(quoteFingerprint(fresh)!==fingerprint)throw new ValidationError('The parcel or shipping accounts changed while rates were loading. Request fresh rates.');
    await client.query('DELETE FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2',[ctx.workspaceId,shipmentId]);
    const now=nowIso();
    await client.query(`UPDATE sales_shipments SET shipping_quote_problems=$3::jsonb,updated_at=$4
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentId,JSON.stringify(quoteProblems),now]);
    for(const {account,answer} of successful)for(const rate of answer.rates||[]){
      await client.query(`INSERT INTO shipment_rates
        (id,workspace_id,shipment_id,provider,provider_rate_id,carrier,service,amount_minor,currency,
         delivery_days,delivery_date,delivery_guaranteed,quoted_at,created_at,connector_id,account_fingerprint,
         parcel_fingerprint,provider_shipment_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT(shipment_id,connector_id,provider_rate_id) DO NOTHING`,[newId('rate'),ctx.workspaceId,shipmentId,
        account.provider,(rate.rateIds||[rate.rateId]).join(','),rate.carrier,rate.service,rate.amountMinor,
        rate.currency||'USD',rate.deliveryDays??null,rate.deliveryDate||null,rate.guaranteed?1:0,now,
        account.connectorId,accountFingerprint(account),fingerprint,JSON.stringify(answer.providerShipmentIds||[])]);
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return state(database,ctx.workspaceId,shipmentId);
}

async function queueLabelPurchase(database,ctx,shipmentId,rateId,input={}){
  const key=String(input.idempotencyKey||'').trim();
  if(!key)throw new ValidationError('A durable idempotency key is required.');
  return database.transaction(async(client)=>{
    const actor=(await client.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    require('../actions/permissions').assertCan(actor,require('../actions/permissions').ADMIN,'buy postage from the business shipping account');
    const shipment=await requireShipment(client,ctx.workspaceId,shipmentId,true);
    const prior=await client.query(`SELECT * FROM shipping_label_transactions
      WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,[ctx.workspaceId,key]);
    if(prior.rows.length){
      if(prior.rows[0].shipment_id!==shipmentId)throw new ValidationError('This purchase key belongs to another shipment.');
      const effect=(await client.query(`SELECT * FROM stockchief_runtime.provider_effects WHERE workspace_id=$1
        AND kind='shipping.label.purchase' AND payload->>'transactionId'=$2 ORDER BY created_at DESC LIMIT 1`,
      [ctx.workspaceId,prior.rows[0].id])).rows[0];
      if(effect&&effect.payload.rateId!==rateId)throw new ValidationError('This purchase key belongs to a different rate.');
      if(prior.rows[0].status==='SUCCEEDED')return {queued:false,replayed:true,shipment};
      if(prior.rows[0].status==='PENDING'&&effect)return {queued:true,replayed:true,effectId:effect.id,transactionId:prior.rows[0].id};
      if(prior.rows[0].status==='REVIEW')throw new InvariantError(
        'The carrier outcome is uncertain. StockChief will not buy this label again automatically.','shipping_purchase_ambiguous');
      throw new ValidationError(prior.rows[0].error_message||'The carrier refused that label purchase. Refresh rates before trying again.');
    }
    if(shipment.label_status==='PURCHASED'&&shipment.label_url)return {queued:false,replayed:true,shipment};
    if(shipment.provider_packages?.some(p=>p.externalLabel===true))throw new ValidationError('This parcel already has an external label. StockChief will not buy a second label. Manage the existing label in its shipping account.');
    if(['PENDING','REVIEW','VOID_PENDING'].includes(shipment.label_status))throw new ValidationError('A label purchase or void is pending or needs review for this shipment.');
    if((await client.query(`SELECT 1 FROM shipping_label_transactions WHERE workspace_id=$1 AND shipment_id=$2
      AND status IN ('PENDING','REVIEW')`,[ctx.workspaceId,shipmentId])).rows.length)
      throw new ValidationError('A label purchase is pending or needs review for this shipment.');
    if(!['PACKED','PICKING'].includes(shipment.status))throw new ValidationError('This shipment has already left or cannot purchase a label.');
    await require('./postgres-return-parcels').assertCurrent(client,ctx.workspaceId,shipment);
    const rate=(await client.query(`SELECT * FROM shipment_rates
      WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,[ctx.workspaceId,shipmentId,rateId])).rows[0];
    if(!rate)throw new ValidationError('Choose a current rate quoted for this parcel.');
    if(!require('./service-eligibility').allowed(rate,shipment.shipping_options||{}))throw new ValidationError('This postal service requires confirmed content eligibility. Review label preferences and request fresh rates before buying.');
    if(Date.now()-new Date(rate.quoted_at).getTime()>30*60_000)throw new ValidationError('This carrier quote expired. Refresh rates before purchasing a label.');
    const account=rate.connector_id?await accounts.forWorkspace(client,ctx.workspaceId,{connectorId:rate.connector_id,provider:rate.provider}):null;
    if(!account||accountFingerprint(account)!==rate.account_fingerprint||
      quoteFingerprint(await state(client,ctx.workspaceId,shipmentId))!==rate.parcel_fingerprint)
      throw new ValidationError('The parcel or shipping account changed. Request fresh rates before purchasing.');
    await require('./postgres-purchase-policy').assertWithin(client,ctx,rate);
    const id=newId('shiptxn');const now=nowIso();
    await client.query(`INSERT INTO shipping_label_transactions
      (id,workspace_id,shipment_id,provider,operation,status,idempotency_key,currency,
       requested_by_user_id,requested_at,updated_at,approved_amount_minor)
      VALUES($1,$2,$3,$4,'PURCHASE','PENDING',$5,$6,$7,$8,$8,$9)`,[id,ctx.workspaceId,shipmentId,rate.provider,
      key,rate.currency,ctx.actorId,now,rate.amount_minor]);
    const queued=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,kind:'shipping.label.purchase',
      provider:rate.provider,aggregateType:'shipment',aggregateId:shipmentId,idempotencyKey:key,
      requestedByUserId:ctx.actorId,payload:{transactionId:id,shipmentId,rateId:rate.id,actorId:ctx.actorId,
        providerRateId:rate.provider_rate_id,currency:rate.currency,connectorId:rate.connector_id,isReturn:Boolean(shipment.customer_return_id),
        accountFingerprint:rate.account_fingerprint,providerShipmentIds:rate.provider_shipment_ids,packageCount:(await packagesFor(client,ctx.workspaceId,shipmentId)).length,options:require('./parcel-contract').options(shipment.shipping_options||{})},
      priority:10,maxAttempts:12});
    await client.query(`UPDATE sales_shipments SET provider=$3,shipping_connector_id=$4,
      provider_shipment_id=$5,label_status='PENDING',updated_at=$6 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,shipmentId,rate.provider,rate.connector_id,(rate.provider_shipment_ids||[]).join(','),now]);
    return {queued:true,replayed:false,effectId:queued.effect.id,transactionId:id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function queueLabelVerificationWithin(client,effect){
  return require('../operations/postgres-job-queue').enqueue({query:(...args)=>client.query(...args),transaction:operation=>operation(client)},
    {workspaceId:effect.workspaceId,kind:'shipping.label.verify',payload:{effectId:effect.id,readOnlyVerification:true},
      idempotencyKey:'shipping-label-verification:'+effect.id,priority:10,maxAttempts:12});
}

async function recoverKnownLabelVerifications(client,options={}){
  const rows=(await client.query(`SELECT * FROM stockchief_runtime.provider_effects WHERE kind='shipping.label.purchase'
    AND status='AMBIGUOUS' AND provider_reference->>'externalId' IS NOT NULL
    ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;let resumed=0;
  for(const row of rows){
    if(row.error_code==='shipping_charge_exceeds_approval')continue;
    const provider=options.providerResolver?options.providerResolver(row.provider):defaultProviders.has(row.provider)?defaultProviders.get(row.provider):null;
    if(typeof provider?.verifyPurchase!=='function')continue;
    const effect=providerEffects.hydrate(row),queued=await queueLabelVerificationWithin(client,effect);
    if(!['PENDING','RUNNING','RETRY'].includes(queued.job.status))continue;
    await client.query(`UPDATE shipping_label_transactions SET status='PENDING',updated_at=$3
      WHERE workspace_id=$1 AND id=$2 AND status='REVIEW'`,[effect.workspaceId,effect.payload.transactionId,nowIso()]);
    await client.query(`UPDATE sales_shipments SET label_status='PENDING',updated_at=$3
      WHERE workspace_id=$1 AND id=$2 AND label_status='REVIEW'`,[effect.workspaceId,effect.aggregateId,nowIso()]);
    resumed++;
  }
  return {resumed};
}

async function confirmLabelPurchase(database,workspaceId,effect,token,rate,bought){
  const input=effect.payload;
  const exactReview=bought.currency===rate.currency&&Number.isSafeInteger(bought.amountMinor)&&bought.amountMinor>=0&&bought.amountMinor>Number(rate.amount_minor)
    &&await require('./postgres-receipt-review').covers(database,workspaceId,effect,bought);
  if(Number.isSafeInteger(bought.amountMinor)&&bought.amountMinor>=0&&(bought.currency!==rate.currency||bought.amountMinor>Number(rate.amount_minor)&&!exactReview)){
    const error=new InvariantError('The carrier reported a charge above the approved quote or in another currency. The actual charge is held for owner review; the purchase was not repeated.','shipping_charge_exceeds_approval');error.retryable=false;throw error;
  }
  const documents=require('./parcel-contract').documents(bought);
  const packages=require('./package-tracking').receipts(bought,input.packageCount||1);
  if(input.options&&documents.some(doc=>doc.kind==='LABEL'&&doc.format!==input.options.labelFormat))
    throw new InvariantError('The carrier returned a different print format. Verify its saved purchase before printing or repeating it.','shipping_label_format_unverified');
  if(!bought.labelUrl||!Number.isSafeInteger(bought.amountMinor)||bought.amountMinor<0||bought.currency!==rate.currency||bought.amountMinor>Number(rate.amount_minor)&&!exactReview)
    throw new InvariantError('The carrier label or its price needs verification. The purchase must not be repeated.','shipping_receipt_incomplete');
  return providerEffects.succeed(database,workspaceId,effect.id,token,{providerReference:
    bought.providerLabelIds||bought.providerShipmentIds||[],result:{trackingNumber:bought.trackingNumber,
      labelUrl:bought.labelUrl,amountMinor:bought.amountMinor,currency:bought.currency},
    apply:async(client)=>{const now=nowIso();
    await client.query(`UPDATE sales_shipments SET provider_rate_id=$3,provider_shipment_id=$4,label_url=$5,
      label_format=$6,label_status='PURCHASED',tracking_status='PRE_TRANSIT',tracked_at=$7,carrier=$8,
      service=$9,tracking_number=$10,tracking_url=$11,shipping_cost_minor=$12,currency=$13,
      expected_delivery_date=$14,shipping_documents=$15::jsonb,provider_packages=$16::jsonb,updated_at=$7 WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.shipmentId,
      rate.provider_rate_id,(bought.providerShipmentIds||[bought.providerShipmentId]).filter(Boolean).join(','),
      bought.labelUrl,bought.labelFormat||'PDF',now,bought.carrier,bought.service,bought.trackingNumber,bought.trackingUrl||null,
      bought.amountMinor,bought.currency,bought.deliveryDate||null,JSON.stringify(documents),JSON.stringify(packages)]);
    await client.query(`UPDATE shipping_label_transactions SET status='SUCCEEDED',provider_reference=$2,
      amount_minor=$3,currency=$4,detail='Carrier confirmed the label purchase.',error_message=NULL,completed_at=$5,updated_at=$5 WHERE id=$1`,
    [input.transactionId,JSON.stringify(bought.providerLabelIds||bought.providerShipmentIds||[]),bought.amountMinor,bought.currency,now]);
    const entitlements=require('../commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(client,workspaceId);
    await entitlements.commitUsage(client,scope,{meter:'connected_operations',idempotencyKey:workspaceId+':'+effect.idempotencyKey,
      detail:{verifiedProviderReceipt:true,providerEffectId:effect.id}});
    await client.query(`UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE account_id=$1
      AND fingerprint=$2 AND code='AMBIGUOUS_PROVIDER_USAGE'`,[scope.accountId,'ambiguous-usage:'+workspaceId+':'+effect.idempotencyKey]);
  }});
}

function knownPurchaseReference(value){
  if(!value||typeof value.externalId!=='string'||!value.externalId.trim()||value.externalId.length>500)return null;
  const ids=Array.isArray(value.externalIds)&&value.externalIds.length<=100&&value.externalIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=500)?value.externalIds:null;
  return {externalId:value.externalId,...(ids?{externalIds:ids}:{}),...(Number.isSafeInteger(value.expectedCount)&&value.expectedCount>0&&value.expectedCount<=100?{expectedCount:value.expectedCount}:{}),
    ...(typeof value.rateId==='string'&&value.rateId.length<=500?{rateId:value.rateId}:{})};
}

function knownCarrierCharge(receipt){try{if(Number.isSafeInteger(receipt?.amountMinor)&&receipt.amountMinor>=0)return {amountMinor:receipt.amountMinor,currency:require('../domain/currency').code(receipt.currency)};}catch{}return null;}

async function executeLabelPurchaseEffect(database,workspaceId,effectId,options={}){
  const claimed=await providerEffects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {shipment:await requireShipment(database,workspaceId,claimed.effect.aggregateId),replayed:true};
  const effect=claimed.effect;const input=effect.payload;const ctx={workspaceId,actorId:input.actorId};
  const shipment=await requireShipment(database,workspaceId,input.shipmentId);
  const fail=async(error,ambiguous=false,verificationPending=false)=>providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous,
    apply:async client=>{
      await client.query(`UPDATE shipping_label_transactions SET status=$3,error_message=$4,completed_at=$5,updated_at=$5
        WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.transactionId,verificationPending?'PENDING':ambiguous?'REVIEW':'FAILED',
        String(error.message||'The carrier operation failed.').slice(0,500),nowIso()]);
      await client.query(`UPDATE sales_shipments SET label_status=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2
        AND label_status='PENDING'`,[workspaceId,input.shipmentId,verificationPending?'PENDING':ambiguous?'REVIEW':'FAILED',nowIso()]);
      if(verificationPending)await queueLabelVerificationWithin(client,effect);
    }});
  const rate=(await database.query(`SELECT * FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,
    [workspaceId,input.shipmentId,input.rateId])).rows[0];
  if(!rate){const error=Object.assign(new ValidationError('The selected carrier rate no longer exists.'),{code:'shipping_rate_missing'});
    await fail(error);
    throw Object.assign(error,{retryable:false});}
  const held=input.connectorId?await accounts.contextFor(database,ctx,{connectorId:input.connectorId,provider:effect.provider}):null;
  if(!held||accountFingerprint(held.account)!==input.accountFingerprint){const error=Object.assign(new ValidationError('The quoted shipping account changed. Request fresh rates before buying this label.'),
    {code:'shipping_account_missing'});
    await fail(error);
    throw Object.assign(error,{retryable:false});}
  const provider=options.provider||defaultProviders.get(rate.provider);
  let bought,checkpointedReference=null;
  try{
    await require('./postgres-return-parcels').assertCurrent(database,workspaceId,shipment);
    bought=await require('../commercial/operations').run(database,workspaceId,{capability:'shipping.labels',key:effect.idempotencyKey,
      provider:rate.provider,operation:'label_purchase',unit:'label'},()=>provider.buy(held.ctx,
      {providerShipmentIds:input.providerShipmentIds||[],isReturn:input.isReturn===true,
       rateIds:String(rate.provider_rate_id).split(',').filter(Boolean),options:input.options||require('./parcel-contract').options(shipment.shipping_options||{}),idempotencyKey:effect.idempotencyKey,
       approvedAmountMinor:Number(rate.amount_minor),currency:rate.currency,onCheckpoint:async reference=>{
        const safe=knownPurchaseReference(reference);if(!safe)throw new InvariantError('The carrier operation identity could not be retained.','shipping_reference_invalid');
        await providerEffects.checkpoint(database,workspaceId,effectId,effect.claimToken,safe,{allowReferenceExtension:true});checkpointedReference=safe;
       }}));
  }catch(error){
    error.message=String(error.message||'The carrier operation failed.').replaceAll(held.account.apiKey,'[redacted]').replaceAll(Buffer.from(held.account.apiKey+':').toString('base64'),'[redacted]').slice(0,500);
    const ambiguous=!providerEffects.definiteFailure(error);
    const reference=checkpointedReference||knownPurchaseReference(error.providerReference);
    if(reference)await providerEffects.checkpoint(database,workspaceId,effectId,effect.claimToken,reference,{allowReferenceExtension:true});
    if(ambiguous&&reference&&typeof provider.verifyPurchase==='function'){
      error.code='provider_confirmation_pending';await fail(error,true,true);
      return {pending:true,verificationQueued:true,shipment:await requireShipment(database,workspaceId,input.shipmentId),replayed:false};
    }
    await fail(error,ambiguous);
    throw Object.assign(error,{code:ambiguous?'shipping_purchase_ambiguous':(error.code||'shipping_purchase_failed'),retryable:false});
  }
  try{
    const externalId=bought.providerLabelIds?.[0]||bought.providerShipmentIds?.[0]||bought.providerShipmentId;
    if(externalId)await providerEffects.checkpoint(database,workspaceId,effectId,effect.claimToken,{externalId,externalIds:bought.providerLabelIds||bought.providerShipmentIds||[externalId],expectedCount:(bought.providerLabelIds||bought.providerShipmentIds||[externalId]).length},{allowReferenceExtension:true});
    await confirmLabelPurchase(database,workspaceId,effect,effect.claimToken,rate,bought);
  }catch(error){const charge=knownCarrierCharge(bought);await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous:true,
    apply:async(client)=>{const at=nowIso();await client.query(`UPDATE shipping_label_transactions SET status='REVIEW',error_message=$2,
      completed_at=$3,updated_at=$3,amount_minor=coalesce($4,amount_minor),currency=coalesce($5,currency) WHERE id=$1 AND status='PENDING'`,[input.transactionId,
      error.code==='shipping_charge_exceeds_approval'?error.message:'The carrier may have accepted the purchase before StockChief could save its confirmation.',at,charge?.amountMinor??null,charge?.currency||null]);
      await client.query("UPDATE sales_shipments SET label_status='REVIEW',updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND label_status='PENDING'",[workspaceId,input.shipmentId,at]);}});
    throw Object.assign(new InvariantError('The carrier may have accepted this label purchase, but StockChief could not verify it. It was not retried.',
      'shipping_purchase_ambiguous'),{retryable:false,cause:error});}
  return {shipment:await requireShipment(database,workspaceId,input.shipmentId),replayed:false};
}

async function buyLabel(database,ctx,shipmentId,rateId,input={},options={}){const queued=await queueLabelPurchase(database,ctx,shipmentId,rateId,input);
  if(!queued.queued)return {shipment:queued.shipment,replayed:true};
  return executeLabelPurchaseEffect(database,ctx.workspaceId,queued.effectId,options);}

async function verifyLabelPurchaseEffect(database,workspaceId,effectId,options={}){
  const claimed=await providerEffects.claimVerification(database,workspaceId,effectId,'shipping.label.purchase');
  if(claimed.replayed)return {verified:true,replayed:true};
  const effect=claimed.effect,input=effect.payload,ctx={workspaceId,actorId:input.actorId};
  let confirmedCharge=null;try{
    const held=await accounts.contextFor(database,ctx,{connectorId:input.connectorId,provider:effect.provider});
    if(!held)throw Object.assign(new ValidationError('Reconnect this shipment’s shipping account to verify its existing label.'),{retryable:false});
    const provider=options.provider||defaultProviders.get(effect.provider);
    if(typeof provider.verifyPurchase!=='function')throw Object.assign(new ValidationError('This provider requires a manual check of the saved label transaction. The purchase was not repeated.'),{retryable:false});
    const rate=(await database.query(`SELECT * FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,[workspaceId,input.shipmentId,input.rateId])).rows[0];
    if(!rate)throw Object.assign(new ValidationError('The saved label rate is missing. Review the existing provider transaction before any new purchase.'),{retryable:false});
    const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(database,workspaceId);
    const bought=await require('../commercial/context').run({database,scope,system:true,requestId:'shipping-label-verification:'+effect.id},
      ()=>provider.verifyPurchase(held.ctx,effect.providerReference));
    confirmedCharge=knownCarrierCharge(bought);
    await confirmLabelPurchase(database,workspaceId,effect,effect.claimToken,rate,bought);
    return {verified:true,replayed:false,shipmentId:input.shipmentId};
  }catch(error){
    const retryable=error.retryable!==false&&!options.finalAttempt&&
      (error.providerOutcomeUncertain||!providerEffects.definiteFailure(error));
    const chargeReview=error.code==='shipping_charge_exceeds_approval';error.code=chargeReview?error.code:retryable?'provider_confirmation_pending':'shipping_label_verification_required';
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous:true,apply:async client=>{
      await client.query(`UPDATE shipping_label_transactions SET status=$3,error_message=$4,updated_at=$5,amount_minor=coalesce($6,amount_minor),currency=coalesce($7,currency)
        WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.transactionId,retryable?'PENDING':'REVIEW',
        chargeReview?error.message:retryable?'The carrier is still preparing the accepted label. StockChief is checking it without buying again.':
          'The existing carrier transaction needs review. StockChief did not repeat the purchase.',nowIso(),confirmedCharge?.amountMinor??null,confirmedCharge?.currency||null]);
      await client.query(`UPDATE sales_shipments SET label_status=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2
        AND label_status IN ('PENDING','REVIEW')`,[workspaceId,input.shipmentId,retryable?'PENDING':'REVIEW',nowIso()]);
    }});
    throw Object.assign(new ValidationError(retryable?'The accepted label is still being prepared. Verification will retry without another purchase.':
      'The saved label transaction needs attention. The purchase was not repeated.'),{code:error.code,retryable});
  }
}

async function markPacked(database,ctx,shipmentId,input={}){
 return database.transaction(async client=>{await require('./postgres-parcel-options').actor(client,ctx);const s=await requireShipment(client,ctx.workspaceId,shipmentId,true);
  if(s.status==='PACKED')return {replayed:true};if(s.status!=='PICKING')throw new ValidationError('Only a shipment being picked can be marked packed.');
  let boxes=await packagesFor(client,ctx.workspaceId,shipmentId),count=Number(input.packageCount||boxes.length||1);if(!Number.isSafeInteger(count)||count<1||count!==boxes.length)throw new ValidationError('Enter each box in parcel setup before confirming a different package count.');
  if(String(input.weightGrams||'').trim()){
   if(count!==1)throw new ValidationError('Confirm each package’s measured weight in parcel setup.');const weight=require('./parcel-contract').boxes([{weightGrams:input.weightGrams}])[0].weightGrams;
   boxes=await setPackagesInTransaction(client,ctx,shipmentId,[{...boxes[0],weightGrams:weight}]);
  }
  const total=boxes.every(b=>b.weightGrams>0)?boxes.reduce((n,b)=>n+b.weightGrams,0):null;await client.query("UPDATE sales_shipments SET status='PACKED',packed_at=$3,package_count=$4,weight_grams=$5,updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,shipmentId,nowIso(),count,total]);return {replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function handoff(database,ctx,shipmentId,input={}){
  return database.transaction(async client=>{
  const shipment=await requireShipment(client,ctx.workspaceId,shipmentId,true);
  if(shipment.customer_return_id){
    await require('./postgres-parcel-options').actor(client,ctx);
    if(['SHIPPED','DELIVERED'].includes(shipment.status))return {shipment,replayed:true};
    if(shipment.status!=='PACKED'||shipment.label_status!=='PURCHASED')throw new ValidationError('Verify the return label before recording the customer’s carrier handoff.');
    await client.query("UPDATE sales_shipments SET status=CASE WHEN tracking_status='DELIVERED' THEN 'DELIVERED' ELSE 'SHIPPED' END,handover='CARRIER',shipped_at=COALESCE(shipped_at,$3),updated_at=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,shipmentId,nowIso()]);
    return {shipment:await requireShipment(client,ctx.workspaceId,shipmentId),replayed:false,physicalReturnReceiptRequired:true};
  }
  if(shipment.status==='SHIPPED'||shipment.status==='DELIVERED')return {shipment,replayed:true};
  if(shipment.status!=='PACKED')throw new ValidationError('Pack this shipment before recording the handoff.');
  if(['PENDING','REVIEW','VOID_PENDING','VOIDED'].includes(shipment.label_status))
    throw new ValidationError('This label is pending, voided or needs verification. Resolve its saved request before confirming handoff.');
  const handover=String(input.handover||shipment.handover||'CARRIER').trim().toUpperCase().replace(/[\s-]+/g,'_');
  if(!['CARRIER','COLLECTED','DELIVERED_BY_US'].includes(handover))throw new ValidationError('Choose how the goods actually left.');
  const trackingNumber=String(input.trackingNumber||shipment.tracking_number||'').trim()||null;
  const selectedCarrier=String(input.carrier||shipment.carrier||'').trim();const carrier=require('../sales/carriers').lookup(selectedCarrier)?.code||selectedCarrier||require('../sales/carriers').detect(trackingNumber)?.code||null;
  if(handover!=='COLLECTED'&&!addresses.parse(shipment.ship_to_address).complete)
    throw new ValidationError('A complete destination is required before these goods can leave for delivery.');
  if(handover==='CARRIER'&&shipment.label_status!=='PURCHASED'&&!trackingNumber)
    throw new ValidationError('Enter the carrier tracking number, or buy and verify a label, before recording carrier handoff.');
  const lines=(await client.query(`SELECT sales_order_line_id AS "lineId",location_id AS "locationId",quantity
    FROM sales_shipment_lines WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY id`,[ctx.workspaceId,shipmentId])).rows;
  const result=await workflows.fulfillSalesOrderInTransaction(client,ctx,shipment.sales_order_id,{lines,
    idempotencyKey:`shipment-handoff:${shipmentId}`});
  const at=nowIso();
  await client.query(`UPDATE sales_shipments SET status=CASE WHEN tracking_status='DELIVERED' THEN 'DELIVERED' ELSE 'SHIPPED' END,handover=$3,carrier=COALESCE($4,carrier),
    service=COALESCE($5,service),tracking_number=COALESCE($6,tracking_number),
    expected_delivery_date=COALESCE($7,expected_delivery_date),shipping_cost_minor=COALESCE($8,shipping_cost_minor),
    shipped_at=COALESCE(shipped_at,$9),tracking_url=COALESCE($10,tracking_url),updated_at=$9 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentId,
    handover,carrier,String(input.service||'').trim()||null,trackingNumber,input.expectedDeliveryDate||null,
    input.shippingCostMinor??null,at,require('../sales/carriers').trackingUrlFor(carrier,trackingNumber)]);
  return {shipment:await requireShipment(client,ctx.workspaceId,shipmentId),fulfillment:result,replayed:result.replayed};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Reconcile a connected system's already-completed fulfillment. This records
// shipping evidence only: the canonical sales engine exclusively owns the
// inventory, costing and invoice effects. Never infer shipment lines from the
// whole order or rerun its physical handoff to create a missing shipment row.
async function recordProviderFulfillment(database,ctx,input){
  const seen=input.observation||{},identity=String(seen.externalFulfillmentId||'').trim();
  if(!identity||identity.length>240||!input.effectKey)throw new ValidationError('A verified provider fulfillment identity is required.');
  const text=(value,max)=>{const s=String(value||'').trim();if(s.length>max)throw new ValidationError('Provider tracking evidence is too long.');return s||null;};
  const carrier=text(seen.carrier,200),number=text(seen.trackingNumber,240),url=text(seen.trackingUrl,2048);
  if(url){let parsed;try{parsed=new URL(url);}catch{throw new ValidationError('Provider tracking must be a valid web address.');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new ValidationError('Provider tracking must be a public web link without credentials.');}
  return database.transaction(async client=>{
    const connection=(await client.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
      AND status='connected' AND paused_at IS NULL AND authorized_by_user_id=$3`,[ctx.workspaceId,input.connectorId,ctx.actorId])).rows[0];
    if(!connection)throw new ValidationError('The provider shipment does not belong to this authorized business connection.');
    const event=(await client.query(`SELECT * FROM connector_feed_events WHERE workspace_id=$1 AND connector_id=$2
      AND effect_key=$3 AND event_type='sales_order.fulfilled' AND status='COMPLETED' FOR SHARE`,[ctx.workspaceId,input.connectorId,input.effectKey])).rows[0];
    const normalized=typeof event?.normalized_payload==='string'?JSON.parse(event.normalized_payload):event?.normalized_payload;
    if(!event||String(normalized?.data?.externalOrderId)!==String(seen.externalOrderId))
      throw new ValidationError('The source shipment has no matching completed canonical fulfillment.');
    const order=(await client.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,event.action_record_id])).rows[0];
    if(!order)throw new ValidationError('The fulfilled sales order does not belong to this inventory.');
    const movementIds=typeof event.movement_ids==='string'?JSON.parse(event.movement_ids):event.movement_ids||[];
    if(!movementIds.length)throw new ValidationError('Reconcile the original physical fulfillment before recording its shipment.');
    const lines=(await client.query(`SELECT m.id,m.sku_id,m.location_id,-m.quantity_delta AS quantity,
      line.id AS line_id FROM movements m JOIN accounting_journal_entries journal ON journal.workspace_id=m.workspace_id
      AND journal.status='POSTED' AND journal.source_type='sale_fulfillment' AND journal.metadata::jsonb->>'movementId'=m.id
      JOIN sales_order_lines line ON line.workspace_id=m.workspace_id AND line.id=journal.metadata::jsonb->>'salesOrderLineId'
      WHERE m.workspace_id=$1 AND m.id=ANY($2::text[]) AND m.quantity_delta<0 AND journal.source_record_id=$3
      AND line.sales_order_id=$3 AND line.sku_id=m.sku_id ORDER BY m.id`,[ctx.workspaceId,movementIds,order.id])).rows;
    if(lines.length!==movementIds.length)throw new ValidationError('The source shipment is not fully backed by the recorded inventory and accounting effects.');
    if(seen.externalLocationId){const mapping=(await client.query("SELECT foundry_record_id FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='location' AND external_id=$3",[ctx.workspaceId,connection.id,seen.externalLocationId])).rows[0];
      if(!mapping||lines.some(line=>line.location_id!==mapping.foundry_record_id))throw new ValidationError('The provider shipment location does not match the recorded physical fulfillment.');}
    const shipments=[];
    for(const locationId of [...new Set(lines.map(line=>line.location_id))]){
      const key=`provider-fulfillment:${connection.id}:${input.effectKey}:${locationId}`;
      const operation=await client.query(`INSERT INTO stockchief_runtime.business_operations(id,workspace_id,kind,idempotency_key)
        VALUES($1,$2,'shipping.provider-observation',$3) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,[newId('pgop'),ctx.workspaceId,key]);
      if(!operation.rows.length){const prior=(await client.query("SELECT status,result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='shipping.provider-observation' AND idempotency_key=$2 FOR UPDATE",[ctx.workspaceId,key])).rows[0];
        if(prior?.status!=='COMPLETED')throw new InvariantError('The source shipment observation is already being recorded.','operation_in_progress');
        const shipment=await requireShipment(client,ctx.workspaceId,prior.result.shipmentId,true);
        if(shipment.sales_order_id!==order.id||shipment.ship_from_location_id!==locationId||shipment.provider_shipment_id!==identity)
          throw new InvariantError('The source fulfillment identity conflicts with its recorded shipment.','provider_shipment_conflict');
        shipments.push({...prior.result,replayed:true});continue;}
      const id=newId('shp'),name=await require('../operations/postgres-business-numbers').next(client,ctx.workspaceId,'sales_shipments','SHP'),at=nowIso(),shippedAt=input.occurredAt||at;
      await client.query(`INSERT INTO sales_shipments(id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,
        ship_to_address,handover,carrier,tracking_number,tracking_url,currency,notes,shipped_at,created_by_user_id,created_at,updated_at,
        provider,provider_shipment_id) VALUES($1,$2,$3,$4,'SHIPPED',$5,$6,'CARRIER',$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16)`,
      [id,ctx.workspaceId,order.id,name,locationId,order.ship_to_address,carrier,number,url,order.currency,
        `Fulfillment recorded by ${connection.display_name}. Inventory and accounting were verified separately.`,shippedAt,ctx.actorId,at,connection.provider_type,identity]);
      for(const line of lines.filter(line=>line.location_id===locationId))await client.query(`INSERT INTO sales_shipment_lines
        (id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[newId('shpl'),ctx.workspaceId,id,line.line_id,line.sku_id,locationId,Number(line.quantity),at]);
      const result={shipmentId:id,shipmentNumber:name,status:'SHIPPED'};shipments.push({...result,replayed:false});
      await client.query("UPDATE stockchief_runtime.business_operations SET status='COMPLETED',result=$2::jsonb,completed_at=now() WHERE id=$1",[operation.rows[0].id,JSON.stringify(result)]);
    }
    return {shipments};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function applyTracking(database,ctx,shipmentId,input={}){
  return database.transaction(async(client)=>{
    const shipment=await requireShipment(client,ctx.workspaceId,shipmentId,true);
    return applyTrackingInTransaction(client,ctx,shipment,input);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function applyTrackingInTransaction(client,ctx,shipment,input={}){
  const status=String(input.status||'UNKNOWN').toUpperCase();
  if(!Object.hasOwn(RANK,status))throw new ValidationError('The carrier tracking status is not recognized.');
  const externalId=String(input.externalEventId||'').trim();
  if(!externalId)throw new ValidationError('A carrier event id is required.');
  const now=nowIso();
  const tracked=require('./package-tracking').apply(shipment,{...input,status});
  const inserted=await client.query(`INSERT INTO shipment_tracking_events
    (id,workspace_id,shipment_id,provider,external_event_id,status,detail,location,occurred_at,created_at,tracking_number)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,shipment_id,external_event_id) DO NOTHING RETURNING id`,
  [newId('trackevt'),ctx.workspaceId,shipment.id,input.provider||shipment.provider||'manual',externalId,status,
    input.detail||null,input.location||null,input.occurredAt||now,now,input.trackingNumber||shipment.tracking_number]);
  if(!inserted.rows.length)return {applied:false,replayed:true,status:shipment.tracking_status};
  const next=tracked.status;
  await client.query(`UPDATE sales_shipments SET tracking_status=$3,tracking_status_detail=$4,tracked_at=$5,
    status=CASE WHEN $3='DELIVERED' AND status='SHIPPED' THEN 'DELIVERED' ELSE status END,
    delivered_at=CASE WHEN $3='DELIVERED' THEN COALESCE(delivered_at,$5) ELSE delivered_at END,
    exception_reason=CASE WHEN $3 IN ('FAILURE','RETURNED') THEN $4
      WHEN $3 IN ('DELIVERED','CANCELLED') THEN NULL ELSE exception_reason END,provider_packages=$6::jsonb,updated_at=$5
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipment.id,next,input.detail||null,input.occurredAt||now,JSON.stringify(tracked.packages)]);
  shipment.tracking_status=next;
  shipment.provider_packages=tracked.packages;
  return {applied:true,replayed:false,status:next};
}

async function receiveProviderEvent(database,ctx,providerName,event,options={}){
  const provider=options.provider||defaultProviders.get(providerName);
  const read=provider.readEvent(event)||{};
  const externalId=String(read.externalEventId||options.externalEventId||'').trim();
  if(!externalId)throw new ValidationError('The carrier event has no stable identity.');
  return database.transaction(async(client)=>{
    const prior=await client.query(`SELECT outcome FROM shipping_provider_events
      WHERE workspace_id=$1 AND provider=$2 AND external_event_id=$3`,[ctx.workspaceId,providerName,externalId]);
    if(prior.rows.length)return {applied:false,replayed:true,outcome:prior.rows[0].outcome};
    let shipment=null;
    if(read.providerShipmentId){
      shipment=(await client.query(`SELECT * FROM sales_shipments WHERE workspace_id=$1 AND provider=$3
        AND ($2=ANY(string_to_array(COALESCE(provider_shipment_id,''),',')) OR EXISTS(SELECT 1 FROM jsonb_array_elements(provider_packages) p WHERE p->>'externalId'=$2))
        AND ($4::text IS NULL OR shipping_connector_id=$4) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [ctx.workspaceId,String(read.providerShipmentId),providerName,options.connectorId||null])).rows[0]||null;
    }
    if(!shipment&&read.trackingNumber){
      shipment=(await client.query(`SELECT * FROM sales_shipments WHERE workspace_id=$1 AND provider=$3
        AND (tracking_number=$2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(provider_packages) p WHERE p->>'trackingNumber'=$2))
        AND ($4::text IS NULL OR shipping_connector_id=$4) ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[ctx.workspaceId,String(read.trackingNumber),providerName,options.connectorId||null])).rows[0]||null;
    }
    if(shipment&&options.connectorId&&shipment.shipping_connector_id!==options.connectorId)shipment=null;
    const outcome=shipment
      ?`Recorded ${String(read.status||'unknown').toLowerCase().replaceAll('_',' ')} for ${shipment.shipment_number}.`
      :'No shipment in this inventory matches that carrier event.';
    const now=nowIso();
    const inserted=await client.query(`INSERT INTO shipping_provider_events
      (id,workspace_id,provider,external_event_id,event_type,shipment_id,payload,outcome,received_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(workspace_id,provider,external_event_id) DO NOTHING RETURNING id`,
    [newId('shipevt'),ctx.workspaceId,providerName,externalId,read.type||null,shipment?.id||null,
      JSON.stringify(event||{}),outcome,now]);
    if(!inserted.rows.length)return {applied:false,replayed:true,outcome};
    // Existing delivery facts survive downgrade/exhaustion. This internal
    // reconciliation is cost-metered, not a new optional carrier request.
    const costScope=await require('../commercial/entitlements').ownerScopeForWorkspace(client,ctx.workspaceId);
    await require('../commercial/control-service').recordCost(client,costScope,{provider:providerName,
      operation:'tracking_webhook_reconciliation',unit:'event',quantity:1,providerVersion:'verified-webhook-v1',
      idempotencyKey:`shipping-webhook:${providerName}:${ctx.workspaceId}:${externalId}`,
      detail:{essentialReconciliation:true,customerUsageExempt:true}});
    if(!shipment)return {applied:false,replayed:false,outcome};
    const received=Array.isArray(read.events)&&read.events.length?read.events:[{status:read.status,detail:read.detail,
      location:read.location,occurredAt:read.occurredAt||now}];
    const events=received.map((entry,index)=>({...entry,
      externalEventId:entry.externalEventId||`${externalId}:${index}`}))
      .sort((left,right)=>String(left.occurredAt||'').localeCompare(String(right.occurredAt||'')));
    let applied=0;let latest=shipment.tracking_status;
    for(const entry of events){
      const result=await applyTrackingInTransaction(client,ctx,shipment,{provider:providerName,
        trackingNumber:read.trackingNumber,providerShipmentId:read.providerShipmentId,
        externalEventId:entry.externalEventId,status:entry.status||read.status||'UNKNOWN',
        detail:entry.detail||read.detail,location:entry.location,occurredAt:entry.occurredAt||now});
      if(result.applied)applied+=1;latest=result.status;
    }
    if(read.estimatedDeliveryDate||read.trackingUrl){
      await client.query(`UPDATE sales_shipments SET expected_delivery_date=COALESCE($3,expected_delivery_date),
        tracking_url=COALESCE($4,tracking_url),updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,shipment.id,read.estimatedDeliveryDate||null,read.trackingUrl||null,now]);
    }
    return {applied:applied>0,replayed:false,outcome,shipmentId:shipment.id,status:latest,eventsAdded:applied};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function refreshTracking(database,ctx,shipmentId,options={}){
  const shipment=await requireShipment(database,ctx.workspaceId,shipmentId);
  if(!shipment.tracking_number)throw new ValidationError('This shipment has no carrier tracking number yet.');
  const held=await accounts.contextFor(database,ctx,{connectorId:shipment.shipping_connector_id||null,provider:shipment.provider});
  if(!held)throw new ValidationError('Reconnect the postage account before checking the carrier.');
  const provider=options.provider||defaultProviders.get(held.account.provider);
  const packages=shipment.provider_packages?.length?shipment.provider_packages:[{trackingNumber:shipment.tracking_number,externalId:shipment.provider_shipment_id}];
  let latest={applied:false,status:shipment.tracking_status};
  for(const parcel of packages){
  const operation=()=>provider.track(held.ctx,{trackingNumber:parcel.trackingNumber,carrier:shipment.carrier,providerShipmentId:parcel.externalId});
  const read=options.essential?await require('../commercial/context').run({database,
    scope:await require('../commercial/entitlements').ownerScopeForWorkspace(database,ctx.workspaceId),system:true,requestId:'tracking:'+options.idempotencyKey},operation):
    await require('../commercial/operations').run(database,ctx.workspaceId,{capability:'shipping.tracking',
    key:(options.idempotencyKey||newId('track'))+':'+parcel.position+':'+parcel.trackingNumber,provider:held.account.provider,operation:'carrier_tracking'},operation);
  if(!read)continue;
  const events=read.events?.length?read.events:[{externalEventId:`summary:${parcel.trackingNumber}:${read.status}:${read.occurredAt||'undated'}`,
    status:read.status,detail:read.detail,location:read.location,occurredAt:read.occurredAt||nowIso()}];
  for(const event of events){
    latest=await applyTracking(database,ctx,shipmentId,{provider:held.account.provider,
      trackingNumber:parcel.trackingNumber,providerShipmentId:parcel.externalId,
      externalEventId:parcel.trackingNumber+':'+event.externalEventId,status:event.status||read.status,detail:event.detail||read.detail,
      location:event.location,occurredAt:event.occurredAt||nowIso()});
  }
  }
  return latest;
}

async function observeExternalLabel(database,ctx,shipmentId,input){
 const carrier=String(input.carrier||'').trim(),tracking=String(input.trackingNumber||'').trim(),event=String(input.externalEventId||'').trim();
 if(!carrier||!tracking||!event||carrier.length>200||tracking.length>240||event.length>240)throw new ValidationError('A carrier, tracking number and stable notification identity are required.');
 return database.transaction(async client=>{
  const connection=(await client.query(`SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND provider_type='shipstation_custom_store' AND status='connected' AND paused_at IS NULL AND authorized_by_user_id=$3`,[ctx.workspaceId,input.connectorId,ctx.actorId])).rows[0];
  if(!connection)throw new ValidationError('This shipping notification is not authorized for this inventory.');
  const shipment=await requireShipment(client,ctx.workspaceId,shipmentId,true);
  if(Number(shipment.package_count)>1)throw new ValidationError('Custom Store tracking needs individual package identities for this multi-package parcel. Use its connected shipping API instead.');
  if(!['PACKED','SHIPPED','DELIVERED'].includes(shipment.status))throw new ValidationError('The parcel must be packed before accepting an external label.');
  if(['PENDING','REVIEW','VOID_PENDING'].includes(shipment.label_status))throw new ValidationError('Resolve the pending label purchase before accepting another label.');
  if(shipment.tracking_number&&shipment.label_status!=='VOIDED'&&shipment.tracking_number!==tracking)throw new ValidationError('This parcel already has different tracking. Review the conflict before changing it.');
  const prior=(await client.query('SELECT id FROM shipment_tracking_events WHERE workspace_id=$1 AND shipment_id=$2 AND external_event_id=$3',[ctx.workspaceId,shipmentId,event])).rows[0];if(prior)return {replayed:true};
  const trackingUrl=require('../sales/carriers').trackingUrlFor(carrier,tracking),packages=[{externalId:event,trackingNumber:tracking,status:'PRE_TRANSIT',externalLabel:true,sourceConnectorId:input.connectorId}];
  await client.query(`UPDATE sales_shipments SET carrier=$3,service=$4,tracking_number=$5,tracking_url=$6,provider='shipstation_custom_store',provider_shipment_id=$7,
   label_status=CASE WHEN label_status='VOIDED' THEN NULL ELSE label_status END,provider_packages=$8::jsonb,updated_at=$9 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentId,carrier,input.service||null,tracking,trackingUrl,event,JSON.stringify(packages),nowIso()]);
  shipment.provider_packages=packages;shipment.tracking_number=tracking;
  return applyTrackingInTransaction(client,ctx,shipment,{provider:'shipstation_custom_store',externalEventId:event,trackingNumber:tracking,
   status:'PRE_TRANSIT',detail:'ShipStation supplied a label and tracking. Physical handoff has not been inferred.'});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={prepare,markPacked,requireShipment,assertParcelEditable,packagesFor,setPackages,state,quoteFingerprint,ratesFor,quote,queueLabelPurchase,observeExternalLabel,
  executeLabelPurchaseEffect,verifyLabelPurchaseEffect,recoverKnownLabelVerifications,buyLabel,handoff,recordProviderFulfillment,applyTracking,receiveProviderEvent,refreshTracking};
require('../commercial/enforcement').guardExports(module.exports,0,1,{queueLabelPurchase:'shipping.labels',
  prepare:'shipping.workflow',markPacked:'shipping.workflow',setPackages:'shipping.workflow',handoff:'shipping.workflow',applyTracking:'shipping.workflow',observeExternalLabel:'shipping.workflow',recordProviderFulfillment:'connections.commerce'});
