'use strict';

// Scope is the initial PostgreSQL self-service launch, not every adapter kept
// for existing records or later contractual use. A provider is VERIFIED only
// for the exact operation/credential ownership described below.
const STATUS=Object.freeze({
  MERCHANT:'VERIFIED_MERCHANT_PAYS',
  STOCKCHIEF:'VERIFIED_STOCKCHIEF_PAYS_MODELED',
  NO_FEE:'VERIFIED_NO_INCREMENTAL_FEE',
  EXCLUDED:'DISABLED_NOT_MARKETED_AT_LAUNCH'
});
const rows=Object.freeze([
  {provider:'square',status:STATUS.MERCHANT,launch:true,
    scope:'Seller OAuth; standard Orders reads/search, webhooks and seller Checkout payment links only. Non-Square-payment Orders creation is not in launch scope.',
    evidence:['https://developer.squareup.com/us/en/online-payment-apis','https://developer.squareup.com/reference/square/orders-api']},
  {provider:'woocommerce',status:STATUS.MERCHANT,launch:true,
    scope:'Merchant-owned WooCommerce site and REST credentials; merchant pays hosting, plugins and payment processing.',
    evidence:['https://developer.woocommerce.com/docs/apis/rest-api/','https://developer.woocommerce.com/docs/apis/rest-api/authentication/']},
  {provider:'gmail',status:STATUS.NO_FEE,launch:true,
    scope:'Standard Gmail API below the project 80M quota-unit daily threshold; StockChief reserves at most 72M units/day before requests. Merchant pays mailbox license.',
    evidence:['https://developers.google.com/workspace/gmail/api/reference/quota']},
  {provider:'reference_webhook',status:STATUS.NO_FEE,launch:true,
    scope:'Merchant sends signed events to StockChief; shared Render compute is accounted separately.',
    evidence:['src/connections/postgres-service.js']},
  ...['shipengine','shipstation','easypost','shippo'].map(provider=>({provider,status:STATUS.MERCHANT,launch:true,
    scope:'Only a workspace-owned API key is permitted. Postage, labels, tracking and account/API charges accrue to that key owner; StockChief shared/partner credentials are excluded.',
    evidence:provider==='shipengine'?
      ['https://www.shipengine.com/docs/labels/create-a-label/','https://help.shipengine.com/hc/en-us/articles/19326502173851-Advanced-Plan-Overage-and-Add-On-Fees']:
      provider==='shipstation'?['https://docs.shipstation.com/create-labels']:
      provider==='easypost'?['https://docs.easypost.com/docs/users/billing','https://docs.easypost.com/docs/fees']:
      ['https://docs.goshippo.com/docs/guides_general/authentication/']})),
  ...['quickbooks','xero','shopify','clover','microsoft365','supplier_email','stripe','stripe_connect','erp_future','stockchief_shipping_partner'].map(provider=>({
    provider,status:STATUS.EXCLUDED,launch:false,
    scope:'Not an initial self-service advertised entitlement; adapters or existing records remain intact, and any reactivation requires fee/contract review.',
    evidence:provider==='quickbooks'?['https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf']:
      provider==='xero'?['https://developer.xero.com/pricing']:
      provider==='shopify'?['https://shopify.dev/docs/apps/launch/billing']:
      provider==='clover'?['https://docs.clover.com/dev/docs/monetizing-your-apps']:
      ['src/connections/launch-policy.js','src/db/postgres-migrations/037-commercial-initial-provider-scope.sql']})),
  {provider:'anthropic',status:STATUS.STOCKCHIEF,launch:true,
    scope:'StockChief model account, with versioned token rates, actual attempts, and provider-dollar bounds.',
    evidence:['src/commercial/model.js','src/commercial/model-cost-budget.js']},
  {provider:'resend',status:STATUS.STOCKCHIEF,launch:true,
    scope:'StockChief transactional email account; conservative configured message cost; actual account tier must replace estimate.',
    evidence:['https://resend.com/pricing','src/operations/postgres-monitoring.js']}
]);
function assertClosedLaunchSet(){
 const allowed=new Set(Object.values(STATUS));const seen=new Set();
 for(const row of rows){
  if(!allowed.has(row.status)||seen.has(row.provider)||!row.scope||!row.evidence?.length)
   throw new Error(`Unclassified or duplicate launch provider: ${row.provider}`);
  if(row.launch===(row.status===STATUS.EXCLUDED))
   throw new Error(`Contradictory launch provider status: ${row.provider}`);
  seen.add(row.provider);
 }
 return true;
}
module.exports={STATUS,rows,assertClosedLaunchSet};
