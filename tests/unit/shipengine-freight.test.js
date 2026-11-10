'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const freight=require('../../src/shipping/shipengine-freight');
const account={shipengineApiKey:'TEST_fixture'};
const address={company:'Example Wholesale',name:'Dock team',line1:'123 Test Street',city:'Springfield',state:'MA',
  postalCode:'01101',country:'US',phone:'4135550100',locationType:'commercial'};
const input={accountId:'se-123',pickupDate:'2026-11-20',readyTime:'09:00',closeTime:'16:30',from:address,
  to:{...address,company:'Example Retailer',line1:'456 Fixture Street'},confirmed:'yes',nonHazardous:'yes',
  pallets:[{length:'48.5',width:40,height:51,quantity:2,commodities:[{description:'Boxed fixtures',quantity:24,weight:'310.125',freightClass:'125'}]}],
  accessorials:['liftgate_delivery','appointment_delivery']};
const now=Date.parse('2026-11-19T15:30:00Z');
const remoteQuote={freight_provider_account_id:'se-123',offer_id:'offer-1',carrier_scac:'FXFE',carrier_name:'Synthetic Freight',
  service_name:'Standard LTL',total_charges:842.37,quote_expiration_date:'2026-11-19T23:30:00Z'};
const confirmed={freight_shipment_id:'se-555',freight_provider_account_id:'se-123',status:'booked',bol_number:'BOL-1',
  confirmation_number:'PICKUP-1',pro_number:null,documents:[{type:'BILL_OF_LADING',url:'https://api.shipengine.com/v2/downloads/p1/sample/bol.pdf'}]};

test('pallet quotes keep confirmed inches, pounds, classes, exact charges and accessorials',async()=>{
  const snapshot=freight.build(input);
  assert.deepEqual(snapshot.handling[0],{type:'pallet',quantity:2,stackable:false,length:48.5,width:40,height:51,
    commodities:[{description:'Boxed fixtures',quantity:24,weight:310.125,freight_class:'125'}]});
  assert.equal(snapshot.shipFrom.address_residential_indicator,undefined);
  const offers=await freight.quotes(account,snapshot,async(ctx,path,{body,method})=>{
    assert.equal(ctx,account);
    assert.equal(path,'/freight/quotes');
    assert.equal(method,'POST');
    assert.equal(body.shipment_date,'2026-11-20T00:00:00Z');
    assert.deepEqual(body.accessorials,{liftgate_delivery:true,appointment_delivery:true});
    assert.equal(body.handling_units,snapshot.handling);
    return {quotes:[remoteQuote]};
  },now);
  assert.equal(offers[0].amountMinor,84237);
  await assert.rejects(freight.quotes(account,snapshot,async()=>({quotes:[{...remoteQuote,freight_provider_account_id:'se-999'}]}),now),/exact account/);
  await assert.rejects(freight.quotes(account,snapshot,async()=>({quotes:[{...remoteQuote,total_charges:'1.001'}]}),now),/fraction/);
  assert.throws(()=>freight.build({...input,pickupDate:'2026-02-30'}),/pickup date/);
  assert.throws(()=>freight.build({...input,nonHazardous:''}),/non-hazardous/);
  assert.throws(()=>freight.build({...input,accessorials:['carrier_terminal_pickup']}),/supported/);
});

test('one unexpired offer schedules the requested carrier pickup, saves its receipt and can be read back',async()=>{
  const snapshot=freight.build(input),[quote]=await freight.quotes(account,snapshot,async()=>({quotes:[remoteQuote]}),now);
  const identities=[];
  let writes=0;
  const options={reference:'stockchief-freight-1',now,onIdentity:async id=>identities.push(id),request:async(ctx,path,opts)=>{
    assert.equal(ctx,account);
    assert.equal(path,'/freight/shipments');
    assert.equal(opts.method,'POST');
    assert.equal(opts.retries,0);
    assert.equal(opts.body.offer_id,'offer-1');
    assert.equal(opts.body.pickup_details.is_self_scheduled,false);
    assert.deepEqual(opts.body.references,[{type:'reference_1',value:'stockchief-freight-1'}]);
    writes++;
    return confirmed;
  }};
  const receipt=await freight.book(account,snapshot,quote,options);
  assert.deepEqual(identities,['se-555']);
  assert.equal(receipt.number,'PICKUP-1');
  assert.match(receipt.document,/\/downloads\//);
  await assert.rejects(freight.book(account,snapshot,quote,{...options,now:Date.parse('2026-11-20T15:30:00Z')}),e=>e.providerWriteAttempted===false);
  assert.equal(writes,1);
  const read=await freight.retrieve(account,'se-123','se-555',async(ctx,path)=>{
    assert.equal(ctx,account);
    assert.equal(path,'/freight/shipments/se-555');
    return {...confirmed,status:'in_transit',documents:[{type:'bill_of_lading',url:'https://example.test/forged.pdf'}]};
  });
  assert.equal(read.status,'in_transit');
  assert.equal(read.document,null);
  await assert.rejects(freight.book(account,snapshot,quote,{...options,request:async()=>({...confirmed,confirmation_number:null})}),e=>e.providerOutcomeUncertain);
  assert.deepEqual(identities,['se-555','se-555']);
});
