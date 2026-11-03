'use strict';
// Immutable renderer and immutable offer data together define this migration.
// Never change the versioned offer after release; publish another version.
const offer=require('../../commercial/offers/approved-2026-11-02');
const q=v=>v===null?'NULL':"'"+String(v).replaceAll("'","''")+"'",json=v=>q(JSON.stringify(v))+'::jsonb';
function render(){let sql=`
ALTER TABLE commercial_plan_versions ADD COLUMN configuration jsonb NOT NULL DEFAULT '{}';
ALTER TABLE commercial_checkout_attempts ADD COLUMN plan_version_id text REFERENCES commercial_plan_versions(id);
ALTER TABLE commercial_subscription_changes ADD COLUMN target_plan_version_id text REFERENCES commercial_plan_versions(id);
ALTER TABLE commercial_capacity_products ADD COLUMN entitlements jsonb NOT NULL DEFAULT '{}';
ALTER TABLE commercial_capacity_products ADD COLUMN capacity_scope text NOT NULL DEFAULT 'ACCOUNT' CHECK(capacity_scope IN ('ACCOUNT','INVENTORY'));
ALTER TABLE commercial_capacity_orders ADD COLUMN workspace_id text REFERENCES workspaces(id);
ALTER TABLE commercial_capacity_orders ADD COLUMN entitlements jsonb NOT NULL DEFAULT '{}';
INSERT INTO commercial_capabilities(capability,label,category,readiness,variable_cost)
VALUES('reports.advanced','Advanced report comparisons','intelligence','SELLABLE',0),
 ('authority.autonomous','Policy-controlled autonomous work','automation','SELLABLE',1)
ON CONFLICT(capability) DO NOTHING;
-- Freeze legacy unversioned subscriptions before replacing the new-sale offer.
UPDATE commercial_checkout_attempts a SET plan_version_id=(SELECT id FROM commercial_plan_versions v WHERE v.plan_id=a.plan_id AND v.status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE plan_version_id IS NULL;
UPDATE commercial_subscription_changes c SET target_plan_version_id=(SELECT id FROM commercial_plan_versions v WHERE v.plan_id=c.to_plan_id AND v.status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE target_plan_version_id IS NULL;
UPDATE account_subscriptions s SET plan_version_id=NULL WHERE EXISTS(SELECT 1 FROM commercial_plan_versions v WHERE v.id=s.plan_version_id AND v.plan_id<>s.plan_id);
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'before-approved-2026-11-02:'||p.id,p.id,(SELECT coalesce(max(version_number),0)+1 FROM commercial_plan_versions WHERE plan_id=p.id),'RETIRED',p.currency,p.monthly_amount_minor,p.annual_amount_minor,
 coalesce((SELECT jsonb_agg(jsonb_build_object('capability',e.capability,'enabled',e.enabled,'configuration',e.configuration) ORDER BY e.capability) FROM commercial_plan_entitlements e WHERE e.plan_id=p.id),'[]'::jsonb),
 coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.meter) FROM commercial_plan_meters m WHERE m.plan_id=p.id),'[]'::jsonb)
FROM commercial_plans p WHERE EXISTS(SELECT 1 FROM account_subscriptions s WHERE s.plan_id=p.id AND s.plan_version_id IS NULL);
UPDATE account_subscriptions s SET plan_version_id='before-approved-2026-11-02:'||s.plan_id WHERE s.plan_version_id IS NULL;
`;
 for(const [meter,[label,kind]]of Object.entries(offer.definitions))sql+=`INSERT INTO commercial_meter_definitions(meter,label,kind,customer_visible,critical_access) VALUES(${q(meter)},${q(label)},${q(kind)},1,${kind==='STRUCTURAL'?1:0}) ON CONFLICT(meter) DO UPDATE SET label=excluded.label,kind=excluded.kind,customer_visible=1;\n`;
 sql+=`ALTER TABLE commercial_usage_packs DROP CONSTRAINT commercial_usage_packs_category_check;
ALTER TABLE commercial_usage_packs ADD CONSTRAINT commercial_usage_packs_category_check CHECK(category IN ('ai_work_credits','incoming_emails','emails_sent','connected_operations'));
ALTER TABLE commercial_operation_policies DROP CONSTRAINT commercial_operation_policies_category_check;
ALTER TABLE commercial_operation_policies ADD CONSTRAINT commercial_operation_policies_category_check CHECK(category IN ('ai_work_credits','incoming_emails','emails_sent','connected_operations'));
`;
 for(const [planId,p]of Object.entries(offer.plans)){
  const capabilities=p.capabilities.map(capability=>({capability,enabled:1,configuration:{offerId:offer.id}})),meters=offer.meters(planId);
  sql+=`UPDATE commercial_plans SET monthly_amount_minor=${p.monthlyMinor},annual_amount_minor=${p.annualMinor},packaging_status='APPROVED',packaging_approved_at=now(),updated_at=now() WHERE id=${q(planId)};
DELETE FROM commercial_plan_entitlements WHERE plan_id=${q(planId)};
DELETE FROM commercial_plan_meters WHERE plan_id=${q(planId)};
`;
  for(const e of capabilities)sql+=`INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled,configuration) VALUES(${q(planId)},${q(e.capability)},1,${json(e.configuration)});\n`;
  for(const m of meters)sql+=`INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_mode,rollover_months,credit_unit_scale,provider_budget_minor_per_credit) VALUES(${q(planId)},${q(m.meter)},${q(m.label)},${m.included_units},${m.hard_limit},${q(m.overage_mode)},${m.rollover_months},${m.credit_unit_scale},${m.provider_budget_minor_per_credit??'NULL'});\n`;
  sql+=`UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now() WHERE plan_id=${q(planId)} AND status='ACTIVE';
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters,configuration)
VALUES(${q(offer.id+':'+planId)},${q(planId)},(SELECT max(version_number)+1 FROM commercial_plan_versions WHERE plan_id=${q(planId)}),'ACTIVE','USD',${p.monthlyMinor},${p.annualMinor},${json(capabilities)},${json(meters)},${json(offer.configuration(planId))});
INSERT INTO commercial_change_audit(id,subject_type,subject_id,action,after_state,reason) VALUES(${q(offer.id+':'+planId)},'plan',${q(planId)},'approved_packaging',${json({offerId:offer.id,existingTermsPreserved:true,liveCheckoutEnabled:false})},'User approved exact Starter/Growth/Pro packaging for staging. Live checkout remains separately gated.');
`;
 }
 return sql;}
module.exports={render};
