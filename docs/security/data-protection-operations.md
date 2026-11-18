# Keeper Inventory LLC data protection operations

Effective 2026-11-18, version 1.0. Adopted under the operator's instruction to
implement and publish the five remaining controls. Owner: the company operator,
contactable at support@stockchiefhq.com. Public policy: `/security/data-protection`.
This is an operating policy, not a representation that a draft standalone DPA
was signed or that an independent audit or production recovery exercise occurred.

## Weekly review

Use the production admin console with MFA and the existing restricted operator
database tooling. Do not publish customer data or secrets in GitHub or CI.

1. Check `runtime_checkpoints` key `security.retention`. Its PASS time must be
   within 48 hours; investigate stale, missing or failed daily jobs rather than
   treating the presence of a schedule as execution evidence. Inspect cleanup
   counts and repeated deferred connector evidence.
2. Review unfinished `shopify_privacy_work` joined to its request: due dates,
   unfinished exports, unresolved shared records and expired `hold_until` dates.
   Resolve through the inventory owner's Settings → Privacy; never bypass the
   verified-subject, workspace or legal-hold protections with ad hoc SQL deletion.
3. Review the last week's `stockchief_runtime.data_access_events`, grouped by
   workspace, account, actor, channel and category, and the separate commercial
   support-inspection audit. Investigate unexpected exports, unfamiliar accounts,
   repeated denied access and private-link activity. An access event records an
   access attempt, not proof of successful delivery. `ACCESS` denotes a scoped
   service or API credential access, not an HTTP verb. Host/database operator
   access is reviewed in the hosting provider's own audit facilities.
4. Revoke expired or unnecessary support, staff, API and provider authority using
   the existing controls. Review incident intake and outstanding corrective work.
5. Record UTC review time, scope, evidence references, findings and next actions
   in the restricted operations review record. Store only opaque identifiers and
   counts in `runtime_checkpoints` key `security.operator-review`; do not put
   names, message contents, credentials or incident evidence in that checkpoint.

Inventory owners can see their latest 100 access events and record a review at
`/settings/privacy/access`. Access logging must be awaited before app/API/private
link data disclosure. A logging error must not be suppressed to serve the data.
Provider webhook ingestion and billing callbacks keep their independent existing
authentication and evidence paths; do not make them depend on customer sessions.

## Retention and verified deletion

Apply the public schedule. Cleanup is bounded and may need multiple daily runs.
Keep financial history and idempotency receipts; erase covered personal fields
through the privacy service. Review legal and unresolved-work exceptions weekly,
record their purpose and next review date, and end the exception when no longer
needed. A hold is not indefinite permission to retain unrelated personal data.

Quarterly, identify accounts with no activity for 12 months and contact the owner
to agree export, deletion or a documented continued need. Do not automatically
delete active inventories or cancel a paid subscription. Resolve non-Shopify
privacy/offboarding requests within 30 days after verification, subject to a
documented lawful exception. Review the retention schedule annually.

Maintain a restricted deletion/revocation register outside the live database
recovery set for completed erasures and revocations. Record opaque subject hashes,
inventory identifiers, completion time and affected systems, not erased content.
If a restore is needed, keep provider workers paused until changes since the
restore point are reconciled against this register and provider revocation and
deletion evidence. Never reconnect a revoked provider simply because its old
credential exists in the recovered database. No restore is authorized by this
procedure alone: prepare the recovery target and verify impact before execution.

## Manual processing request

Verify the person and merchant without collecting unnecessary identity documents.
The inventory owner opens Customers → the customer → Customer privacy · Credit
decisions and selects manual review. Saving explicitly releases only rule-created
holds and stops future automatic holds/releases for that customer. Review open
orders immediately. Person-created holds, deposits and agreed payment terms are
separate human decisions; review and communicate them to the customer. Record
the customer's position, review outcome and any required follow-up privately.
Never charge for the privacy choice or change the plan to honor it.

## Incident runbook

Follow the public response policy. The company operator is incident lead; there
is no fictitious backup responder or guaranteed 24/7 coverage. Engage qualified
external assistance when needed and grant only the access required.

Create a restricted incident record and UTC timeline. Mark suspected exposure or
active compromise urgent, preserve logs privately before expiry, revoke affected
authority and pause affected external work. Do not post raw data or secrets in
the repository. Preserve financial/provider evidence without creating a charge,
refund, shipment or deletion to test a hypothesis.

Notify affected merchants without undue delay. For actual or suspected compromise
of Shopify merchant data, notify Shopify immediately and within 24 hours of
awareness through its required Partner support channel; follow its security
incident response guidance as well. Check current contractual and applicable
legal deadlines, with qualified assistance as needed; document decisions and
initial/follow-up notices. This policy does not authorize an agent to send
external incident messages without the operator's instruction.

Before reopening affected functions, verify patch/recovery integrity, access,
post-recovery deletion/revocation replay and original-provider effect evidence.
Record the incident outcome and corrective actions. Keep minimized restricted
incident evidence 12 months after closure or a documented longer obligation.
Exercise the runbook annually; distinguish tabletop work, isolated database
recovery tests and an actual production restore in every report.

Sources checked 2026-11-18:
- https://shopify.dev/docs/apps/launch/protected-customer-data
- https://www.shopify.com/legal/api-terms
- https://shopify.dev/docs/apps/build/security/monitoring-and-response/respond-to-a-security-incident
- https://render.com/docs/postgresql-creating-connecting
- https://render.com/docs/postgresql-backups
