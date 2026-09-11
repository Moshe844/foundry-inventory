'use strict';

const { inTransaction } = require('../db');
const shipments = require('../sales/shipment-service');
const warehouse = require('../warehouse/service');
const permissions = require('../actions/permissions');
const provenance = require('../provenance/service');
const repo = require('../domain/repository');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText, requirePositiveInt, requireOneOf, trimOrNull } = require('../lib/util');

function nextNumber(db,workspaceId){return Number(db.prepare('SELECT COALESCE(MAX(wave_number),0)+1 AS n FROM fulfillment_waves WHERE workspace_id=?').get(workspaceId).n);}
function get(db,workspaceId,id){
  const wave=db.prepare('SELECT * FROM fulfillment_waves WHERE workspace_id=? AND id=?').get(workspaceId,id);
  if(!wave)throw new NotFoundError('That fulfillment wave could not be found.');
  wave.shipments=db.prepare(`SELECT ws.*,sh.shipment_number,sh.status AS shipment_status,so.order_number,c.name AS customer_name,wc.code AS container_code
    FROM fulfillment_wave_shipments ws JOIN sales_shipments sh ON sh.id=ws.shipment_id JOIN sales_orders so ON so.id=ws.sales_order_id
    JOIN customers c ON c.id=so.customer_id LEFT JOIN warehouse_containers wc ON wc.id=ws.container_id WHERE ws.wave_id=? ORDER BY so.needed_by,so.order_number`).all(id);
  wave.lines=db.prepare(`SELECT l.*,s.code AS sku_code,s.barcode AS sku_barcode,i.name AS item_name,i.tracking_mode,s.variant_label,loc.name AS location_name,loc.barcode AS location_barcode,sh.shipment_number
    FROM fulfillment_wave_lines l JOIN skus s ON s.id=l.sku_id JOIN items i ON i.id=s.item_id JOIN locations loc ON loc.id=l.location_id JOIN sales_shipments sh ON sh.id=l.shipment_id
    WHERE l.wave_id=? ORDER BY loc.pick_sequence,loc.name,i.name,s.position`).all(id);
  wave.scans=db.prepare('SELECT * FROM fulfillment_wave_scans WHERE wave_id=? ORDER BY seq DESC LIMIT 100').all(id);
  wave.units={planned:wave.lines.reduce((n,l)=>n+Number(l.planned_quantity),0),picked:wave.lines.reduce((n,l)=>n+Number(l.picked_quantity),0)};
  return wave;
}

function create(db,ctx,membership,input){
  permissions.assertCan(membership,permissions.MANAGE_FULFILLMENT_WAVES,'create fulfillment waves');
  return inTransaction(db,()=>{
    const orderIds=[...new Set(Array.isArray(input.orderIds)?input.orderIds:[])];if(!orderIds.length)throw new ValidationError('Choose at least one ready customer order.');
    const number=nextNumber(db,ctx.workspaceId),id=newId('wave'),at=nowIso();const strategy=requireOneOf(String(input.strategy||'WAVE').toUpperCase(),['WAVE','BATCH','CLUSTER'],'Picking strategy');
    db.prepare(`INSERT INTO fulfillment_waves (id,workspace_id,wave_number,strategy,status,title,created_by_user_id,created_at) VALUES (?,?,?,?,'RELEASED',?,?,?)`)
      .run(id,ctx.workspaceId,number,strategy,trimOrNull(input.title)||`${strategy.charAt(0)+strategy.slice(1).toLowerCase()} pick #${number}`,ctx.actorId,at);
    const addShipment=db.prepare(`INSERT INTO fulfillment_wave_shipments (wave_id,workspace_id,sales_order_id,shipment_id,status) VALUES (?,?,?,?,'PICKING')`);
    const addLine=db.prepare(`INSERT INTO fulfillment_wave_lines (id,workspace_id,wave_id,shipment_id,shipment_line_id,sku_id,location_id,planned_quantity) VALUES (?,?,?,?,?,?,?,?)`);
    for(const orderId of orderIds){
      const existing=db.prepare(`SELECT 1 FROM fulfillment_wave_shipments ws JOIN fulfillment_waves w ON w.id=ws.wave_id WHERE ws.workspace_id=? AND ws.sales_order_id=? AND w.status NOT IN ('COMPLETED','CANCELLED')`).get(ctx.workspaceId,orderId);
      if(existing)throw new ValidationError('One selected order is already in an active fulfillment wave.');
      const box=shipments.startPicking(db,ctx,orderId,{});addShipment.run(id,ctx.workspaceId,orderId,box.id);
      provenance.record(db,ctx.workspaceId,{type:'FULFILLED_BY',from:{type:'sales_order',id:orderId},to:{type:'fulfillment_wave',id}});
      provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'fulfillment_wave',id},to:{type:'shipment',id:box.id}});
      box.lines.forEach((line)=>{const lineId=newId('wvl');addLine.run(lineId,ctx.workspaceId,id,box.id,line.id,line.sku_id,line.location_id,Number(line.quantity));provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'fulfillment_wave',id},to:{type:'fulfillment_wave_line',id:lineId}});});
    }
    db.prepare("UPDATE fulfillment_waves SET status='PICKING' WHERE id=?").run(id);return get(db,ctx.workspaceId,id);
  });
}

