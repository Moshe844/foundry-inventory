-- Xero's Manual Journals API is available on every developer tier. An
-- individual journal submission has no additional per-request tariff; the
-- app's tier/subscription and capacity charges remain separate. This prices
-- only the native operation wrapper, not an upgrade or customer invoice.
INSERT INTO commercial_cost_rates
 (id,provider,operation,unit,cost_per_unit_minor,currency,effective_from,source,model,provider_version,pricing_basis,confidence)
SELECT 'costrate_xero_journal_export_20261123','xero','journal_export','journal',0,'USD','2026-11-23',
 'https://developer.xero.com/faq/pricing-and-policy-updates; https://developer.xero.com/pricing; no incremental Manual Journals request fee; provider tier fees and five-company Starter capacity remain separate.',
 '','','VERIFIED_PUBLIC','HIGH'
WHERE NOT EXISTS(SELECT 1 FROM commercial_cost_rates WHERE provider='xero' AND operation='journal_export' AND unit='journal'
 AND model='' AND provider_version='' AND effective_until IS NULL);
