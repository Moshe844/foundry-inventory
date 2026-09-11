# Mission 5 — Warehouse Intelligence

## What is implemented

Foundry has one warehouse execution layer around the canonical inventory
engine. It does not maintain a competing stock ledger.

- Locations form a validated hierarchy: warehouse/store → zone → aisle →
  shelf → bin, with docks and staging areas supported at any appropriate level.
- Existing locations and balances migrate unchanged. No bin or stock movement
  is generated during migration.
- SKU, location, lot, serial and container barcodes resolve deterministically.
  Existing external codes can be registered as aliases. Unknown or ambiguous
  codes fail closed; AI is not involved in scanned identity.
- Durable receiving, putaway, pick, count and transfer tasks retain line-level
  progress, scan evidence, pause/resume state and completion state.
- Each client scan has a workspace-scoped idempotency key. Replaying a queued
  offline scan returns its original result and cannot repeat the movement.
- Quantity, lot and serial rules are validated before a movement. Serial units
  must be scanned individually. A lot count must name the exact lot.
- Accepted RECEIVE scans use `inventory-engine.receive`; accepted PUTAWAY,
  PICK and TRANSFER scans use `inventory-engine.transfer`; completed quantity
  counts use `inventory-engine.adjust` with the physical-count reason.
- Totes, cartons, pallets and packages retain their exact scanned contents and
  current location.
- Putaway rules may select a stored destination. Without a matching rule,
  Foundry asks for a destination rather than inventing one.
- Product, location, lot, serial and container labels render printable Code 128
  SVG and verify the encoded value before display.
- The warehouse task page is mobile-first and uses large, ordered scan fields.

## Important invariants

1. A task, line, identity and location must belong to the same workspace.
2. A rejected scan records evidence but cannot change stock.
3. A duplicate client scan id cannot create a second event or movement.
4. A transfer scan produces the canonical paired movement legs.
5. A task completes only after all planned non-count quantities are processed.
6. Counts complete only after their physical result is posted and verified.
7. Scan events are immutable in the database.
8. A location cannot become its own ancestor, and a location with active
   children cannot be archived.

## Where to use it

- **Warehouse work:** `/warehouse`
- **Physical layout:** `/locations`
- **Printable SKU label:** each product/variant row links to its label
- **Containers, putaway rules and barcode aliases:** progressive sections on
  the Warehouse page

## Browser acceptance run

Run only the Mission 5 browser test:

```powershell
node -r .\tests\helpers\test-models.js --test tests\e2e\warehouse.e2e.js
```

The test uses a real Chromium page at a phone viewport. It creates a task from
the visible UI, rejects the wrong location, accepts one scan, replays that scan,
pauses, restarts the server/database, resumes, completes the remaining work,
prints the label, then independently reconciles both balances and movement
legs. Screenshots are written to `artifacts/screenshots/warehouse`.

Focused deterministic coverage:

```powershell
node --test tests\unit\mission5-warehouse.test.js
node --test tests\integration\mission5-warehouse-http.test.js
```

The full browser certification includes the Mission 5 browser file through
`npm run certify:browser`.
