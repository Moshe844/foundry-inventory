'use strict';
// Job 69: each connected account's own address check, read into one shape.
// The carrier answers here are recorded documentation shapes, not live calls.
const test=require('node:test'),assert=require('node:assert/strict');
const validation=require('../../src/shipping/address-validation');
const {judge}=require('../../src/shipping/agent-address-checks');

function response(body,status=200){return {ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body),json:async()=>body};}
const to={name:'Receiver',phone:'5185550100',line1:'10 Jobsite Rd',line2:null,city:'Albany',state:'NY',postalCode:'12207',country:'US'};

test('each carrier address check is called once in its own format and read into one shape',async()=>{
  const calls=[],held=global.fetch;
  global.fetch=async(url,init={})=>{calls.push({url:String(url),init});const u=new URL(url);
    if(u.hostname==='api.shipengine.com'||u.hostname==='api.shipstation.com')return response([{status:'verified',original_address:{},
      matched_address:{address_line1:'10 JOBSITE RD',city_locality:'ALBANY',state_province:'NY',postal_code:'12207-4021',country_code:'US',address_residential_indicator:'no'},messages:[]}]);
    if(u.hostname==='api.goshippo.com')return response({original_address:{},recommended_address:{address_line_1:'100 Jobsite Rd',city_locality:'Albany',state_province:'NY',postal_code:'12207',country_code:'US'},
      analysis:{validation_result:{value:'partially_valid',reasons:[{code:'street_number',description:'Street number corrected'}]},address_type:'residential'}});
    if(u.hostname==='api.easypost.com')return response({street1:'10 JOBSITE RD',city:'ALBANY',state:'NY',zip:'12207',country:'US',residential:true,
      verifications:{delivery:{success:true,errors:[],details:{}}}});
    throw new Error('Unexpected '+url);};
  try{
    const se=await validation.forProvider('shipengine')({shipengineApiKey:'TEST_key'},to);
    assert.deepEqual(se,{status:'VERIFIED',matched:{line1:'10 JOBSITE RD',line2:null,city:'ALBANY',state:'NY',postalCode:'12207-4021',country:'US'},residential:false,messages:[]});
    assert.equal(calls[0].url,'https://api.shipengine.com/v1/addresses/validate');assert.equal(calls[0].init.method,'POST');
    assert.equal(JSON.parse(calls[0].init.body)[0].address_line1,'10 Jobsite Rd');assert.equal(calls[0].init.headers['api-key'],'TEST_key');
    const ss=await validation.forProvider('shipstation')({shipstationApiKey:'TEST_ss'},to);
    assert.equal(ss.status,'VERIFIED');assert.equal(calls[1].url,'https://api.shipstation.com/v2/addresses/validate');
    const sh=await validation.forProvider('shippo')({shippoApiKey:'shippo_test_key'},to);
    assert.equal(sh.status,'VERIFIED');assert.equal(sh.matched.line1,'100 Jobsite Rd');assert.equal(sh.residential,true);assert.deepEqual(sh.messages,['Street number corrected']);
    const read=new URL(calls[2].url);assert.equal(read.pathname,'/v2/addresses/validate');assert.equal(read.searchParams.get('address_line_1'),'10 Jobsite Rd');
    assert.equal(read.searchParams.get('postal_code'),'12207');assert.equal(calls[2].init.method||'GET','GET');
    const ep=await validation.forProvider('easypost')({easypostApiKey:'EZTK_key'},to);
    assert.equal(ep.status,'VERIFIED');assert.equal(ep.residential,true);assert.equal(calls[3].url,'https://api.easypost.com/v2/addresses');
    assert.deepEqual(JSON.parse(calls[3].init.body).verify,['delivery']);
    assert.equal(calls.length,4,'one call per check, never retried');
    assert.equal(validation.forProvider('shipstation_custom_store'),null);
  }finally{global.fetch=held;}
});

