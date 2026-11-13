'use strict';

const {ValidationError}=require('../domain/errors');
const {requireText}=require('../lib/util');
const money=require('../domain/currency');
const shipengine=require('./providers/shipengine');

const identifier=/^se-[0-9]{1,30}$/;
const offerIdentifier=/^[a-z0-9][a-z0-9-]{0,79}$/i;
const freightClasses=new Set(['50','55','60','65','70','77.5','85','92.5','100','110','125','150','175','200','250','300','400','500']);
const locations=new Set(['airport','carrier_terminal','commercial','construction','container_freight_station','distribution_center',
  'government_facility','limited_access','pier_port_wharf','residential','secured_access','trade_show']);
const accessorials=['liftgate_pickup','liftgate_delivery','inside_pickup','inside_delivery','residential_pickup','residential_delivery',
  'construction_site_pickup','construction_site_delivery','appointment_delivery','notify_before_delivery','hold_at_terminal',
  'sort_and_segregate','protection_from_cold','protection_from_heat','grocery_consolidation_pickup','grocery_consolidation_delivery'];
// Standard LTL handling units: a pallet up to 96 inches on each side and
// 2,500 pounds, and up to 15,000 pounds a shipment. Anything larger is
// oversized freight: a person confirms the carrier takes it, and a routine
// never books it.
const limits={sideInches:96,palletPounds:2500,shipmentPounds:15000};
const time=/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const calendar=/^\d{4}-\d{2}-\d{2}$/;
const iso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function scoped(ctx){
  if(!ctx?.shipengineApiKey)throw new ValidationError('Use a connected freight account for this inventory.');
  if(process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&!/^TEST_/.test(ctx.shipengineApiKey))
    throw new ValidationError('Staging can only use a freight sandbox key.');
}

function numeric(value,label,{decimals=0,max}){
  const text=String(value??'').trim(),pattern=decimals?/^\d+(?:\.\d{1,3})?$/:/^\d+$/;
  const amount=Number(text);
  if(text.length>16||!pattern.test(text)||!Number.isFinite(amount)||amount<=0||amount>max)
    throw new ValidationError('Enter the measured '+label+' as a positive number up to '+max+'.');
  return amount;
}

function address(input){
  if(!locations.has(input?.locationType))throw new ValidationError('Choose the actual freight location type.');
  if(!/^[A-Z]{2}$/.test(input.country))throw new ValidationError('Confirm the two-letter country codes.');
  const {address_residential_indicator:_indicator,...wire}=shipengine.address(input);
  const contact={...wire,company_name:requireText(input.company,'Company name',{max:150}),
    name:requireText(input.name,'Freight contact name',{max:150}),phone:requireText(input.phone,'Freight contact phone',{max:45}),
    location_type:input.locationType};
  for(const field of ['address_line1','city_locality','state_province','postal_code','country_code']){
    if(!contact[field])throw new ValidationError('Confirm the complete freight pickup and delivery addresses.');
  }
  return contact;
}

// Which pallet groups are over the standard limits, in plain words, or null.
function oversize(handling){
  const over=[];let total=0;
  for(const [index,unit] of handling.entries()){
    const pounds=unit.commodities.reduce((sum,commodity)=>sum+commodity.weight,0);total+=pounds*unit.quantity;
    if([unit.length,unit.width,unit.height].some(side=>side>limits.sideInches)||pounds>limits.palletPounds)over.push(index+1);
  }
  if(over.length)return 'Pallet group '+over.join(', ')+' is over the standard LTL limit of '+limits.sideInches+
    ' inches a side and '+limits.palletPounds.toLocaleString('en-US')+' pounds a pallet.';
  return total>limits.shipmentPounds?'This freight is over the standard LTL limit of '+limits.shipmentPounds.toLocaleString('en-US')+' pounds.':null;
}

