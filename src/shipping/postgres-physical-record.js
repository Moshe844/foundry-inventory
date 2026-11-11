'use strict';
const {newId,nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors'),carriers=require('../sales/carriers');
// Called inside the canonical sales fulfillment transaction, after its exact
// movement/cost/invoice results are known. This records evidence, never stock.
async function recordWithin(client,ctx,order,lines,input){
 const handover=String(input.handover|| (order.delivery_method==='PICKUP'?'COLLECTED':order.delivery_method==='DELIVER'?'DELIVERED_BY_US':'CARRIER')).toUpperCase();
 if(!['CARRIER','COLLECTED','DELIVERED_BY_US'].includes(handover))throw new ValidationError('Choose how the goods physically left.');
 const tracking=String(input.trackingNumber||'').trim(),givenCarrier=String(input.carrier||'').trim();if(tracking.length>240||givenCarrier.length>200)throw new ValidationError('Carrier or tracking information is too long.');
 const carrier=carriers.lookup(givenCarrier)?.code||givenCarrier||carriers.detect(tracking)?.code||null,trackingUrl=carriers.trackingUrlFor(carrier,tracking);
 if(lines.some(line=>line.supplierDirect))return recordDirect(client,ctx,order,lines,{carrier,tracking,trackingUrl,input});
 const open=(await client.query("SELECT shipment_number FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('PICKING','PACKED') FOR UPDATE",[ctx.workspaceId,order.id])).rows;
 if(open.length)throw new ValidationError('Use the existing shipment '+open.map(s=>s.shipment_number).join(', ')+' to record its handoff. No stock or accounting was changed.');
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['shipment-number:'+ctx.workspaceId]);
 const physicalLines=lines.flatMap(l=>l.kitComponents?l.kitComponents.map(c=>({...c,lineId:l.lineId,kitComponentId:c.componentId})):l);
 let number=Number((await client.query('SELECT count(*) n FROM sales_shipments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),out=[];const at=nowIso();
 for(const locationId of [...new Set(physicalLines.map(l=>l.locationId))]){const id=newId('shp'),shipmentNumber='SHP-'+String(++number).padStart(5,'0');
  await client.query(`INSERT INTO sales_shipments(id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,ship_to_address,handover,carrier,tracking_number,tracking_url,package_count,currency,shipped_at,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'SHIPPED',$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$12,$12)`,[id,ctx.workspaceId,order.id,shipmentNumber,locationId,order.ship_to_address,handover,handover==='CARRIER'?carrier:null,handover==='CARRIER'?tracking||null:null,handover==='CARRIER'?trackingUrl:null,order.currency,at,ctx.actorId]);
  const combined=new Map();for(const l of physicalLines.filter(l=>l.locationId===locationId)){const key=JSON.stringify([l.lineId,l.kitComponentId||null]),prior=combined.get(key);combined.set(key,{...l,quantity:prior?require('../domain/exact-quantity').safeNumber(require('../domain/exact-quantity').add(prior.quantity,l.quantity)):l.quantity,movementIds:[...(prior?.movementIds||[]),...(l.movementId?[l.movementId]:[])]});}
  for(const l of combined.values())if(l.kitComponentId)await client.query('INSERT INTO sales_shipment_kit_lines(id,workspace_id,shipment_id,kit_component_id,sales_order_line_id,sku_id,location_id,quantity,movement_ids,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)',[newId('shpk'),ctx.workspaceId,id,l.kitComponentId,l.lineId,l.skuId,locationId,l.quantity,JSON.stringify(l.movementIds),at]);else await client.query(`INSERT INTO sales_shipment_lines(id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at) SELECT $1,$2,$3,id,sku_id,$5,$6,$7,$7 FROM sales_order_lines WHERE workspace_id=$2 AND id=$4 AND sales_order_id=$8`,[newId('shpl'),ctx.workspaceId,id,l.lineId,locationId,l.quantity,at,order.id]);
  out.push({shipmentId:id,shipmentNumber});
 }
 return out;
}

async function recordDirect(client,ctx,order,lines,{carrier,tracking,trackingUrl,input}){
 const grant=require('../purchasing/direct-shipment-authority').fulfillment(ctx);
 if(!grant||lines.some(line=>!line.supplierDirect||line.supplierDirect.dispatchId!==grant.dispatchId))
  throw new ValidationError('A direct shipment needs its confirmed supplier dispatch evidence.');
 if(!carrier||!tracking)throw new ValidationError('Record the supplier’s actual carrier and tracking number before passing the shipment to the customer.');
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['shipment-number:'+ctx.workspaceId]);
 const number=Number((await client.query('SELECT count(*) n FROM sales_shipments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n)+1;
 const id=newId('shp'),shipmentNumber='SHP-'+String(number).padStart(5,'0'),at=nowIso();
 await client.query(`INSERT INTO sales_shipments(id,workspace_id,sales_order_id,shipment_number,status,ship_to_address,
  handover,carrier,tracking_number,tracking_url,package_count,currency,shipped_at,created_by_user_id,created_at,updated_at,
  delivery_kind,direct_purchase_order_id)
  VALUES($1,$2,$3,$4,'SHIPPED',$5,'CARRIER',$6,$7,$8,1,$9,$10,$11,$12,$12,'CUSTOMER_DIRECT',$13)`,
 [id,ctx.workspaceId,order.id,shipmentNumber,order.ship_to_address,carrier,tracking,trackingUrl,order.currency,
  input.shippedAt,ctx.actorId,at,grant.purchaseOrderId]);
 for(const line of lines)await client.query(`INSERT INTO sales_shipment_lines(id,workspace_id,shipment_id,sales_order_line_id,
  sku_id,quantity,created_at,updated_at,direct_dispatch_line_id) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
 [newId('shpl'),ctx.workspaceId,id,line.lineId,line.skuId,line.quantity,at,line.supplierDirect.dispatchLineId]);
 return [{shipmentId:id,shipmentNumber}];
}
module.exports={recordWithin};
