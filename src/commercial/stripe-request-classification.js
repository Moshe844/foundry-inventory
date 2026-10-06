'use strict';

// These are the ordinary Stripe Billing/Payments REST resources currently used
// by stripe-billing.js. Stripe publishes product/volume/transaction pricing,
// not a charge for these HTTP attempts. This does NOT waive Billing volume,
// Payments, Tax, Connect, dispute, or contractual fees; those are separate.
const evidence=Object.freeze({
 basis:'VERIFIED_NO_INCREMENTAL_REQUEST_FEE',
 source:'https://stripe.com/billing/pricing',
 paymentsSource:'https://stripe.com/pricing',
 verifiedAt:'2026-10-05',
});
const paths=[
 /^\/v1\/checkout\/sessions(?:\/[^/?]+)?$/,
 /^\/v1\/billing_portal\/sessions(?:\/[^/?]+)?$/,
 /^\/v1\/payment_intents(?:\/[^/?]+)?$/,
 /^\/v1\/payment_methods\/[^/?]+$/,
 /^\/v1\/balance_transactions\/[^/?]+$/,
 /^\/v1\/invoices(?:\/[^/?]+)?(?:\/create_preview)?$/,
 /^\/v1\/credit_notes(?:\/[^/?]+)?$/,
 /^\/v1\/invoice_payments(?:\/[^/?]+)?$/,
 /^\/v1\/customers\/[^/?]+\/balance_transactions$/,
 /^\/v1\/subscriptions(?:\/[^/?]+)?$/,
 /^\/v1\/subscription_schedules(?:\/[^/?]+)?$/,
 /^\/v1\/invoiceitems(?:\/[^/?]+)?$/,
 /^\/v1\/prices\/[^/?]+$/,
];
function classify(url){
 const target=new URL(url);
 if(target.origin!=='https://api.stripe.com')return null;
 const matched=paths.find(path=>path.test(target.pathname));
 if(!matched)return null;
 return {...evidence,resourcePattern:matched.source};
}
module.exports={classify,evidence};
