'use strict';
const entitlements=require('../../commercial/entitlements');
const keys=['api.public','inventory.transfers','inventory.kits','automation.transfers','automation.purchasing','warehouse.advanced','authority.advanced','authority.autonomous','communications.ai_drafts','payments.customer'];
async function read(database,scope){const [states,plans]=await Promise.all([entitlements.capabilityStates(database,scope,keys),database.query(`SELECT DISTINCT ON(e->>'capability') e->>'capability' AS capability,p.id,p.public_name FROM commercial_plan_versions v JOIN commercial_plans p ON p.id=v.plan_id CROSS JOIN LATERAL jsonb_array_elements(v.entitlements) e WHERE v.status='ACTIVE' AND e->>'capability'=ANY($1::text[]) AND (e->>'enabled')::bigint=1 AND p.status='ACTIVE' AND p.is_public=1 ORDER BY e->>'capability',p.display_order`,[keys])]);
 const tiers=new Map(plans.rows.map(p=>[p.capability,p.id==='enterprise'?'Custom':p.public_name]));return Object.fromEntries(keys.map(key=>{const sub=states.get(key)?.subscription,legacy=key==='authority.autonomous'&&sub?.plan_version_id&&!sub.plan_configuration?.offerId;
  return [key,{enabled:(legacy?states.get('authority.advanced'):states.get(key))?.enabled===true,tier:tiers.get(key)||'Custom'}];}));}
module.exports={read,keys};
