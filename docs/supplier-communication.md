# Supplier communication

Mission 12 keeps supplier communication inside the operation: **Connections**, each **Supplier**, each **Purchase order**, **Home / Needs You**, and **Activity**. It does not add an inbox or a separate email-management module.

## Deployment setup

Configure either or both OAuth providers:

```text
FOUNDRY_PUBLIC_URL=https://foundry.example.com

GMAIL_CLIENT_ID=<Google OAuth client ID>
GMAIL_CLIENT_SECRET=<Google OAuth client secret>

MICROSOFT365_CLIENT_ID=<Microsoft Entra application ID>
MICROSOFT365_CLIENT_SECRET=<Microsoft Entra client secret>
MICROSOFT365_TENANT=common
```

Register these OAuth redirects:

- Gmail: `https://foundry.example.com/settings/connections/gmail/callback`
- Microsoft 365: `https://foundry.example.com/settings/connections/microsoft365/callback`

Gmail uses safe scheduled polling by default. For push delivery, create a Google Cloud Pub/Sub topic and an authenticated push subscription whose endpoint is:

```text
https://foundry.example.com/api/v1/connections/gmail/webhooks?token=<long-random-secret>
```

Then set:

```text
GMAIL_PUBSUB_TOPIC=projects/<project>/topics/<topic>
GMAIL_PUBSUB_VERIFICATION_TOKEN=<the-same-long-random-secret>
```

Grant Gmail permission to publish to the topic as required by Gmail's `watch` API. Without both push settings, Foundry deliberately stays on polling.

Microsoft 365 creates a Microsoft Graph inbox subscription after OAuth. Its notification callback is:

```text
https://foundry.example.com/api/v1/connections/microsoft365/webhooks/<connection-id>
```

Foundry validates Graph's subscription `clientState` before reading the mailbox. Expired subscriptions and provider failures become connection issues; scheduled polling remains the recovery path.

Foundry renews Gmail watches and Microsoft Graph subscriptions automatically before they expire. Renewal failures are visible connection issues while the scheduled mailbox check continues as a safe fallback.

## Business setup

1. Connect Gmail or Microsoft 365 under **Settings → Connections → Supplier communication**.
2. Open a supplier and choose the watched mailbox.
3. Add only trusted sender addresses or domains for that supplier.
4. Choose whether Foundry may prepare messages, whether it may send routine messages, and the price, quantity, and spend limits.
5. Review the supplier's purchase-order timeline and resolve only exceptions in **Needs You**.

Users can set the same supplier rules through **Tell Foundry**. Authority-changing language creates the same reviewable configuration used by the supplier settings page.

## Safety model

- Unknown senders are stored as mailbox evidence but do not affect purchasing or inventory.
- Email and attachment text is untrusted evidence. It cannot change authority, security, or unrelated records.
- AI extraction proposes document facts only. Deterministic supplier, PO, SKU, price, quantity, and tolerance checks decide what may be recorded.
- Invoices can update cost evidence and price history but never receive physical stock.
- Shipment notices update incoming expectations and dates, not on-hand balances.
- Delivery claims require physical receiving confirmation unless a separately audited advanced receiving policy authorizes a trusted source.
- Provider message IDs, document identities, and content hashes prevent duplicate PO updates and movements.
- Paused Foundry never sends supplier messages automatically or manually through the supplier agent.
