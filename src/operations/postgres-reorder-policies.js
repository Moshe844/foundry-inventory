'use strict';
const {ValidationError}=require('../domain/errors'),permissions=require('../actions/permissions'),{newId,nowIso}=require('../lib/util');
async function setManyInTransaction(client,ctx,inputs){
 if(!inputs.length)return [];
 const unique=new Map();for(const input of inputs){const key=JSON.stringify([input.skuId,input.locationId||null]);const prior=unique.get(key);if(prior){for(const field of ['reorderPoint','targetStock','safetyStock','leadTimeDays'])if(input[field]!==undefined&&prior[field]!==undefined&&input[field]!==prior[field])throw new ValidationError('Conflicting reorder settings need review.');unique.set(key,{...prior,...Object.fromEntries(Object.entries(input).filter(([,v])=>v!==undefined))});}else unique.set(key,input);}inputs=[...unique.values()];
 const actor=(await client.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];permissions.assertCan(actor,permissions.MANAGE_REPLENISHMENT,'set reorder policies');
 const normalized=inputs.map(input=>{const row={id:newId('rpol'),sku_id:input.skuId,location_id:input.locationId||null,source:input.source==='foundry'?'foundry':'manual',notes:input.notes||null};
  for(const [key,column,max]of [['reorderPoint','reorder_point',1000000000],['targetStock','target_stock',1000000000],['safetyStock','safety_stock',1000000000],['leadTimeDays','lead_time_days',365]]){
    if(input[key]===undefined||input[key]===null){row[column]=null;continue;}
    const n=Number(input[key]);if(!Number.isSafeInteger(n)||n<0||n>max)throw new ValidationError('Reorder settings must use nonnegative whole quantities and lead times within the supported range.');row[column]=n;
  }return row;});
 const current=(await client.query(`SELECT p.* FROM reorder_policies p JOIN jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text) ON x.sku_id=p.sku_id AND x.location_id IS NOT DISTINCT FROM p.location_id WHERE p.workspace_id=$1 FOR UPDATE OF p`,[ctx.workspaceId,JSON.stringify(normalized)])).rows;
 for(const row of normalized){const prior=current.find(p=>p.sku_id===row.sku_id&&p.location_id===row.location_id);for(const k of ['reorder_point','target_stock','safety_stock','lead_time_days'])if(row[k]===null&&prior)row[k]=prior[k];if(row.reorder_point!==null&&row.target_stock!==null&&Number(row.target_stock)<Number(row.reorder_point))throw new ValidationError('Target stock must be at least the reorder point.');}
 const found=(await client.query(`SELECT x.sku_id FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text)
   JOIN skus s ON s.workspace_id=$1 AND s.id=x.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
   WHERE s.is_active=1 AND i.is_active=1 AND (x.location_id IS NULL OR EXISTS(SELECT 1 FROM locations l WHERE l.workspace_id=$1 AND l.id=x.location_id AND l.is_active=1))`,[ctx.workspaceId,JSON.stringify(normalized)])).rows;
 if(found.length!==normalized.length)throw new ValidationError('Every reorder product and location must belong to this inventory.');
 const saved=await client.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,lead_time_days,source,notes,created_at,updated_at)
   SELECT x.id,$1,x.sku_id,x.location_id,x.reorder_point,x.target_stock,x.safety_stock,x.lead_time_days,x.source,x.notes,$3,$3
   FROM jsonb_to_recordset($2::jsonb) AS x(id text,sku_id text,location_id text,reorder_point bigint,target_stock bigint,safety_stock bigint,lead_time_days bigint,source text,notes text)
   ON CONFLICT(workspace_id,sku_id,(COALESCE(location_id,''))) DO UPDATE SET reorder_point=EXCLUDED.reorder_point,target_stock=EXCLUDED.target_stock,safety_stock=EXCLUDED.safety_stock,lead_time_days=EXCLUDED.lead_time_days,source=EXCLUDED.source,notes=EXCLUDED.notes,updated_at=EXCLUDED.updated_at RETURNING id,sku_id,location_id`,[ctx.workspaceId,JSON.stringify(normalized),nowIso()]);return saved.rows;
}
module.exports={setManyInTransaction};
