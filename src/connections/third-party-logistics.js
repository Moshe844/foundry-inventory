'use strict';

// Job 186: the seam between StockChief and a 3PL that runs one of the
// business's warehouses. The 3PL order flow (agent-3pl-orders.js) never speaks
// a 3PL's own API. It hands an adapter a plain order and reads back plain
// shipments and stock:
//
//   adapter = {
//     key, label,
//     connectorKey,                 the workspace connection it uses
//     account(config)               the 3PL account or channel the connection is for
//     payload(order)                the 3PL's own request for one order; the
//                                   request fingerprint is taken over it
//     client(secret, config, transport) -> {
//       verify()                    the credentials can see that account
//       submit(payload, beforeCreate) -> placed order; replay-safe: an order
//                                   already there under the same reference is
//                                   returned, never created twice. beforeCreate
//                                   runs just before anything is created.
//       order(id, reference)        -> placed order, checked against its reference
//       stock(inventoryRef, sku)    -> {inventoryRef, onHand, available}
//     }
//   }
//   order  = {reference, number, recipient:{name,line1,line2,city,state,postalCode,country},
//             lines:[{sku,name,quantity}]}
//   placed = {id, status, shipments:[{id, status, shipped, carrier, tracking, shippedAt,
//             lines:[{sku,quantity}]}]}
//
// ShipBob's sandbox is built in. Another 3PL is one more adapter of this
// shape; tests hand in a scripted one through register().

const {ValidationError}=require('../domain/errors');
const adapters=new Map();
const CLIENT=['verify','submit','order','stock'];

function register(key,adapter){
  const name=String(key||'').toLowerCase();
  if(!/^[a-z0-9-]{2,40}$/.test(name))throw new TypeError('A 3PL adapter needs a short lowercase name.');
  for(const field of ['label','connectorKey'])if(typeof adapter?.[field]!=='string')throw new TypeError('3PL adapter "'+name+'" needs '+field+'.');
  for(const fn of ['account','payload','client'])if(typeof adapter?.[fn]!=='function')throw new TypeError('3PL adapter "'+name+'" is missing '+fn+'.');
  adapters.set(name,{...adapter,key:name});
  return ()=>adapters.delete(name);
}
function get(key){
  const found=adapters.get(String(key||'').toLowerCase());
  if(!found)throw new ValidationError('This 3PL is not available. Reconnect it.');
  return found;
}
function byConnector(connectorKey){
  for(const adapter of adapters.values())if(adapter.connectorKey===connectorKey)return adapter;
  return null;
}
function list(){return [...adapters.values()];}
function client(adapter,secret,config,transport){
  const made=adapter.client(secret||{},config||{},transport);
  const missing=CLIENT.filter(m=>typeof made?.[m]!=='function');
  if(missing.length)throw new TypeError('3PL adapter "'+adapter.key+'" is missing: '+missing.join(', ')+'.');
  return made;
}
const whole=(n,label)=>{const v=Number(n);if(!Number.isSafeInteger(v)||v<0||v>2147483647)throw new ValidationError('The 3PL reported an unclear '+label+'.');return v;};

// ShipBob: a shipment counts as shipped once ShipBob marks it completed.
function placedShipBob(order){
  const shipments=(order.shipments||[]).map(s=>({id:String(s.id),status:String(s.status||'Unknown'),shipped:/^(completed|shipped|delivered)$/i.test(String(s.status||'')),
    carrier:s.tracking?.carrier||null,tracking:s.tracking?.number||s.tracking?.tracking_number||null,shippedAt:s.actual_fulfillment_date||null,
    lines:(s.products||[]).map(p=>({sku:String(p.reference_id||p.sku||''),quantity:p.quantity!=null?Number(p.quantity):
      (p.inventory_items||[]).reduce((n,i)=>n+Number(i.quantity||0),0)}))}));
  return {id:String(order.id),status:String(order.status||'Unknown'),shipments,raw:order};
}
register('shipbob',{
  label:'ShipBob sandbox',connectorKey:'agent-shipbob-sandbox',
  account:config=>String(config.channelId),
  payload:o=>({reference_id:o.reference,order_number:o.number,type:'DTC',shipping_method:'Standard',
    recipient:{name:o.recipient.name,address:{address1:o.recipient.line1,address2:o.recipient.line2,city:o.recipient.city,state:o.recipient.state,country:o.recipient.country,zip_code:o.recipient.postalCode}},
    products:o.lines.map(l=>({reference_id:l.sku,name:l.name,quantity:l.quantity}))}),
  client(secret,config,transport){
    const api=require('./shipbob-sandbox-api').client({apiKey:secret.apiKey,channelId:config.channelId},transport);
    return {
      verify:()=>api.verify(),
      submit:async(payload,beforeCreate)=>placedShipBob(await api.send(payload,beforeCreate)),
      order:async(id,reference)=>placedShipBob(await api.order(id,reference)),
      async stock(inventoryRef,sku){const v=await api.stock(inventoryRef,sku);return {inventoryRef:String(v.inventory_id),onHand:whole(v.total_on_hand_quantity,'stock'),available:whole(v.total_fulfillable_quantity,'stock')};}
    };
  }
});

module.exports={register,get,byConnector,list,client,whole,placedShipBob};
