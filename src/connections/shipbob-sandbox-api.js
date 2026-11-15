'use strict';
const {ValidationError}=require('../domain/errors');

const sandboxBase='https://sandbox-api.shipbob.com/2026-07/';
const liveBase='https://api.shipbob.com/2026-07/';
function positiveId(value,label){
  if(!/^[1-9]\d{0,14}$/.test(String(value))) throw new ValidationError('Enter a valid '+label+'.');
  return String(value);
}
function client({apiKey,channelId,liveAuthority},fetchImpl=fetch){
  const channel=positiveId(channelId,'ShipBob channel ID');
  const live=Boolean(liveAuthority),base=live?liveBase:sandboxBase,label=live?'ShipBob':'ShipBob sandbox';
  async function call(path,body){
    if(live)liveAuthority();
    const headers={Authorization:'Bearer '+apiKey,shipbob_channel_id:channel,Accept:'application/json'};
    if(body)headers['Content-Type']='application/json';
    let response;
    try{
      response=await fetchImpl(base+path,{headers,method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),
        signal:AbortSignal.timeout(12000),redirect:'error'});
    }catch{const error=new ValidationError(path.startsWith('inventory-level/')?label+' did not respond. The saved stock reading is unchanged.':label+' did not respond. Check the same order reference before retrying.');error.retryable=true;throw error;}
    if(!response.ok){
      const error=new ValidationError(label+' returned HTTP '+response.status+'. Check the connected channel and request.');
      error.providerStatus=response.status;error.retryable=response.status===429||response.status>=500;throw error;
    }
    try{return await response.json();}catch{throw new ValidationError(label+' returned an unreadable response.');}
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
      const visited=new Set();
      let path='channel';
      while(path&&!visited.has(path)&&visited.size<100){
        visited.add(path);
        const page=await call(path),channels=Array.isArray(page)?page:page?.items;
        if(!Array.isArray(channels))throw new ValidationError('ShipBob returned an unexpected channel list.');
        const match=channels.find(c=>String(c.id)===channel);
        if(match){
          const required=['orders_read','orders_write','inventory_read',...(live?['channels_read']:[])];
          if((live||Array.isArray(match.scopes))&&!required.every(scope=>match.scopes?.includes(scope)))
            throw new ValidationError('Choose a ShipBob channel with permission to read and send orders and read inventory.');
          return;
        }
        if(!page.next)break;
        const next=new URL(page.next,base),cursor=next.searchParams.get('cursor')||next.searchParams.get('Cursor');
        if(next.origin!==new URL(base).origin||next.pathname!=='/2026-07/channel'||!cursor||cursor.length>1024)
          throw new ValidationError('ShipBob returned an invalid channel page.');
        path='channel?'+new URLSearchParams({Cursor:cursor});
      }
      throw new ValidationError(label+' could not find this channel for the token you entered.');
    },
    async send(payload,beforeCreate){
      const existing=await find(payload.reference_id);
      if(existing)return checkOrder(existing,payload);
      if(beforeCreate)await beforeCreate();
      try{return checkOrder(await call('order',payload),payload);}
      catch(error){if(![409,422].includes(error.providerStatus))throw error;const duplicate=await find(payload.reference_id);if(!duplicate)throw error;return checkOrder(duplicate,payload);}
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
