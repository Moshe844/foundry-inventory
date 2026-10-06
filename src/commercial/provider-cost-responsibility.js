'use strict';

// Offline commercial evidence, not a cost-rate table. An unknown contractual
// charge has no numeric value and must never be imported as a zero-dollar rate.
const CATEGORY=Object.freeze({MERCHANT:'MERCHANT_PAID_PASS_THROUGH',VARIABLE:'STOCKCHIEF_PAID_VARIABLE',
 INFRA:'STOCKCHIEF_INFRASTRUCTURE',NO_FEE:'NO_INCREMENTAL_PROVIDER_FEE',UNKNOWN:'UNKNOWN_REQUIRES_PROVIDER_CONFIRMATION'});
const entries=Object.freeze([
 {provider:'shopify',scope:'merchant store',merchant:['Shopify subscription, merchant transaction/payment charges'],unknown:['StockChief app/distribution terms until partner account verified'],evidence:['https://shopify.dev/docs/api/usage/limits','https://shopify.dev/docs/apps/launch/billing']},
 {provider:'square',scope:'merchant commerce',merchant:['merchant processing and POS charges'],noFee:['standard Square API/SDK use'],unknown:['Orders API non-Square-payment transaction fee if that feature is used'],evidence:['https://developer.squareup.com/us/en/online-payment-apis','https://developer.squareup.com/reference/square/orders-api']},
 {provider:'clover',scope:'merchant commerce',merchant:['merchant processing and POS charges'],unknown:['StockChief app or API-specific fees']},
 {provider:'woocommerce',scope:'merchant store',merchant:['hosting, plugins and merchant payment processing'],unknown:['StockChief plugin or API-specific fees']},
 {provider:'gmail',scope:'merchant mailbox',merchant:['Google Workspace/mailbox subscription'],noFee:['standard Gmail API use below the 80M quota-units/day project threshold'],unknown:['future over-threshold Google charge; pricing not yet published'],evidence:['https://developers.google.com/workspace/gmail/api/reference/quota']},
 {provider:'microsoft365',scope:'merchant mailbox',merchant:['Microsoft 365/mailbox subscription'],noFee:['standard Graph mail endpoints within reasonable-access limits'],unknown:['metered/high-capacity Graph endpoints if introduced'],evidence:['https://learn.microsoft.com/en-us/graph/metered-api-overview']},
 {provider:'quickbooks',scope:'merchant accounting',merchant:['QuickBooks subscription and merchant payment charges'],variable:['Intuit partner tier fee and CorePlus overage when applicable'],unknown:['StockChief developer account tier and Core/CorePlus endpoint classification'],evidence:['https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf']},
 {provider:'xero',scope:'merchant accounting',merchant:['Xero subscription and merchant payment charges'],variable:['Xero developer-platform tier fee and API egress overage after included GB'],unknown:['StockChief app tier/connection count and actual API egress'],evidence:['https://developer.xero.com/faq/pricing-and-policy-updates']},
 {provider:'supplier_email',scope:'merchant-connected mail',merchant:['merchant mailbox subscription'],unknown:['mail provider API-specific fee, if any']},
 {provider:'reference_webhook',scope:'merchant-owned sender',merchant:['merchant source-system subscription and sending costs'],unknown:[]},
 {provider:'erp_future',scope:'custom contract only',merchant:[],unknown:['every fee and payer until a signed custom contract'],productionEnabled:false},
 {provider:'shipengine',scope:'workspace seller key',merchant:['postage, labels, carrier charges and seller-account fees'],unknown:['StockChief partner/API-specific fees']},
 {provider:'shipstation',scope:'workspace carrier key',merchant:['postage, labels, carrier charges and seller-account fees, including eligible per-shipment account fees'],unknown:['StockChief partner/API-specific fees'],evidence:['https://help.shipstation.com/hc/en-us/articles/22354433862555-Shipment-Fees-by-Plan']},
 {provider:'easypost',scope:'workspace account key',merchant:['postage, labels, carrier charges and seller-account fees'],unknown:['StockChief referral/partner/API-specific fees']},
 {provider:'shippo',scope:'workspace account key',merchant:['postage, labels, carrier charges and seller-account fees, including rate/tracking API charges on the merchant key'],unknown:['StockChief partner/API-specific fees'],evidence:['https://goshippo.com/pricing/api','https://docs.goshippo.com/docs/guides_general/authentication/']},
 {provider:'stripe_merchant',scope:'direct charges on merchant connected account',merchant:['customer-payment processing, refunds, disputes and negative balances when Stripe confirms merchant fee/loss responsibility'],unknown:['Connect platform-specific fees or a changed fee/loss collector']},
 {provider:'stripe_stockchief_billing',scope:'StockChief subscriptions and Buy More',variable:['actual Stripe balance-transaction fees, refunds and disputes on StockChief charges','observed 0.7% Billing-volume plan','observed Radar Standard $0.05 per screened transaction'],noFee:['ordinary Billing/Payments REST HTTP request itself'],unknown:['non-domestic and alternative payment-method rates until first live fee rows','Stripe Tax only if separately enabled later'],evidence:['https://stripe.com/billing/pricing','https://stripe.com/pricing','src/commercial/stripe-live-fee-evidence.js']},
 {provider:'anthropic',scope:'StockChief model account',variable:['input/output/cache token charges, including failed attempts'],unknown:[]},
 {provider:'resend',scope:'StockChief system email account',variable:['StockChief transactional email delivery or overage'],unknown:['paid plan and contracted overage rate']},
 {provider:'render',scope:'shared web, worker, Postgres, storage and egress',infra:['shared compute, Postgres, disk, backup capacity and outbound bandwidth'],unknown:['production load/capacity and external object-storage contract']},
]);
function classified(){return entries.flatMap(row=>Object.entries({
 [CATEGORY.MERCHANT]:row.merchant||[],[CATEGORY.VARIABLE]:row.variable||[],
 [CATEGORY.INFRA]:row.infra||[],[CATEGORY.NO_FEE]:row.noFee||[],[CATEGORY.UNKNOWN]:row.unknown||[]})
 .flatMap(([category,costs])=>costs.map(cost=>({provider:row.provider,scope:row.scope,
  category,cost,productionEnabled:row.productionEnabled!==false,evidence:row.evidence||[],
  contractRateUsd:category===CATEGORY.UNKNOWN?null:undefined}))));}
module.exports={CATEGORY,entries,classified};
