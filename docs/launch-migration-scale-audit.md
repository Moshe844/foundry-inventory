# Launch audit — migration and scale

Date: 2026-09-14

This audit treats named products and record counts as examples, not as a vendor
allow-list or a hard-coded size tier. The standard is one canonical Foundry
domain that accepts small and large businesses through the same contracts.

## Executive result before remediation

Foundry has a strong inventory core and a real evidence-first opening-stock
migration. It does **not** yet meet the stated launch gate for a full switch
from an established inventory/ERP system, nor has it proved operation at
250,000 active SKUs and millions of movements.

The existing migration safely handles catalogue, variants, locations, opening
quantities, selling price, unit cost, barcodes, lots, serials and expiry dates.
It does not migrate the rest of the operating position as one reconciled
cutover: suppliers and supplier-item terms, customers, open purchase orders,
open sales orders/allocations, reorder rules, or evidenced history. The current
reconciliation proves products, locations and units, but not those other
record families.

The existing runtime is tenant-scoped and indexed around its central ledgers,
but several whole-workspace scans, N+1 signal queries, fixed scan limits, an
in-memory importer and a single-process SQLite write boundary prevent an honest
enterprise-scale certification.

## Post-remediation result

The repository-level gaps identified above are now implemented behind one
provider-neutral contract. This is not a list of named ERP vendors and there is
no runtime branch for a catalogue size. A file reader or provider connector
translates its source records into the same typed package; Foundry validates,
orders, applies and reconciles that package through its own domain services.

### Already supported after remediation

- Typed staged packages now cover locations, products, exact SKU pages,
  suppliers, customers, supplier-item terms, selling price, purchase cost,
  reorder policy, open purchase orders, open sales orders, inventory positions,
  lots, serials and evidence-only history facts.
- Source records are content-hashed and replay-safe. External identities are
  durable and scoped by workspace plus source namespace. Unknown references,
  conflicting identities, negative positions and serial-count mismatches block
  before operational mutation.
- Apply is bounded and resumable. Every mutation goes through the owning
  location, catalogue, inventory, purchasing, sales or pricing service; a
  connector cannot write balances or accounting totals.
- Reconciliation rereads live targets and immutable movements. It compares
  record families, SKU identities, physical units, lot/serial identities,
  purchase-order units and incoming units, and sales-order/open-demand units.
  An unknown manifest total is marked `UNKNOWN` and blocks cutover rather than
  being guessed.
- An owner-visible cutover progresses through stage, validate, approve, apply,
  reconcile and activate. A scoped API may stage and validate evidence but has
  no approve/apply/activate endpoint.
- The owner can now start that canonical cutover directly in the browser at
  `Move to Foundry`: upload or paste immutable exports, review each real sheet,
  confirm uncertain meanings once, stage the exact stored bytes, and continue
  to validation. No connector-created package, developer fixture or command
  line is required for file-based switching.
- A normal combined catalogue/stock export expands deterministically into
  products, SKUs, locations, positions, selling prices, purchase costs,
  suppliers and supplier-item relationships. It never invents a missing SKU
  or location. Other record families use the same per-dataset mapping contract.
- Ordinary row-per-line open purchase-order and sales-order exports now use
  that browser mapping contract too. Repeated order numbers become one document
  with exact lines; source order numbers, counterparties, destinations, dates,
  prices and supported open states are retained and reconciled.
- Upload capacity is deployment policy rather than a product tier. The shipped
  default is 500 files / 512 MiB and can be changed through environment policy
  without a code change. Overflow is rejected explicitly and never truncated.
- Unfamiliar tabular sources now use a provider-neutral mapping profile. Exact
  canonical names are deterministic, generic inventory aliases are proposals,
  and every unknown column must be mapped or explicitly ignored by an owner.
  Approved mappings are reusable for every bounded page in that source dataset.
- Live sources now carry an immutable starting cursor, ordered source changes
  and an owner-confirmed final frozen cursor. Validation and activation are
  impossible until that checkpoint chain is complete. Immutable exports remain
  simple static snapshots and do not inherit unnecessary live-system steps.
- Exact imports can add arbitrary supplied option axes and up to 5,000 exact
  variants per page, with no limit on the number of pages. The 200-variant,
  three-axis guard remains only on the manual Cartesian-product form where it
  prevents an accidental explosion.
- Catalog attributes and deterministic `all` / `any` / `none` selectors let
  authority and operating policies cover categories, suppliers, locations and
  other source attributes without one rule per SKU.
- Manager coverage uses a durable rotating cursor. Set-based evidence decides
  which observed SKUs require full demand/cash/supplier analysis; uneventful
  receipt-only stock is not converted into thousands of identical cold-start
  plans.
- Exact SKU/order lookup is indexed, catalog listing has a compatible keyset
  cursor, and an FTS-backed search contract indexes product names, variants,
  barcodes, supplier SKUs and arbitrary catalog attributes. Signal aggregation
  is set-based, and order-number allocation no longer reads every prior order.

