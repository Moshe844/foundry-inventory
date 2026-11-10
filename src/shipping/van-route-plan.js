'use strict';

const {ValidationError}=require('../domain/errors');

const maximumStops=40;
const maximumVans=12;

function minute(value,label){
  const match=/^(\d{2}):(\d{2})$/.exec(String(value||''));
  if(!match||Number(match[1])>23||Number(match[2])>59)throw new ValidationError('Enter the exact local time for '+label+'.');
  return Number(match[1])*60+Number(match[2]);
}

function clock(value){
  return String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');
}

function minutes(values,count){
  if(!Array.isArray(values)||values.length!==count||values.some(row=>!Array.isArray(row)||row.length!==count))
    throw new ValidationError('Road times must include the depot and every selected stop in both directions.');
  return values.map((row,from)=>row.map((value,to)=>{
    if(value===null&&from!==to)return null;
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||from===to&&value!==0||value>86400)
      throw new ValidationError('Road times must be measured travel seconds or an explicitly unavailable leg.');
    return Math.ceil(value/60);
  }));
}

function schedule(van,sequence,matrix){
  let time=van.start,previous=0,roadMinutes=0,loadGrams=0;
  const stops=[];
  for(const stop of sequence){
    const travel=matrix[previous][stop.point];
    if(travel===null)return null;
    loadGrams+=stop.weightGrams;
    if(loadGrams>van.capacityGrams)return null;
    const arrival=Math.max(time+travel,stop.opens),leave=arrival+stop.serviceMinutes;
    if(leave>stop.closes||leave>van.end)return null;
    stops.push({id:stop.id,arrival,leave});
    time=leave;
    roadMinutes+=travel;
    previous=stop.point;
  }
  const back=matrix[previous][0];
  if(back===null||time+back>van.end)return null;
  return {stops,loadGrams,roadMinutes:roadMinutes+back,returnAt:time+back};
}

function choose(vans,stop,matrix){
  let best=null;
  for(const van of vans){
    for(let index=0;index<=van.sequence.length;index++){
      const sequence=[...van.sequence];
      sequence.splice(index,0,stop);
      const next=schedule(van,sequence,matrix);
      if(!next)continue;
      const extra=next.roadMinutes-van.route.roadMinutes;
      if(!best||extra<best.extra||extra===best.extra&&next.returnAt<best.route.returnAt){
        best={van,sequence,route:next,extra};
      }
    }
  }
  return best;
}

function plan(stops,vehicles,roadSeconds){
  if(!Array.isArray(stops)||!stops.length||stops.length>maximumStops||!Array.isArray(vehicles)||!vehicles.length||vehicles.length>maximumVans)
    throw new ValidationError('Choose one to '+maximumStops+' delivery stops and one to '+maximumVans+' vans.');
  if(new Set(stops.map(stop=>stop.id)).size!==stops.length||new Set(vehicles.map(van=>van.id)).size!==vehicles.length)
    throw new ValidationError('Each stop and van must appear once in this run.');
  const matrix=minutes(roadSeconds,stops.length+1);
  const validTime=value=>Number.isSafeInteger(value)&&value>=0&&value<1440;
  const positive=value=>Number.isSafeInteger(value)&&value>0;
  if(stops.some(stop=>!stop.id||!validTime(stop.opens)||!validTime(stop.closes)||!positive(stop.serviceMinutes)||
      stop.opens+stop.serviceMinutes>stop.closes||!positive(stop.weightGrams))||
    vehicles.some(van=>!van.id||!validTime(van.start)||!validTime(van.end)||van.start>=van.end||!positive(van.capacityGrams)))
    throw new ValidationError('Confirm the measured loads, van capacities, shift hours and stop time windows.');
  const fleet=vehicles.map(van=>({...van,sequence:[],route:schedule(van,[],matrix)}));
  const waiting=stops.map((stop,index)=>({...stop,point:index+1}))
    .sort((a,b)=>a.closes-b.closes||a.opens-b.opens||b.weightGrams-a.weightGrams||a.id.localeCompare(b.id));
  const unassigned=[];
  for(const stop of waiting){
    const placement=choose(fleet,stop,matrix);
    if(placement){
      placement.van.sequence=placement.sequence;
      placement.van.route=placement.route;
    }else{
      const reason=fleet.every(van=>van.capacityGrams<stop.weightGrams)?'The stop load exceeds every van’s capacity.':
        matrix[0][stop.point]===null||matrix[stop.point][0]===null?'Road times do not include a usable trip to and from the depot.':
        'The stop does not fit the available routes, time windows and remaining loads.';
      unassigned.push({id:stop.id,reason});
    }
  }
  return {routes:fleet.filter(van=>van.route.stops.length).map(van=>({vehicleId:van.id,start:van.start,...van.route})),unassigned};
}

module.exports={clock,minute,plan,minutes,maximumStops,maximumVans};
