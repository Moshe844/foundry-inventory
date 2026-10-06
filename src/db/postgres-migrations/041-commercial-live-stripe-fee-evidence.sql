-- The intended live billing account's Dashboard displayed Standard Payments
-- 2.9% + $0.30 domestic cards, Billing pay-as-you-go 0.7% of volume, and
-- Radar Standard $0.05 per screened transaction on 2026-10-06. This resolves
-- the missing expected Billing-volume rate, not future actual-fee reconciliation.
-- Release additionally requires this exact account ID in configuration.
UPDATE commercial_critical_warnings SET status='RESOLVED',
 detail=jsonb_build_object('severity','INFO','disposition','ACCOUNT_SPECIFIC_PLAN_OBSERVED',
  'accountId','acct_1UBFTdIjKuQgOJD6','observedOn','2026-10-06',
  'paymentsDomesticCardFraction',0.029,'paymentsDomesticCardFixedUsd',0.30,
  'billingVolumeFraction',0.007,'radarScreenedTransactionUsd',0.05,
  'actualLiveFeeRowsObserved',0,'taxLaunchEnabled',false,
  'source','https://dashboard.stripe.com/acct_1UBFTdIjKuQgOJD6/settings/plans-and-fees/plans',
  'billingDetail','https://dashboard.stripe.com/acct_1UBFTdIjKuQgOJD6/settings/plans-and-fees/plans/billing',
  'limitation','Actual balance-transaction fees supersede expected rates; other payment methods and cross-border surcharges are not certified.')
 WHERE fingerprint='launch:stripe-billing-volume' AND code='UNVERIFIED_STRIPE_BILLING_VOLUME_COST';
