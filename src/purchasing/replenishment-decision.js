'use strict';

// One explicit measurement contract for planning, explanations and execution.
// These are defaults for missing settings, never substitute source facts.
const WINDOW_DAYS=90,DEFAULT_LEAD_DAYS=14,SAFETY_DAYS=7,COVER_DAYS=30,MIN_ISSUE_EVENTS=2;
const optional=value=>value===null||value===undefined?null:Number(value);
// A saved demand forecast (job 144 or 146) replaces the flat 90-day rate when
// the plan lets it drive planning. Its daily values already carry this
// location's share of sales, so lead, cover and safety demand follow the
// forecast's seasons day by day.
function forecastUnits(forecast,days){
 const daily=forecast.daily;let total=0;
 for(let i=0;i<days&&i<daily.length;i++)total+=daily[i];
 if(days>daily.length&&daily.length){const tail=daily.slice(-28);total+=(days-daily.length)*tail.reduce((a,b)=>a+b,0)/tail.length;}
 return Math.round(total*1e6)/1e6;
}
function derive(row){
 const onHand=Number(row.on_hand||0),committed=Number(row.committed||0),incoming=Number(row.incoming||0),issued=Number(row.issued??row.sold_90??0),issueEvents=Number(row.issue_events||0),lead=optional(row.lead_time_days)??DEFAULT_LEAD_DAYS,coverDays=optional(row.cover_days)??COVER_DAYS;
 // Job 132: a discontinued product gets no reorder point, target or safety stock.
 const suppressed=row.planning_suppressed||row.discontinued;
 const forecast=!suppressed&&Array.isArray(row.forecast?.daily)?row.forecast:null,rate=forecast?forecastUnits(forecast,coverDays)/coverDays:issued/WINDOW_DAYS,demand=days=>forecast?forecastUnits(forecast,days):rate*days;
 const safety=suppressed?0:optional(row.safety_stock)??Math.ceil(demand(SAFETY_DAYS)),inferredReorder=suppressed?null:forecast||issueEvents>=MIN_ISSUE_EVENTS?Math.ceil(demand(lead))+safety:null,reorder=suppressed?null:optional(row.reorder_point)??inferredReorder,target=suppressed?null:optional(row.target_stock)??(reorder===null?null:Math.max(reorder+safety,Math.ceil(demand(coverDays)))),available=onHand-committed,projected=available+incoming;
 return {onHand,committed,incoming,available,projected,issued,issueEvents,rate,lead,safety,reorder,target,inferredReorder,windowDays:WINDOW_DAYS,coverDays,shortage:reorder!==null&&projected<=reorder,daysOfSupply:rate>0?available/rate:null,
  ...(forecast?{forecast:{basis:forecast.basis,method:forecast.method,label:forecast.label}}:{})};
}
function requiredUnits(position){return Math.max(0,(position.target??position.reorder??0)-position.projected);}
function retainedUnits(position){return Math.max(position.safety,position.reorder??0);}
function transferPlan(rows){
 const bySku=new Map(),result=[];
 for(const row of rows){if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}
 for(const locations of bySku.values()){
  const spare=new Map(locations.map(row=>[row.location_id,row.location_id?Math.max(0,row.available-retainedUnits(row)):0]));
  const destinations=locations.filter(row=>row.location_id&&row.shortage&&row.tracking_mode==='quantity'&&requiredUnits(row)>0)
   .sort((a,b)=>(a.daysOfSupply??Number.MAX_SAFE_INTEGER)-(b.daysOfSupply??Number.MAX_SAFE_INTEGER)||a.location_id.localeCompare(b.location_id));
  for(const destination of destinations){
   const source=locations.filter(row=>row.location_id!==destination.location_id&&spare.get(row.location_id)>0)
    .sort((a,b)=>spare.get(b.location_id)-spare.get(a.location_id)||a.location_id.localeCompare(b.location_id))[0];
   if(!source)continue;
   const quantity=Math.min(requiredUnits(destination),spare.get(source.location_id));
   spare.set(source.location_id,spare.get(source.location_id)-quantity);
   result.push({skuId:destination.sku_id,source,destination,quantity,sourceSafety:retainedUnits(source)});
  }
 }
 return result;
}
module.exports={WINDOW_DAYS,DEFAULT_LEAD_DAYS,SAFETY_DAYS,COVER_DAYS,MIN_ISSUE_EVENTS,derive,forecastUnits,requiredUnits,retainedUnits,transferPlan};
