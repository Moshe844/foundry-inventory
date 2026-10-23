'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const shipengine=require('../../src/shipping/providers/shipengine'),shippo=require('../../src/shipping/providers/shippo');

test('PostgreSQL workers and web routes have the canonical provider registry without loading the legacy application',()=>{
  const registry=require('../../src/shipping/provider');
  for(const name of ['easypost','shipstation','shippo','shipengine'])assert.equal(registry.has(name),true,name+' is registered at the shared provider boundary');
});

test('metric parcel dimensions are converted into the units accepted by ShipStation and ShipEngine',()=>{
  for(const [length,width,height]of [[200,150,100],[123,57,9],[1,1,1]]){
    const parcel=shipengine.parcel({weightGrams:350,lengthMm:length,widthMm:width,heightMm:height});
    assert.deepEqual(parcel.dimensions,{length:length/10,width:width/10,height:height/10,unit:'centimeter'});
    assert.deepEqual(parcel.weight,{value:350,unit:'gram'});
  }
});

test('a Shippo rate reference is resolved before purchase and retains the label price and service',async()=>{
  const previous=global.fetch,calls=[];
  global.fetch=async(url,input)=>{calls.push({url:String(url),method:input.method});
    const data=String(url).includes('/rates/')?{object_id:'rate-confirmed',amount:'6.37',currency:'USD',provider:'USPS',servicelevel:{name:'Ground Advantage'}}:
      {object_id:'txn-confirmed',status:'SUCCESS',rate:'rate-confirmed',label_url:'https://example.test/label.pdf',tracking_number:'TEST-TRACK'};
    return {ok:true,status:200,text:async()=>JSON.stringify(data)};};
  try{const result=await shippo.buy({shippoApiKey:'shippo_test_wire_fixture'},{rateIds:['rate-confirmed'],idempotencyKey:'test-buy'});
    assert.equal(result.amountMinor,637);assert.equal(result.currency,'USD');assert.equal(result.carrier,'usps');assert.equal(result.service,'Ground Advantage');
    assert.deepEqual(calls.map(call=>call.method),['GET','POST']);assert.match(calls[0].url,/\/rates\/rate-confirmed\/?$/);
  }finally{global.fetch=previous;}
});

test('an accepted asynchronous Shippo purchase retains its provider identity and cannot be retried as a new buy',async()=>{
  const previous=global.fetch;
  global.fetch=async(url)=>({ok:true,status:200,text:async()=>JSON.stringify(String(url).includes('/rates/')?
    {object_id:'rate-pending',amount:'7.25',currency:'USD',provider:'USPS',servicelevel:{name:'Priority Mail'}}:
    {object_id:'txn-pending',status:'WAITING',rate:'rate-pending',test:true})});
  try{await assert.rejects(shippo.buy({shippoApiKey:'shippo_test_wire_fixture'},{rateIds:['rate-pending'],idempotencyKey:'pending-buy'}),
    error=>error.providerOutcomeUncertain===true&&error.providerReference?.externalId==='txn-pending');
  }finally{global.fetch=previous;}
});

for(const provider of ['easypost','shipstation','shippo','shipengine'])test(provider+' does not retry a label HTTP write after an ambiguous response',async()=>{
  const previous=global.fetch;let writes=0;
  global.fetch=async(_url,input)=>{
    if(input.method==='GET')return {ok:true,status:200,text:async()=>JSON.stringify({amount:'5.25',currency:'USD'})};
    writes++;return {ok:false,status:503,headers:{get:()=>null},text:async()=>JSON.stringify({})};
  };
  try{
    await assert.rejects(require('../../src/shipping/providers/'+provider).buy({[provider+'ApiKey']:'test_contract_key'},
      {providerShipmentIds:['shipment-fixture'],rateIds:['rate-fixture'],idempotencyKey:'one-submission'}),
      error=>error.providerOutcomeUncertain===true);
    assert.equal(writes,1,'an arbitrary idempotency header does not prove a provider guarantees deduplication');
  }finally{global.fetch=previous;}
});

test('a definite Shippo label refusal retains its transaction and explains the provider problem without exposing credentials',async()=>{
 const previous=global.fetch,key='shippo_test_private_fixture';
 global.fetch=async(url)=>({ok:true,status:200,text:async()=>JSON.stringify(String(url).includes('/rates/')?
   {object_id:'rate-refused',amount:'4.25',currency:'USD'}:
   {object_id:'transaction-refused',status:'ERROR',messages:[{text:'Carrier registration incomplete. '+key}]})});
 try{await assert.rejects(shippo.buy({shippoApiKey:key},{rateIds:['rate-refused'],idempotencyKey:'one-refused-label'}),
  error=>error.status===400&&error.providerReference?.externalId==='transaction-refused'&&/Carrier registration incomplete/.test(error.message)&&!error.message.includes(key));
 }finally{global.fetch=previous;}
});

test('Shippo requests a missing sender contact before making a rate request',async()=>{
 await assert.rejects(shippo.quote({shippoApiKey:'shippo_test_contact_fixture'},{from:{},to:{},packages:[]}),/shipping contact email.*ship-from location/i);
});

test('Shippo forwards the explicit location contact to its address contract',async()=>{
 const previous=global.fetch;let request;
 global.fetch=async(_url,init)=>{request=JSON.parse(init.body);return {ok:true,status:200,text:async()=>JSON.stringify({object_id:'parcel-contact',rates:[]})};};
 try{await shippo.quote({shippoApiKey:'shippo_test_contact_fixture'},{from:{email:'dispatch@example.test'},to:{},packages:[{weightGrams:300,lengthMm:200,widthMm:150,heightMm:100}]});
  assert.equal(request.address_from.email,'dispatch@example.test');
 }finally{global.fetch=previous;}
});
