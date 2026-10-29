# Private StockChief platform owner console

The private console uses its own host, layout, sign-in flow and host-only cookie. It does not use customer inventory selection or subscription middleware. The account identity store, PostgreSQL database, support messages, commercial audit and Stripe billing engines remain shared authorities.

## Deployment boundary

- Set `STOCKCHIEF_OWNER_ORIGIN` to the exact HTTPS console origin on the web service.
- Only the exact incoming Host is dispatched to the owner application. Forwarded-host values do not select it.
- Customer hosts return 404 for every `/commercial-admin` route, including POST routes.
- `qualify.stockchiefhq.com` remains Staging. `app.stockchiefhq.com` is the intended customer production host; changing its destination requires the separate production release.
- During Staging verification the console must show its Staging environment banner. Do not represent Staging data as production customers.

## Identity and MFA

Only explicit platform roles are accepted. Existing commercial administrators are migrated additively. A developer/test role alone does not become a console role. An authorized owner without a workspace or active customer plan can sign in directly to the console.

The password is verified against the existing account identity store. MFA enrollment follows password verification and never grants access until a TOTP code is confirmed. Authenticator secrets are AES-GCM encrypted using the existing configured encryption key; no secrets appear in audit events. Challenges expire after five minutes and five attempts. Accepted time steps cannot be reused. Sessions have a 30-minute idle limit and eight-hour absolute lifetime. Password changes and role revocation invalidate existing sessions. Sensitive commercial changes require a sign-in from the last 15 minutes.

The human owner must complete authenticator enrollment themselves. Never seed an authenticator, recovery bypass or customer cookie for the real owner. Recovery is an offline identity-verification and audited operator procedure; password-only MFA removal is intentionally unavailable.

## Support and customer consent

Customer Help always opens their own chat. The private Support Inbox uses the same `support_requests`, `support_messages`, staff profiles, presence and notification jobs. Replies are human messages, not AI output.

Business inspection requires an exact customer-owner-approved grant for the operator, workspace, requested areas and 5–60-minute duration. Scope and expiration are checked inside the same read-only PostgreSQL snapshot as the business reads. Approval, revocation, reads and operator replies are recorded in the existing commercial audit. Repeated access-request submissions use one idempotency key. Provider secrets and raw job payloads never appear in list/inspection projections.

Inventory, order, purchasing and Money inspection is read-only. Business changes remain in existing customer workflows with their normal financial/stock approvals. The owner never signs in using a customer's credentials.

## Public product truth

## Company operations

Customers are account identities; Users lists each person once with their business memberships. Customer workspaces join the existing subscription, usage, connection and support records by their authoritative identifiers, but display names, email addresses, business names, money and local dates. Connection status uses the same health calculation as the customer application. Recorded revenue and cost totals describe their coverage rather than claiming reconciled provider invoices.

An owner can disable access, restore access or end an account's current sessions. Each action requires fresh MFA, the exact target email, a reason and confirmation. An account access revision invalidates previously saved sessions even if an in-flight request writes an old session back. Disabled owners cannot start new business work; existing billing is not silently cancelled. The owner's own identity and active operator identities are protected.

Permanent removal uses the existing account-removal review, queue and tenant purge engine. It requires disabled access, a fresh review, the owner's password, exact email and explicit irreversible confirmation. Active subscriptions, other-owner memberships, active/uncertain work and protected spending records remain blockers. Deletion is audited and does not substitute for cancelling billing. Tests execute destructive cases only in disposable databases, including email reuse and preservation of other customers.

Read-only support permission can be requested from the business page without inventing a support conversation. The customer must still approve the exact areas and duration before records become visible.

## Reference public experience

`scripts/capture-product-truth.js --video` creates a fresh disposable PostgreSQL demo through canonical stock, pricing and purchasing engines, records actual Chromium pages and removes the fixture when finished. The controlled scenario is independent of any customer upload, item name or account. The recording explicitly excludes real merchant, carrier and mailbox certification, and uses a deterministic test classifier for its database-backed Ask answer.

The public experience follows the supplied local design's hero cards, capability grid, recording timeline, connections orbit, control and switching sections. The design's illustrative orders, prices, event counts and tolerances are not copied as product evidence. Cards and chapter controls open matching points in the actual recording. The import preview is prepared without importing any stock. Motion respects reduced-motion preferences. Native signup, selected plans and billing rules remain authoritative.

The public website consumes the existing plan/entitlement catalogue and real add-on pack catalogue. No subscription price, business accounting amount, paid-model allowance or checkout release is changed by this work.

## Verification

Run the required `test:customer-navigation` gate. Additional cases cover separate cookies, mandatory/replay-resistant MFA, customer denial, role revocation, customer-chat → private inbox → human reply, access idempotency/expiry/revocation, canonical quantities, all inspection views, exhausted-credit recovery, catalogue pack IDs and desktop/phone public pages. Fixtures send no external mail or paid model calls. Local/simulated billing tests must be distinguished from real Stripe payment acceptance.
