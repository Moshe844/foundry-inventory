-- Existing Stripe Billing REST attempts were incorrectly treated as unpriced
-- provider-cost units. The request itself has no incremental tariff under the
-- dated public Billing/Payments schedules; transaction and Billing volume
-- charges remain separate liabilities and must be reconciled independently.
UPDATE commercial_cost_events SET amount_minor=0,
 detail=detail||jsonb_build_object(
   'costRateMissing',false,
   'costBasis','VERIFIED_NO_INCREMENTAL_REQUEST_FEE',
   'costConfidence','HIGH',
   'costSource','https://stripe.com/billing/pricing',
   'feeResponsibility','NO_INCREMENTAL_HTTP_REQUEST_FEE',
   'evidenceVerifiedAt','2026-10-05',
   'otherStripeFees','Actual payment, dispute, Tax and Billing volume fees remain separately chargeable')
WHERE provider='stripe_billing' AND operation='http_request' AND unit='request'
 AND provider_version='2026-09-30.endive' AND amount_minor IS NULL
 AND (detail->>'hostname')='api.stripe.com'
 AND (detail->>'costBasis')='MISSING';
UPDATE commercial_critical_warnings SET status='RESOLVED',
 detail=detail||jsonb_build_object('resolution','VERIFIED_NO_INCREMENTAL_REQUEST_FEE',
   'evidence','https://stripe.com/billing/pricing','verifiedAt','2026-10-05')
WHERE code='MISSING_COST_RATE' AND status='OPEN'
 AND detail->>'provider'='stripe_billing' AND detail->>'operation'='http_request'
 AND detail->>'unit'='request' AND detail->>'providerVersion'='2026-09-30.endive'
 AND NOT EXISTS (SELECT 1 FROM commercial_cost_events event WHERE event.provider='stripe_billing'
   AND event.operation='http_request' AND event.unit='request'
   AND event.provider_version='2026-09-30.endive' AND event.amount_minor IS NULL
   AND event.account_id IS NOT DISTINCT FROM commercial_critical_warnings.account_id);
UPDATE commercial_critical_warnings warning SET status='RESOLVED',
 detail=warning.detail||jsonb_build_object('resolution','VERIFIED_NO_INCREMENTAL_REQUEST_FEE',
   'evidence','https://stripe.com/billing/pricing','verifiedAt','2026-10-05')
FROM commercial_cost_events event
WHERE warning.code='MISSING_HISTORICAL_COST_RATE' AND warning.status='OPEN'
 AND warning.detail->>'costEventId'=event.id
 AND event.provider='stripe_billing' AND event.operation='http_request'
 AND event.provider_version='2026-09-30.endive'
 AND event.detail->>'costBasis'='VERIFIED_NO_INCREMENTAL_REQUEST_FEE';
