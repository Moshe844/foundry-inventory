'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('return intent survives provider boundaries and uses ShipStation’s supported return-label endpoint',async()=>{
 const previous=global.fetch,requests=[];global.fetch=async(url,init={})=>{const u=new URL(url),body=init.body?JSON.parse(init.body):null;requests.push({host:u.hostname,path:u.pathname,body});let result={};
  if(u.pathname.endsWith('/carriers'))result={carriers:[{carrier_id:'carrier'}]};
  else if(u.pathname==='/v2/rates/r')result={carrier_id:'carrier',service_code:'ground',shipping_amount:{amount:5,currency:'USD'}};
  else if(u.pathname==='/v2/shipments/shipment')result={ship_from:{name:'Customer',country_code:'US'},ship_to:{name:'Warehouse',country_code:'US'},packages:[{weight:{value:100,unit:'gram'}}]};
  else if(u.pathname==='/v2/labels')result={label_id:'return-label',tracking_number:'RMA-TRACK',is_return_label:true,shipment_cost:{amount:5,currency:'USD'},label_format:'pdf',label_download:{pdf:'https://example.test/return.pdf'}};
  else if(u.hostname.includes('easypost'))result={id:'shipment',rates:[]};else if(u.hostname.includes('goshippo'))result={object_id:'shipment',rates:[]};
  return {ok:true,status:200,text:async()=>JSON.stringify(result)};};
 try{
  for(const provider of ['easypost','shippo'])await require('../../src/shipping/providers/'+provider).quote({[provider+'ApiKey']:'test_fixture'},{isReturn:true,originalCarrier:'usps',from:{name:'Customer',email:'customer@example.test'},to:{name:'Warehouse',email:'merchant@example.test'},packages:[{weightGrams:100,lengthMm:100,widthMm:100,heightMm:100}]});
  const ss=require('../../src/shipping/providers/shipstation');await ss.buy({shipstationApiKey:'test_fixture'},{isReturn:true,providerShipmentIds:['shipment'],rateIds:['r'],currency:'USD',approvedAmountMinor:500});
  assert.equal(requests.find(r=>r.host.includes('easypost')).body.shipment.is_return,true);assert.equal(requests.find(r=>r.host.includes('goshippo')).body.extra.is_return,true);
  assert.equal(requests.find(r=>r.host.includes('easypost')).body.shipment.from_address.name,'Warehouse');assert.equal(requests.find(r=>r.host.includes('easypost')).body.shipment.to_address.name,'Customer');
  assert.equal(requests.find(r=>r.host.includes('goshippo')).body.address_from.name,'Warehouse');assert.equal(requests.find(r=>r.host.includes('goshippo')).body.address_to.name,'Customer');
  const label=requests.find(r=>r.path==='/v2/labels');assert.equal(label.body.is_return_label,true);assert.equal(label.body.charge_event,'carrier_default');assert.equal(label.body.shipment.service_code,'ground');assert.equal(label.body.shipment.ship_to.name,'Warehouse');assert(!requests.some(r=>r.path.includes('/labels/rates/')));
 }finally{global.fetch=previous;}
});