### Verified scale

`node scripts/certify-launch-scale.js` completed against the same local domain
with **250,000 SKUs, 12 locations and 1,000,001 immutable movements**:

| Path | Measured |
| --- | ---: |
| Exact lookup of the last SKU | 29.4 ms |
| Indexed human-language discovery of the last SKU | 60.6 ms |
| 50-row catalog page with a 250,000-variant product | 937.0 ms |
| Set-based signals for 400 SKUs | 149.9 ms |
| First rotating 400-SKU manager coverage batch | 472.3 ms |
| Next rotating batch (proves cursor advances) | 464.9 ms |
| Canonical inventory write after one million movements | 1.3 ms |

Three real-browser cutover tests completed without page errors. The static path
completed stage → validate → approve → apply → reconcile → activate and showed
`Source 15 / Foundry 15`. The live custom-source path reviewed an unfamiliar
mapping, captured a changed source record, froze the final cursor, reconciled
that cursor and activated. The owner path began at the browser’s `Move to
Foundry` screen, uploaded catalogue, open-PO and open-sales-order CSVs together,
confirmed proposed meanings, and proved stock, selling price, purchase cost,
supplier and exact open-order truth after activation.

### Partially supported after remediation

- Existing spreadsheet onboarding remains a compatible reader for in-flight
  sessions, while new file switches enter the canonical owner workspace. A
  previously unseen proprietary source is profiled and its field meanings are
  reviewed through the same mapping contract. Flat order documents are grouped
  in-product; genuinely hierarchical source formats use the same canonical
  structured contract. Unsupported lifecycle states stop with their real state
  intact rather than being silently downgraded.
- Historical facts can be retained exactly as evidence, but Foundry does not
  turn an unprovable old snapshot into invented movements, allocations or
  accounting postings.
- The local certification proves application/query behavior on SQLite. It does
  not certify multi-node write throughput, deployed replicas, failover or a
  production search service.

### Missing external launch evidence

These are launch gates, not reasons to hard-code a vendor or product tier:

1. A production connector or approved mapping for each actual source the first
   launch customers use. The reusable mapping and freeze/delta machinery now
   exists, but its source-specific evidence must still be exercised during the
   real customer's cutover.
2. A shared production relational deployment and the Mission 4 concurrency,
   failover, backup/restore and soak evidence on that deployment.
3. The production relational/search implementation must rerun the same 250k
   catalog gate. The local FTS implementation is certified; that measurement is
   not automatically evidence for a different deployed database engine.

## Universal complexity and automation boundary

There is no honest finite allow-list of inventory shapes that can promise every
future business is already modelled. Foundry therefore uses one canonical core
plus exact variants, arbitrary attributes, explicit units/conversions,
locations, lots/serials, policies and provider adapters. A genuinely new fact
or lifecycle is registered as a typed extension; it is never squeezed into the
nearest existing field or maintained as a customer-specific fork.

The 90–95% automation target is measured over eligible routine operations:
completed, verified operations divided by all operations Foundry had sufficient
evidence and authority to handle. Physical work, statutory approvals and facts
that only a human can know stay explicit. They are not hidden from the metric,
and the model cannot manufacture them to improve the percentage.

Accordingly, the canonical migration and local scale architecture now pass;
an untested arbitrary source and an undeployed database do **not** receive a
blanket “production launch certified” claim.

## Already supported

| Area | Evidence | Classification |
| --- | --- | --- |
| Canonical products, arbitrary SKU rows, locations and immutable movements | `src/db/schema.sql`; all stock mutation uses `src/domain/inventory-engine.js` | Production-quality domain invariants |
| Quantity, lot and serial tracking | `balances`, `lots`, `lot_balances`, `serial_units`; integrity verification in the inventory engine | Production-quality for supported workflows |
| Variants as normalized option axes/values | `item_options`, `skus`, `sku_option_values` | Sound relational model |
| Suppliers, supplier SKUs, pack/UOM, MOQ, multiples, lead time and cost | `src/db/schema-purchasing.sql`; `src/purchasing/supplier-service.js` | Production-quality domain services |
| Purchase and sales order lifecycles | `src/purchasing/po-service.js`; `src/sales/sales-order-service.js` | Implemented domain services |
| Staged opening-stock migration | Source hashes, immutable stored bytes, consolidation plan, explicit conflict decisions, approval, idempotent execution and post-run reconciliation in `src/onboarding/*` and `src/imports/*` | Trustworthy for its current narrow scope |
| Duplicate/retry protection | Unique execution keys and per-row status in `schema-imports.sql`; domain idempotency throughout orders/events | Supported |
| Tenant isolation | `workspace_id` on domain tables and workspace-scoped service queries | Supported and tested |
| Basic list pagination | Inventory and activity pages paginate | Supported for small/medium data |
| Durable jobs/outbox/inbox | `src/operations/*` | Supported on the current database architecture |
| Bounded autonomous authority | Versioned policies and deterministic evaluation | Supported for registered operations |

