'use strict';
const entitlements=require('../../commercial/entitlements');
const keys=['api.public','inventory.transfers','automation.transfers','automation.purchasing','warehouse.advanced','authority.advanced','communications.ai_drafts','payments.customer'];
async function read(database,scope){const [states,plans]=await Promise.all([entitlements.capabilityStates(database,scope,keys),database.query(`SELECT DISTINCT ON(e.capability) e.capability,p.id,p.public_name FROM commercial_plan_entitlements e JOIN commercial_plans p ON p.id=e.plan_id WHERE e.capability=ANY($1::text[]) AND e.enabled=1 AND p.status='ACTIVE' AND p.is_public=1 ORDER BY e.capability,p.display_order`,[keys])]);const tiers=new Map(plans.rows.map(p=>[p.capability,p.id==='enterprise'?'Custom':p.public_name]));return Object.fromEntries(keys.map(key=>[key,{enabled:states.get(key)?.enabled===true,tier:tiers.get(key)||'Custom'}]));}
module.exports={read,keys};
