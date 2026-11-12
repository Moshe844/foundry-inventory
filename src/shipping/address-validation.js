'use strict';
// Job 69: the carrier's own address check, behind one shape.
//
//   check(ctx, to) -> { status: 'VERIFIED' | 'UNDELIVERABLE' | 'UNVERIFIED',
//                       matched: { line1, line2, city, state, postalCode, country } | null,
//                       residential: true | false | null, messages: [text] }
//
// These are kept apart from the rate adapters on purpose: a test or a caller
// that supplies its own rate adapter never makes a hidden address call.
const {ValidationError}=require('../domain/errors');

const text=value=>{const s=String(value??'').trim();return s||null;};
const flag=value=>value===true||value==='yes'||value==='true'?true:value===false||value==='no'||value==='false'?false:null;
const notes=list=>(Array.isArray(list)?list:[]).map(row=>text(typeof row==='string'?row:row?.message||row?.text||row?.description)).filter(Boolean).slice(0,10);

// ShipEngine and ShipStation V2 share one address-validation contract.
function readShipEngine(body){
  const row=Array.isArray(body)?body[0]:null;
  if(!row||typeof row!=='object')throw new ValidationError('The carrier did not answer the address check.');
  const status=String(row.status||'').toLowerCase(),m=row.matched_address;
  const matched=m&&m.address_line1?{line1:text(m.address_line1),line2:text(m.address_line2),city:text(m.city_locality),state:text(m.state_province),
    postalCode:text(m.postal_code),country:text(m.country_code)}:null;
  return {status:status==='error'?'UNDELIVERABLE':(status==='verified'||status==='warning')&&matched?'VERIFIED':'UNVERIFIED',
    matched,residential:flag(m?.address_residential_indicator),messages:notes(row.messages)};
}
function wireAddress(to){return [require('./providers/shipengine').address(to)];}

async function shipengine(ctx,to){
  return readShipEngine(await require('./providers/shipengine').call(ctx,'/addresses/validate',{method:'POST',retries:0,body:wireAddress(to)}));
}
async function shipstation(ctx,to){
  return readShipEngine(await require('./providers/shipstation').call(ctx,'/addresses/validate',{method:'POST',retries:0,body:wireAddress(to)}));
}

// Shippo's address validation answers a read with a recommended address.
function readShippo(body){
  const analysis=body?.analysis,result=String(analysis?.validation_result?.value||'').toLowerCase(),r=body?.recommended_address;
  if(!analysis)throw new ValidationError('The carrier did not answer the address check.');
  const matched=r&&r.address_line_1?{line1:text(r.address_line_1),line2:text(r.address_line_2),city:text(r.city_locality),state:text(r.state_province),
    postalCode:text(r.postal_code),country:text(r.country_code)}:null;
  const type=String(analysis.address_type||'').toLowerCase();
  return {status:result==='invalid'?'UNDELIVERABLE':(result==='valid'||result==='partially_valid')&&matched?'VERIFIED':'UNVERIFIED',
    matched,residential:type==='residential'?true:type==='commercial'?false:null,messages:notes(analysis.validation_result?.reasons)};
}
async function shippo(ctx,to){
  const query=new URLSearchParams(Object.entries({address_line_1:to.line1,address_line_2:to.line2,city_locality:to.city,state_province:to.state,
    postal_code:to.postalCode,country_code:to.country||'US'}).filter(([,value])=>text(value)).map(([key,value])=>[key,String(value)]));
  return readShippo(await require('./providers/shippo').call(ctx,'/v2/addresses/validate?'+query.toString(),{retries:0}));
}

// EasyPost verifies delivery when it creates the address record.
function readEasyPost(body){
  const delivery=body?.verifications?.delivery;
  if(!delivery||typeof delivery.success!=='boolean')throw new ValidationError('The carrier did not answer the address check.');
  const matched=delivery.success&&body.street1?{line1:text(body.street1),line2:text(body.street2),city:text(body.city),state:text(body.state),
    postalCode:text(body.zip),country:text(body.country)}:null;
  return {status:delivery.success&&matched?'VERIFIED':'UNDELIVERABLE',matched,residential:flag(body.residential),messages:notes(delivery.errors)};
}
async function easypost(ctx,to){
  const easy=require('./providers/easypost');
  return readEasyPost(await easy.call(ctx,'/addresses',{method:'POST',retries:0,body:{address:easy.address(to),verify:['delivery']}}));
}

const validators=new Map([['shipengine',shipengine],['shipstation',shipstation],['shippo',shippo],['easypost',easypost]]);
function forProvider(name){return validators.get(String(name||'').toLowerCase())||null;}

// Street words written differently but meaning the same thing. A correction
// that only changes these, letter case, punctuation or the ZIP+4 is formatting.
const WORDS={street:'st',str:'st',avenue:'ave',av:'ave',road:'rd',drive:'dr',lane:'ln',boulevard:'blvd',court:'ct',place:'pl',terrace:'ter',
  circle:'cir',highway:'hwy',parkway:'pkwy',square:'sq',trail:'trl',expressway:'expy',freeway:'fwy',turnpike:'tpke',crossing:'xing',
  north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw',
  apartment:'#',apt:'#',unit:'#',suite:'#',ste:'#',number:'#',no:'#',building:'bldg',floor:'fl',room:'rm',mount:'mt',fort:'ft'};
function words(value){
  return String(value||'').toLowerCase().replace(/#/g,' # ').replace(/[.,']/g,' ').split(/\s+/).filter(Boolean).map(word=>WORDS[word]||word).join(' ');
}
function key(a){
  if(!a)return '';
  return [words([a.line1,a.line2].filter(Boolean).join(' ')),words(a.city),String(a.state||'').trim().toUpperCase(),
    String(a.postalCode||'').replace(/\s/g,'').slice(0,5).toUpperCase(),String(a.country||'US').trim().toUpperCase()].join('|');
}
function sameAddress(a,b){return key(a)!==''&&key(a)===key(b);}
function oneLine(a){
  return [a.line1,a.line2,a.city,[a.state,a.postalCode].filter(Boolean).join(' '),a.country&&a.country!=='US'?a.country:null].filter(Boolean).join(', ');
}

const PO_BOX=/\b(?:p\s*\.?\s*o\s*\.?\s*box|post\s+office\s+box|pobox)\b/i;
function poBox(a){return Boolean(a)&&[a.line1,a.line2].some(line=>PO_BOX.test(String(line||'')));}
// UPS, FedEx and DHL do not deliver to PO boxes. Their services that hand the
// last mile to the postal service do. These are carrier identifiers only.
function refusesPoBox(rate){
  const carrier=String(rate?.carrier||'').toLowerCase().replace(/[^a-z]/g,''),service=String(rate?.service||'').toLowerCase().replace(/[^a-z]/g,'');
  if(/surepost|smartpost|groundeconomy|mailinnovations|parcelselect/.test(service))return false;
  return /^(ups|fedex|dhl|ontrac|lasership)/.test(carrier);
}

module.exports={forProvider,readShipEngine,readShippo,readEasyPost,sameAddress,key,oneLine,poBox,refusesPoBox};
