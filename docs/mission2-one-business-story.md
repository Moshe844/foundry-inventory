# Mission 2 — One Business Story

StockChief records business provenance as immutable, workspace-scoped relations between existing domain records. The relation graph supplements domain records; it does not replace their operational or accounting truth.

## Contract

- Every relation has a typed `from` record, typed `to` record, relation type, evidence basis, creation time, and optional domain event.
- Both endpoints must already exist in the same workspace.
- Relations are idempotent and cannot be updated or deleted.
- New write paths record relations in the same database transaction whenever possible.
- Historical backfill uses exact persisted identifiers and foreign keys only. Similar names, amounts, dates, or SKUs are never treated as proof.
- Graph reads apply workspace isolation and the current user's accounting permission.

## Owner experience

Purchase and customer-order stories remain concise by default. **See how this purchase is connected** and **See how this order is connected** expose the supporting records and links. Ask StockChief uses the same persisted graph for “Why?” answers and says when no linked cause or outcome is known.

## Covered lifecycle paths

- Replenishment evidence / customer demand → work item or decision → purchase order
- Purchase order → lines → receipt → received lines → inventory movements
- Purchase order or receipt → supplier bill → supplier payment → journal entry
- Customer order → lines → fulfillment events → inventory movements
- Customer order → customer invoice → customer payment → journal entry
- Fulfillment evidence → revenue, receivable, inventory value reduction, and exact product cost
- Action proposal → approval/attention → execution → verification

## Extension rule

New important record types and relationships must be declared in the provenance registry and emitted from their authoritative write path. Do not infer missing history from descriptive similarity; leave it unknown until supported by an exact record or document.
