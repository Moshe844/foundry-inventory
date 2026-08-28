# Foundry Events API

Foundry's reference connector accepts authenticated, workspace-scoped evidence
from external systems. Provider payloads must be translated to this normalized
contract before they are sent. Foundry then uses its existing inventory and
Sales Order services; this API never writes a balance directly.

## Authentication

Create a **Custom business system** connection under **Settings →
Connections**. Copy the token when it is shown and send it as:

```http
Authorization: Bearer fnd_live_...
Content-Type: application/json
```

`POST /api/v1/events` accepts one event or `{ "events": [...] }` with at most
500 events. `eventId` is the provider's immutable idempotency key within that
connection. Repeating it cannot repeat the Foundry action. A replay with
different content is flagged and the first completed action remains
authoritative.

`GET /api/v1/events/schema` returns the current machine-readable contract when
called with the same connection token.

## Common envelope

```json
{
  "eventId": "evt_123",
  "type": "sale.completed",
  "version": "4",
  "aggregateId": "order_88",
  "occurredAt": "2026-08-27T14:30:00Z",
  "data": {}
}
```

- `version` and `aggregateId` allow deterministic stale-event protection.
- Preserve the provider's event and occurrence timestamps.
- Use external identifiers after their mappings are approved. An exact Foundry
  SKU code or location name can establish a high-certainty mapping once.
- Unknown records return `NEEDS_MAPPING`, appear in **Needs You**, and can be
  retried safely after mapping.

## Examples

Sale:

```json
{
  "eventId": "sale_10482_line_1",
  "type": "sale.completed",
  "occurredAt": "2026-08-27T14:30:00Z",
  "data": {
    "externalSku": "12345",
    "skuCode": "TS-BLK-S",
    "externalLocationId": "store_12",
    "locationName": "Downtown Store",
    "quantity": 3
  }
}
```

Customer order:

```json
{
  "eventId": "order_88_created",
  "type": "sales_order.created",
  "aggregateId": "order_88",
  "version": 1,
  "data": {
    "externalOrderId": "order_88",
    "customer": { "externalId": "customer_4", "name": "ABC School" },
    "fulfillmentLocationName": "Downtown Store",
    "lines": [{ "externalSku": "12345", "quantity": 10 }]
  }
}
```

Absolute order updates use `sales_order.snapshot`; incremental additions use
`sales_order.changed`. Fulfillment and cancellation use
`sales_order.fulfilled` and `sales_order.cancelled`, with the same
`externalOrderId`. Receipt, confirmed physical return, financial-return
evidence, adjustment and transfer types are `inventory.receipt`,
`return.completed`, `return.reported`, `inventory.adjustment` and
`inventory.transfer`. Catalog notifications use `product.changed` and
`location.changed`.

Reconciliation evidence:

```json
{
  "eventId": "reconciliation_2026-08-27",
  "type": "reconciliation.summary",
  "data": {
    "periodStart": "2026-08-27T00:00:00Z",
    "periodEnd": "2026-08-28T00:00:00Z",
    "expected": { "sale.completed": 24 }
  }
}
```

Foundry reports discrepancies but does not overwrite stock.

## Supplier email foundation

Create a **Supplier email foundation** connection, configure allowed sender
addresses or `@domain` rules, then send provider notifications to
`POST /api/v1/email/messages` with that connection's token.

```json
{
  "messageId": "provider-message-id",
  "sender": "orders@supplier.example",
  "recipients": ["receiving@example.com"],
  "subject": "Invoice 884",
  "bodyText": "...",
  "receivedAt": "2026-08-27T14:30:00Z",
  "attachments": [{
    "id": "attachment-1",
    "filename": "invoice-884.pdf",
    "mimeType": "application/pdf",
    "contentBase64": "..."
  }]
}
```

Messages are deduplicated by provider message ID. Allowed senders become
trusted evidence; other messages are retained as untrusted and surfaced for
review. Invoice and delivery-document classification never changes inventory
in Mission 11.
