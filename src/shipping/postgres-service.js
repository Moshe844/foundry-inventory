'use strict';

const { ValidationError,NotFoundError,InvariantError }=require('../domain/errors');
const { newId,nowIso }=require('../lib/util');
const addresses=require('./address');
const accounts=require('./postgres-accounts');
const defaultProviders=require('./provider');
const workflows=require('../operations/postgres-business-workflows');
const providerEffects=require('../operations/postgres-provider-effects');

const RANK={UNKNOWN:0,PRE_TRANSIT:1,IN_TRANSIT:2,OUT_FOR_DELIVERY:3,FAILURE:3,DELIVERED:4,RETURNED:4,CANCELLED:4};

async function requireShipment(queryable,workspaceId,shipmentId,lock=false){
  const result=await queryable.query(`SELECT shipment.*,orders.order_number,orders.needed_by,orders.customer_id,
      customer.name AS customer_name,customer.email AS customer_email,customer.phone AS customer_phone,
      location.name AS location_name,location.address AS location_address,location.phone AS location_phone
    FROM sales_shipments shipment JOIN sales_orders orders ON orders.id=shipment.sales_order_id
    LEFT JOIN customers customer ON customer.id=orders.customer_id
    LEFT JOIN locations location ON location.id=shipment.ship_from_location_id
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
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`shipment-number:${ctx.workspaceId}`]);
    const count=await client.query('SELECT COUNT(*) AS count FROM sales_shipments WHERE workspace_id=$1',[ctx.workspaceId]);
    const shipmentId=newId('shp');
    const shipmentNumber=`SHP-${String(Number(count.rows[0].count)+1).padStart(5,'0')}`;
    const at=nowIso();
    await client.query(`INSERT INTO sales_shipments
      (id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,ship_to_address,
       handover,package_count,weight_grams,currency,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'PACKED',$5,$6,'CARRIER',1,$7,$8,$9,$10,$10)`,[shipmentId,ctx.workspaceId,
      salesOrderId,shipmentNumber,input.shipFromLocationId||order.fulfillment_location_id,destination,
      input.weightGrams?Math.round(Number(input.weightGrams)):null,order.currency||'USD',ctx.actorId,at]);
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
    const result={shipmentId,shipmentNumber,status:'PACKED'};
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

async function setPackages(database,ctx,shipmentId,boxes){
  if(!Array.isArray(boxes)||!boxes.length)throw new ValidationError('A shipment needs at least one package.');
  return database.transaction(async(client)=>{
    await requireShipment(client,ctx.workspaceId,shipmentId,true);
    await client.query('DELETE FROM shipment_packages WHERE workspace_id=$1 AND shipment_id=$2',[ctx.workspaceId,shipmentId]);
    const now=nowIso();let total=0;
    for(const [index,box] of boxes.entries()){
      const weight=Math.round(Number(box.weightGrams));
      if(!Number.isSafeInteger(weight)||weight<=0)throw new ValidationError(`Package ${index+1} needs a positive weight in grams.`);
      total+=weight;
      await client.query(`INSERT INTO shipment_packages
        (id,workspace_id,shipment_id,position,weight_grams,length_mm,width_mm,height_mm,weight_source,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'MEASURED',$9,$9)`,[newId('pkg'),ctx.workspaceId,shipmentId,index+1,weight,
        box.lengthMm?Math.round(Number(box.lengthMm)):null,box.widthMm?Math.round(Number(box.widthMm)):null,
        box.heightMm?Math.round(Number(box.heightMm)):null,now]);
    }
    await client.query(`UPDATE sales_shipments SET package_count=$3,weight_grams=$4,updated_at=$5
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentId,boxes.length,total,now]);
    return boxes;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function state(database,workspaceId,shipmentId){
  const shipment=await requireShipment(database,workspaceId,shipmentId);
  const to=addresses.parse(shipment.ship_to_address);
  to.name=shipment.customer_name||to.name;to.email=shipment.customer_email;to.phone=shipment.customer_phone;
  const from=addresses.parse(shipment.location_address);
  from.name=shipment.location_name||from.name;from.phone=shipment.location_phone;
  const boxes=await packagesFor(database,workspaceId,shipmentId);
  const account=await accounts.forWorkspace(database,workspaceId);
  const blocked=[];
  if(!to.complete)blocked.push(addresses.why(to));
  if(!from.complete)blocked.push(`The ship-from location is incomplete: ${addresses.why(from)}`);
  if(!to.phone)blocked.push('The customer needs a shipping phone number. StockChief will not invent one.');
  if(!from.phone)blocked.push('The ship-from location needs a shipping contact phone.');
  if(boxes.some((box)=>!(box.weightGrams>0)))blocked.push('Enter a measured package weight before requesting rates.');
  if(!account)blocked.push('Connect this inventory’s own postage account before requesting live rates.');
  const rates=await ratesFor(database,workspaceId,shipmentId);
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
  return {shipment,to,from,boxes,account,blocked,ready:blocked.length===0,rates,events,labelOperation};
}

