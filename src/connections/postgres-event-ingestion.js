'use strict';

const crypto=require('node:crypto');
const {newId,nowIso,requireText,trimOrNull}=require('../lib/util');
const {ValidationError,InvariantError}=require('../domain/errors');
const inventory=require('../domain/postgres-inventory-engine');
const workflows=require('../operations/postgres-business-workflows');
const commerce=require('../operations/postgres-commerce');
const jobs=require('../operations/postgres-job-queue');

const MAX_BATCH=100;
const LEGACY_MAX_BATCH=500;
const TYPES=Object.freeze({sale:'sale.completed',issue:'sale.completed','sale.completed':'sale.completed',
  shipment_out:'inventory.issue',damage:'inventory.issue','inventory.issue':'inventory.issue',
  receive:'inventory.receipt',receipt:'inventory.receipt','inventory.receipt':'inventory.receipt',
  customer_return:'return.completed',return:'return.completed','return.completed':'return.completed',
  count:'inventory.adjust',adjust:'inventory.adjust',adjustment:'inventory.adjust','inventory.adjust':'inventory.adjust',
  transfer:'inventory.transfer','inventory.transfer':'inventory.transfer',
  return_reported:'return.reported','return.reported':'return.reported',
  'sales_order.created':'sales_order.created','sales_order.snapshot':'sales_order.snapshot',
  'sales_order.fulfilled':'sales_order.fulfilled','sales_order.cancelled':'sales_order.cancelled',
  'product.changed':'product.changed','location.changed':'location.changed'});

function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}

function normalize(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new ValidationError('Each event must be an object.');
  const eventId=requireText(input.eventId||input.id,'Event id',{max:160});
  const rawType=requireText(input.type,'Event type',{max:80}).toLowerCase().replaceAll('-','_');
  const type=TYPES[rawType];
  if(!type)throw new ValidationError(`Unsupported PostgreSQL connector event type: ${rawType}.`);
  const data=input.data&&typeof input.data==='object'&&!Array.isArray(input.data)?{...input.data}:{...input};
  for(const key of ['id','eventId','type','version','occurredAt','providerTimestamp','data'])delete data[key];
  return {eventId,type,sourceType:rawType,version:trimOrNull(input.version),
    occurredAt:trimOrNull(input.occurredAt||input.providerTimestamp),data};
}

async function candidates(client,workspaceId,entityType,query){
  if(entityType==='sku')return (await client.query(`SELECT s.id,
      CASE WHEN COALESCE(s.variant_label,'')='' THEN i.name ELSE i.name||' / '||s.variant_label END||' · '||s.code AS label
    FROM skus s JOIN items i ON i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
    ORDER BY CASE WHEN lower(s.code)=lower($2) THEN 0 ELSE 1 END,lower(i.name),s.position LIMIT 8`,[workspaceId,String(query||'')])).rows;
  return (await client.query(`SELECT id,name AS label FROM locations WHERE workspace_id=$1 AND is_active=1
    ORDER BY CASE WHEN lower(name)=lower($2) THEN 0 ELSE 1 END,lower(name) LIMIT 8`,[workspaceId,String(query||'')])).rows;
}

async function mapping(client,auth,entityType,externalId,directId,exact){
  const table=entityType==='sku'?'skus':'locations';
  if(externalId){
    const mapped=await client.query(`SELECT foundry_record_id FROM connection_mappings
      WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
    [auth.workspaceId,auth.connectorId,entityType,externalId]);
    if(mapped.rows.length)return mapped.rows[0].foundry_record_id;
  }
  if(directId){
    const found=await client.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND id=$2`,[auth.workspaceId,directId]);
    if(found.rows.length)return found.rows[0].id;
  }
  if(exact){
    const found=entityType==='sku'
      ? await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND lower(code)=lower($2) AND is_active=1',[auth.workspaceId,exact])
      : await client.query('SELECT id FROM locations WHERE workspace_id=$1 AND lower(name)=lower($2) AND is_active=1',[auth.workspaceId,exact]);
    if(found.rows.length===1){
      if(externalId)await client.query(`INSERT INTO connection_mappings
        (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'exact',$7,$7) ON CONFLICT(workspace_id,connector_id,entity_type,external_id) DO NOTHING`,
      [newId('cmap'),auth.workspaceId,auth.connectorId,entityType,externalId,found.rows[0].id,nowIso()]);
      return found.rows[0].id;
    }
  }
  return null;
}