function handlingUnits(rows){
  if(!Array.isArray(rows)||!rows.length||rows.length>40)throw new ValidationError('Record one to 40 pallet groups from the packed freight.');
  return rows.map(row=>{
    if(!Array.isArray(row?.commodities)||!row.commodities.length||row.commodities.length>100)
      throw new ValidationError('Record the actual freight class and weight for every commodity on each pallet.');
    return {type:'pallet',quantity:numeric(row.quantity,'pallet count',{max:200}),stackable:row.stackable===true,
      length:numeric(row.length,'pallet length in inches',{decimals:3,max:1000}),width:numeric(row.width,'pallet width in inches',{decimals:3,max:1000}),
      height:numeric(row.height,'pallet height in inches',{decimals:3,max:1000}),commodities:row.commodities.map(commodity=>{
        const freightClass=String(commodity?.freightClass);
        if(!freightClasses.has(freightClass))throw new ValidationError('Use the freight class already confirmed with the carrier.');
        return {description:requireText(commodity.description,'Commodity description',{max:180}),
          quantity:numeric(commodity.quantity,'commodity package count',{max:100000}),
          weight:numeric(commodity.weight,'commodity weight in pounds',{decimals:3,max:100000}),freight_class:freightClass,
          ...(commodity.nmfcCode?{nmfc_code:requireText(commodity.nmfcCode,'NMFC code',{max:24})}:{})};
      })};
  });
}

function build(input){
  if(input?.confirmed!=='yes')throw new ValidationError('Confirm the measured freight and that this shipment is non-hazardous.');
  if(input.nonHazardous!=='yes')throw new ValidationError('Confirm this shipment is non-hazardous. Hazardous freight always needs a person to book it directly with the carrier.');
  if(!identifier.test(input.accountId))throw new ValidationError('Choose an active freight account from your ShipStation API connection.');
  const date=String(input.pickupDate||''),dateTime=new Date(date+'T00:00:00Z');
  if(!calendar.test(date)||!Number.isFinite(dateTime.getTime())||dateTime.toISOString().slice(0,10)!==date||
    !time.test(input.readyTime)||!time.test(input.closeTime)||input.readyTime>=input.closeTime)
    throw new ValidationError('Confirm the pickup date and earliest and latest pickup times in the warehouse’s local time.');
  const extras=input.accessorials||[];
  if(!Array.isArray(extras)||extras.some(extra=>!accessorials.includes(extra)))throw new ValidationError('Choose only supported pickup or delivery services.');
  const shipFrom=address(input.from),shipTo=address(input.to);
  const pickup={pickup_date:date,ready_time:input.readyTime,close_time:input.closeTime,is_self_scheduled:false,location_type:shipFrom.location_type};
  const handling=handlingUnits(input.pallets),over=oversize(handling);
  // Over the standard limits it stops and asks: a person checks that the
  // carrier takes this freight, or books it with the carrier directly.
  if(over&&input.oversizeConfirmed!=='yes')throw new ValidationError(over+' Check with the carrier first, then confirm it takes this freight.');
  return {accountId:input.accountId,shipFrom,shipTo,pickup,handling,...(over?{oversize:true}:{}),
    services:Object.fromEntries(accessorials.filter(extra=>extras.includes(extra)).map(extra=>[extra,true]))};
}

async function accounts(ctx,request=shipengine.call){
  scoped(ctx);
  const result=await request(ctx,'/freight/provider_accounts');
  if(!Array.isArray(result?.freight_provider_accounts))throw new ValidationError('ShipStation did not return the connected freight accounts.');
  return result.freight_provider_accounts.filter(row=>identifier.test(row.freight_provider_account_id)&&row.freight_provider_code).map(row=>({
    id:row.freight_provider_account_id,code:String(row.freight_provider_code).slice(0,80),name:String(row.nickname||row.freight_provider_code).slice(0,150)}));
}

