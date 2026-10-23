'use strict';
const {ValidationError}=require('../../domain/errors');
async function easypost(call,ctx,input){
 const page=await call(ctx,'/webhooks'),found=(page?.webhooks||[]).find(row=>row.url===input.url);
 const body={webhook:{url:input.url,webhook_secret:input.webhookSecret}};
 const row=found?await call(ctx,'/webhooks/'+encodeURIComponent(found.id),{method:'PATCH',retries:0,body:{webhook_secret:input.webhookSecret}}):
  await call(ctx,'/webhooks',{method:'POST',retries:0,body});
 if(!row?.id)throw new ValidationError('EasyPost did not confirm the webhook registration.');
 return {status:'CONNECTED',id:row.id};
}
async function shippo(call,ctx,input){
 const url=new URL(input.url);url.searchParams.set('token',input.webhookSecret);
 // Reconcile by exact URL before every write, including recovery after a lost response.
 for(let page=1;page<=100;page++){
  const list=await call(ctx,'/webhooks/?page='+page),rows=list?.results||[];
  const found=rows.find(row=>row.url===url.href&&row.event==='track_updated'&&Boolean(row.is_test)===Boolean(input.testMode)&&row.active!==false);
  if(found)return {status:'CONNECTED',id:found.object_id};
  if(!list?.next)break;if(page===100)throw new ValidationError('The carrier webhook list could not be completely reconciled.');
 }
 const row=await call(ctx,'/webhooks/',{method:'POST',retries:0,body:{url:url.href,event:'track_updated',is_test:Boolean(input.testMode)}});
 if(!row?.object_id)throw new ValidationError('Shippo did not confirm the webhook registration.');
 return {status:'CONNECTED',id:row.object_id};
}
async function shipstation(call,ctx,input){
 if(input.testMode)return {status:'POLLING',reason:'ShipStation supports webhooks only in its live environment. Test shipments are checked automatically.'};
 const list=await call(ctx,'/environment/webhooks'),rows=Array.isArray(list)?list:list?.webhooks||[];
 const found=rows.find(row=>row.url===input.url&&row.event==='track_event_v2');
 const row=found||await call(ctx,'/environment/webhooks',{method:'POST',retries:0,body:{url:input.url,event:'track_event_v2'}});
 if(!row?.webhook_id)throw new ValidationError('ShipStation did not confirm the webhook registration.');
 return {status:'CONNECTED',id:row.webhook_id};
}
module.exports={easypost,shippo,shipstation};
