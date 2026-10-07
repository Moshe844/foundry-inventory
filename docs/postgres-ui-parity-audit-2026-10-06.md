# PostgreSQL UI parity audit — 2026-10-06

## Scope and evidence

- This audit compares the current PostgreSQL web application with the former SQLite route and UI surface. It is not a production certification.
- A fresh-workspace Chromium sweep visited core pages and the complete Everything else directory, inspecting rendered links and forms. A populated-workspace sweep inspected customer, supplier, invoices, bills, banking, orders, settings, and Activity.
- Chromium completed purchasing → receiving → supplier payment → customer order → fulfillment → customer payment, and separate bank evidence → exact payment match → statement reconciliation. Related inventory, shipping, connection, Ask, import, planning, warehouse, and returns suites passed locally.
- A static route-declaration comparison finds 254 former route paths without an exact PostgreSQL declaration. This is a screening signal, **not** 254 confirmed defects: some endpoints were intentionally replaced or renamed, and some old paths were not customer-facing. Each flow still needs behavioral review.
- No deployed staging or live third-party qualification was performed during this audit. Passing local Chromium tests do not establish deployed parity.

## Restored in this checkout

- Gmail/Microsoft connection details expose business mail, set-aside senders, configurable poll timing, and manual polling. The UI distinguishes a queued poll from a completed one.
- Ask StockChief handles a bounded set of explicit navigation commands; evidence links no longer target the SQLite-only navigation route.
- Customer records open from Orders and support editing, archiving, restoring, and order history without deleting existing orders or invoices.
- The former dead manual invoice, supplier bill, and financial-account controls now perform actual PostgreSQL writes. Manual invoices/bills do not create physical stock; invoice journal lines balance.
- Banking's manual evidence import, exact matching, and reconciliation operate transactionally. A match does not create another sale or expense.
- Activity includes recent sales orders, purchase orders, exceptions, and action proposals alongside inventory movements. It is labelled as a recent timeline, not a complete historical archive.
- The email-alert test button queues an encrypted delivery to the signed-in owner when a provider is configured, rather than reporting an event-dependent pseudo-test.
- The inventories list no longer offers PostgreSQL Delete/Leave buttons that lead to missing routes. It explicitly states those operations are unavailable.

## Confirmed remaining parity and launch blockers

- Mailbox supplier-watch rules and attachment/document ingestion present in the former connection flow are not restored by the current PostgreSQL mailbox page. Known-contact mail capture is not equivalent to the complete former workflow.
- Permanent inventory deletion and leaving a shared inventory are not implemented in the PostgreSQL app. Data must not be described as deleted merely because a workspace is hidden.
- Customer-specific payment terms and payment-hold controls from the former customer/order pages lack PostgreSQL route equivalents.
- Former migration review/conflict-resolution routes, warehouse cycle-count routes, accounting opening/migration routes, and shipping label-void routes have no exact PostgreSQL equivalents. Their replacement workflows require separate UI and behavior qualification.
- Activity currently assembles a bounded recent window per stream. It is not a complete, paginated cross-domain audit trail.
- Explicit navigation intent in Ask is limited to recognized page names; arbitrary natural-language page requests and the broader Ask business-action surface are not certified as flawless.
- The full PostgreSQL regression suite, deployed-browser suite, real connected Gmail/Stripe/carrier/QuickBooks flows, load, restore, and rollback gates were not rerun here.

## Release position

Do not claim full website parity or subscription-ready production status from the focused green suites. Complete the remaining workflow ports, then certify each in a real browser against PostgreSQL staging and qualified third-party accounts.
