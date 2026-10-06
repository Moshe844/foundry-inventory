-- These are evidence gates, not invented cost rates. Checkout stays disabled
-- until the operator verifies contracts and mixed-workload launch capacity.
INSERT INTO commercial_critical_warnings(id,fingerprint,code,detail) VALUES
 ('critical:stripe-billing-volume','launch:stripe-billing-volume','UNVERIFIED_STRIPE_BILLING_VOLUME_COST',
  '{"severity":"CRITICAL","required":"Verify actual StockChief Stripe Billing/Tax fee statement or contract; HTTP requests are not the billable unit.","source":"https://stripe.com/billing/pricing"}'),
 ('critical:intuit-platform-fees','launch:intuit-platform-fees','UNVERIFIED_INTUIT_PLATFORM_FEES',
  '{"severity":"CRITICAL","required":"Confirm developer tier and CorePlus endpoint usage; establish a bounded global cost policy before QuickBooks self-service launch.","source":"https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf"}'),
 ('critical:xero-platform-fees','launch:xero-platform-fees','UNVERIFIED_XERO_PLATFORM_FEES',
  '{"severity":"CRITICAL","required":"Confirm app tier, connections and API egress; establish a bounded global cost policy before Xero self-service launch.","source":"https://developer.xero.com/faq/pricing-and-policy-updates"}'),
 ('critical:mixed-render-capacity','launch:mixed-render-capacity','UNVERIFIED_MIXED_WORKLOAD_CAPACITY',
  '{"severity":"CRITICAL","required":"Measure concurrent commerce, AI, imports, orders, worker, accounting, mailbox and shipping workload on the intended Render service sizes; verify alerts and scale trigger.","source":"docs/commercial-production-gate-evidence-2026-10-05.md"}')
ON CONFLICT(fingerprint) DO NOTHING;
