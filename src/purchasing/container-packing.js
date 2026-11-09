'use strict';
const {ValidationError}=require('../domain/errors');
function whole(value,label,{min=1,max=1000000000}={}){
 const text=String(value??'');if(!/^(?:0|[1-9]\d*)$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)<min||Number(text)>max)throw new ValidationError(label+' must be a whole number from '+min+' to '+max+'.');return Number(text);
}
function container(input){
 if(!['20','40'].includes(String(input.feet)))throw new ValidationError('Choose a 20 ft or 40 ft container.');
 return {feet:String(input.feet),length:whole(input.lengthMm,'Usable inside length',{max:String(input.feet)==='20'?6096:12192}),width:whole(input.widthMm,'Usable inside width',{max:3000}),height:whole(input.heightMm,'Usable inside height',{max:4000}),payload:whole(input.payloadGrams,'Confirmed cargo payload in grams'),count:whole(input.containerCount,'Number of containers',{max:20})};
}
function pack(input){
 if(!['yes','no'].includes(input.rotate))throw new ValidationError('Confirm whether the carton may be turned horizontally.');
 return {length:whole(input.lengthMm,'Carton outer length',{max:100000}),width:whole(input.widthMm,'Carton outer width',{max:100000}),height:whole(input.heightMm,'Carton outer height',{max:100000}),weight:whole(input.weightGrams,'Carton gross weight in grams'),maximumAbove:whole(input.maximumAboveGrams,'Maximum supported weight above a carton',{min:0}),rotate:input.rotate==='yes'};
}
const volume=p=>BigInt(p.length)*BigInt(p.width)*BigInt(p.height);
function calculate(spec,lines){
 const count=lines.reduce((n,l)=>n+whole(l.cartons,'Carton count',{max:2000}),0);if(count>2000)throw new ValidationError('Plan up to 2,000 whole cartons at a time. Split larger loads into separate projects.');
 const pending=lines.map((l,i)=>({...l,sourceIndex:i,remaining:l.cartons})).sort((a,b)=>{const av=volume(a.pack),bv=volume(b.pack);return av===bv?b.pack.weight-a.pack.weight||a.sourceIndex-b.sourceIndex:av>bv?-1:1;}),placed=[],loads=[];
 let attempts=0;
 for(let bin=0;bin<spec.count;bin++){
  const spaces=[{x:0,y:0,z:0,length:spec.length,width:spec.width,height:spec.height,supports:[]}],load={container:bin+1,weightGrams:0,volumeMm3:0n,cartons:0};loads.push(load);
  for(const line of pending){
   while(line.remaining){
    if(load.weightGrams+line.pack.weight>spec.payload)break;
    let chosen=null;
    const orientations=[{length:line.pack.length,width:line.pack.width,height:line.pack.height},...(line.pack.rotate&&line.pack.length!==line.pack.width?[{length:line.pack.width,width:line.pack.length,height:line.pack.height}]:[])];
    for(let s=0;s<spaces.length&&!chosen;s++){
     const space=spaces[s];if(++attempts>5000000)throw new ValidationError('This layout needs a smaller planning group. Split the orders into separate projects.');
     if(space.supports.some(id=>placed[id].aboveGrams+line.pack.weight>placed[id].maximumAboveGrams))continue;
     for(const orientation of orientations)if(orientation.length<=space.length&&orientation.width<=space.width&&orientation.height<=space.height){chosen={s,space,orientation};break;}
    }
    if(!chosen)break;
    const {s,space,orientation:o}=chosen,id=placed.length;spaces.splice(s,1);
    const position={container:bin+1,lineId:line.lineId,skuId:line.skuId,carton:line.cartons-line.remaining+1,x:space.x,y:space.y,z:space.z,...o,weightGrams:line.pack.weight,maximumAboveGrams:line.pack.maximumAbove,aboveGrams:0,supports:space.supports};
    for(const support of space.supports)placed[support].aboveGrams+=line.pack.weight;
    placed.push(position);load.weightGrams+=line.pack.weight;load.volumeMm3+=volume(o);load.cartons++;line.remaining--;
    // Disjoint guillotine spaces. Top spaces retain their complete supporting
    // footprint and every ancestor's load allowance; no floating cartons.
    if(space.length>o.length)spaces.push({...space,x:space.x+o.length,length:space.length-o.length});
    if(space.width>o.width)spaces.push({...space,y:space.y+o.width,length:o.length,width:space.width-o.width});
    if(space.height>o.height&&line.pack.maximumAbove>0)spaces.push({...space,z:space.z+o.height,length:o.length,width:o.width,height:space.height-o.height,supports:[...space.supports,id]});
    spaces.sort((a,b)=>a.z-b.z||a.x-b.x||a.y-b.y);
   }
  }
 }
 const rows=lines.map(line=>{const remaining=pending.find(p=>p.lineId===line.lineId).remaining;return {lineId:line.lineId,skuId:line.skuId,cartons:line.cartons,loaded:line.cartons-remaining,remaining};});
 return {algorithm:'supported-guillotine-v1',placed,rows,loads:loads.map(l=>({...l,volumeMm3:l.volumeMm3.toString(),capacityMm3:volume(spec).toString(),payloadGrams:spec.payload})),cartons:count,loaded:placed.length,remaining:count-placed.length};
}
module.exports={whole,container,pack,volume,calculate};