test('carrier answers are read conservatively',()=>{
  assert.equal(validation.readShipEngine([{status:'error',matched_address:null,messages:[{message:'Invalid City'}]}]).status,'UNDELIVERABLE');
  assert.equal(validation.readShipEngine([{status:'unverified',matched_address:null}]).status,'UNVERIFIED');
  assert.equal(validation.readShipEngine([{status:'warning',matched_address:{address_line1:'1 A St',city_locality:'B',state_province:'NY',postal_code:'10001',country_code:'US'},messages:[{message:'Apartment missing'}]}]).status,'VERIFIED');
  assert.throws(()=>validation.readShipEngine({}),/did not answer/);
  assert.equal(validation.readShippo({analysis:{validation_result:{value:'invalid'}},recommended_address:null}).status,'UNDELIVERABLE');
  assert.throws(()=>validation.readShippo({}),/did not answer/);
  assert.equal(validation.readEasyPost({verifications:{delivery:{success:false,errors:[{message:'Address not found'}]}}}).status,'UNDELIVERABLE');
  assert.deepEqual(validation.readEasyPost({verifications:{delivery:{success:false,errors:[{message:'Address not found'}]}}}).messages,['Address not found']);
  assert.throws(()=>validation.readEasyPost({street1:'1 A St'}),/did not answer/);
});

test('only formatting is told apart from a real correction, and PO boxes from carriers that refuse them',()=>{
  const a={line1:'10 Jobsite Road',line2:'Apt 4',city:'Albany',state:'NY',postalCode:'12207',country:'US'};
  assert.equal(validation.sameAddress(a,{line1:'10 JOBSITE RD',line2:'# 4',city:'ALBANY',state:'ny',postalCode:'12207-4021',country:'US'}),true);
  assert.equal(validation.sameAddress(a,{line1:'10 Jobsite Rd Unit 4',city:'Albany',state:'NY',postalCode:'12207'}),true);
  assert.equal(validation.sameAddress(a,{line1:'100 Jobsite Rd',line2:'Apt 4',city:'Albany',state:'NY',postalCode:'12207'}),false);
  assert.equal(validation.sameAddress(a,{line1:'10 Jobsite Rd',line2:'Apt 4',city:'Albany',state:'NY',postalCode:'12208'}),false);
  assert.equal(validation.sameAddress(a,{line1:'10 Jobsite Rd',line2:'Apt 5',city:'Albany',state:'NY',postalCode:'12207'}),false);
  assert.equal(validation.poBox({line1:'P.O. Box 12'}),true);assert.equal(validation.poBox({line1:'PO Box 12'}),true);
  assert.equal(validation.poBox({line1:'12 Boxwood Ln'}),false);
  assert.equal(validation.refusesPoBox({carrier:'ups',service:'Ground'}),true);assert.equal(validation.refusesPoBox({carrier:'fedex',service:'FedEx Home Delivery'}),true);
  assert.equal(validation.refusesPoBox({carrier:'dhl_express',service:'Express Worldwide'}),true);
  assert.equal(validation.refusesPoBox({carrier:'usps',service:'Priority Mail'}),false);assert.equal(validation.refusesPoBox({carrier:'stamps_com',service:'USPS Ground Advantage'}),false);
  assert.equal(validation.refusesPoBox({carrier:'ups',service:'UPS SurePost'}),false);assert.equal(validation.refusesPoBox({carrier:'fedex',service:'SmartPost'}),false);
});

test('a carrier answer becomes a hold only when a person must decide',()=>{
  const parsed=require('../../src/shipping/address').parse('10 Jobsite Rd, Albany, NY 12207'),subject={to:parsed,text:parsed.raw,orderText:parsed.raw,business:'',changed:false};
  const exact={status:'VERIFIED',matched:{line1:'10 Jobsite Rd',city:'Albany',state:'NY',postalCode:'12207',country:'US'},residential:false,messages:[]};
  assert.deepEqual([judge(subject,exact).result,judge(subject,exact).hold],['VERIFIED',null]);
  const tidy=judge(subject,{...exact,matched:{...exact.matched,line1:'10 JOBSITE RD',postalCode:'12207-4021'}});
  assert.deepEqual([tidy.result,tidy.hold,tidy.suggested],['FORMATTED',null,'10 JOBSITE RD, Albany, NY 12207-4021']);
  const moved=judge(subject,{...exact,matched:{...exact.matched,line1:'100 Jobsite Rd'}});assert.deepEqual([moved.result,moved.hold],['CORRECTED','correction']);
  assert.equal(judge({...subject,business:'Jobsite Supply'},{...exact,residential:true}).hold,'residential');
  assert.equal(judge(subject,{...exact,residential:true}).hold,null,'a home address is expected for a person');
  assert.equal(judge(subject,{failed:true,messages:[]}).hold,'failed');
  assert.deepEqual([judge(subject,null).result,judge(subject,null).hold],['UNCHECKED',null]);
  assert.equal(judge({...subject,changed:true,orderText:'5 Main St, Troy, NY 12180'},null).suggested,'5 Main St, Troy, NY 12180');
});