async function resolve(client,auth,event,entityType){
  const data=event.data;
  const externalId=entityType==='sku'?trimOrNull(data.externalSku||data.externalSkuId):trimOrNull(data.externalLocationId);
  const directId=entityType==='sku'?trimOrNull(data.skuId):trimOrNull(data.locationId);
  const exact=entityType==='sku'?trimOrNull(data.skuCode):trimOrNull(data.locationName);
  const id=await mapping(client,auth,entityType,externalId,directId,exact);
  if(id)return id;
  if(entityType==='sku'&&trimOrNull(data.supplierCode)){
    const values=[auth.workspaceId,data.supplierCode];
    let supplierFilter='';
    if(trimOrNull(data.supplierName)){values.push(data.supplierName);supplierFilter=` AND lower(supplier.name)=lower($${values.length})`;}
    const matched=await client.query(`SELECT DISTINCT sku.id FROM supplier_items supplier_item
      JOIN suppliers supplier ON supplier.id=supplier_item.supplier_id AND supplier.workspace_id=supplier_item.workspace_id
      JOIN skus sku ON sku.id=supplier_item.sku_id AND sku.workspace_id=supplier_item.workspace_id
      JOIN items item ON item.id=sku.item_id AND item.workspace_id=sku.workspace_id
      WHERE supplier_item.workspace_id=$1 AND lower(supplier_item.supplier_sku)=lower($2)
        AND supplier_item.is_active=1 AND sku.is_active=1 AND item.is_active=1${supplierFilter}` ,values);
    if(matched.rows.length===1){
      if(externalId)await mapRecord(client,auth,'sku',externalId,matched.rows[0].id);
      return matched.rows[0].id;
    }
  }
  if(entityType==='location'&&!externalId&&!directId&&!exact){
    const active=await client.query('SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY id',[auth.workspaceId]);
    if(active.rows.length===1)return active.rows[0].id;
  }
  return {missing:true,entityType,externalId:externalId||exact||directId||'unknown',
    candidates:await candidates(client,auth.workspaceId,entityType,exact||externalId)};
}

async function persistIssue(client,auth,event,missing){
  const issueType=`UNKNOWN_${missing.entityType.toUpperCase()}`;
  const fingerprint=`${issueType}:${auth.connectorId}:${missing.externalId}`;
  const at=nowIso();
  await client.query(`INSERT INTO connection_issues
    (id,workspace_id,connector_id,external_event_id,issue_type,fingerprint,title,detail,resolution_hint,
     candidate_matches,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'OPEN',$11,$11)
    ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET external_event_id=EXCLUDED.external_event_id,
      candidate_matches=EXCLUDED.candidate_matches,status='OPEN',resolved_at=NULL,updated_at=EXCLUDED.updated_at`,
  [newId('conissue'),auth.workspaceId,auth.connectorId,event.eventId,issueType,fingerprint,
    `Unknown ${missing.entityType} from ${auth.displayName}`,
    `StockChief received ${event.type} for ${missing.externalId}, but cannot safely match it to this inventory.`,
    'Choose the matching StockChief record once. StockChief will remember it before applying this event.',
    JSON.stringify(missing.candidates),at]);
}

async function persistReturnReview(client,auth,event){
  const fingerprint=`return-review:${auth.connectorId}:${event.eventId}`;
  const reference=trimOrNull(event.data.reference)||`External refund ${event.eventId}`;
  const at=nowIso();
  await client.query(`INSERT INTO connection_issues
    (id,workspace_id,connector_id,external_event_id,issue_type,fingerprint,title,detail,resolution_hint,
     candidate_matches,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,'RETURN_REVIEW_REQUIRED',$5,$6,$7,$8,'[]','OPEN',$9,$9)
    ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,
      detail=EXCLUDED.detail,resolution_hint=EXCLUDED.resolution_hint,updated_at=EXCLUDED.updated_at`,
  [newId('conissue'),auth.workspaceId,auth.connectorId,event.eventId,fingerprint,
    `${auth.displayName} reported a refund that needs return confirmation`,
    `${reference} is financial evidence only. StockChief has not increased stock.`,
    'Confirm that the product physically returned, then record the return in StockChief.',at]);
}

