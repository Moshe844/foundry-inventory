'use strict';
const policy=require('../commercial/agent-plan'),money=require('../domain/currency');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const observed=`WITH observations AS (
 SELECT p.id,p.sku_id,s.item_id,s.code,c.display_name,c.id AS connector_id,p.last_verified_at,
  CASE WHEN p.baseline_provider->>'amount' ~ '^[0-9]{1,15}$' THEN (p.baseline_provider->>'amount')::bigint END AS amount,
  CASE WHEN p.baseline_provider->>'currency' ~ '^[A-Z]{3}$' THEN p.baseline_provider->>'currency' END AS currency,current_prices.amount_minor AS local_amount,current_prices.currency AS local_currency,
  r.minimum_minor,r.currency AS map_currency
 FROM connection_commerce_positions p JOIN workspace_connectors c ON c.workspace_id=p.workspace_id AND c.id=p.connector_id
 JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 LEFT JOIN LATERAL (SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=p.workspace_id AND sku_id=p.sku_id ORDER BY created_at DESC,id DESC LIMIT 1) current_prices ON true
 LEFT JOIN stockchief_runtime.channel_map_rules r ON r.workspace_id=p.workspace_id AND r.sku_id=p.sku_id
 WHERE p.workspace_id=$1 AND p.field='price' AND p.mode<>'off' AND c.status='connected' AND c.paused_at IS NULL
  AND p.provider_account_id=c.provider_account_id AND p.provider_type=c.provider_type AND coalesce(c.config::jsonb->>'syncDisabled','false')<>'true'
  AND s.is_active=1 AND i.is_active=1 AND ($2='' OR lower(s.code)=lower($2) OR lower(c.display_name)=lower($2))
), reviewed AS (
 SELECT *,CASE WHEN last_verified_at IS NULL OR last_verified_at<now()-interval '24 hours' THEN 'Refresh provider check'
  WHEN amount IS NULL OR currency IS NULL THEN 'Provider price unavailable'
  WHEN minimum_minor IS NOT NULL AND currency<>map_currency THEN 'MAP currency needs review'
  WHEN minimum_minor IS NOT NULL AND amount<minimum_minor THEN 'Recorded price below MAP'
  WHEN local_amount IS NOT NULL AND currency<>local_currency THEN 'Catalogue currency differs'
  WHEN local_amount IS NOT NULL AND amount<>local_amount THEN 'Recorded price differs from catalogue'
  ELSE 'Matches recorded catalogue price' END AS finding FROM observations
) SELECT code AS "SKU",display_name AS "Channel",amount AS price_minor,currency AS "Currency",minimum_minor AS map_minor,map_currency,
 last_verified_at::text AS "Checked",finding AS "Finding",id AS reference,'/settings/connections/'||connector_id AS link
 FROM reviewed ORDER BY code,display_name,id`;
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
async function review(db,ctx,{filter='',page=1}){
 const rows=(await db.query(observed+' LIMIT 101 OFFSET $3',[ctx.workspaceId,filter,(page-1)*100])).rows;
 const rules=(await db.query(`SELECT r.*,s.code FROM stockchief_runtime.channel_map_rules r JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id
  WHERE r.workspace_id=$1 ORDER BY s.code LIMIT 100`,[ctx.workspaceId])).rows;
 return {rows:rows.slice(0,100).map(({price_minor,map_minor,map_currency,reference,...r})=>({...r,
  'Recorded provider price':formatProvider(price_minor,r.Currency),
  'Minimum advertised price':map_minor==null?null:money.format(map_minor,map_currency)})),more:rows.length>100,
  mapForm:{rules:rules.map(r=>({...r,minimum:money.fromMinor(r.minimum_minor,r.currency)}))},
  summary:'Compares the last verified provider prices with the current catalogue and your recorded MAP terms. Checks older than 24 hours need a fresh provider check. Review each difference before changing prices.'};
}
function formatProvider(amount,currency){
 if(amount==null||!currency)return 'Unavailable';
 try{return money.format(amount,currency);}catch(error){if(error.code!=='validation_error')throw error;return 'Provider currency needs review';}
}
module.exports={observed,save,definition:{id:87,key:'channel-prices',label:'Channel prices and advertised-price terms',filterLabel:'SKU or channel',readPage:review}};
