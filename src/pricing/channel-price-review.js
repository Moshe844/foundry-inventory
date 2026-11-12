'use strict';
const policy=require('../commercial/agent-plan'),money=require('../domain/currency');
const {ValidationError,AuthorizationError}=require('../domain/errors');
// Job 87: the owner's minimum advertised price (MAP) terms. The checks
// themselves live in agent-channel-price-checks.js.
async function save(db,ctx,input){
 return db.transaction(async c=>{
  const actor=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  if(actor?.role!=='owner')throw new AuthorizationError('Only the inventory owner can record advertised-price terms.');
  if(input.remove!=='1')await policy.requireWorkspaceJob(c,ctx.workspaceId,87,'automatic');
  const sku=(await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND is_active=1 AND lower(code)=lower($2) LIMIT 2',[ctx.workspaceId,String(input.sku||'').trim()])).rows;
  if(sku.length!==1)throw new ValidationError('Choose one active SKU by its exact code.');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['map:'+ctx.workspaceId+':'+sku[0].id]);
  const prior=(await c.query('SELECT * FROM stockchief_runtime.channel_map_rules WHERE workspace_id=$1 AND sku_id=$2 FOR UPDATE',[ctx.workspaceId,sku[0].id])).rows[0];
  const revision=Number(input.revision);
  if(!Number.isSafeInteger(revision)||revision<0||(prior?.revision||0)!==revision)throw new ValidationError('The advertised-price terms changed. Reload before saving.');
  if(input.remove==='1'){
   await c.query('DELETE FROM stockchief_runtime.channel_map_rules WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku[0].id]);
  }else{
   const currency=require('./postgres-service').normaliseCurrency(input.currency),minimum=money.userToMinor(input.minimum,currency);
   if(minimum<=0)throw new ValidationError('Enter the positive minimum advertised price from your supplier terms.');
   if(!prior)await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
   await c.query(`INSERT INTO stockchief_runtime.channel_map_rules(workspace_id,sku_id,minimum_minor,currency,authorized_by)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,sku_id) DO UPDATE SET minimum_minor=excluded.minimum_minor,
    currency=excluded.currency,authorized_by=excluded.authorized_by,revision=channel_map_rules.revision+1`,[ctx.workspaceId,sku[0].id,minimum,currency,ctx.actorId]);
  }
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Minimum advertised price terms changed',reference:sku[0].id,before:prior||{},after:{remove:input.remove==='1',minimum:input.minimum,currency:input.currency}});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={save,definition:{id:87,key:'channel-prices',label:'Channel prices and advertised-price terms',filterLabel:'SKU or channel',readPage:(db,ctx,args)=>require('./agent-channel-price-checks').review(db,ctx,args)}};
