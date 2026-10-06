'use strict';

// Account-specific, read-only Dashboard observation. This is an expected-cost
// schedule, not a substitute for actual balance-transaction reconciliation.
// It applies only to the intended StockChief billing account below.
const evidence=Object.freeze({
 accountId:'acct_1UBFTdIjKuQgOJD6',
 observedOn:'2026-10-06',
 source:'https://dashboard.stripe.com/acct_1UBFTdIjKuQgOJD6/settings/plans-and-fees/plans',
 billingDetail:'https://dashboard.stripe.com/acct_1UBFTdIjKuQgOJD6/settings/plans-and-fees/plans/billing',
 payments:{domesticCardFraction:0.029,domesticCardFixedUsd:0.30,plan:'Standard pricing'},
 billing:{volumeFraction:0.007,plan:'Pay as you go'},
 radar:{screenedTransactionUsd:0.05,plan:'Standard',trialCreditAssumed:false},
 invoicing:{oneTimeInvoiceFraction:0.004,usedByLaunchCheckout:false},
 tax:{usedByLaunchCheckout:false,accountRateCertified:false},
 workflows:{usedByLaunchCheckout:false},
 connect:{usedByLaunchCheckout:false},
 observedLiveFeeRows:0,
 // International cards, FX and payment-method-specific rates are not covered
 // by the domestic-card headline. Actual ledger rows supersede this reserve.
 otherPaymentMethodRatesCertified:false,
 actualFeesReconciledFromBalanceTransactions:true,
});
module.exports=evidence;
