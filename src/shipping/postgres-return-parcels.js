'use strict';
// A return is a direction of travel in the shared parcel engine. Carrier events
// never stand in for canonical RMA receipt, inspection, restocking or refund.
const {ValidationError,NotFoundError}=require('../domain/errors'),{newId,nowIso}=require('../lib/util');
async function current(database,workspaceId,returnId){return (await database.query("SELECT id,shipment_number,status,label_status,tracking_number FROM sales_shipments WHERE workspace_id=$1 AND customer_return_id=$2 AND status<>'CANCELLED' ORDER BY created_at DESC LIMIT 1",[workspaceId,returnId])).rows[0]||null;}
async function outstanding(queryable,workspaceId,returnId){
 const rma=(await queryable.query('SELECT * FROM customer_returns WHERE workspace_id=$1 AND id=$2',[workspaceId,returnId])).rows[0];
 if(!rma)throw new NotFoundError('That authorized return is not in this business.');
 if(!['AUTHORIZED','PARTIALLY_RECEIVED'].includes(rma.status))throw new ValidationError('Authorize the return before preparing postage. Already received goods do not need another return label.');
 const quantities=(await queryable.query('SELECT id,sku_id,quantity_authorized-quantity_received AS quantity FROM customer_return_lines WHERE workspace_id=$1 AND customer_return_id=$2 AND quantity_authorized>quantity_received ORDER BY id',[workspaceId,returnId])).rows.map(row=>({lineId:row.id,skuId:row.sku_id,quantity:Number(row.quantity)}));
 if(!quantities.length)throw new ValidationError('No authorized goods are still expected for this return.');return {rma,quantities};
}
async function assertCurrent(queryable,workspaceId,shipment){if(!shipment.customer_return_id)return;
 const {quantities}=await outstanding(queryable,workspaceId,shipment.customer_return_id);
 if(!require('node:util').isDeepStrictEqual(quantities,shipment.return_quantities))throw new ValidationError('The authorized return quantities changed. Review or void its existing label before preparing another parcel.');
}
async function prepare(database,ctx,returnId,input={}){return database.transaction(async client=>{
 await require('./postgres-parcel-options').actor(client,ctx);
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['return-postage:'+ctx.workspaceId+':'+returnId]);
 const {rma,quantities}=await outstanding(client,ctx.workspaceId,returnId),existing=await current(client,ctx.workspaceId,returnId);
 if(existing)return {shipmentId:existing.id,replayed:true};
 const outbounds=(await client.query("SELECT * FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND customer_return_id IS NULL AND status IN ('SHIPPED','DELIVERED') ORDER BY shipped_at DESC,id",[ctx.workspaceId,rma.sales_order_id])).rows;
 let outbound=input.outboundShipmentId?outbounds.find(row=>row.id===input.outboundShipmentId):outbounds[0];
 if(!outbound)throw new ValidationError('Choose an original shipment that actually left for this customer.');
 if(!input.outboundShipmentId&&new Set(outbounds.map(row=>row.ship_to_address)).size>1)throw new ValidationError('This order went to different addresses. Select its original shipment before preparing return postage.');
 const source=await require('./postgres-service').requireShipment(client,ctx.workspaceId,outbound.id),address=require('./address'),origin=address.parse(source.ship_to_address);
 Object.assign(origin,{name:source.customer_name,email:source.customer_email,phone:source.customer_phone});
 const location=(await client.query('SELECT * FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1',[ctx.workspaceId,input.locationId||source.ship_from_location_id])).rows[0];
 if(!origin.complete||!location||!address.parse(location.address).complete)throw new ValidationError('Confirm the complete customer collection and return-destination addresses before preparing postage.');
 const id=newId('ship'),at=nowIso(),name='RET-'+rma.return_number;
 await client.query(`INSERT INTO sales_shipments(id,workspace_id,sales_order_id,shipment_number,status,ship_from_location_id,ship_to_address,customer_return_id,return_origin,return_quantities,currency,created_by_user_id,packed_at,created_at,updated_at,return_outbound_shipment_id)
  VALUES($1,$2,$3,$4,'PACKED',$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$12,$12,$13)`,[id,ctx.workspaceId,rma.sales_order_id,name,location.id,location.address,returnId,JSON.stringify(origin),JSON.stringify(quantities),source.currency,ctx.actorId,at,outbound.id]);
 const boxes=await require('./postgres-service').packagesFor(client,ctx.workspaceId,outbound.id);
 for(const [i,box]of boxes.entries())await client.query(`INSERT INTO shipment_packages(id,workspace_id,shipment_id,position,weight_grams,length_mm,width_mm,height_mm,weight_source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ESTIMATED',$9,$9)`,[newId('pkg'),ctx.workspaceId,id,i+1,box.weightGrams||null,box.lengthMm||null,box.widthMm||null,box.heightMm||null,at]);
 return {shipmentId:id,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={prepare,current,outstanding,assertCurrent};
require('../commercial/enforcement').guardExports(module.exports,0,1,{prepare:'shipping.workflow'});
