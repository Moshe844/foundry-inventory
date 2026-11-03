'use strict';
const catalog=require('./catalog');
async function active(database,planId){return (await database.query("SELECT * FROM commercial_plan_versions WHERE plan_id=$1 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1",[planId])).rows[0]||null;}
function present(plan,version){if(!version)return plan;return {...plan,active_plan_version_id:version.id,configuration:version.configuration||{},currency:version.currency,monthly_amount_minor:version.monthly_amount_minor,annual_amount_minor:version.annual_amount_minor,
 entitlements:version.entitlements,meters:version.meters.map(row=>{const definition=catalog.assertMeterKey(row.meter);return {...row,label:row.label||definition.label,kind:definition.kind,customer_visible:definition.customerVisible?1:0};})};}
module.exports={active,present};
