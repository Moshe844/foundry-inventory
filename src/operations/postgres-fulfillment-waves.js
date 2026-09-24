'use strict';

const {ValidationError,NotFoundError,InvariantError}=require('../domain/errors');
const permissions=require('../actions/permissions');
const {newId,nowIso,requireText,requirePositiveInt,requireOneOf,trimOrNull}=require('../lib/util');

async function actor(client,ctx,what){
  const row=(await client.query('SELECT id,role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new ValidationError('The acting user does not belong to this inventory.');
  permissions.assertCan(row,permissions.MANAGE_FULFILLMENT_WAVES,what);
  return row;
}

async function get(database,workspaceId,id){
  const wave=(await database.query('SELECT * FROM fulfillment_waves WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!wave)throw new NotFoundError('That fulfillment wave could not be found.');
  const [shipments,lines,scans]=await Promise.all([
    database.query(`SELECT wave_shipment.*,shipment.shipment_number,shipment.status AS shipment_status,
      orders.order_number,customer.name AS customer_name,container.code AS container_code
      FROM fulfillment_wave_shipments wave_shipment
      JOIN sales_shipments shipment ON shipment.id=wave_shipment.shipment_id
      JOIN sales_orders orders ON orders.id=wave_shipment.sales_order_id
      JOIN customers customer ON customer.id=orders.customer_id
      LEFT JOIN warehouse_containers container ON container.id=wave_shipment.container_id
      WHERE wave_shipment.workspace_id=$1 AND wave_shipment.wave_id=$2
      ORDER BY orders.needed_by NULLS LAST,orders.order_number`,[workspaceId,id]),
    database.query(`SELECT line.*,sku.code AS sku_code,sku.barcode AS sku_barcode,item.name AS item_name,
      item.tracking_mode,sku.variant_label,location.name AS location_name,location.barcode AS location_barcode,
      shipment.shipment_number
      FROM fulfillment_wave_lines line JOIN skus sku ON sku.id=line.sku_id
      JOIN items item ON item.id=sku.item_id JOIN locations location ON location.id=line.location_id
      JOIN sales_shipments shipment ON shipment.id=line.shipment_id
      WHERE line.workspace_id=$1 AND line.wave_id=$2
      ORDER BY location.pick_sequence,location.name,item.name,sku.position`,[workspaceId,id]),
    database.query(`SELECT * FROM fulfillment_wave_scans WHERE workspace_id=$1 AND wave_id=$2
      ORDER BY seq DESC LIMIT 100`,[workspaceId,id]),
  ]);
  const hydrated={...wave,shipments:shipments.rows,lines:lines.rows.map((row)=>({...row,
    planned_quantity:Number(row.planned_quantity),picked_quantity:Number(row.picked_quantity)})),scans:scans.rows};
  hydrated.units={planned:hydrated.lines.reduce((sum,line)=>sum+line.planned_quantity,0),
    picked:hydrated.lines.reduce((sum,line)=>sum+line.picked_quantity,0)};
  return hydrated;
}

async function list(database,workspaceId){
  const result=await database.query(`SELECT wave.*,
    (SELECT COUNT(*) FROM fulfillment_wave_shipments shipment WHERE shipment.wave_id=wave.id)::integer AS shipment_count,
    (SELECT COALESCE(SUM(planned_quantity),0) FROM fulfillment_wave_lines line WHERE line.wave_id=wave.id)::bigint AS units
    FROM fulfillment_waves wave WHERE wave.workspace_id=$1 ORDER BY wave.created_at DESC,wave.id DESC`,[workspaceId]);
  return result.rows.map((row)=>({...row,shipment_count:Number(row.shipment_count),units:Number(row.units)}));
}

async function readyOrders(database,workspaceId){
  const result=await database.query(`SELECT orders.id,orders.order_number,orders.needed_by,customer.name AS customer_name,
      COALESCE(SUM(allocation.quantity),0)::bigint AS units
    FROM sales_orders orders JOIN customers customer ON customer.id=orders.customer_id
    JOIN sales_order_lines line ON line.sales_order_id=orders.id AND line.workspace_id=orders.workspace_id
    JOIN sales_order_allocations allocation ON allocation.sales_order_line_id=line.id AND allocation.workspace_id=line.workspace_id
    WHERE orders.workspace_id=$1 AND orders.status IN ('CONFIRMED','PARTIALLY_FULFILLED')
      AND NOT EXISTS(SELECT 1 FROM fulfillment_wave_shipments wave_shipment
        JOIN fulfillment_waves wave ON wave.id=wave_shipment.wave_id
        WHERE wave_shipment.workspace_id=orders.workspace_id AND wave_shipment.sales_order_id=orders.id
          AND wave.status NOT IN ('COMPLETED','CANCELLED'))
    GROUP BY orders.id,customer.name HAVING SUM(allocation.quantity)>0
    ORDER BY orders.needed_by NULLS LAST,orders.order_number`,[workspaceId]);
  return result.rows.map((row)=>({...row,units:Number(row.units)}));
}

async function beginOperation(client,workspaceId,key){
  const idempotencyKey=requireText(key,'Wave release key',{max:240});const id=newId('pgop');
  const inserted=await client.query(`INSERT INTO stockchief_runtime.business_operations
    (id,workspace_id,kind,idempotency_key) VALUES($1,$2,'fulfillment-wave.create',$3)
    ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,[id,workspaceId,idempotencyKey]);
  if(inserted.rows.length)return {id,replayed:false};
  const prior=(await client.query(`SELECT status,result FROM stockchief_runtime.business_operations
    WHERE workspace_id=$1 AND kind='fulfillment-wave.create' AND idempotency_key=$2 FOR UPDATE`,
  [workspaceId,idempotencyKey])).rows[0];
  if(prior?.status==='COMPLETED')return {replayed:true,result:prior.result};
  throw new InvariantError('That wave release is already running.','operation_in_progress');
}

async function create(database,ctx,input){
  const orderIds=[...new Set((Array.isArray(input.orderIds)?input.orderIds:[input.orderIds]).filter(Boolean))];
  if(!orderIds.length)throw new ValidationError('Choose at least one ready customer order.');
  return database.transaction(async(client)=>{
    await actor(client,ctx,'create fulfillment waves');
    const operation=await beginOperation(client,ctx.workspaceId,input.idempotencyKey);
    if(operation.replayed)return {...operation.result,replayed:true};
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`fulfillment-wave:${ctx.workspaceId}`]);
    const number=Number((await client.query('SELECT COALESCE(MAX(wave_number),0)+1 AS number FROM fulfillment_waves WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0].number);
    const strategy=requireOneOf(String(input.strategy||'WAVE').toUpperCase(),['WAVE','BATCH','CLUSTER'],'Picking strategy');
    const waveId=newId('wave');const at=nowIso();
    await client.query(`INSERT INTO fulfillment_waves
      (id,workspace_id,wave_number,strategy,status,title,created_by_user_id,created_at)
      VALUES($1,$2,$3,$4,'PICKING',$5,$6,$7)`,[waveId,ctx.workspaceId,number,strategy,
      trimOrNull(input.title)||`${strategy.charAt(0)+strategy.slice(1).toLowerCase()} pick #${number}`,ctx.actorId,at]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`shipment-number:${ctx.workspaceId}`]);
    let shipmentOffset=Number((await client.query('SELECT COUNT(*) AS count FROM sales_shipments WHERE workspace_id=$1',
      [ctx.workspaceId])).rows[0].count);
    for(const orderId of orderIds){
      const order=(await client.query(`SELECT orders.*,customer.name AS customer_name FROM sales_orders orders
        JOIN customers customer ON customer.id=orders.customer_id WHERE orders.workspace_id=$1 AND orders.id=$2 FOR UPDATE OF orders`,
      [ctx.workspaceId,orderId])).rows[0];
      if(!order)throw new NotFoundError('One selected customer order could not be found.');
      if(!['CONFIRMED','PARTIALLY_FULFILLED'].includes(order.status))throw new ValidationError(`${order.order_number} is not ready to pick.`);
      const active=await client.query(`SELECT 1 FROM fulfillment_wave_shipments wave_shipment
        JOIN fulfillment_waves wave ON wave.id=wave_shipment.wave_id
        WHERE wave_shipment.workspace_id=$1 AND wave_shipment.sales_order_id=$2
          AND wave.status NOT IN ('COMPLETED','CANCELLED') LIMIT 1`,[ctx.workspaceId,orderId]);
      if(active.rows.length)throw new ValidationError(`${order.order_number} is already in an active fulfillment wave.`);
      const allocations=(await client.query(`SELECT allocation.sales_order_line_id,allocation.location_id,
          allocation.quantity,line.sku_id
        FROM sales_order_allocations allocation JOIN sales_order_lines line ON line.id=allocation.sales_order_line_id
        WHERE allocation.workspace_id=$1 AND line.sales_order_id=$2 AND allocation.quantity>0
        ORDER BY line.created_at,allocation.created_at FOR UPDATE OF allocation`,[ctx.workspaceId,orderId])).rows;
      if(!allocations.length)throw new ValidationError(`${order.order_number} has no committed stock ready to pick.`);
      shipmentOffset+=1;const shipmentId=newId('shp');const shipmentNumber=`SHP-${String(shipmentOffset).padStart(5,'0')}`;
      await client.query(`INSERT INTO sales_shipments
        (id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,ship_to_address,
         package_count,currency,created_by_user_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,'PICKING',$5,$6,1,$7,$8,$9,$9)`,[shipmentId,ctx.workspaceId,orderId,shipmentNumber,
        order.fulfillment_location_id,order.ship_to_address,order.currency||'USD',ctx.actorId,at]);
      await client.query(`INSERT INTO fulfillment_wave_shipments
        (wave_id,workspace_id,sales_order_id,shipment_id,status) VALUES($1,$2,$3,$4,'PICKING')`,
      [waveId,ctx.workspaceId,orderId,shipmentId]);
      for(const allocation of allocations){
        const shipmentLineId=newId('shpl');
        await client.query(`INSERT INTO sales_shipment_lines
          (id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)`,[shipmentLineId,ctx.workspaceId,shipmentId,
          allocation.sales_order_line_id,allocation.sku_id,allocation.location_id,Number(allocation.quantity),at]);
        await client.query(`INSERT INTO fulfillment_wave_lines
          (id,workspace_id,wave_id,shipment_id,shipment_line_id,sku_id,location_id,planned_quantity)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[newId('wvl'),ctx.workspaceId,waveId,shipmentId,
          shipmentLineId,allocation.sku_id,allocation.location_id,Number(allocation.quantity)]);
      }
    }
    const result={waveId,waveNumber:number,status:'PICKING'};
    await client.query(`UPDATE stockchief_runtime.business_operations SET status='COMPLETED',result=$2::jsonb,
      completed_at=now() WHERE id=$1`,[operation.id,JSON.stringify(result)]);
    return {...result,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function resolveIdentity(client,workspaceId,value,kind,options={}){
  const barcode=requireText(value,options.label||'Barcode',{max:240});
  const alias=(await client.query(`SELECT target_id FROM warehouse_barcode_aliases
    WHERE workspace_id=$1 AND lower(barcode)=lower($2) AND target_kind=$3`,[workspaceId,barcode,kind])).rows[0];
  if(alias)return alias.target_id;
  let result;
  if(kind==='location')result=await client.query(`SELECT id FROM locations WHERE workspace_id=$1 AND is_active=1
    AND (lower(barcode)=lower($2) OR lower(name)=lower($2)) LIMIT 2`,[workspaceId,barcode]);
  else if(kind==='sku')result=await client.query(`SELECT id FROM skus WHERE workspace_id=$1 AND is_active=1
    AND (lower(barcode)=lower($2) OR lower(code)=lower($2)) LIMIT 2`,[workspaceId,barcode]);
  else if(kind==='serial')result=await client.query(`SELECT id FROM serial_units WHERE workspace_id=$1
    AND sku_id=$3 AND lower(serial)=lower($2) LIMIT 2`,[workspaceId,barcode,options.skuId]);
  else if(kind==='lot')result=await client.query(`SELECT id FROM lots WHERE workspace_id=$1
    AND sku_id=$3 AND lower(code)=lower($2) LIMIT 2`,[workspaceId,barcode,options.skuId]);
  if(result?.rows.length===1)return result.rows[0].id;
  throw new ValidationError(`${options.label||kind} did not match exactly one active record. Nothing was picked.`);
}

async function recordScan(client,ctx,waveId,input){
  const row=(await client.query(`INSERT INTO fulfillment_wave_scans
    (id,workspace_id,wave_id,line_id,client_scan_id,location_barcode,item_barcode,lot_id,serial_unit_id,
     quantity,status,message,actor_user_id,scanned_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [newId('wvscan'),ctx.workspaceId,waveId,input.lineId||null,input.clientScanId,input.locationBarcode||null,
    input.itemBarcode||null,input.lotId||null,input.serialUnitId||null,input.quantity,input.status,input.message,
    ctx.actorId,nowIso()])).rows[0];
  return row;
}

async function scan(database,ctx,id,input){
  return database.transaction(async(client)=>{
    await actor(client,ctx,'scan fulfillment waves');
    const clientScanId=requireText(input.clientScanId,'Scan ID',{max:240});
    const prior=(await client.query(`SELECT * FROM fulfillment_wave_scans
      WHERE workspace_id=$1 AND client_scan_id=$2`,[ctx.workspaceId,clientScanId])).rows[0];
    if(prior)return {...prior,duplicate:true};
    const wave=(await client.query(`SELECT * FROM fulfillment_waves WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.workspaceId,id])).rows[0];
    if(!wave)throw new NotFoundError('That fulfillment wave could not be found.');
    if(!['PICKING','BLOCKED'].includes(wave.status))throw new ValidationError('That wave is not open for picking.');
    const quantity=requirePositiveInt(input.quantity||1,'Picked quantity');
    try{
      const locationId=await resolveIdentity(client,ctx.workspaceId,input.locationBarcode,'location',{label:'Location scan'});
      const skuId=await resolveIdentity(client,ctx.workspaceId,input.itemBarcode,'sku',{label:'Product scan'});
      const line=(await client.query(`SELECT line.*,item.name AS item_name,item.tracking_mode,location.name AS location_name
        FROM fulfillment_wave_lines line JOIN skus sku ON sku.id=line.sku_id JOIN items item ON item.id=sku.item_id
        JOIN locations location ON location.id=line.location_id
        WHERE line.workspace_id=$1 AND line.wave_id=$2 AND line.location_id=$3 AND line.sku_id=$4
          AND line.picked_quantity<line.planned_quantity ORDER BY line.id LIMIT 1 FOR UPDATE OF line`,
      [ctx.workspaceId,id,locationId,skuId])).rows[0];
      if(!line)throw new ValidationError('That product and location are not open work in this wave. Nothing was picked.');
      const remaining=Number(line.planned_quantity)-Number(line.picked_quantity);
      if(quantity>remaining)throw new ValidationError(`Only ${remaining} remain on this wave line. Nothing was picked.`);
      let lotId=null;let serialUnitId=null;
      if(line.tracking_mode==='serial'){
        if(quantity!==1)throw new ValidationError('Scan one serial number at a time. Nothing was picked.');
        serialUnitId=await resolveIdentity(client,ctx.workspaceId,input.serialBarcode,'serial',
          {skuId:line.sku_id,label:'Serial scan'});
        const unit=(await client.query(`SELECT * FROM serial_units WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [ctx.workspaceId,serialUnitId])).rows[0];
        if(!unit||unit.location_id!==line.location_id||unit.status!=='in_stock')throw new ValidationError('That serial unit is not available at this pick location. Nothing was picked.');
        const used=await client.query(`SELECT 1 FROM fulfillment_wave_scans WHERE workspace_id=$1
          AND serial_unit_id=$2 AND status='ACCEPTED' LIMIT 1`,[ctx.workspaceId,serialUnitId]);
        if(used.rows.length)throw new ValidationError('That serial unit has already been picked. Nothing was picked.');
      }else if(line.tracking_mode==='lot'){
        lotId=await resolveIdentity(client,ctx.workspaceId,input.lotBarcode,'lot',{skuId:line.sku_id,label:'Lot or batch scan'});
        const available=Number((await client.query(`SELECT COALESCE(quantity,0) AS quantity FROM lot_balances
          WHERE workspace_id=$1 AND lot_id=$2 AND location_id=$3 FOR UPDATE`,
        [ctx.workspaceId,lotId,line.location_id])).rows[0]?.quantity||0);
        const already=Number((await client.query(`SELECT COALESCE(SUM(quantity),0) AS quantity FROM fulfillment_wave_scans
          WHERE workspace_id=$1 AND line_id=$2 AND lot_id=$3 AND status='ACCEPTED'`,
        [ctx.workspaceId,line.id,lotId])).rows[0].quantity);
        if(already+quantity>available)throw new ValidationError('That lot does not contain enough stock for this scan. Nothing was picked.');
      }
      await client.query(`UPDATE fulfillment_wave_lines SET picked_quantity=picked_quantity+$2,
        status=CASE WHEN picked_quantity+$2=planned_quantity THEN 'PICKED' ELSE 'OPEN' END WHERE id=$1`,
      [line.id,quantity]);
      await client.query(`UPDATE fulfillment_waves SET status='PICKING' WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,id]);
      return recordScan(client,ctx,id,{...input,clientScanId,quantity,lineId:line.id,lotId,serialUnitId,
        status:'ACCEPTED',message:`Verified ${quantity} ${line.item_name} from ${line.location_name}.`});
    }catch(error){
      if(!(error instanceof ValidationError||error instanceof NotFoundError))throw error;
      await client.query(`UPDATE fulfillment_waves SET status='BLOCKED' WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,id]);
      return recordScan(client,ctx,id,{...input,clientScanId,quantity,status:'REJECTED',message:error.message});
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function reportShortage(database,ctx,id,lineId,foundQuantity,note){
  return database.transaction(async(client)=>{
    await actor(client,ctx,'record wave shortages');
    const line=(await client.query(`SELECT line.* FROM fulfillment_wave_lines line JOIN fulfillment_waves wave ON wave.id=line.wave_id
      WHERE line.workspace_id=$1 AND line.wave_id=$2 AND line.id=$3 AND wave.status IN ('PICKING','BLOCKED')
      FOR UPDATE OF line,wave`,[ctx.workspaceId,id,lineId])).rows[0];
    if(!line)throw new NotFoundError('That open pick line is not in this wave.');
    const clientScanId=`shortage:${id}:${lineId}`;
    const prior=await client.query(`SELECT 1 FROM fulfillment_wave_scans WHERE workspace_id=$1 AND client_scan_id=$2`,
      [ctx.workspaceId,clientScanId]);
    if(prior.rows.length)return {waveId:id,replayed:true};
    const found=Number(foundQuantity);const remaining=Number(line.planned_quantity)-Number(line.picked_quantity);
    if(!Number.isInteger(found)||found<0||found>=remaining)throw new ValidationError('Record a shortage smaller than the quantity still expected.');
    await client.query(`UPDATE fulfillment_wave_lines SET status='SHORT' WHERE id=$1`,[lineId]);
    await client.query(`UPDATE fulfillment_waves SET status='BLOCKED' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id]);
    await recordScan(client,ctx,id,{clientScanId,quantity:1,lineId,status:'REJECTED',
      message:`Only ${found} found. ${trimOrNull(note)||'Recount or replenish before continuing.'}`});
    return {waveId:id,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function packShipment(database,ctx,id,shipmentId,input={}){
  return database.transaction(async(client)=>{
    await actor(client,ctx,'pack fulfillment waves');
    const wave=(await client.query(`SELECT * FROM fulfillment_waves WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.workspaceId,id])).rows[0];
    if(!wave)throw new NotFoundError('That fulfillment wave could not be found.');
    const lines=(await client.query(`SELECT * FROM fulfillment_wave_lines WHERE workspace_id=$1
      AND wave_id=$2 AND shipment_id=$3 FOR UPDATE`,[ctx.workspaceId,id,shipmentId])).rows;
    if(!lines.length)throw new NotFoundError('That shipment is not in this wave.');
    if(lines.some((line)=>Number(line.picked_quantity)!==Number(line.planned_quantity)))throw new ValidationError('Finish scan-verifying every unit in this carton before packing it.');
    const containerId=trimOrNull(input.containerId);
    if(containerId){const container=await client.query(`SELECT 1 FROM warehouse_containers WHERE workspace_id=$1
      AND id=$2 AND status='OPEN'`,[ctx.workspaceId,containerId]);if(!container.rows.length)throw new ValidationError('Choose an open carton from this inventory.');}
    const packageCount=requirePositiveInt(input.packageCount||1,'Package count');
    const weight=input.weightGrams?requirePositiveInt(input.weightGrams,'Measured weight'):null;const at=nowIso();
    await client.query(`UPDATE sales_shipments SET status='PACKED',package_count=$3,weight_grams=COALESCE($4,weight_grams),
      packed_at=COALESCE(packed_at,$5),updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,shipmentId,packageCount,weight,at]);
    await client.query(`UPDATE fulfillment_wave_shipments SET status='PACKED',container_id=$4
      WHERE workspace_id=$1 AND wave_id=$2 AND shipment_id=$3`,[ctx.workspaceId,id,shipmentId,containerId]);
    const remaining=Number((await client.query(`SELECT COUNT(*) AS count FROM fulfillment_wave_shipments
      WHERE workspace_id=$1 AND wave_id=$2 AND status<>'PACKED'`,[ctx.workspaceId,id])).rows[0].count);
    if(!remaining)await client.query(`UPDATE fulfillment_waves SET status='PACKED' WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id]);
    return {waveId:id,shipmentId,status:'PACKED'};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function refresh(database,ctx,id){
  return database.transaction(async(client)=>{
    await actor(client,ctx,'complete fulfillment waves');
    const wave=(await client.query(`SELECT * FROM fulfillment_waves WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.workspaceId,id])).rows[0];
    if(!wave)throw new NotFoundError('That fulfillment wave could not be found.');
    await client.query(`UPDATE fulfillment_wave_shipments wave_shipment SET status=CASE
        WHEN shipment.status IN ('SHIPPED','DELIVERED') THEN 'SHIPPED'
        WHEN shipment.status='CANCELLED' THEN 'CANCELLED'
        ELSE wave_shipment.status END
      FROM sales_shipments shipment WHERE wave_shipment.workspace_id=$1 AND wave_shipment.wave_id=$2
        AND shipment.id=wave_shipment.shipment_id`,[ctx.workspaceId,id]);
    const remaining=Number((await client.query(`SELECT COUNT(*) AS count FROM fulfillment_wave_shipments
      WHERE workspace_id=$1 AND wave_id=$2 AND status NOT IN ('SHIPPED','CANCELLED')`,[ctx.workspaceId,id])).rows[0].count);
    if(!remaining)await client.query(`UPDATE fulfillment_waves SET status='COMPLETED',completed_at=COALESCE(completed_at,$3)
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,nowIso()]);
    return {waveId:id,completed:!remaining};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function containers(database,workspaceId){
  return (await database.query(`SELECT * FROM warehouse_containers WHERE workspace_id=$1 ORDER BY code,id`,[workspaceId])).rows;
}

module.exports={get,list,readyOrders,create,scan,reportShortage,packShipment,refresh,containers,resolveIdentity};
