-- Resolve launch *scope* risk, not unknown contractual prices. These optional
-- providers are excluded from new self-service connections by launch-policy,
-- the plan entitlements in 037, and the release-time existing-connection check.
-- Historical business data is never deleted. Re-enabling one requires a new
-- explicit contract/cost review; this migration is not proof of a $0 tariff.
UPDATE commercial_critical_warnings SET status='RESOLVED',
 detail=jsonb_build_object('severity','INFO','disposition','DISABLED_NOT_MARKETED_AT_LAUNCH',
  'costVerified',false,'evidence',jsonb_build_array(
   'https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf',
   'https://developer.xero.com/pricing',
   'src/connections/launch-policy.js',
   'src/db/postgres-migrations/037-commercial-initial-provider-scope.sql'))
 WHERE fingerprint IN ('launch:intuit-platform-fees','launch:xero-platform-fees')
 AND status='OPEN';

UPDATE commercial_critical_warnings SET status='RESOLVED',
 detail=jsonb_build_object('severity','INFO','disposition','VERIFIED_OR_BOUNDED_LAUNCH_SCOPE',
  'costVerified',false,'evidence',jsonb_build_array(
   'src/commercial/launch-provider-matrix.js',
   'src/commercial/network.js',
   'src/shipping/postgres-accounts.js',
   'src/connections/launch-policy.js'))
 WHERE fingerprint='launch:other-provider-fees' AND status='OPEN';