function scopedDatabase(client){return {query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation)=>operation(client)};}

function quantity(value){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<=0)throw new ValidationError('Quantity must be a positive whole number.');
  return number;
}

function countedQuantity(value){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<0)throw new ValidationError('Counted quantity must be a whole number of zero or more.');
  return number;
}

async function serialUnitIds(client,workspaceId,skuId,locationId,rawSerials){
  const serials=[...new Set((Array.isArray(rawSerials)?rawSerials:[]).filter(Boolean).map(String))];
  if(!serials.length)return [];
  const result=await client.query(`SELECT id,serial FROM serial_units WHERE workspace_id=$1 AND sku_id=$2
    AND location_id=$3 AND status='in_stock' AND lower(serial)=ANY($4::text[]) FOR UPDATE`,
  [workspaceId,skuId,locationId,serials.map((serial)=>serial.toLowerCase())]);
  if(result.rows.length!==serials.length)throw new ValidationError('One or more serial numbers are not uniquely available at that location.');
  return result.rows.map((row)=>row.id);
}

class MappingNeeded extends Error{
  constructor(missing){super(`Mapping required for ${missing.entityType}.`);this.missing=missing;}
}

async function requiredMapping(client,auth,event,entityType,data=event.data){
  const resolved=await resolve(client,auth,{...event,data},entityType);
  if(resolved?.missing)throw new MappingNeeded(resolved);
  return resolved;
}

async function mapRecord(client,auth,entityType,externalId,foundryRecordId){
  if(!externalId)return;
  const at=nowIso();
  await client.query(`INSERT INTO connection_mappings
    (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'exact',$7,$8,$8)
    ON CONFLICT(workspace_id,connector_id,entity_type,external_id) DO NOTHING`,
  [newId('cmap'),auth.workspaceId,auth.connectorId,entityType,String(externalId),foundryRecordId,auth.actorId,at]);
}

async function mappedRecord(client,auth,entityType,externalId){
  if(!externalId)return null;
  const result=await client.query(`SELECT foundry_record_id FROM connection_mappings
    WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=$4`,
  [auth.workspaceId,auth.connectorId,entityType,String(externalId)]);
  return result.rows[0]?.foundry_record_id||null;
}

async function customerFor(client,auth,event){
  const data=event.data;const customer=data.customer||{};
  const externalId=trimOrNull(data.externalCustomerId||customer.externalId)||
    `order:${requireText(data.externalOrderId||data.orderId,'External order id',{max:160})}`;
  const mapped=await mappedRecord(client,auth,'customer',externalId);
  if(mapped){
    const found=await client.query(`SELECT id FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'`,
      [auth.workspaceId,mapped]);
    if(found.rows.length)return found.rows[0].id;
  }
  const name=trimOrNull(data.customerName||customer.name)||'External customer';
  const email=trimOrNull(data.customerEmail||customer.email);
  const exact=email
    ?await client.query(`SELECT id FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND lower(email)=lower($2)`,
      [auth.workspaceId,email])
    :await client.query(`SELECT id FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND lower(name)=lower($2)`,
      [auth.workspaceId,name]);
  let id;
  if(exact.rows.length===1)id=exact.rows[0].id;
  else id=(await commerce.createCustomerInTransaction(client,{workspaceId:auth.workspaceId,actorId:auth.actorId},{
    name,email,company:data.company,shippingAddress:data.shippingAddress||customer.shippingAddress,
    notes:`Created from ${auth.displayName} order ${data.externalOrderId||data.orderId}.`,
  })).id;
  await mapRecord(client,auth,'customer',externalId,id);
  return id;
}

