-- Public tariffs and merchant-owned API keys do not establish StockChief's
-- platform/partner fee liability. Keep self-service checkout closed until each
-- production-launch connector is verified, bounded, or excluded.
INSERT INTO commercial_critical_warnings(id,fingerprint,code,detail) VALUES
 ('critical:other-launch-provider-fees','launch:other-provider-fees',
  'UNVERIFIED_OTHER_LAUNCH_PROVIDER_FEES',
  '{"severity":"CRITICAL","required":"Verify or explicitly exclude/bound remaining production connector platform and partner fee exposures (Shopify, Square non-Square Orders, Clover, WooCommerce, shipping partners, Stripe Connect fee responsibility, Resend and mailbox threshold/overage). Record account-specific evidence and update the provider responsibility registry before resolving.","source":"docs/commercial-production-gate-evidence-2026-10-05.md"}')
ON CONFLICT(fingerprint) DO NOTHING;
