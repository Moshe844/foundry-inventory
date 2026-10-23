'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('ShipStation quotes all price components rather than silently dropping insurance or signature fees',()=>{
 const adapter=require('../../src/shipping/providers/shipstation');assert.equal(adapter.readRate({rate_id:'r',shipping_amount:{currency:'usd',amount:5},insurance_amount:{currency:'usd',amount:1.25},confirmation_amount:{currency:'usd',amount:2.5},other_amount:{currency:'usd',amount:0.75}}).amountMinor,950);
 assert.throws(()=>adapter.readRate({rate_id:'r',shipping_amount:{currency:'usd',amount:5},insurance_amount:{currency:'eur',amount:1}}),/currenc/i);
});
test('requested print format and signature survive each provider wire boundary',async()=>{
 const previous=global.fetch,requests=[];global.fetch=async(url,init={})=>{const u=new URL(url),body=init.body?JSON.parse(init.body):null;requests.push({host:u.hostname,path:u.pathname,body});
  let result=u.pathname.endsWith('/carriers')?{carriers:[{carrier_id:'carrier'}]}:u.hostname.includes('goshippo')&&u.pathname.startsWith('/rates/')?{object_id:'r',amount:'5.00',currency:'USD'}:
   u.hostname.includes('easypost')?{id:'shp',rates:[],selected_rate:{rate:'5',currency:'USD'},postage_label:{label_url:'https://example.test/label.zpl',label_file_type:'ZPL'},tracking_code:'TN'}:
    u.hostname.includes('shipstation')?u.pathname.endsWith('/rates')?{rate_response:{rates:[]}}:{label_id:'label',label_format:'zpl',label_download:{zpl:'https://example.test/label.zpl'},shipment_cost:{amount:5,currency:'USD'}}:
     u.pathname.endsWith('/transactions/')?{object_id:'txn',status:'SUCCESS',rate:{amount:'5',currency:'USD'},label_url:'https://example.test/label.zpl',label_file_type:'ZPLII',tracking_number:'TN'}:{object_id:'shp',rates:[]};
  return {ok:true,status:200,text:async()=>JSON.stringify(result)};};
 try{for(const name of ['easypost','shipstation','shippo']){const adapter=require('../../src/shipping/providers/'+name),ctx={[name+'ApiKey']:'test_fixture'},input={from:{email:'sender@example.test'},to:{},packages:[{weightGrams:100,lengthMm:100,widthMm:100,heightMm:100}],options:{labelFormat:'ZPL',labelLayout:'4x6',signature:'ADULT'}};
   await adapter.quote(ctx,input);const label=await adapter.buy(ctx,{rateIds:['r'],providerShipmentIds:['shp'],options:input.options});assert.match(label.labelFormat,/ZPL/i);assert.equal(label.labelUrl,'https://example.test/label.zpl');}
  assert.equal(requests.find(r=>r.host.includes('easypost')&&r.path.endsWith('/shipments')).body.shipment.options.label_format,'ZPL');
  assert.equal(requests.find(r=>r.host.includes('easypost')&&r.path.endsWith('/shipments')).body.shipment.options.delivery_confirmation,'ADULT_SIGNATURE');
  assert.equal(requests.find(r=>r.host.includes('shipstation')&&r.path.endsWith('/rates')).body.shipment.confirmation,'adult_signature');
  assert.equal(requests.find(r=>r.host.includes('shipstation')&&r.path.includes('/labels/rates/')).body.label_format,'zpl');
  assert.equal(requests.find(r=>r.host.includes('goshippo')&&r.path.endsWith('/transactions/')).body.label_file_type,'ZPLII');
  assert.equal(requests.find(r=>r.host.includes('goshippo')&&r.path.endsWith('/shipments/')).body.extra.signature_confirmation,'ADULT');
 }finally{global.fetch=previous;}
});