async function quotes(ctx,snapshot,request=shipengine.call,now=Date.now()){
  scoped(ctx);
  const result=await request(ctx,'/freight/quotes',{method:'POST',retries:0,timeoutMs:18000,body:{
    freight_provider_account_id:snapshot.accountId,shipment_date:snapshot.pickup.pickup_date+'T00:00:00Z',
    ship_from:snapshot.shipFrom,ship_to:snapshot.shipTo,handling_units:snapshot.handling,accessorials:snapshot.services}});
  if(!Array.isArray(result?.quotes))throw new ValidationError('ShipStation did not return the available freight quotes.');
  const ids=new Set();
  return result.quotes.map(quote=>{
    if(quote.freight_provider_account_id!==snapshot.accountId||!offerIdentifier.test(quote.offer_id)||ids.has(quote.offer_id)||
      !iso.test(quote.quote_expiration_date)||!quote.carrier_scac||!quote.carrier_name||!quote.service_name)
      throw new ValidationError('A freight quote is missing its exact account, carrier, service, offer or expiration.');
    ids.add(quote.offer_id);
    // Freight limits and approvals are in US dollars. A quote in another
    // currency stops the request: it is never converted or compared.
    const charge=quote.total_charges!==null&&typeof quote.total_charges==='object'?quote.total_charges:{amount:quote.total_charges,currency:quote.currency};
    const currency=String(charge.currency??'USD').trim().toUpperCase();
    if(currency!=='USD')throw new ValidationError('The carrier quoted in '+(/^[A-Z]{3}$/.test(currency)?currency:'another currency')+
      ', but freight here is approved in US dollars. Book this pickup with the carrier directly.');
    return {id:quote.offer_id,accountId:snapshot.accountId,carrier:requireText(quote.carrier_scac,'Carrier code',{max:20}),
      carrierName:requireText(quote.carrier_name,'Carrier name',{max:150}),service:requireText(quote.service_name,'Freight service',{max:100}),
      amountMinor:money.toMinor(charge.amount,'USD',{label:'Quoted freight charge'}),expiresAt:quote.quote_expiration_date,
      estimatedDelivery:iso.test(quote.estimated_delivery_date)?quote.estimated_delivery_date:null,guaranteed:quote.is_guaranteed===true};
  }).filter(quote=>Date.parse(quote.expiresAt)>now&&quote.amountMinor>0);
}

function document(value){
  try{
    const url=new URL(value);
    return url.origin==='https://api.shipengine.com'&&!url.username&&!url.password&&
      /^\/v[12]\/downloads\/[a-z0-9_./%-]+\.pdf$/i.test(url.pathname)?url.href:null;
  }catch{return null;}
}

function confirmed(raw,expectedAccount,expectedId){
  const id=raw?.freight_shipment_id;
  if(!identifier.test(id)||expectedId&&expectedId!==id||raw.freight_provider_account_id!==expectedAccount||
    !['booked','in_transit','delivered'].includes(raw.status)||!raw.bol_number||!raw.confirmation_number)
    throw new ValidationError('ShipStation did not confirm this exact freight pickup. Verify the existing booking before another attempt.');
  const bol=(Array.isArray(raw.documents)?raw.documents:[]).find(item=>String(item.type).toLowerCase()==='bill_of_lading');
  return {id,status:raw.status,number:requireText(raw.confirmation_number,'Pickup confirmation',{max:180}),
    bol:requireText(raw.bol_number,'Bill of lading number',{max:180}),document:document(bol?.url),
    proNumber:raw.pro_number?requireText(raw.pro_number,'Carrier tracking number',{max:180}):null};
}

async function book(ctx,snapshot,quote,{reference,onIdentity=async()=>{},request=shipengine.call,now=Date.now()}={}){
  scoped(ctx);
  if(quote.accountId!==snapshot.accountId||!offerIdentifier.test(quote.id)||!iso.test(quote.expiresAt)||
    !(Date.parse(quote.expiresAt)>now)||!/^[a-z0-9_-]{4,35}$/i.test(reference)){
    throw Object.assign(new ValidationError('Review a current freight quote and a saved pickup reference before booking.'),{providerWriteAttempted:false});
  }
  const result=await request(ctx,'/freight/shipments',{method:'POST',retries:0,timeoutMs:18000,body:{
    offer_id:quote.id,ship_from:snapshot.shipFrom,ship_to:snapshot.shipTo,handling_units:snapshot.handling,
    pickup_details:snapshot.pickup,references:[{type:'reference_1',value:reference}]}});
  try{
    if(identifier.test(result?.freight_shipment_id)&&result.freight_provider_account_id===snapshot.accountId)
      await onIdentity(result.freight_shipment_id);
    return confirmed(result,snapshot.accountId);
  }catch(error){error.providerOutcomeUncertain=true;throw error;}
}

async function retrieve(ctx,accountId,freightId,request=shipengine.call){
  scoped(ctx);
  if(!identifier.test(accountId)||!identifier.test(freightId))throw new ValidationError('No exact freight booking reference is available for checking.');
  const result=await request(ctx,'/freight/shipments/'+freightId);
  if(result?.status==='cancelled'&&result.freight_shipment_id===freightId&&result.freight_provider_account_id===accountId)
    return {id:freightId,status:'cancelled'};
  return confirmed(result,accountId,freightId);
}

module.exports={build,accounts,quotes,book,retrieve,accessorials,locations,freightClasses,limits};