async function pricedLines(client,auth,event){
  const source=Array.isArray(event.data.lines)?event.data.lines:[];
  if(!source.length)throw new ValidationError('A customer order needs at least one line.');
  const totals=new Map();
  for(const line of source){
    const skuId=await requiredMapping(client,auth,event,'sku',line);
    const count=quantity(line.quantity);const prior=totals.get(skuId);
    totals.set(skuId,{skuId,quantity:count+(prior?.quantity||0),unitPriceMinor:line.unitPriceMinor??prior?.unitPriceMinor});
  }
  for(const line of totals.values())if(line.unitPriceMinor===undefined||line.unitPriceMinor===null){
    const price=await client.query(`SELECT amount_minor FROM sku_prices WHERE workspace_id=$1 AND sku_id=$2
      AND amount_minor IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1`,[auth.workspaceId,line.skuId]);
    if(!price.rows.length)throw new ValidationError('A provider order line has no selling price. Add the price before retrying this event.');
    line.unitPriceMinor=Number(price.rows[0].amount_minor);
  }
  return [...totals.values()];
}

async function salesOrderFor(client,auth,event){
  const externalId=requireText(event.data.externalOrderId||event.data.orderId,'External order id',{max:160});
  const id=await mappedRecord(client,auth,'sales_order',externalId);
  if(!id)throw new MappingNeeded({missing:true,entityType:'sales_order',externalId,candidates:[]});
  const result=await client.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[auth.workspaceId,id]);
  if(!result.rows.length)throw new MappingNeeded({missing:true,entityType:'sales_order',externalId,candidates:[]});
  return result.rows[0];
}

async function applySalesOrder(client,auth,event){
  const ctx={workspaceId:auth.workspaceId,actorId:auth.actorId};const data=event.data;
  const externalOrderId=requireText(data.externalOrderId||data.orderId,'External order id',{max:160});
  if(event.type==='sales_order.created'){
    const existing=await mappedRecord(client,auth,'sales_order',externalOrderId);
    if(existing)return {actionType:'sales_order.created',actionRecordId:existing,movementIds:[]};
    const lines=await pricedLines(client,auth,event);const customerId=await customerFor(client,auth,event);
    let fulfillmentLocationId=null;
    if(data.externalLocationId||data.fulfillmentLocationExternalId||data.locationId||data.locationName){
      fulfillmentLocationId=await requiredMapping(client,auth,event,'location',{
        externalLocationId:data.externalLocationId||data.fulfillmentLocationExternalId,
        locationId:data.locationId,locationName:data.locationName,
      });
    }
    const created=await workflows.createSalesOrderInTransaction(client,ctx,{customerId,lines,
      orderNumber:trimOrNull(data.orderNumber),orderDate:(event.occurredAt||nowIso()).slice(0,10),
      neededBy:data.neededBy,fulfillmentLocationId,deliveryMethod:data.deliveryMethod||'SHIP',
      shipToAddress:data.shippingAddress||data.customer?.shippingAddress,reference:`Source: ${auth.displayName}; ${externalOrderId}`,
      notes:`External event ${event.eventId}.`,currency:data.currency||'USD',discountMinor:data.discountMinor||0,
      taxMinor:data.taxMinor||0,idempotencyKey:`connector:${auth.connectorId}:${event.eventId}:create`});
    await mapRecord(client,auth,'sales_order',externalOrderId,created.salesOrderId);
    await workflows.confirmSalesOrderInTransaction(client,ctx,created.salesOrderId,
      {idempotencyKey:`connector:${auth.connectorId}:${event.eventId}:confirm`});
    return {actionType:'sales_order.created',actionRecordId:created.salesOrderId,movementIds:[]};
  }
  const order=await salesOrderFor(client,auth,event);
  if(event.type==='sales_order.cancelled'){
    const cancelled=await workflows.cancelSalesOrderInTransaction(client,ctx,order.id,{reason:data.reason,
      idempotencyKey:`connector:${auth.connectorId}:${event.eventId}:cancel`});
    return {actionType:'sales_order.cancelled',actionRecordId:cancelled.salesOrderId,movementIds:[]};
  }
  if(event.type==='sales_order.snapshot'){
    const synced=await workflows.synchronizeSalesOrderInTransaction(client,ctx,order.id,{lines:await pricedLines(client,auth,event),
      source:auth.displayName,idempotencyKey:`connector:${auth.connectorId}:${event.eventId}:snapshot`});
    return {actionType:'sales_order.changed',actionRecordId:synced.salesOrderId,movementIds:[]};
  }
  if(order.status==='FULFILLED')return {actionType:'sales_order.fulfilled',actionRecordId:order.id,movementIds:[]};
  const orderLines=(await client.query(`SELECT * FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2
    ORDER BY created_at,id FOR UPDATE`,[auth.workspaceId,order.id])).rows;
  const requested=[];const supplied=Array.isArray(data.lines)?data.lines:[];
  if(supplied.length){
    for(const external of supplied){
      const skuId=await requiredMapping(client,auth,event,'sku',external);
      const line=orderLines.find((row)=>row.sku_id===skuId);
      if(!line)throw new ValidationError('The provider fulfillment contains a product that is not on this Sales Order.');
      let remaining=quantity(external.quantity);
      const allocations=(await client.query(`SELECT * FROM sales_order_allocations WHERE workspace_id=$1
        AND sales_order_line_id=$2 ORDER BY created_at,id FOR UPDATE`,[auth.workspaceId,line.id])).rows;
      for(const allocation of allocations){if(!remaining)break;const count=Math.min(remaining,Number(allocation.quantity));
        if(count)requested.push({lineId:line.id,locationId:allocation.location_id,quantity:count});remaining-=count;}
      if(remaining)throw new ValidationError('The provider fulfillment exceeds stock committed to this Sales Order.');
    }
  }else{
    const allocations=(await client.query(`SELECT a.* FROM sales_order_allocations a JOIN sales_order_lines l
      ON l.id=a.sales_order_line_id WHERE a.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.created_at,a.created_at FOR UPDATE`,
    [auth.workspaceId,order.id])).rows;
    for(const allocation of allocations)requested.push({lineId:allocation.sales_order_line_id,
      locationId:allocation.location_id,quantity:Number(allocation.quantity)});
  }
  if(!requested.length)throw new ValidationError('The provider says this order was fulfilled, but StockChief has no committed stock to issue.');
  const fulfilled=await workflows.fulfillSalesOrderInTransaction(client,ctx,order.id,{lines:requested,
    fulfilledAt:event.occurredAt||nowIso(),idempotencyKey:`connector:${auth.connectorId}:${event.eventId}:fulfill`});
  return {actionType:'sales_order.fulfilled',actionRecordId:order.id,
    movementIds:fulfilled.lines.map((line)=>line.movementId).filter(Boolean)};
}

