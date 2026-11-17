-- Refund HTTP requests have no incremental request tariff. Stripe's actual
-- payment/refund balance fees and Billing-volume charges remain separate.
-- The earlier classifier omitted /v1/refunds, and legacy attempt rows did not
-- retain their path. Infer that resource only from the completed native refund
-- worker, within its recorded execution window, with its verified refund.
UPDATE commercial_cost_events event SET amount_minor=0,
 detail=event.detail||jsonb_build_object(
  'costRateMissing',false,'costBasis','VERIFIED_NO_INCREMENTAL_REQUEST_FEE',
  'costConfidence','HIGH','costSource','https://stripe.com/billing/pricing',
  'feeResponsibility','NO_INCREMENTAL_HTTP_REQUEST_FEE',
  'evidenceVerifiedAt','2026-11-17','refundHttpEvidence','536',
  'inferredResource','/v1/refunds',
  'inferenceBasis','COMPLETED_NATIVE_GUARANTEE_WORKER_WITH_VERIFIED_REFUND',
  'otherStripeFees','Reconcile actual balance transaction and Billing volume fees separately.')
FROM stockchief_runtime.jobs job JOIN commercial_guarantee_requests request
 ON request.id=job.payload->>'requestId' AND request.account_id=job.payload->>'accountId'
WHERE event.provider='stripe_billing' AND event.operation='http_request'
 AND event.unit='request' AND event.model='' AND event.provider_version='2026-09-30.endive'
 AND event.amount_minor IS NULL AND event.rate_id IS NULL
 AND event.detail->>'hostname'='api.stripe.com' AND event.detail->>'costBasis'='MISSING'
 AND event.detail->>'httpStatus'='200' AND event.detail->>'providerPath' IS NULL
 AND event.detail->>'requestId'=job.id
 AND job.kind='commercial.subscription-guarantee' AND job.status='COMPLETED'
 AND request.status='REFUNDED' AND job.completed_at IS NOT NULL
 AND event.occurred_at>=job.created_at AND event.occurred_at<=job.completed_at
 AND (event.account_id IS NULL OR event.account_id=request.account_id)
 AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(request.parts) part
  JOIN commercial_stripe_refunds refund ON refund.account_id=request.account_id
   AND refund.payment_intent_id=part->>'paymentIntentId'
   AND refund.amount_minor=(part->>'amount')::bigint
   AND refund.currency=part->>'currency' AND refund.status='succeeded');

-- Resolve only the exact affected warning when no unknown attempt remains.
-- Tax, future resources, other workers and unverified refunds stay unknown.
UPDATE commercial_critical_warnings warning SET status='RESOLVED',
 detail=warning.detail||jsonb_build_object('resolution','VERIFIED_REFUND_HTTP_REQUEST_EVIDENCE',
  'source','https://stripe.com/billing/pricing','verifiedAt','2026-11-17')
WHERE warning.code='MISSING_COST_RATE' AND warning.status='OPEN'
 AND warning.detail->>'provider'='stripe_billing'
 AND warning.detail->>'operation'='http_request' AND warning.detail->>'unit'='request'
 AND coalesce(warning.detail->>'model','')=''
 AND warning.detail->>'providerVersion'='2026-09-30.endive'
 AND EXISTS (SELECT 1 FROM commercial_cost_events event
  WHERE event.account_id IS NOT DISTINCT FROM warning.account_id
   AND event.provider='stripe_billing' AND event.operation='http_request'
   AND event.unit='request' AND event.model='' AND event.provider_version='2026-09-30.endive'
   AND event.detail->>'refundHttpEvidence'='536')
 AND NOT EXISTS (SELECT 1 FROM commercial_cost_events event
  WHERE event.account_id IS NOT DISTINCT FROM warning.account_id
   AND event.provider='stripe_billing' AND event.operation='http_request'
   AND event.unit='request' AND event.model='' AND event.provider_version='2026-09-30.endive'
   AND event.amount_minor IS NULL);

UPDATE commercial_critical_warnings warning SET status='RESOLVED',
 detail=warning.detail||jsonb_build_object('resolution','VERIFIED_REFUND_HTTP_REQUEST_EVIDENCE')
FROM commercial_cost_events event
WHERE warning.code='MISSING_HISTORICAL_COST_RATE' AND warning.status='OPEN'
 AND warning.detail->>'costEventId'=event.id
 AND event.amount_minor=0 AND event.detail->>'refundHttpEvidence'='536';
