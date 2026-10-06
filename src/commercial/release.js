'use strict';
const config=require('../config');
const {ValidationError}=require('../domain/errors');
const stripeFeeEvidence=require('./stripe-live-fee-evidence');
const LAUNCH_BLOCKERS=Object.freeze(['UNVERIFIED_STRIPE_BILLING_VOLUME_COST',
  'UNVERIFIED_INTUIT_PLATFORM_FEES','UNVERIFIED_XERO_PLATFORM_FEES',
  'UNVERIFIED_OTHER_LAUNCH_PROVIDER_FEES','UNVERIFIED_MIXED_WORKLOAD_CAPACITY',
  'MISSING_COST_RATE','MISSING_HISTORICAL_COST_RATE','AMBIGUOUS_PROVIDER_USAGE']);
async function state(database){return (await database.query('SELECT * FROM commercial_release_control WHERE singleton=true')).rows[0];}
async function isOpen(database){const release=await state(database);
 if(!(config.commercial.checkoutEnabled&&release?.checkout_enabled&&release.economics_approved_at&&release.readiness_approved_at))return false;
 // Stripe Tax is out of the initial technical launch scope. Turning it on
 // requires separately verified account pricing and tax-compliance approval.
 if(config.commercial.automaticTax)return false;
 // The observed fee schedule cannot authorize checkout under another account.
 if(config.commercial.stripeAccountId!==stripeFeeEvidence.accountId)return false;
 const unresolved=(await database.query(`SELECT 1 FROM commercial_critical_warnings WHERE status='OPEN'
   AND code=ANY($1::text[]) LIMIT 1`,[LAUNCH_BLOCKERS])).rows.length;
 if(unresolved)return false;
 // Historical connections are preserved. An excluded adapter already active
 // in this environment needs a qualified cost agreement before new checkout.
 const unqualified=(await database.query(`SELECT 1 FROM workspace_connectors
   WHERE status='connected' AND paused_at IS NULL
   AND provider_type=ANY($1::text[])
   UNION ALL SELECT 1 FROM payment_connect_accounts WHERE charges_enabled=1
   LIMIT 1`,
  [[...Object.keys(require('../connections/launch-policy').EXCLUDED),'stripe','supplier_email']])).rows.length;
 return unqualified===0;}
async function assertCheckoutOpen(database,options={}){
  // Only isolated tests may exercise provider contracts while the live release is closed.
  if(options.testMode===true&&process.env.NODE_ENV==='test')return;
  if(!await isOpen(database))
    throw new ValidationError('Checkout is closed pending approval of the Commercial Readiness Report and final usage pricing.');
}
module.exports={state,isOpen,assertCheckoutOpen,LAUNCH_BLOCKERS};