function missingMappingError(missing){
  if(missing.entityType==='sku')return new ValidationError('The feed event did not match a product in this inventory.');
  return new ValidationError('The location in that feed event was not found or was not unique.');
}

async function ingest(database,auth,raw,options={}){
  const event=normalize(raw);const payloadHash=hash(raw);const receivedAt=nowIso();
  return database.transaction(async(client)=>{
    const inserted=await client.query(`INSERT INTO connector_feed_events
      (id,workspace_id,connector_id,external_event_id,event_type,payload,status,movement_ids,external_version,
       payload_hash,normalized_payload,attempt_count,last_attempt_at,occurred_at,received_at,processed_at)
      VALUES($1,$2,$3,$4,$5,$6,'PROCESSING','[]',$7,$8,$9,1,$10,$11,$10,$10)
      ON CONFLICT(workspace_id,connector_id,external_event_id) DO NOTHING RETURNING id`,
    [newId('cevt'),auth.workspaceId,auth.connectorId,event.eventId,event.type,JSON.stringify(raw),event.version,
      payloadHash,JSON.stringify(event),receivedAt,event.occurredAt]);
    if(!inserted.rows.length){
      const prior=(await client.query(`SELECT * FROM connector_feed_events WHERE workspace_id=$1 AND connector_id=$2
        AND external_event_id=$3 FOR UPDATE`,[auth.workspaceId,auth.connectorId,event.eventId])).rows[0];
      if(prior.payload_hash!==payloadHash)throw new InvariantError('That external event id was already used for different evidence.','external_event_conflict');
      if(['COMPLETED','IGNORED'].includes(prior.status))return {accepted:true,replayed:true,status:prior.status,eventId:event.eventId,
        movementIds:prior.movement_ids||[]};
      if(['NEEDS_MAPPING','REJECTED','FAILED','STALE'].includes(prior.status))return {accepted:false,replayed:true,
        status:prior.status,eventId:event.eventId,movementIds:[],error:prior.error_message};
      throw new InvariantError('That external event is already being processed.','event_in_progress');
    }
    if(event.type==='return.reported'){
      await persistReturnReview(client,auth,event);
      const processedAt=nowIso();
      await client.query(`UPDATE connector_feed_events SET status='IGNORED',action_type='return.review_required',
        action_record_id=NULL,error_message=$2,processed_at=$3 WHERE workspace_id=$1 AND connector_id=$4
          AND external_event_id=$5`,[auth.workspaceId,
        'Financial refund recorded; physical return requires confirmation.',processedAt,auth.connectorId,event.eventId]);
      await client.query(`UPDATE workspace_connectors SET last_activity_at=$3,last_synced_at=$3,last_error=NULL,updated_at=$3
        WHERE workspace_id=$1 AND id=$2`,[auth.workspaceId,auth.connectorId,processedAt]);
      return {accepted:true,replayed:false,status:'IGNORED',eventId:event.eventId,movementIds:[],requiresReview:true};
    }
    if(event.type==='product.changed'||event.type==='location.changed'){
      const scheduled=await jobs.enqueue(scopedDatabase(client),{workspaceId:auth.workspaceId,kind:'provider.catalog-sync',
        idempotencyKey:`provider-catalog-sync:${auth.connectorId}:event:${event.eventId}`,
        payload:{connectorId:auth.connectorId,sourceEventId:event.eventId},priority:25,maxAttempts:5});
      const processedAt=nowIso();
      await client.query(`UPDATE connector_feed_events SET status='IGNORED',action_type='provider.refresh_scheduled',
        action_record_id=$2,error_message=NULL,processed_at=$3 WHERE workspace_id=$1 AND connector_id=$4
          AND external_event_id=$5`,[auth.workspaceId,scheduled.job.id,processedAt,auth.connectorId,event.eventId]);
      await client.query(`UPDATE workspace_connectors SET last_activity_at=$3,last_error=NULL,updated_at=$3
        WHERE workspace_id=$1 AND id=$2`,[auth.workspaceId,auth.connectorId,processedAt]);
      return {accepted:true,replayed:false,status:'IGNORED',eventId:event.eventId,movementIds:[],
        refreshScheduled:true,refreshJobId:scheduled.job.id};
    }
    if(event.type.startsWith('sales_order.')){
      let result;
      try{result=await applySalesOrder(client,auth,event);}catch(error){
        if(!(error instanceof MappingNeeded))throw error;
        await persistIssue(client,auth,event,error.missing);
        await client.query(`UPDATE connector_feed_events SET status='NEEDS_MAPPING',error_message=$2,processed_at=$3
          WHERE workspace_id=$1 AND connector_id=$4 AND external_event_id=$5`,[auth.workspaceId,
          `Unmatched ${error.missing.entityType}: ${error.missing.externalId}`,nowIso(),auth.connectorId,event.eventId]);
        return {accepted:false,replayed:false,status:'NEEDS_MAPPING',eventId:event.eventId,mapping:error.missing};
      }
      const processedAt=nowIso();
      await client.query(`UPDATE connector_feed_events SET status='COMPLETED',movement_ids=$2,action_type=$3,
        action_record_id=$4,aggregate_key=$5,error_message=NULL,processed_at=$6 WHERE workspace_id=$1
          AND connector_id=$7 AND external_event_id=$8`,[auth.workspaceId,JSON.stringify(result.movementIds||[]),
        result.actionType,result.actionRecordId||null,String(event.data.externalOrderId||event.data.orderId||''),processedAt,
        auth.connectorId,event.eventId]);
      await client.query(`UPDATE workspace_connectors SET last_activity_at=$3,last_synced_at=$3,last_error=NULL,updated_at=$3
        WHERE workspace_id=$1 AND id=$2`,[auth.workspaceId,auth.connectorId,processedAt]);
      return {accepted:true,replayed:false,status:'COMPLETED',eventId:event.eventId,
        movementIds:result.movementIds||[],actionType:result.actionType,actionRecordId:result.actionRecordId};
    }
    const sku=await resolve(client,auth,event,'sku');
    let locations={};
    if(event.type==='inventory.transfer'){
      locations.source=await resolve(client,auth,{...event,data:{externalLocationId:event.data.externalFromLocationId,
        locationId:event.data.fromLocationId,locationName:event.data.fromLocationName}},'location');
      locations.destination=await resolve(client,auth,{...event,data:{externalLocationId:event.data.externalToLocationId,
        locationId:event.data.toLocationId,locationName:event.data.toLocationName}},'location');
    }else locations.location=await resolve(client,auth,event,'location');
    const missing=sku?.missing?sku:Object.values(locations).find((entry)=>entry?.missing)||null;
    if(missing){
      if(options.rejectUnknownMapping)throw missingMappingError(missing);
      await persistIssue(client,auth,event,missing);
      await client.query(`UPDATE connector_feed_events SET status='NEEDS_MAPPING',error_message=$2,processed_at=$3
        WHERE workspace_id=$1 AND connector_id=$4 AND external_event_id=$5`,[auth.workspaceId,
        `Unmatched ${missing.entityType}: ${missing.externalId}`,nowIso(),auth.connectorId,event.eventId]);
      return {accepted:false,replayed:false,status:'NEEDS_MAPPING',eventId:event.eventId,mapping:missing};
    }
    const ctx={workspaceId:auth.workspaceId,actorId:auth.actorId};
    const location=locations.location;
    const reference=trimOrNull(event.data.reference)||`${options.referencePrefix||'external'}:${event.eventId}`;
    const notes=trimOrNull(event.data.notes)||`Source: ${auth.displayName}; external event: ${event.eventId}.`;
    const common={skuId:sku,locationId:location,reference,notes,occurredAt:event.occurredAt||receivedAt,
      idempotencyKey:`connector:${auth.connectorId}:${event.eventId}`};
    let result;let actionType;
    if(event.type==='sale.completed'||event.type==='inventory.issue'){
      const serialIds=await serialUnitIds(client,auth.workspaceId,sku,location,event.data.serials);
      result=await inventory.issueInTransaction(client,ctx,{...common,quantity:quantity(event.data.quantity),
        serialUnitIds:serialIds,lotId:event.data.lotId,
        lotCode:event.data.lotCode,reasonCode:trimOrNull(event.data.reasonCode)||(event.sourceType==='damage'?'damaged':'sold')});
      actionType='inventory.issue';
    }else if(event.type==='inventory.receipt'||event.type==='return.completed'){
      result=await inventory.receiveInTransaction(client,ctx,{...common,quantity:quantity(event.data.quantity),
        serials:event.data.serials,lotId:event.data.lotId,
        lotCode:event.data.lotCode,expiresAt:event.data.expiresAt,reasonCode:trimOrNull(event.data.reasonCode)});
      actionType='inventory.receive';
    }else if(event.type==='inventory.adjust'){
      result=await inventory.adjustInTransaction(client,ctx,{skuId:sku,locationId:location,
        countedQuantity:countedQuantity(event.data.countedQuantity??event.data.countedQty),
        reasonCode:trimOrNull(event.data.reasonCode)||'physical_count',reference,notes,
        occurredAt:event.occurredAt||receivedAt,idempotencyKey:common.idempotencyKey});
      actionType='inventory.adjust';
    }else{
      const serialIds=await serialUnitIds(client,auth.workspaceId,sku,locations.source,event.data.serials);
      result=await inventory.transferInTransaction(client,ctx,{skuId:sku,sourceLocationId:locations.source,
        destinationLocationId:locations.destination,quantity:quantity(event.data.quantity),serialUnitIds:serialIds,
        lotId:event.data.lotId,lotCode:event.data.lotCode,reference,notes,occurredAt:event.occurredAt||receivedAt,
        idempotencyKey:common.idempotencyKey});
      actionType='inventory.transfer';
    }
    const movementIds=[result.movementId,result.outMovementId,result.inMovementId].filter(Boolean);
    await client.query(`UPDATE connector_feed_events SET status='COMPLETED',movement_ids=$2,action_type=$3,
      action_record_id=$4,error_message=NULL,processed_at=$5 WHERE workspace_id=$1 AND connector_id=$6 AND external_event_id=$7`,
    [auth.workspaceId,JSON.stringify(movementIds),actionType,
      movementIds[0]||null,nowIso(),auth.connectorId,event.eventId]);
    await client.query(`UPDATE workspace_connectors SET last_activity_at=$3,last_synced_at=$3,last_error=NULL,updated_at=$3
      WHERE workspace_id=$1 AND id=$2`,[auth.workspaceId,auth.connectorId,nowIso()]);
    return {accepted:true,replayed:false,status:'COMPLETED',eventId:event.eventId,movementIds};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function recordLegacyRejection(database,auth,raw,error){
  const eventId=requireText(raw?.eventId||raw?.id,'Event id',{max:160});
  const receivedAt=nowIso();const payloadHash=hash(raw);const eventType=trimOrNull(raw?.type)||'unknown';
  return database.transaction(async(client)=>{
    const inserted=await client.query(`INSERT INTO connector_feed_events
      (id,workspace_id,connector_id,external_event_id,event_type,payload,status,movement_ids,payload_hash,
       normalized_payload,attempt_count,last_attempt_at,error_message,occurred_at,received_at,processed_at)
      VALUES($1,$2,$3,$4,$5,$6,'REJECTED','[]',$7,'{}',1,$8,$9,$10,$8,$8)
      ON CONFLICT(workspace_id,connector_id,external_event_id) DO NOTHING RETURNING id`,
    [newId('cevt'),auth.workspaceId,auth.connectorId,eventId,eventType,JSON.stringify(raw),payloadHash,receivedAt,
      error.message,trimOrNull(raw?.occurredAt||raw?.providerTimestamp)]);
    if(inserted.rows.length)await client.query(`UPDATE workspace_connectors SET last_error=$3,updated_at=$4
      WHERE workspace_id=$1 AND id=$2`,[auth.workspaceId,auth.connectorId,error.message,receivedAt]);
    const row=(await client.query(`SELECT status,error_message FROM connector_feed_events
      WHERE workspace_id=$1 AND connector_id=$2 AND external_event_id=$3`,[auth.workspaceId,auth.connectorId,eventId])).rows[0];
    return {accepted:false,replayed:!inserted.rows.length,eventId,type:eventType,status:row?.status||'REJECTED',
      movementIds:[],error:error.message||row?.error_message};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function legacyType(raw,result){
  if(result.actionType==='inventory.transfer')return 'transfer';
  if(result.actionType==='inventory.adjust')return 'adjust';
  if(result.actionType==='inventory.receive')return 'receive';
  if(result.actionType==='inventory.issue')return 'issue';
  const type=String(raw?.type||'').toLowerCase().replaceAll('-','_');
  if(['receive','receipt','customer_return'].includes(type))return 'receive';
  if(['count','adjust','adjustment'].includes(type))return 'adjust';
  if(type==='transfer')return 'transfer';
  return 'issue';
}

async function ingestLegacy(database,auth,raw){
  try{
    const result=await ingest(database,auth,raw,{rejectUnknownMapping:true,referencePrefix:'feed'});
    return {...result,type:legacyType(raw,result)};
  }catch(error){
    if(!error?.status)throw error;
    return recordLegacyRejection(database,auth,raw,error);
  }
}

async function ingestLegacyBatch(database,auth,envelope){
  const raw=Array.isArray(envelope?.events)?envelope.events:[envelope];
  if(!raw.length)throw new ValidationError('Send at least one event.');
  if(raw.length>LEGACY_MAX_BATCH)throw new ValidationError(`Send at most ${LEGACY_MAX_BATCH} events at once.`);
  const results=[];for(const event of raw)results.push(await ingestLegacy(database,auth,event));
  return {accepted:results.filter((entry)=>entry.accepted&&!entry.replayed).length,
    replayed:results.filter((entry)=>entry.replayed).length,rejected:results.filter((entry)=>!entry.accepted).length,results};
}

async function ingestBatch(database,auth,envelope){
  const raw=Array.isArray(envelope?.events)?envelope.events:[envelope];
  if(!raw.length)throw new ValidationError('At least one event is required.');
  if(raw.length>MAX_BATCH)throw new ValidationError(`A batch may contain at most ${MAX_BATCH} events.`);
  const results=[];for(const event of raw)results.push(await ingest(database,auth,event));
  return {results,accepted:results.filter((row)=>row.accepted).length,needsMapping:results.filter((row)=>row.status==='NEEDS_MAPPING').length,
    replayed:results.filter((row)=>row.replayed).length};
}

module.exports={MAX_BATCH,LEGACY_MAX_BATCH,TYPES,normalize,ingest,ingestBatch,ingestLegacy,ingestLegacyBatch};
