'use strict';
const {ValidationError}=require('../domain/errors'),money=require('../domain/currency'),{newId,nowIso}=require('../lib/util');
async function build(database,workspaceId,input){
 const currency=(await database.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[workspaceId])).rows[0]?.base_currency||'USD';
 if(input.currency&&money.code(input.currency)!==currency)throw new ValidationError('Use the business’s accounting currency for this shipping rule.');
 const optional=(value,check)=>value==null||String(value).trim()===''?null:check(value),whole=(v,label,max)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1||n>max)throw new ValidationError(label+' must be a positive whole number up to '+max+'.');return n;};
 const maxCostMinor=optional(input.maxCost,v=>money.toMinor(v,currency)),maxDeliveryDays=optional(input.maxDeliveryDays,v=>whole(v,'Delivery days',30)),minWeightGrams=optional(input.minWeightGrams,v=>whole(v,'Minimum weight in grams',2147483647)),maxWeightGrams=optional(input.maxWeightGrams,v=>whole(v,'Maximum weight in grams',2147483647));
 if(minWeightGrams!=null&&maxWeightGrams!=null&&minWeightGrams>maxWeightGrams)throw new ValidationError('Maximum parcel weight must be at least the minimum.');
 const carrier=String(input.carrier||'').trim()||null,service=String(input.service||'').trim()||null;
 if(carrier?.length>160||service?.length>160)throw new ValidationError('Carrier and service names must be at most 160 characters.');
 const requireByPromised=input.requireByPromised===true||String(input.requireByPromised).toLowerCase()==='true';
 if(input.requireByPromised!=null&&!['true','false'].includes(String(input.requireByPromised).toLowerCase()))throw new ValidationError('Say whether delivery by the promised date is required.');
 if(!carrier&&!service&&maxCostMinor===null&&maxDeliveryDays===null&&minWeightGrams===null&&maxWeightGrams===null&&!requireByPromised)throw new ValidationError('Give at least one shipping condition.');
 const name=[carrier?carrier.toUpperCase():'Any carrier',service,maxCostMinor!=null?'up to '+money.format(maxCostMinor,currency):null,minWeightGrams!=null?'from '+minWeightGrams+' g':null,maxWeightGrams!=null?'up to '+maxWeightGrams+' g':null].filter(Boolean).join(' · ');
 return {ruleId:newId('shiprule'),name,carrier,service,maxCostMinor,maxDeliveryDays,minWeightGrams,maxWeightGrams,currency,requireByPromised,statedText:String(input.statedText||'').trim().slice(0,2000)||null};
}
async function insert(client,ctx,p){const at=nowIso();const row=(await client.query(`INSERT INTO shipping_rules(id,workspace_id,name,carrier,service,max_cost_minor,require_by_promised,max_delivery_days,is_active,stated_text,created_by_user_id,created_at,updated_at,min_weight_grams,max_weight_grams,currency)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$11,$12,$13,$14) RETURNING id`,[p.ruleId,ctx.workspaceId,p.name,p.carrier,p.service,p.maxCostMinor,p.requireByPromised?1:0,p.maxDeliveryDays,p.statedText,ctx.actorId,at,p.minWeightGrams??null,p.maxWeightGrams??null,p.currency||null])).rows[0];return row;}
async function save(database,ctx,input){return database.transaction(async client=>{await require('./postgres-parcel-options').actor(client,ctx);return insert(client,ctx,await build(client,ctx.workspaceId,input));},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={build,insert,save};
