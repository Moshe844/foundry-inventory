'use strict';
// Job 208: helpers shared by the adapters that teach each trained job from a
// run of identical approvals. Everything here reads records; nothing writes.
const {hash}=require('../../pricing/postgres-promotions');
const money=require('../../domain/currency');

const T=name=>'stockchief_runtime.'+name;
const day=value=>new Date(value).toISOString().slice(0,10);
const num=value=>{if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;};
// The approval with the largest value, newest first on a tie.
function largest(rows,value){
  let best=null;
  for(const r of rows){const v=num(value(r));if(v===null)continue;if(!best||v>best.v)best={r,v};}
  return best?.r||null;
}
const maximum=(rows,value)=>rows.reduce((m,r)=>{const v=num(value(r));return v===null?m:m===null||v>m?v:m;},null);
const minimum=(rows,value)=>rows.reduce((m,r)=>{const v=num(value(r));return v===null?m:m===null||v<m?v:m;},null);
const whole=value=>Number.isSafeInteger(value)&&value>0;
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
const amount=(minor,currency)=>money.format(Number(minor),currency);
// The confirmation token: the exact teaching the owner saw. Anything that
// changes it means the offer changed and must be reviewed again.
const token=input=>hash(input).slice(0,24);
// A plain row for the run engine.
function row(id,scope,at,{declined=false,needsPerson=false,variant=null,label=null,value=null,data={}}={}){
  return {id:String(id),scope:String(scope),at:new Date(at),declined:Boolean(declined),needsPerson:Boolean(needsPerson),variant,label,value,data};
}
async function locationNames(db,workspaceId,ids){
  if(!ids?.length)return '';
  return (await db.query('SELECT string_agg(name,\', \' ORDER BY name) n FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[])',[workspaceId,ids])).rows[0]?.n||'';
}
async function bookCurrency(db,workspaceId){
  return (await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0]?.base_currency||null;
}

module.exports={T,day,num,largest,maximum,minimum,whole,plural,amount,token,row,hash,money,locationNames,bookCurrency};