function recordScan(db,ctx,waveId,input){const id=newId('wvscan');db.prepare(`INSERT INTO fulfillment_wave_scans
  (id,workspace_id,wave_id,line_id,client_scan_id,location_barcode,item_barcode,lot_id,serial_unit_id,quantity,status,message,actor_user_id,scanned_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,ctx.workspaceId,waveId,input.lineId||null,input.clientScanId,input.locationBarcode||null,input.itemBarcode||null,input.lotId||null,input.serialUnitId||null,input.quantity,input.status,input.message,ctx.actorId,nowIso());return db.prepare('SELECT * FROM fulfillment_wave_scans WHERE id=?').get(id);}

function scan(db,ctx,membership,id,input){
  permissions.assertCan(membership,permissions.MANAGE_FULFILLMENT_WAVES,'scan fulfillment waves');
  return inTransaction(db,()=>{
    const clientScanId=requireText(input.clientScanId,'Scan ID');const prior=db.prepare('SELECT * FROM fulfillment_wave_scans WHERE workspace_id=? AND client_scan_id=?').get(ctx.workspaceId,clientScanId);if(prior)return {...prior,duplicate:true};
    const wave=get(db,ctx.workspaceId,id);if(!['PICKING','BLOCKED'].includes(wave.status))throw new ValidationError('That wave is not open for picking.');
    const quantity=requirePositiveInt(input.quantity||1,'Picked quantity');
    try{
      const location=warehouse.resolveIdentity(db,ctx.workspaceId,input.locationBarcode,{kind:'location',label:'Location barcode'});
      const sku=warehouse.resolveIdentity(db,ctx.workspaceId,input.itemBarcode,{kind:'sku',label:'Product barcode'});
      const line=wave.lines.find((candidate)=>candidate.location_id===location.id&&candidate.sku_id===sku.id&&Number(candidate.picked_quantity)<Number(candidate.planned_quantity));
      if(!line)throw new ValidationError('That product and location are not the next open work in this wave. Nothing was picked.');
      const remaining=Number(line.planned_quantity)-Number(line.picked_quantity);if(quantity>remaining)throw new ValidationError(`Only ${remaining} remain on this wave line. Nothing was picked.`);
      let lotId=null,serialUnitId=null;
      if(line.tracking_mode==='serial'){
        if(quantity!==1)throw new ValidationError('Scan one serial number at a time. Nothing was picked.');
        const unitRef=warehouse.resolveIdentity(db,ctx.workspaceId,input.serialBarcode,{kind:'serial',skuId:line.sku_id,label:'Serial barcode'});
        const unit=repo.requireSerialUnit(db,ctx.workspaceId,unitRef.id);
        if(unit.sku_id!==line.sku_id||unit.location_id!==line.location_id||unit.status!=='in_stock')throw new ValidationError('That serial unit is not available at this pick location. Nothing was picked.');
        if(db.prepare("SELECT 1 FROM fulfillment_wave_scans WHERE workspace_id=? AND serial_unit_id=? AND status='ACCEPTED'").get(ctx.workspaceId,unit.id))throw new ValidationError('That serial unit has already been picked. Nothing was picked.');
        serialUnitId=unit.id;
      }
      if(line.tracking_mode==='lot'){
        const lotRef=warehouse.resolveIdentity(db,ctx.workspaceId,input.lotBarcode,{kind:'lot',skuId:line.sku_id,label:'Lot or batch barcode'});
        const lot=repo.requireLot(db,ctx.workspaceId,lotRef.id);
        if(lot.sku_id!==line.sku_id)throw new ValidationError('That lot belongs to another product. Nothing was picked.');
        const already=Number(db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM fulfillment_wave_scans WHERE workspace_id=? AND line_id=? AND lot_id=? AND status='ACCEPTED'").get(ctx.workspaceId,line.id,lot.id).n);
        if(already+quantity>Number(repo.getLotBalance(db,ctx.workspaceId,lot.id,line.location_id)))throw new ValidationError('That lot does not contain enough stock for this scan. Nothing was picked.');
        lotId=lot.id;
      }
      db.prepare(`UPDATE fulfillment_wave_lines SET picked_quantity=picked_quantity+?,status=CASE WHEN picked_quantity+?=planned_quantity THEN 'PICKED' ELSE 'OPEN' END WHERE id=?`).run(quantity,quantity,line.id);
      db.prepare("UPDATE fulfillment_waves SET status='PICKING' WHERE id=?").run(id);
      return recordScan(db,ctx,id,{...input,clientScanId,quantity,lineId:line.id,lotId,serialUnitId,status:'ACCEPTED',message:`Verified ${quantity} ${line.item_name} from ${line.location_name}.`});
    }catch(error){if(!error.status||error.status>=500)throw error;db.prepare("UPDATE fulfillment_waves SET status='BLOCKED' WHERE id=?").run(id);return recordScan(db,ctx,id,{...input,clientScanId,quantity,status:'REJECTED',message:error.message});}
  });
}

function reportShortage(db,ctx,membership,id,lineId,foundQuantity,note){permissions.assertCan(membership,permissions.MANAGE_FULFILLMENT_WAVES,'record wave shortages');const wave=get(db,ctx.workspaceId,id),line=wave.lines.find((x)=>x.id===lineId);if(!line)throw new NotFoundError('That pick line is not in this wave.');const clientScanId=`shortage:${id}:${lineId}`;const prior=db.prepare('SELECT id FROM fulfillment_wave_scans WHERE workspace_id=? AND client_scan_id=?').get(ctx.workspaceId,clientScanId);if(prior)return get(db,ctx.workspaceId,id);const found=Number(foundQuantity);if(!Number.isInteger(found)||found<0||found>=Number(line.planned_quantity)-Number(line.picked_quantity))throw new ValidationError('Record a shortage smaller than the quantity still expected.');db.prepare("UPDATE fulfillment_wave_lines SET status='SHORT' WHERE id=?").run(lineId);db.prepare("UPDATE fulfillment_waves SET status='BLOCKED' WHERE id=?").run(id);recordScan(db,ctx,id,{clientScanId,quantity:1,lineId,status:'REJECTED',message:`Only ${found} found. ${trimOrNull(note)||'Recount or replenish before continuing.'}`});return get(db,ctx.workspaceId,id);}

function packShipment(db,ctx,membership,id,shipmentId,input={}){permissions.assertCan(membership,permissions.MANAGE_FULFILLMENT_WAVES,'pack fulfillment waves');return inTransaction(db,()=>{const wave=get(db,ctx.workspaceId,id);const lines=wave.lines.filter((line)=>line.shipment_id===shipmentId);if(!lines.length)throw new NotFoundError('That shipment is not in this wave.');if(lines.some((line)=>Number(line.picked_quantity)!==Number(line.planned_quantity)))throw new ValidationError('Finish scan-verifying every unit in this carton before packing it.');const packed=shipments.markPacked(db,ctx,shipmentId,{packageCount:input.packageCount||1,weightGrams:input.weightGrams});db.prepare("UPDATE fulfillment_wave_shipments SET status='PACKED',container_id=? WHERE wave_id=? AND shipment_id=?").run(trimOrNull(input.containerId),id,shipmentId);const remaining=db.prepare("SELECT COUNT(*) AS n FROM fulfillment_wave_shipments WHERE wave_id=? AND status<>'PACKED'").get(id).n;if(!remaining)db.prepare("UPDATE fulfillment_waves SET status='PACKED' WHERE id=?").run(id);return {...get(db,ctx.workspaceId,id),packed};});}

function refresh(db,ctx,membership,id){permissions.assertCan(membership,permissions.MANAGE_FULFILLMENT_WAVES,'complete fulfillment waves');const wave=get(db,ctx.workspaceId,id);for(const row of wave.shipments){const shipment=shipments.getShipment(db,ctx.workspaceId,row.shipment_id);db.prepare('UPDATE fulfillment_wave_shipments SET status=? WHERE wave_id=? AND shipment_id=?').run(shipment.status==='DELIVERED'||shipment.status==='SHIPPED'?'SHIPPED':shipment.status,id,shipment.id);}const remaining=db.prepare("SELECT COUNT(*) AS n FROM fulfillment_wave_shipments WHERE wave_id=? AND status NOT IN ('SHIPPED','CANCELLED')").get(id).n;if(!remaining)db.prepare("UPDATE fulfillment_waves SET status='COMPLETED',completed_at=? WHERE id=?").run(nowIso(),id);return get(db,ctx.workspaceId,id);}

function list(db,workspaceId){return db.prepare(`SELECT w.*,(SELECT COUNT(*) FROM fulfillment_wave_shipments s WHERE s.wave_id=w.id) AS shipment_count,(SELECT COALESCE(SUM(planned_quantity),0) FROM fulfillment_wave_lines l WHERE l.wave_id=w.id) AS units FROM fulfillment_waves w WHERE workspace_id=? ORDER BY created_at DESC`).all(workspaceId);}
function readyOrders(db,workspaceId){return shipments.workQueue(db,workspaceId).ready;}

module.exports={create,get,scan,reportShortage,packShipment,refresh,list,readyOrders};