async function ratesFor(database,workspaceId,shipmentId){
  const result=await database.query(`SELECT * FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2
    ORDER BY amount_minor,delivery_days NULLS LAST,id`,[workspaceId,shipmentId]);
  const seen=new Set();
  return result.rows.filter((row)=>{const key=[row.carrier,row.service,row.currency,row.delivery_date||row.delivery_days,
    row.delivery_guaranteed].join('|');if(seen.has(key))return false;seen.add(key);return true;})
    .map((row)=>({...row,amountMinor:Number(row.amount_minor),deliveryDays:row.delivery_days===null?null:Number(row.delivery_days),
      guaranteed:Boolean(Number(row.delivery_guaranteed))}));
}

async function quote(database,ctx,shipmentId,options={}){
  const current=await state(database,ctx.workspaceId,shipmentId);
  if(!current.ready)return {...current,rates:[]};
  const held=await accounts.contextFor(database,ctx);
  const provider=options.provider||defaultProviders.get(held.account.provider);
  const answer=await provider.quote(held.ctx,{to:current.to,from:current.from,packages:current.boxes});
  await database.transaction(async(client)=>{
    await client.query('DELETE FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2',[ctx.workspaceId,shipmentId]);
    const now=nowIso();
    for(const rate of answer.rates||[]){
      await client.query(`INSERT INTO shipment_rates
        (id,workspace_id,shipment_id,provider,provider_rate_id,carrier,service,amount_minor,currency,
         delivery_days,delivery_date,delivery_guaranteed,quoted_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        ON CONFLICT(shipment_id,provider_rate_id) DO NOTHING`,[newId('rate'),ctx.workspaceId,shipmentId,
        held.account.provider,(rate.rateIds||[rate.rateId]).join(','),rate.carrier,rate.service,rate.amountMinor,
        rate.currency||'USD',rate.deliveryDays??null,rate.deliveryDate||null,rate.guaranteed?1:0,now]);
    }
    await client.query(`UPDATE sales_shipments SET provider=$3,provider_shipment_id=$4,updated_at=$5
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentId,held.account.provider,
      (answer.providerShipmentIds||[]).join(','),now]);
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return state(database,ctx.workspaceId,shipmentId);
}

async function queueLabelPurchase(database,ctx,shipmentId,rateId,input={}){
  const key=String(input.idempotencyKey||'').trim();
  if(!key)throw new ValidationError('A durable idempotency key is required.');
  return database.transaction(async(client)=>{
    const shipment=await requireShipment(client,ctx.workspaceId,shipmentId,true);
    if(shipment.label_status==='PURCHASED'&&shipment.label_url)return {queued:false,replayed:true,shipment};
    const prior=await client.query(`SELECT * FROM shipping_label_transactions
      WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,[ctx.workspaceId,key]);
    if(prior.rows.length){
      if(prior.rows[0].status==='SUCCEEDED')return {queued:false,replayed:true,shipment};
      const effect=(await client.query(`SELECT * FROM stockchief_runtime.provider_effects WHERE workspace_id=$1
        AND kind='shipping.label.purchase' AND payload->>'transactionId'=$2 ORDER BY created_at DESC LIMIT 1`,
      [ctx.workspaceId,prior.rows[0].id])).rows[0];
      if(prior.rows[0].status==='PENDING'&&effect)return {queued:true,replayed:true,effectId:effect.id,transactionId:prior.rows[0].id};
      if(prior.rows[0].status==='REVIEW')throw new InvariantError(
        'The carrier outcome is uncertain. StockChief will not buy this label again automatically.','shipping_purchase_ambiguous');
      throw new ValidationError(prior.rows[0].error_message||'The carrier refused that label purchase. Refresh rates before trying again.');
    }
    const rate=(await client.query(`SELECT * FROM shipment_rates
      WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,[ctx.workspaceId,shipmentId,rateId])).rows[0];
    if(!rate)throw new ValidationError('Choose a current rate quoted for this parcel.');
    const actor=(await client.query('SELECT id FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!actor)throw new ValidationError('The acting user does not belong to this inventory.');
    const id=newId('shiptxn');const now=nowIso();
    await client.query(`INSERT INTO shipping_label_transactions
      (id,workspace_id,shipment_id,provider,operation,status,idempotency_key,currency,
       requested_by_user_id,requested_at,updated_at)
      VALUES($1,$2,$3,$4,'PURCHASE','PENDING',$5,$6,$7,$8,$8)`,[id,ctx.workspaceId,shipmentId,rate.provider,
      key,rate.currency,ctx.actorId,now]);
    const queued=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,kind:'shipping.label.purchase',
      provider:rate.provider,aggregateType:'shipment',aggregateId:shipmentId,idempotencyKey:key,
      requestedByUserId:ctx.actorId,payload:{transactionId:id,shipmentId,rateId:rate.id,actorId:ctx.actorId,
        providerRateId:rate.provider_rate_id,currency:rate.currency,providerShipmentId:shipment.provider_shipment_id},
      priority:10,maxAttempts:12});
    return {queued:true,replayed:false,effectId:queued.effect.id,transactionId:id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function executeLabelPurchaseEffect(database,workspaceId,effectId,options={}){
  const claimed=await providerEffects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {shipment:await requireShipment(database,workspaceId,claimed.effect.aggregateId),replayed:true};
  const effect=claimed.effect;const input=effect.payload;const ctx={workspaceId,actorId:input.actorId};
  const shipment=await requireShipment(database,workspaceId,input.shipmentId);
  const rate=(await database.query(`SELECT * FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3`,
    [workspaceId,input.shipmentId,input.rateId])).rows[0];
  if(!rate){const error=Object.assign(new ValidationError('The selected carrier rate no longer exists.'),{code:'shipping_rate_missing'});
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous:false,
      apply:(client)=>client.query(`UPDATE shipping_label_transactions SET status='FAILED',error_message=$2,
        completed_at=$3,updated_at=$3 WHERE id=$1`,[input.transactionId,error.message,nowIso()])});
    throw Object.assign(error,{retryable:false});}
  const held=await accounts.contextFor(database,ctx);
  if(!held){const error=Object.assign(new ValidationError('Reconnect the postage account before buying this label.'),
    {code:'shipping_account_missing'});
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous:false,
      apply:(client)=>client.query(`UPDATE shipping_label_transactions SET status='FAILED',error_message=$2,
        completed_at=$3,updated_at=$3 WHERE id=$1`,[input.transactionId,error.message,nowIso()])});
    throw Object.assign(error,{retryable:false});}
  const provider=options.provider||defaultProviders.get(rate.provider);
  let bought;
  try{
    bought=await provider.buy(held.ctx,{providerShipmentIds:String(shipment.provider_shipment_id||'').split(',').filter(Boolean),
      rateIds:String(rate.provider_rate_id).split(',').filter(Boolean),idempotencyKey:effect.idempotencyKey});
  }catch(error){
    const ambiguous=!providerEffects.definiteFailure(error);
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous,
      apply:(client)=>client.query(`UPDATE shipping_label_transactions SET status=$2,error_message=$3,
        completed_at=$4,updated_at=$4 WHERE id=$1`,[input.transactionId,ambiguous?'REVIEW':'FAILED',
        String(error.message||'Carrier operation failed.').slice(0,500),nowIso()])});
    throw Object.assign(error,{code:ambiguous?'shipping_purchase_ambiguous':(error.code||'shipping_purchase_failed'),retryable:false});
  }
  try{await providerEffects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:
    bought.providerLabelIds||bought.providerShipmentIds||[],result:{trackingNumber:bought.trackingNumber,
      labelUrl:bought.labelUrl,amountMinor:bought.amountMinor,currency:bought.currency||rate.currency},
    apply:async(client)=>{const now=nowIso();
    await client.query(`UPDATE sales_shipments SET provider_rate_id=$3,provider_shipment_id=$4,label_url=$5,
      label_format=$6,label_status='PURCHASED',tracking_status='PRE_TRANSIT',tracked_at=$7,carrier=$8,
      service=$9,tracking_number=$10,tracking_url=$11,shipping_cost_minor=$12,currency=$13,
      expected_delivery_date=$14,updated_at=$7 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,input.shipmentId,
      rate.provider_rate_id,(bought.providerShipmentIds||[bought.providerShipmentId]).filter(Boolean).join(','),
      bought.labelUrl,bought.labelFormat||'PDF',now,bought.carrier,bought.service,bought.trackingNumber,bought.trackingUrl||null,
      bought.amountMinor,bought.currency||rate.currency,bought.deliveryDate||null]);
    await client.query(`UPDATE shipping_label_transactions SET status='SUCCEEDED',provider_reference=$2,
      amount_minor=$3,currency=$4,detail='Carrier confirmed the label purchase.',completed_at=$5,updated_at=$5 WHERE id=$1`,
    [input.transactionId,JSON.stringify(bought.providerLabelIds||bought.providerShipmentIds||[]),bought.amountMinor,
      bought.currency||rate.currency,now]);}});
  }catch(error){await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous:true,
    apply:(client)=>client.query(`UPDATE shipping_label_transactions SET status='REVIEW',error_message=$2,
      completed_at=$3,updated_at=$3 WHERE id=$1 AND status='PENDING'`,[input.transactionId,
      'The carrier may have accepted the purchase before StockChief could save its confirmation.',nowIso()])});
    throw Object.assign(new InvariantError('The carrier may have accepted this label purchase, but StockChief could not verify it. It was not retried.',
      'shipping_purchase_ambiguous'),{retryable:false,cause:error});}
  return {shipment:await requireShipment(database,workspaceId,input.shipmentId),replayed:false};
}

