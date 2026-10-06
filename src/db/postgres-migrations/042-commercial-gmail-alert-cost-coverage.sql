-- Gmail's standard API is explicitly no-charge below its published daily
-- billing threshold. StockChief reserves at most 72M of the 80M units before
-- sending a recognized method. This is evidence, not a fabricated zero rate.
UPDATE commercial_cost_events SET amount_minor=0,
 detail=detail||jsonb_build_object('costRateMissing',false,
  'costBasis','VERIFIED_NO_INCREMENTAL_GMAIL_API_FEE_BELOW_RESERVED_DAILY_THRESHOLD',
  'costConfidence','HIGH',
  'costSource','https://developers.google.com/workspace/gmail/api/reference/quota',
  'feeResponsibility','NO_INCREMENTAL_GMAIL_API_FEE_BELOW_DAILY_THRESHOLD',
  'projectDailySafetyCeiling',72000000,'evidenceVerifiedAt','2026-10-06')
WHERE provider='gmail' AND amount_minor IS NULL
 AND ((operation='gmail_api_quota' AND unit='quota_unit' AND provider_version='v1')
   OR (operation='http_request' AND unit='request' AND provider_version='v1'))
 AND detail->>'hostname'='gmail.googleapis.com';

-- These records were logical wrappers around separately recorded API calls.
-- They consume shared app resources, but cannot create a second Gmail tariff.
UPDATE commercial_cost_events SET amount_minor=0,
 detail=detail||jsonb_build_object('costRateMissing',false,
  'costBasis','NO_EXTRA_GMAIL_WRAPPER_PROVIDER_FEE','costConfidence','HIGH',
  'costSource','src/commercial/operations.js; API attempts recorded separately',
  'feeResponsibility','NO_EXTRA_PROVIDER_CALL_FOR_WRAPPER',
  'evidenceVerifiedAt','2026-10-06')
WHERE provider='gmail' AND amount_minor IS NULL
 AND operation IN ('authorization_exchange','catalog_sync','mailbox_poll',
   'outbound_email','push_renewal','webhook_registration');

-- Ingestion is a local database operation after the separately costed API
-- fetch. It is not another provider request or tariff.
UPDATE commercial_cost_events SET amount_minor=0,
 detail=detail||jsonb_build_object('costRateMissing',false,
  'costBasis','NO_EXTRA_GMAIL_MESSAGE_INGESTION_FEE','costConfidence','HIGH',
  'costSource','https://developers.google.com/workspace/gmail/api/reference/quota; API attempts recorded separately',
  'feeResponsibility','NO_EXTRA_PROVIDER_CALL_FOR_INGESTION',
  'evidenceVerifiedAt','2026-10-06')
WHERE provider='gmail' AND operation='message_ingestion' AND unit='message'
 AND amount_minor IS NULL;

-- OAuth token exchange is not the Gmail API quota endpoint. There is no
-- account-specific tariff evidence, so use a deliberately conservative,
-- configurable $0.001/request estimate rather than silently recording zero.
INSERT INTO commercial_cost_rates(id,provider,operation,unit,cost_per_unit_minor,
 currency,effective_from,source,model,provider_version,pricing_basis,confidence)
VALUES('costrate_google_oauth_token_estimate_2026_10','google_oauth','http_request',
 'request',0.1,'USD','2026-09-01T00:00:00Z',
 'https://developers.google.com/identity/openid-connect/openid-connect; provisional $0.001/request upper reserve pending Google Cloud Billing evidence',
 '','oauth2-v1','CONSERVATIVE_ESTIMATE','LOW')
ON CONFLICT(id) DO NOTHING;
UPDATE commercial_cost_events SET provider='google_oauth',provider_version='oauth2-v1',
 rate_id='costrate_google_oauth_token_estimate_2026_10',amount_minor=quantity*0.1,
 detail=detail||jsonb_build_object('costRateMissing',false,
  'costBasis','CONSERVATIVE_ESTIMATE','costConfidence','LOW',
  'costSource','https://developers.google.com/identity/openid-connect/openid-connect; provisional $0.001/request upper reserve pending Google Cloud Billing evidence',
  'feeResponsibility','STOCKCHIEF_CONSERVATIVE_TOKEN_EXCHANGE_RESERVE',
  'evidenceVerifiedAt','2026-10-06')
WHERE provider='gmail' AND operation='http_request' AND unit='request'
 AND provider_version='unversioned' AND amount_minor IS NULL
 AND detail->>'hostname'='oauth2.googleapis.com';

-- The existing configured responder is a Cloudflare Worker. Public Standard
-- overage is far below this $0.001/request reserve, but the account contract
-- and CPU usage are not verified. This estimate is LOW confidence and must be
-- replaced by actual Cloudflare invoice/usage evidence when available.
INSERT INTO commercial_cost_rates(id,provider,operation,unit,cost_per_unit_minor,
 currency,effective_from,source,model,provider_version,pricing_basis,confidence)
VALUES('costrate_alert_worker_estimate_2026_10',
 'stockchief-alert-responder.mysolutionstesting.workers.dev',
 'operational_alert','request',0.1,'USD','2026-09-01T00:00:00Z',
 'https://developers.cloudflare.com/workers/platform/pricing/; conservative $0.001/alert reserve including CPU and unknown account terms',
 '','webhook-v1','CONSERVATIVE_ESTIMATE','LOW')
ON CONFLICT(id) DO NOTHING;
UPDATE commercial_cost_events SET rate_id='costrate_alert_worker_estimate_2026_10',
 amount_minor=quantity*0.1,
 detail=detail||jsonb_build_object('costRateMissing',false,
  'costBasis','CONSERVATIVE_ESTIMATE','costConfidence','LOW',
  'costSource','https://developers.cloudflare.com/workers/platform/pricing/; conservative $0.001/alert reserve including CPU and unknown account terms',
  'feeResponsibility','STOCKCHIEF_ESTIMATED_ALERT_RESPONDER',
  'evidenceVerifiedAt','2026-10-06')
WHERE provider='stockchief-alert-responder.mysolutionstesting.workers.dev'
 AND operation='operational_alert' AND unit='request'
 AND provider_version='webhook-v1' AND amount_minor IS NULL;

UPDATE commercial_critical_warnings warning SET status='RESOLVED',
 detail=detail||jsonb_build_object('resolution','EVIDENCE_BACKED_OR_EXPLICIT_CONSERVATIVE_ESTIMATE',
  'verifiedAt','2026-10-06')
WHERE warning.code='MISSING_COST_RATE' AND warning.status='OPEN'
 AND warning.detail->>'provider' IN ('gmail','google_oauth',
  'stockchief-alert-responder.mysolutionstesting.workers.dev')
 AND NOT EXISTS (SELECT 1 FROM commercial_cost_events event
   WHERE event.account_id IS NOT DISTINCT FROM warning.account_id
   AND event.provider=warning.detail->>'provider'
   AND event.operation=warning.detail->>'operation'
   AND event.unit=warning.detail->>'unit'
   AND event.model=COALESCE(warning.detail->>'model','')
   AND event.provider_version=COALESCE(warning.detail->>'providerVersion','')
   AND event.amount_minor IS NULL);
