'use strict';
// Host-only deployment check. No inference, budget changes or price seeding.
async function verifyPricing(database,profile=null) {
 const wire=profile?require('../../scripts/environment-agent-demo/codex-wire').forProfile(profile.id):require('../../scripts/environment-agent-demo/codex-wire');
 const rows=(await database.query(`SELECT DISTINCT ON (operation) operation,cost_per_unit_minor,pricing_basis
  FROM commercial_cost_rates WHERE provider='openai' AND model=$1 AND provider_version=$2
  AND unit='token' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())
  ORDER BY operation,effective_from DESC`,[wire.MODEL,'responses-2026-10-11'])).rows;
 const prices=new Map(rows.map(row=>[row.operation,row]));
 for(const [operation,dollars]of Object.entries(wire.PROFILE.rates)){
  const rate=prices.get(operation);
  if(!rate||!['VERIFIED_PUBLIC','VERIFIED_CONTRACT'].includes(rate.pricing_basis)||
   Number(rate.cost_per_unit_minor)!==dollars/10000)
   throw Object.assign(Error('The Staging agent is unavailable because its approved model pricing is missing or inconsistent. No model call was made.'),{code:'STAGING_MODEL_PRICE_UNVERIFIED',operation});
 }
 return {model:wire.MODEL,reasoning:wire.EFFORT,pricingVerified:true};
}
module.exports={verifyPricing};