async function buyLabel(database,ctx,shipmentId,rateId,input={},options={}){const queued=await queueLabelPurchase(database,ctx,shipmentId,rateId,input);
  if(!queued.queued)return {shipment:queued.shipment,replayed:true};
  return executeLabelPurchaseEffect(database,ctx.workspaceId,queued.effectId,options);}

async function handoff(database,ctx,shipmentId,input={}){
  const shipment=await requireShipment(database,ctx.workspaceId,shipmentId);
  if(shipment.status==='SHIPPED'||shipment.status==='DELIVERED')return {shipment,replayed:true};
  if(shipment.label_status!=='PURCHASED'||!shipment.tracking_number)throw new ValidationError('Buy and verify the carrier label before recording handoff.');
  const lines=(await database.query(`SELECT sales_order_line_id AS "lineId",location_id AS "locationId",quantity
    FROM sales_shipment_lines WHERE workspace_id=$1 AND shipment_id=$2 ORDER BY id`,[ctx.workspaceId,shipmentId])).rows;
  const result=await workflows.fulfillSalesOrder(database,ctx,shipment.sales_order_id,{lines,
    idempotencyKey:input.idempotencyKey||`shipment-handoff:${shipmentId}`});
  await database.query(`UPDATE sales_shipments SET status='SHIPPED',handover='CARRIER',shipped_at=COALESCE(shipped_at,$3),
    updated_at=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipmentId,nowIso()]);
  return {shipment:await requireShipment(database,ctx.workspaceId,shipmentId),fulfillment:result,replayed:result.replayed};
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
  const inserted=await client.query(`INSERT INTO shipment_tracking_events
    (id,workspace_id,shipment_id,provider,external_event_id,status,detail,location,occurred_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,shipment_id,external_event_id) DO NOTHING RETURNING id`,
  [newId('trackevt'),ctx.workspaceId,shipment.id,input.provider||shipment.provider||'manual',externalId,status,
    input.detail||null,input.location||null,input.occurredAt||now,now]);
  if(!inserted.rows.length)return {applied:false,replayed:true,status:shipment.tracking_status};
  const current=String(shipment.tracking_status||'UNKNOWN');
  const next=RANK[status]>=RANK[current]?status:current;
  await client.query(`UPDATE sales_shipments SET tracking_status=$3,tracking_status_detail=$4,tracked_at=$5,
    status=CASE WHEN $3='DELIVERED' THEN 'DELIVERED' ELSE status END,
    delivered_at=CASE WHEN $3='DELIVERED' THEN COALESCE(delivered_at,$5) ELSE delivered_at END,
    exception_reason=CASE WHEN $3 IN ('FAILURE','RETURNED') THEN $4
      WHEN $3 IN ('DELIVERED','CANCELLED') THEN NULL ELSE exception_reason END,updated_at=$5
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,shipment.id,next,input.detail||null,input.occurredAt||now]);
  shipment.tracking_status=next;
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
      shipment=(await client.query(`SELECT * FROM sales_shipments WHERE workspace_id=$1
        AND POSITION($2 IN COALESCE(provider_shipment_id,''))>0 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [ctx.workspaceId,String(read.providerShipmentId)])).rows[0]||null;
    }
    if(!shipment&&read.trackingNumber){
      shipment=(await client.query(`SELECT * FROM sales_shipments WHERE workspace_id=$1 AND tracking_number=$2
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[ctx.workspaceId,String(read.trackingNumber)])).rows[0]||null;
    }
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
    if(!shipment)return {applied:false,replayed:false,outcome};
    const received=Array.isArray(read.events)&&read.events.length?read.events:[{status:read.status,detail:read.detail,
      location:read.location,occurredAt:read.occurredAt||now}];
    const events=received.map((entry,index)=>({...entry,
      externalEventId:entry.externalEventId||`${externalId}:${index}`}))
      .sort((left,right)=>String(left.occurredAt||'').localeCompare(String(right.occurredAt||'')));
    let applied=0;let latest=shipment.tracking_status;
    for(const entry of events){
      const result=await applyTrackingInTransaction(client,ctx,shipment,{provider:providerName,
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
  const held=await accounts.contextFor(database,ctx);
  if(!held)throw new ValidationError('Reconnect the postage account before checking the carrier.');
  const provider=options.provider||defaultProviders.get(held.account.provider);
  const read=await provider.track(held.ctx,{trackingNumber:shipment.tracking_number,carrier:shipment.carrier,
    providerShipmentId:shipment.provider_shipment_id});
  if(!read)return {applied:false,status:shipment.tracking_status,because:'The carrier has no scan for this parcel yet.'};
  const events=read.events?.length?read.events:[{externalEventId:`summary:${shipment.tracking_number}:${read.status}:${read.occurredAt||nowIso()}`,
    status:read.status,detail:read.detail,location:read.location,occurredAt:read.occurredAt||nowIso()}];
  let latest={applied:false,status:shipment.tracking_status};
  for(const event of events){
    latest=await applyTracking(database,ctx,shipmentId,{provider:held.account.provider,
      externalEventId:event.externalEventId,status:event.status||read.status,detail:event.detail||read.detail,
      location:event.location,occurredAt:event.occurredAt||nowIso()});
  }
  return latest;
}

module.exports={prepare,requireShipment,packagesFor,setPackages,state,ratesFor,quote,queueLabelPurchase,
  executeLabelPurchaseEffect,buyLabel,handoff,applyTracking,receiveProviderEvent,refreshTracking};
