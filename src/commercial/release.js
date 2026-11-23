'use strict';
const config=require('../config');
const {ValidationError,DomainError}=require('../domain/errors');
const stripeFeeEvidence=require('./stripe-live-fee-evidence');
const LAUNCH_BLOCKERS=Object.freeze(['UNVERIFIED_STRIPE_BILLING_VOLUME_COST',
  'UNVERIFIED_INTUIT_PLATFORM_FEES','UNVERIFIED_XERO_PLATFORM_FEES',
  'UNVERIFIED_OTHER_LAUNCH_PROVIDER_FEES','UNVERIFIED_MIXED_WORKLOAD_CAPACITY',
  'MISSING_COST_RATE','MISSING_HISTORICAL_COST_RATE','AMBIGUOUS_PROVIDER_USAGE']);
async function state(database){return (await database.query('SELECT * FROM commercial_release_control WHERE singleton=true')).rows[0];}
function stagingTestCheckout(){return process.env.STOCKCHIEF_RUNTIME_ENV==='staging'&&process.env.STOCKCHIEF_STAGING_SUBSCRIPTION_CHECKOUT==='1'&&/^sk_test_/.test(config.commercial.stripeSecretKey||'');}
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
 // Approved private pilots do not grant provider access to public signups.
 // Shopify additionally binds the exception to its exact authorized store.
 const launchPolicy=require('../connections/launch-policy');
 const publicApp=String(process.env.SHOPIFY_PUBLIC_APP_ID||'').replace(/^gid:\/\/shopify\/App\//,'');
 const publicAppId=/^\d{1,30}$/.test(publicApp)?'gid://shopify/App/'+publicApp:null;
 // This is provider-derived evidence of the merchant's fee arrangement, not
 // permission to activate a new connection. Pausing new Connect sign-ins must
 // not shut subscription checkout for already qualified merchant contracts.
 const certifiedStripe=`p.provider='stripe' AND p.livemode=1 AND c.provider_type='stripe'
   AND c.provider_account_id=p.provider_account_id AND c.workspace_id=p.workspace_id
   AND c.config::jsonb#>>'{stripeConnectEvidence,source}'=$5
   AND c.config::jsonb#>>'{stripeConnectEvidence,platformAccountId}'=$4
   AND c.config::jsonb#>>'{stripeConnectEvidence,merchantAccountId}'=p.provider_account_id
   AND c.config::jsonb#>>'{stripeConnectEvidence,live}'='true'
   AND c.config::jsonb#>>'{stripeConnectEvidence,feesPayer}'='account'
   AND c.config::jsonb#>>'{stripeConnectEvidence,lossesPayer}'='stripe'
   AND c.config::jsonb#>>'{stripeConnectEvidence,dashboard}'='full'`;
 const unqualified=(await database.query(`SELECT 1 FROM workspace_connectors c
   WHERE c.status='connected' AND c.paused_at IS NULL
   AND c.provider_type=ANY($1::text[])
   AND NOT ((c.provider_type='microsoft365' AND COALESCE(c.workspace_id=ANY($2::text[]),false))
    OR (c.provider_type='shopify' AND (COALESCE(($3::jsonb->c.workspace_id) ? c.provider_account_id,false)
      OR COALESCE((c.config::jsonb->>'shopifyProfile'='public' AND $6::text<>'' AND c.config::jsonb->>'shopifyClientId'=$6
       AND ($8::boolean OR EXISTS(SELECT 1 FROM workspaces w JOIN commercial_shopify_subscriptions b ON b.account_id=w.owner_account_id
        WHERE w.id=c.workspace_id AND b.app_id=$7 AND b.shop=c.provider_account_id AND b.development_store=true))),false)))
    OR (c.provider_type='stripe' AND EXISTS(SELECT 1 FROM payment_connect_accounts p WHERE p.connector_id=c.id AND ${certifiedStripe}))
    OR COALESCE((c.provider_type='clover' AND COALESCE(($9::jsonb->c.workspace_id) ? c.provider_account_id,false)
     AND c.config::jsonb#>>'{cloverTestEvidence,merchantId}'=c.provider_account_id
     AND c.config::jsonb#>>'{cloverTestEvidence,appId}'=$10
     AND ((c.config::jsonb#>>'{cloverTestEvidence,source}'='CLOVER_NONBILLABLE_TEST_MERCHANT_V1'
       AND c.config::jsonb#>>'{cloverTestEvidence,isBillable}'='false')
      OR (c.config::jsonb#>>'{cloverTestEvidence,source}'='CLOVER_OWNER_APPROVED_TEST_MERCHANT_V1'
       AND c.config::jsonb#>>'{cloverTestEvidence,workspaceId}'=c.workspace_id
       AND c.config::jsonb#>>'{cloverTestEvidence,approvedByUserId}'=c.authorized_by_user_id
       AND c.config::jsonb#>>'{cloverTestEvidence,ownerApprovedTestMerchant}'='true'
       AND c.config::jsonb#>>'{cloverTestEvidence,providerBillingFlagsMissing}'='true'))),false)
    OR COALESCE((c.provider_type IN('xero','quickbooks') AND ($11::jsonb->c.provider_type) ? c.workspace_id
     AND c.config::jsonb#>>'{accountingPilotEvidence,source}'=$12
     AND c.config::jsonb#>>'{accountingPilotEvidence,provider}'=c.provider_type
     AND c.config::jsonb#>>'{accountingPilotEvidence,workspaceId}'=c.workspace_id
     AND c.config::jsonb#>>'{accountingPilotEvidence,providerAccountId}'=c.provider_account_id
     AND c.config::jsonb#>>'{accountingPilotEvidence,approvedByUserId}'=c.authorized_by_user_id
     AND c.config::jsonb#>>'{accountingPilotEvidence,qualificationOnly}'='true'
     AND c.config::jsonb#>>'{accountingPilotEvidence,clientId}'=$13::jsonb->>c.provider_type
     AND $13::jsonb->>c.provider_type<>''),false)
    OR COALESCE((c.provider_type='xero' AND $14::text<>''
     AND c.config::jsonb#>>'{xeroCustomerEvidence,source}'=$15
     AND c.config::jsonb#>>'{xeroCustomerEvidence,clientId}'=$14
     AND c.config::jsonb#>>'{xeroCustomerEvidence,workspaceId}'=c.workspace_id
     AND c.config::jsonb#>>'{xeroCustomerEvidence,providerAccountId}'=c.provider_account_id
     AND c.config::jsonb#>>'{xeroCustomerEvidence,approvedByUserId}'=c.authorized_by_user_id
     AND c.config::jsonb#>>'{xeroCustomerEvidence,readOnly}'='true'
     AND c.config::jsonb#>>'{xeroCustomerEvidence,providerPlan}'='starter'
     AND c.config::jsonb#>>'{xeroCustomerEvidence,maxOrganizations}'='5'),false))
   UNION ALL SELECT 1 FROM payment_connect_accounts p LEFT JOIN workspace_connectors c ON c.id=p.connector_id
     WHERE p.charges_enabled=1 AND NOT COALESCE((${certifiedStripe}),false)
   LIMIT 1`,
  [[...Object.keys(launchPolicy.EXCLUDED),'stripe','supplier_email'],launchPolicy.productionOutlookWorkspaces(),JSON.stringify(launchPolicy.productionShopifyPilots()),config.commercial.stripeAccountId,require('../payments/stripe-live-qualification').SOURCE,process.env.SHOPIFY_PUBLIC_CLIENT_ID||'',publicAppId,launchPolicy.publicShopifyEnabled(),JSON.stringify(require('../connections/clover-review-pilot').pilots()),process.env.CLOVER_CLIENT_ID||'',JSON.stringify(require('../connections/accounting-review-pilot').pilots()),require('../connections/accounting-review-pilot').SOURCE,JSON.stringify(require('../connections/accounting-review-pilot').clientIds()),require('../connections/xero-customer-rollout').approvedClientId(),require('../connections/xero-customer-rollout').SOURCE])).rows.length;
 return unqualified===0;}
async function assertCheckoutOpen(database,options={}){
  // Only isolated tests may exercise provider contracts while the live release is closed.
  if(options.testMode===true&&process.env.NODE_ENV==='test')return;
  if(!await isOpen(database))
    throw new ValidationError('Checkout is closed pending approval of the Commercial Readiness Report and final usage pricing.');
}
async function isSubscriptionCheckoutOpen(database){return stagingTestCheckout()||await isOpen(database);}
async function assertSubscriptionCheckoutOpen(database,options={}){
 if(stagingTestCheckout())return;
 try{return await assertCheckoutOpen(database,options);}catch(error){
  if(error instanceof ValidationError)throw new DomainError('Plan changes are paused right now. Please contact support.',{code:'checkout_paused',status:409});
  throw error;
 }
}
module.exports={stagingTestCheckout,isSubscriptionCheckoutOpen,assertSubscriptionCheckoutOpen,state,isOpen,assertCheckoutOpen,LAUNCH_BLOCKERS};
