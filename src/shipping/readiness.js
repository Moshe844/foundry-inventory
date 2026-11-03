'use strict';
// Everything a carrier needs before it will quote, known up front and asked for
// together on the order, so nobody discovers the gaps one trip at a time.
const addresses=require('./address'),locations=require('../domain/postgres-location-service');
const {ValidationError}=require('../domain/errors'),{trimOrNull,nowIso}=require('../lib/util');

async function needs(db,workspaceId,{orderId,locationId,shipToAddress}){
 const order=(await db.query('SELECT id,customer_id,ship_to_address,contact_phone FROM sales_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,orderId])).rows[0];
 const place=locationId?(await db.query('SELECT id,name,address,phone FROM locations WHERE workspace_id=$1 AND id=$2',[workspaceId,locationId])).rows[0]:null;
 const destination=shipToAddress===undefined?order?.ship_to_address:shipToAddress,to=addresses.parse(destination),from=addresses.parse(place?.address);
 const result={customerPhone:!trimOrNull(order?.contact_phone),shipTo:to.complete?null:{address:destination||'',why:addresses.why(to)},
  from:place&&(!from.complete||!trimOrNull(place.phone))?{id:place.id,name:place.name,address:place.address||'',phone:place.phone||'',addressMissing:!from.complete,phoneMissing:!trimOrNull(place.phone),why:from.complete?null:addresses.why(from)}:null};
 result.any=Boolean(result.customerPhone||result.shipTo||result.from);
 return result;
}

// Saves only what was asked for. Checked first, so a bad address changes nothing.
async function save(db,ctx,{orderId,locationId,canEditLocation=false},body){
 const shipTo=trimOrNull(body.shipToAddress),fromAddress=trimOrNull(body.shipFromAddress),fromPhone=trimOrNull(body.shipFromPhone),phone=trimOrNull(body.customerPhone);
 if(shipTo){const parsed=addresses.parse(shipTo);if(!parsed.complete)throw new ValidationError(addresses.why(parsed));}
 if(fromAddress){const parsed=addresses.parse(fromAddress);if(!parsed.complete)throw new ValidationError(addresses.why(parsed,'The ship-from address'));}
 if(shipTo||phone)await db.transaction(async client=>{const at=nowIso();
  if(shipTo){await client.query("UPDATE sales_orders SET ship_to_address=$3,ship_to_source='order',updated_at=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,orderId,shipTo,at]);
   await client.query("UPDATE sales_shipments SET ship_to_address=$3,updated_at=$4 WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('PICKING','PACKED') AND customer_return_id IS NULL AND coalesce(label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING')",[ctx.workspaceId,orderId,shipTo,at]);}
  if(phone){await client.query('UPDATE sales_orders SET contact_phone=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,orderId,phone,at]);
   await client.query("UPDATE customers SET phone=$3,updated_at=$4 WHERE workspace_id=$1 AND id=(SELECT customer_id FROM sales_orders WHERE workspace_id=$1 AND id=$2) AND coalesce(phone,'')=''",[ctx.workspaceId,orderId,phone,at]);}
 });
 if((fromAddress||fromPhone)&&locationId){
  if(!canEditLocation)throw new ValidationError('Only an owner can change a location. Ask them to add its address and phone.');
  const place=(await db.query('SELECT name,kind,parent_location_id FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,locationId])).rows[0];
  await locations.updateLocation(db,ctx,locationId,{name:place.name,kind:place.kind,parentLocationId:place.parent_location_id,...(fromAddress?{address:fromAddress}:{}),...(fromPhone?{phone:fromPhone}:{})});
 }
}
module.exports={needs,save};
