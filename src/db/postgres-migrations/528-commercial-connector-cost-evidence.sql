-- Deployed adapters record each provider request separately. Their discrete
-- workflow wrappers, and local Square event processing, add no provider tariff.
WITH evidence AS (
 SELECT id, CASE
  WHEN provider='gmail' THEN 'NO_EXTRA_GMAIL_WRAPPER_PROVIDER_FEE'
  WHEN provider='square' AND operation='event_ingestion' THEN 'NO_EXTRA_SQUARE_EVENT_INGESTION_FEE'
  ELSE 'NO_EXTRA_CONNECTOR_WRAPPER_PROVIDER_FEE' END AS basis
 FROM commercial_cost_events
 WHERE amount_minor IS NULL AND (
  (provider='gmail' AND operation='reply_email' AND unit='message' AND detail->>'attempted'='true')
  OR (provider='microsoft365' AND operation IN ('authorization_exchange','catalog_sync','mailbox_poll',
      'outbound_email','reply_email','push_renewal','webhook_registration') AND detail->>'attempted'='true')
  OR (provider='square' AND operation IN ('authorization_exchange','catalog_sync','webhook_registration')
      AND detail->>'attempted'='true')
  OR (provider='square' AND operation='event_ingestion' AND unit='event' AND detail ? 'eventType'))
)
UPDATE commercial_cost_events event SET amount_minor=0,
 detail=event.detail||jsonb_build_object('costRateMissing',false,'costBasis',evidence.basis,'costConfidence','HIGH',
  'costSource','StockChief adapter code; provider attempts and application resources are recorded separately',
  'launchCostEvidence','2026-11-16')
FROM evidence WHERE event.id=evidence.id;

-- The historical release used these host/version combinations for its fixed
-- adapter paths. New requests are qualified by HTTP method and path as well.
WITH evidence(provider,version,hostname,basis,source) AS (VALUES
 ('square','2026-08-19','connect.squareup.com','NO_INCREMENTAL_SQUARE_API_REQUEST_FEE',
  'https://developer.squareup.com/us/en/online-payment-apis; seller Square payments and refunds are separate'),
 ('microsoft365','v1.0','graph.microsoft.com','MICROSOFT_GRAPH_STANDARD_MAIL_API_INCLUDED_IN_USER_LICENSE',
  'https://learn.microsoft.com/en-us/graph/metered-api-overview; https://learn.microsoft.com/en-us/graph/metered-api-list'),
 ('login.microsoftonline.com','v2.0','login.microsoftonline.com','MICROSOFT_ENTRA_WORKFORCE_OAUTH_INCLUDED_IN_USER_LICENSE',
  'https://www.microsoft.com/en-us/security/business/microsoft-entra-pricing; delegated workforce authentication'))
UPDATE commercial_cost_events event SET amount_minor=0,
 detail=event.detail||jsonb_build_object('costRateMissing',false,'costBasis',evidence.basis,'costConfidence','HIGH',
  'costSource',evidence.source,'launchCostEvidence','2026-11-16')
FROM evidence
WHERE event.amount_minor IS NULL AND event.provider=evidence.provider
 AND event.provider_version=evidence.version AND event.detail->>'hostname'=evidence.hostname
 AND event.operation='http_request' AND event.unit='request' AND event.model='';

UPDATE commercial_critical_warnings warning SET status='RESOLVED',
 detail=warning.detail||jsonb_build_object('resolution','VERIFIED_CONNECTOR_COST_EVIDENCE','verifiedAt','2026-11-16')
WHERE warning.code='MISSING_COST_RATE' AND warning.status='OPEN'
 AND EXISTS (SELECT 1 FROM commercial_cost_events event
  WHERE event.account_id IS NOT DISTINCT FROM warning.account_id
   AND event.provider=warning.detail->>'provider' AND event.operation=warning.detail->>'operation'
   AND event.unit=warning.detail->>'unit' AND event.model=coalesce(warning.detail->>'model','')
   AND event.provider_version=coalesce(warning.detail->>'providerVersion','')
   AND event.detail->>'launchCostEvidence'='2026-11-16')
 AND NOT EXISTS (SELECT 1 FROM commercial_cost_events event
  WHERE event.account_id IS NOT DISTINCT FROM warning.account_id
   AND event.provider=warning.detail->>'provider' AND event.operation=warning.detail->>'operation'
   AND event.unit=warning.detail->>'unit' AND event.model=coalesce(warning.detail->>'model','')
   AND event.provider_version=coalesce(warning.detail->>'providerVersion','')
   AND event.amount_minor IS NULL);
