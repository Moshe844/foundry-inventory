'use strict';const money=require('../domain/currency'),permissions=require('../actions/permissions'),{newId,nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors');
async function get(database,workspaceId){return (await database.query('SELECT * FROM shipping_purchase_limits WHERE workspace_id=$1',[workspaceId])).rows[0]||null;}
async function save(database,ctx,input){const value={currency:money.code(input.currency),perLabelMinor:input.perLabelMinor==null?null:money.integer(input.perLabelMinor),rollingDayMinor:input.rollingDayMinor==null?null:money.integer(input.rollingDayMinor)};
 return database.transaction(async client=>{await require('./postgres-parcel-options').actor(client,ctx,permissions.ADMIN);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['postage-budget:'+ctx.workspaceId]);const before=await get(client,ctx.workspaceId),at=nowIso();
 await client.query(`INSERT INTO shipping_purchase_limits(workspace_id,currency,per_label_minor,rolling_day_minor,updated_by_user_id,updated_at) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(workspace_id) DO UPDATE SET currency=EXCLUDED.currency,per_label_minor=EXCLUDED.per_label_minor,rolling_day_minor=EXCLUDED.rolling_day_minor,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=EXCLUDED.updated_at`,[ctx.workspaceId,value.currency,value.perLabelMinor,value.rollingDayMinor,ctx.actorId,at]);
 await client.query('INSERT INTO shipping_purchase_limit_changes(id,workspace_id,actor_user_id,before_value,after_value,created_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)',[newId('postagelimit'),ctx.workspaceId,ctx.actorId,JSON.stringify(before),JSON.stringify(value),at]);return value;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function assertWithin(client,ctx,rate){
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['postage-budget:'+ctx.workspaceId]);const policy=await get(client,ctx.workspaceId);if(!policy)return;
 const amount=money.integer(rate.amount_minor);if(policy.currency!==rate.currency)throw new ValidationError('This quote uses a different currency from the postage limits. The owner must review that currency before buying.');
 if(policy.per_label_minor!=null&&amount>Number(policy.per_label_minor))throw new ValidationError('This parcel exceeds the business’s per-parcel postage limit. Choose another service or ask the owner to review the limit.');
 if(policy.rolling_day_minor!=null){
  const rows=(await client.query(`SELECT transaction.status,transaction.currency,coalesce(transaction.amount_minor,transaction.approved_amount_minor,rate.amount_minor) AS reserved
   FROM shipping_label_transactions transaction LEFT JOIN stockchief_runtime.provider_effects effect ON effect.workspace_id=transaction.workspace_id AND effect.payload->>'transactionId'=transaction.id AND effect.kind='shipping.label.purchase'
   LEFT JOIN shipment_rates rate ON rate.workspace_id=transaction.workspace_id AND rate.id=effect.payload->>'rateId'
   WHERE transaction.workspace_id=$1 AND transaction.operation='PURCHASE' AND transaction.status IN ('PENDING','REVIEW','SUCCEEDED') AND transaction.requested_at>=$2`,[ctx.workspaceId,new Date(Date.now()-24*60*60_000).toISOString()])).rows;
  if(rows.some(row=>row.currency!==policy.currency||row.reserved==null))throw new ValidationError('Existing postage charges need review before the 24-hour spending limit can be verified. No additional label was queued.');
  const committed=money.sum(rows.map(row=>money.integer(row.reserved)));if(money.sum([committed,amount])>Number(policy.rolling_day_minor))throw new ValidationError('This purchase exceeds the business’s rolling 24-hour postage limit. Pending and uncertain purchases remain reserved until verified.');
 }
}
module.exports={get,save,assertWithin};