## Partially supported

| Area | What exists | What is incomplete |
| --- | --- | --- |
| Migration source understanding | Deterministic column mapping and workbook parsing | Only the primary sheet is migrated; important operational datasets are recognized but not applied |
| Migration reconciliation | Independently re-counts products, locations and on-hand units | Does not reconcile SKU identity coverage, suppliers, customers, open POs/SOs, incoming/committed units, costs, prices, rules, lots/serials by identity, or history totals |
| Historical migration | Event feed accepts timestamped operating events | First-sync cap is 500 and there is no staged snapshot-plus-delta cutover/checkpoint contract |
| Search | Searches products, SKUs, locations, suppliers, orders, customers, lots and serials | Uses leading-wildcard `LIKE` and correlated totals, so it is not scale-certified |
| Forecasting/manager | Event-scoped re-evaluation exists | Periodic planning scans only 400 SKUs and does not persist a rotating coverage cursor |
| Policies | Can scope by explicit item, location and supplier IDs | No reusable category/tag/attribute selector; large customers would enumerate IDs |
| Import resumption | Per-row status makes retries idempotent | Analysis and execution load whole files/pending rows into memory and execute in the web request |
| Database indexes | Core ledger/order indexes exist | Several workspace + active + sort/search access paths are missing; list endpoints use offset pagination |

## Missing

- One canonical, typed migration package covering every supported operational
  record family with dependency ordering and domain-owned adapters.
- A cutover lifecycle: snapshot time, source checkpoint, delta catch-up,
  read-only/freeze boundary, final reconciliation and explicit activation.
- External identity/version maps for all migrated entities, not only connected
  provider records.
- Field-level and identity-level reconciliation for suppliers, customers,
  open orders, prices/costs, policies, lots, serials and history.
- Generic item attributes/categories/tags and reusable policy selectors.
- A complete 250,000-SKU/million-movement certification harness with budgets
  for imports, search, APIs, ledgers, orders, purchasing, planning and manager
  coverage.
- A shared relational production database. SQLite serializes writers and is a
  single-node deployment boundary; it cannot be the final multi-node launch
  architecture regardless of local benchmark results.

## Scale bottlenecks

1. `src/domain/item-service.js` caps a product at 200 variants and three axes.
2. `src/forecasting/planning-service.js` scans at most 400 active SKUs per run.
3. `src/signals/signal-engine.js` runs balance and movement aggregates per SKU
   and per location (N+1 query growth).
4. `src/domain/search-service.js` uses `%term%` scans and correlated subqueries.
5. `src/imports/executor.js` loads every pending row and groups the entire import
   in memory; onboarding additionally reads sources repeatedly.
6. `src/web/multipart.js` still buffers each browser request in the web process.
   Its capacity is now deployment-configured (500 files / 512 MiB by default),
   not a product limit, but object-storage/direct-upload streaming remains the
   preferred production architecture for multi-gigabyte source snapshots.
7. `src/onboarding/consolidation-service.js` compares similar product names in
   a pairwise loop, which is quadratic in product count.
8. Several number generators read every order number to find the next value.
9. Offset pagination grows more expensive and can shift under concurrent writes.
10. The current synthetic harness caps itself at 3,000 SKUs, so existing green
    tests are not evidence for enterprise scale.

## Migration gaps

The current `src/imports/fields.js` explicitly excludes suppliers, categories,
reorder settings, sales/order history and weights. That is honest for an
opening-stock importer but insufficient for a system switch. The onboarding
profile can label supplier and purchasing files, yet `migration-service.js`
passes them through the catalogue/opening-stock importer. Only the primary
sheet of a workbook participates. A completed run can therefore say the stock
count matches while leaving live commitments, suppliers or policies behind.

## Must be fixed before launch

P0 launch blockers:

1. Add an extensible canonical migration contract whose entity adapters call
   Foundry domain services, never write balances or accounting totals directly.
2. Stage and validate all datasets before mutation; block unresolved identity,
   quantity, lot/serial, document-state and money conflicts.
3. Reconcile every migrated record family and refuse cutover while a material
   measured check differs or remains unmeasured.
4. Add snapshot/delta checkpoints and an explicit activation gate.
5. Remove product-shape caps from exact/provider imports while retaining a
   safety limit on manual Cartesian generation.
6. Add attributes and group policy selectors with deterministic membership.
7. Replace fixed first-N manager scans with checkpointed partition coverage and
   batch the signal aggregates.
8. Add indexed search/read paths and keyset pagination for large catalogues and
   ledgers.
9. Move large ingestion to durable background batches with bounded memory.
10. Add and run a realistic scale certification. A local SQLite pass may prove
    query/application behavior, but final launch still requires the Mission 4
    shared-database, deployment, soak and failure gates.

## Remediation rule

No vendor names or catalogue sizes belong in runtime branching. Provider
adapters translate exports/API pages into the canonical migration contract;
the contract, validators, dependency graph, reconciliation and cutover state
are shared by every source and every business size.
