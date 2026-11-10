'use strict';

const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const {providerFetch}=require('../lib/provider-http');
const {readResponseText}=require('../connections/providers/common');
const solver=require('./van-route-plan');

const provider='StockChief Road Routing';
const operation='van_route_road_times';

function endpoint(){
  let url;
  try{url=new URL(process.env.STOCKCHIEF_OSRM_URL||'');}catch{return null;}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)return null;
  return url;
}

function point(raw,label){
  const parts=String(raw||'').split(',').map(value=>value.trim());
  const format=/^-?\d{1,3}(?:\.\d{1,7})?$/;
  if(parts.length!==2||parts.some(value=>!format.test(value)))
    throw new ValidationError('Enter a latitude and longitude for '+label+'.');
  const [latitude,longitude]=parts.map(Number);
  if(Math.abs(latitude)>90||Math.abs(longitude)>180)
    throw new ValidationError('Check the latitude and longitude for '+label+'.');
  return [longitude,latitude];
}

async function lookup(db,ctx,points){
  const url=endpoint();
  if(!url)throw new ValidationError('The road-routing service is unavailable. Use a road-time export for this run.');
  url.pathname=url.pathname.replace(/\/$/,'')+'/table/v1/driving/'+points.map(position=>position.join(',')).join(';');
  url.searchParams.set('annotations','duration');
  return require('../commercial/operations').run(db,ctx.workspaceId,{operation,provider:'stockchief_osrm',
    key:newId('vanroads'),capability:'shipping.workflow',providerVersion:'table-v1'},async()=>{
    const response=await providerFetch(url.href,{redirect:'error'},{provider,timeoutMs:12000,retries:1});
    if(!response.ok)throw new ValidationError('The road-routing service could not calculate these travel times. Check the pins or use a road-time export.');
    let data;
    try{data=JSON.parse(await readResponseText(response,256*1024));}
    catch{throw new ValidationError('The road-routing service returned an unreadable road-time table.');}
    if(data?.code!=='Ok')throw new ValidationError('Some pins could not be placed on roads. Check the depot and stop pins.');
    solver.minutes(data.durations,points.length);
    return data.durations;
  });
}

module.exports={endpoint,point,lookup,provider};
