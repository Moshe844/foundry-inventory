'use strict';
const {newId,nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors'),carriers=require('../sales/carriers');
// Called inside the canonical sales fulfillment transaction, after its exact
// movement/cost/invoice results are known. This records evidence, never stock.
async function recordWithin(client,ctx,order,lines,input){
 const handover=String(input.handover|| (order.delivery_method==='PICKUP'?'COLLECTED':order.delivery_method==='DELIVER'?'DELIVERED_BY_US':'CARRIER')).toUpperCase();
 if(!['CARRIER','COLLECTED','DELIVERED_BY_US'].includes(handover))throw new ValidationError('Choose how the goods physically left.');
 const tracking=String(input.trackingNumber||'').trim(),givenCarrier=String(input.carrier||'').trim();if(tracking.length>240||givenCarrier.length>200)throw new ValidationError('Carrier or tracking information is too long.');
 const carrier=carriers.lookup(givenCarrier)?.code||givenCarrier||carriers.detect(tracking)?.code||null,trackingUrl=carriers.trackingUrlFor(carrier,tracking);
 const open=(await client.query("SELECT shipment_number FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('PICKING','PACKED') FOR UPDATE",[ctx.workspaceId,order.id])).rows;
 if(open.length)throw new ValidationError('Use the existing shipment '+open.map(s=>s.shipment_number).join(', ')+' to record its handoff. No stock or accounting was changed.');
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['shipment-number:'+ctx.workspaceId]);
 let number=Number((await client.query('SELECT count(*) n FROM sales_shipments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),out=[];const at=nowIso();
 for(const locationId of [...new Set(lines.map(l=>l.locationId))]){const id=newId('shp'),shipmentNumber='SHP-'+String(++number).padStart(5,'0');
  await client.query(`INSERT INTO sales_shipments(id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,ship_to_address,handover,carrier,tracking_number,tracking_url,package_count,currency,shipped_at,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,'SHIPPED',$5,$6,$7,$8,$9,$10,1,$11,$12,$13,$12,$12)`,[id,ctx.workspaceId,order.id,shipmentNumber,locationId,order.ship_to_address,handover,handover==='CARRIER'?carrier:null,handover==='CARRIER'?tracking||null:null,handover==='CARRIER'?trackingUrl:null,order.currency,at,ctx.actorId]);
  for(const l of lines.filter(l=>l.locationId===locationId))await client.query(`INSERT INTO sales_shipment_lines(id,workspace_id,shipment_id,sales_order_line_id,sku_id,location_id,quantity,created_at,updated_at) SELECT $1,$2,$3,id,sku_id,$5,$6,$7,$7 FROM sales_order_lines WHERE workspace_id=$2 AND id=$4 AND sales_order_id=$8`,[newId('shpl'),ctx.workspaceId,id,l.lineId,locationId,l.quantity,at,order.id]);
  out.push({shipmentId:id,shipmentNumber});
 }
 return out;
}
module.exports={recordWithin};
