'use strict';
const {ValidationError}=require('../domain/errors');

const base='https://sandbox-api.shipbob.com/2026-07/';
function positiveId(value,label){
  if(!/^[1-9]\d{0,14}$/.test(String(value))) throw new ValidationError('Enter a valid '+label+'.');
  return String(value);
}
function client({apiKey,channelId},fetchImpl=fetch){
  const channel=positiveId(channelId,'ShipBob channel ID');
  async function call(path,body){
    const headers={Authorization:'Bearer '+apiKey,shipbob_channel_id:channel,Accept:'application/json'};
    if(body)headers['Content-Type']='application/json';
    let response;
    try{
      response=await fetchImpl(base+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),
        signal:AbortSignal.timeout(12000),redirect:'error'});
    }catch{const error=new ValidationError('ShipBob sandbox did not respond. Retry this order using the same reference.');error.retryable=true;throw error;}
    if(!response.ok){
      const error=new ValidationError('ShipBob sandbox returned HTTP '+response.status+'. Check the connected channel and request.');
      error.providerStatus=response.status;error.retryable=response.status===429||response.status>=500;throw error;
    }
    try{return await response.json();}catch{throw new ValidationError('ShipBob sandbox returned an unreadable response.');}
  }
  async function find(reference){
    const found=await call('order?'+new URLSearchParams({ReferenceIds:reference}));
    if(!Array.isArray(found))throw new ValidationError('ShipBob returned an unexpected order list.');
    const eligible=found.filter(o=>o.reference_id===reference && String(o.channel?.id)===channel);
    if(eligible.length>1)throw new ValidationError('More than one ShipBob order has this reference. Review the channel.');
    return eligible[0]||null;
  }
  function checkOrder(order,payload){
    if(!order || !order.id || order.reference_id!==payload.reference_id || String(order.channel?.id)!==channel)
      throw new ValidationError('ShipBob did not confirm the order reference and channel.');
    const items=list=>(list||[]).map(p=>[String(p.reference_id),Number(p.quantity)]).sort((a,b)=>a[0].localeCompare(b[0]));
    if(JSON.stringify(items(order.products))!==JSON.stringify(items(payload.products)))
      throw new ValidationError('Products or quantities in ShipBob differ from the reviewed order.');
    return order;
  }
  return {
    async verify(){
      const channels=await call('channel');
      if(!Array.isArray(channels)||!channels.some(c=>String(c.id)===channel))throw new ValidationError('This sandbox token cannot see that channel.');
    },
    async send(payload){
      const existing=await find(payload.reference_id);
      if(existing)return checkOrder(existing,payload);
      try{return checkOrder(await call('order',payload),payload);}
      catch(error){if(error.providerStatus!==422)throw error;const duplicate=await find(payload.reference_id);if(!duplicate)throw error;return checkOrder(duplicate,payload);}
    },
    async order(id,reference){
      const value=await call('order/'+positiveId(id,'ShipBob order ID'));
      if(String(value?.id)!==String(id)||value.reference_id!==reference||String(value.channel?.id)!==channel)
        throw new ValidationError('The ShipBob order belongs to a different reference or channel.');
      return value;
    },
    async stock(id,sku){
      const value=await call('inventory-level/'+positiveId(id,'ShipBob inventory ID'));
      if(String(value.inventory_id)!==String(id)||value.sku!==sku || ![value.total_on_hand_quantity,value.total_fulfillable_quantity].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647))
        throw new ValidationError('ShipBob inventory does not match this SKU or has unconfirmed quantities.');
      return value;
    }
  };
}
module.exports={client,positiveId};
