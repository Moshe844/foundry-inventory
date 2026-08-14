# Foundry Inventory

One inventory platform with flexible inventory primitives. The same engine
represents four fundamentally different kinds of inventory — quantity,
variants, individually serialized units, and lots/batches — plus the
combinations of them, without a second application and without generating a
codebase per customer.

One account can hold several completely separate inventories — a clothing
business, an equipment company, a school's stockroom — each with its own items,
locations, history, Foundry configuration and attention items. An **inventory
workspace is not a location**: one workspace contains many.

It is built in three layers, and each one only ever reads the layer below:

1. **The truth engine.** Receive, issue, transfer and adjust, with every
   invariant enforced centrally and an immutable movement ledger behind every
   number. No AI anywhere near it.
2. **The architect.** A business owner describes their operation in ordinary
   language; Foundry works out what they are tracking and configures the engine
   above. The model proposes; the engine decides what is legal.
3. **The operator.** Foundry watches the movement history and answers "what
   needs my attention right now, and why?" — with the evidence attached.
4. **The hands.** Foundry can carry out inventory work, but only work a person
   has seen and approved, and only through the engine in layer 1. It is never
   autonomous: nothing moves stock without an explicit approval.

## Running it

```bash
npm install
npm start
```

Then open <http://localhost:4000> and create an account. Signing up creates
your first inventory; add more from the switcher at any time.

To click around a realistic dataset covering every archetype, with two months
of trading history so the operator has something real to reason about:

```bash
npm run seed:demo
```

That signs you in as `dana@northwind.test` / `foundry-demo-1`. The fixtures live
in `fixtures/` and go through the same public services the UI uses — no
privileged path into the database, and no example-specific logic in `src/`.

To try bringing data in, `npm run seed:samples` writes two deliberately untidy
files to `samples/`. Upload either at **Bring data in**; nothing is created
until you approve what Foundry shows you.

| Command | What it does |
| --- | --- |
| `npm start` | Runs the app on `PORT` (default 4000) |
| `npm test` | Unit and integration tests (`node --test`) |
| `npm run test:live` | The tests that call a real model (skipped without a key) |
| `npm run test:e2e` | Full browser runs in Chromium, each from an empty database |
| `npm run test:all` | All three |
| `npm run seed:demo` | Adds the demo inventory |
| `npm run seed:foundry` | Adds an inventory configured by a real Foundry run |
| `npm run seed:samples` | Writes messy sample spreadsheets to `samples/` to import |
| `npm run db:reset` | Deletes the local database |

Configuration is environment variables: `PORT`, `DATABASE_PATH`,
`FOUNDRY_DATA_DIR`, `SESSION_SECRET`, `NODE_ENV`, plus `ANTHROPIC_API_KEY` and
`FOUNDRY_AI_PROVIDER` for the layers that use a model. A local `.env` is read at
startup and is gitignored.

### Model tiers

Foundry asks a model eight different questions, and they are not the same size
of question. Each call site names the *thinking it needs* rather than a model,
so which model serves a tier is a deployment decision:

| Tier | Used for | Default |
| --- | --- | --- |
| `deep` | Reading a business description and designing its inventory model | `claude-opus-5`, high effort |
| `standard` | Reading instructions and questions, the Foundry assistant | `claude-sonnet-5`, medium effort |
| `fast` | Column mapping, briefs, rewording findings | `claude-haiku-4-5`, no extended thinking |

Override any of them with `FOUNDRY_AI_MODEL_DEEP`, `FOUNDRY_AI_MODEL_STANDARD`,
`FOUNDRY_AI_MODEL_FAST` and the matching `FOUNDRY_AI_EFFORT_*` variables. Setting
effort to `none` turns extended thinking off for that tier.

The tiers were assigned by measurement, not by guessing: `npm run test:live`
exercises every model path against real records, so moving a call site down a
tier and re-running it is how you find out whether the cheaper model can
actually do that job. Two call sites — reading an instruction and planning a
query — genuinely need the middle tier and fail on the smallest one.

Without an API key the engine, the console, the whole attention briefing and
importing a file all still work; only the language layers stand down — an
import maps the columns it recognises by their headings and leaves the rest for
you to name on the preview.

## Architecture

Server-rendered Express application over SQLite.

```
src/
  entitlements/    plan limits as data, so billing can enforce them later
  domain/          the only code allowed to change stock
    workspace-service.js  inventories: create, list, resolve, leave
    inventory-engine.js   receive / issue / transfer / adjust + invariants
    repository.js         workspace-scoped reads
    item-service.js       items, variants, item detail
    location-service.js   locations
    activity-service.js   the ledger, regrouped into sentences
    search-service.js     items, variants, serials, lots
    inventory-query.js    list and overview read models
    auth-service.js       accounts, memberships, passwords, roles
  ai/              the vendor boundary: prompt + JSON Schema in, data out
  foundry/         the architect — understanding, plans, configuration
  signals/         deterministic facts derived from the ledger
  attention/       the operator — detection, priority, brief, questions
  actions/         controlled actions — proposals, approval, execution, checks
  web/             routes, views (EJS), middleware, static assets
  db/              schema.sql, schema-foundry.sql, schema-attention.sql,
                   and the additive migrations that upgrade older databases
```

Routes never touch balances. They validate shape, call a domain service, and
render. The engine owns every invariant, so the same guarantees hold whether a
change comes from the UI, from fixtures, from a test, or from a layer above.

### Deleting an inventory

Leaving an inventory removes your membership; deleting one removes the
inventory. Only an owner can, and only after typing its name on a screen that
counts what will be destroyed first.

It is the one operation in Foundry that removes a movement. Everywhere else the
ledger is immutable and a trigger enforces it — but refusing to delete a
customer's records in the name of an audit trail would mean keeping data they
asked to be rid of. So the trigger is lifted inside the deleting transaction and
restored in the same one, which means any failure rolls it back into place along
with the data. A test asserts it is still there and still working afterwards.

The order tables are emptied in is derived from the schema at run time, not
written down: twenty-eight columns use `ON DELETE RESTRICT`, so children have to
go before parents, and a hardcoded list of thirty-eight tables would be wrong
the first time anyone added one. A half-deleted inventory is a far worse outcome
than a failed delete, so an order that cannot be worked out raises rather than
guesses.

### Tenancy

`accounts` is the login identity — one person, one password, any number of
inventories. `workspaces` is the tenant boundary, and `users` is the membership
that joins the two, carrying the role that account holds *in that inventory*.
Every other table in the schema has a `workspace_id`, so isolation is a property
of the data model rather than a rule the routes have to remember.

Every movement points at a membership row, which is why a person can act in
several inventories and the ledger still says exactly who did what, where.
Leaving an inventory ends access but never deletes a membership that recorded
movements — history has to keep resolving.

A workspace id from a session, a URL or a form is only ever turned into
something usable by `resolveForAccount`, which requires membership. A workspace
belonging to someone else is therefore "not found", exactly like any other
record you have no claim on.

### Plans and limits

`src/entitlements/` is the boundary a future billing system plugs into. Limits
live in `plans.js` as data — inventories per account, people, locations, SKUs,
AI requests, feature flags — and every place that could exceed one asks
`assertWithin(db, scope, 'locations')` rather than counting for itself. There is
no billing yet; when there is, the numbers change in one file and no call site
moves. `null` means unlimited, and every declared limit has a counter, which a
test enforces so a limit can never be declared and quietly unchecked.

### Why one engine, not four

A **SKU** is the unit of stock-keeping. A quantity item has exactly one; a
variant item has one per option combination. The item's `tracking_mode`
(`quantity` | `serial` | `lot`) decides how that SKU's stock is represented,
and `has_variants` is orthogonal to it. That is what makes "a variant that is
also lot tracked" a supported combination rather than a special case.

`balances` is an aggregate the engine maintains; `movements` is the authority.
Every balance change writes an immutable movement row carrying the actor,
timestamp, operation, reason, reference and resulting balance. A transfer is
two rows sharing a `group_id`, written in one transaction, so it is impossible
for stock to exist in neither place or both.

### Invariants, and where they are enforced

All of these live in `src/domain/`, not in the UI:

- Stock cannot go negative unless the item explicitly allows it. The guard is
  in the `UPDATE ... WHERE on_hand + delta >= 0` clause, so two concurrent
  writers cannot both pass a check and then both subtract.
- Every mutation writes a movement with actor, timestamp, operation type and
  reference. `movements` has triggers that reject `UPDATE` and `DELETE`.
- A transfer never creates or destroys stock: both legs run in one IMMEDIATE
  transaction and sum to zero.
- A serial number cannot exist in two locations: a unit is one row with one
  nullable `location_id`. It cannot be received twice while active: a partial
  unique index on `(workspace_id, sku_id, serial) WHERE status = 'in_stock'`.
- Lot quantity cannot move from a lot that does not hold enough at that
  location, and lot balances always sum to the location balance.
- A variant's stock belongs to that variant, not its parent item.
- Cross-workspace access is impossible: every read is scoped by `workspace_id`,
  so another inventory's record is "not found" rather than reachable.
- Adjustments require a reason, and record what was expected and what was
  counted.

`verifyIntegrity()` re-derives balances from the ledger, the lots and the units
and reports any disagreement. The Settings page runs it on every visit, and the
tests assert it after every scenario.

### Persistence and concurrency

SQLite in WAL mode with foreign keys on and a busy timeout. Write operations
run in `BEGIN IMMEDIATE` transactions, which serialises writers across
processes rather than within one event loop; the concurrency tests spawn real
child processes to prove it. Sessions live in the same database, so a restart
does not sign anyone out.

The schema files are re-executed on every open, which creates anything missing
but cannot widen a table that already exists — so columns added after a release
are listed in `ADDED_COLUMNS` in `src/db/index.js` and applied by `ALTER` before
the schema runs, since an index over a new column cannot be created until the
column is there. A test opens a deliberately old database and proves it
upgrades without losing anything.

The timed sweep takes a short lease in the database before it runs, so "once per
interval" holds across however many processes are serving the application rather
than once per process.

## The architect

A new workspace meets Foundry before it meets the console. Someone describes
their business in their own words; Foundry returns a typed
`InventoryUnderstanding`, asks at most three questions that would actually
change the configuration, and proposes a versioned
`InventoryConfigurationPlan` carrying an integrity hash over its own bytes.

The model's output is validated against a JSON Schema, repaired only where a
repair cannot change meaning, and then checked against Foundry's stricter
contract. `plan-applier.js` imports the location service and nothing else — it
is structurally incapable of creating a tracking mode the engine does not have,
because it has no way to reach one. A plan whose hash no longer matches is
refused.

Reading a business is a real model call of a minute or more, so it runs as a
background job with a progress page that reports the pass actually running.

## The operator

Detection is deterministic and happens before any model is involved.
`signals/signal-engine.js` derives facts from the ledger and keeps **measured**
values separate from **estimated** ones throughout. Nothing is estimated
without enough history to justify it — a single sale is not a rate — and
transfers between our own locations are never counted as demand.

`attention/detectors.js` turns those facts into candidate findings across eight
categories; `attention/policy.js` decides which categories a business can
produce at all, from its own configuration, so a single-location shop is never
told about imbalance and a business with no lots is never told about expiry.
Related signals about one SKU are folded into one story rather than three
alarms, then scored into an explainable priority order.

Each finding is stored with a fingerprint, which is what makes it *the same
finding* across runs: acknowledgement, dismissal and the first-seen date
survive re-evaluation, and a condition that stops holding is RESOLVED with a
reason rather than deleted. Re-evaluation is scoped — receiving one item cannot
close another item's warning — and runs from the route layer after the movement
has committed, so the interpretation layer can never fail a receive.

The model's only jobs here are wording and reading questions:

- **Rewording.** Every number it writes must already appear in that finding's
  own evidence; it may not claim an action was taken or attribute a cause. What
  fails verification is discarded and the measured wording stands.
- **Questions.** Ask Foundry turns a question into a *plan* — one intent from a
  fixed list plus a few bounded parameters. The model never sees SQL, never
  writes SQL, and never receives a database handle. Every query is hand-written
  and parameterised, and the answer is composed from the rows that came back.
  A question outside what Foundry can look up is answered as such.

Feedback is recorded and never silently applied. If a rule is wrong, that is
something to fix openly rather than have the briefing quietly re-tune itself.

## Controlled actions

Foundry can be told "move 15 Navy 8 from New Jersey to Brooklyn", or asked to
carry out something it recommended. The path is fixed and every step is
separately auditable:

```
instruction → intent (model)  → resolution (deterministic, one workspace)
            → proposal        → authorization → approval (a person)
            → revalidation    → the Mission 1 engine
            → verification    → audit + attention re-evaluation
```

The model chooses one action type from a fixed list and names things in the
words the person used. It never returns an id, never sees the database, and
never calls an inventory function. `resolver.js` turns those words into exact
records with scoped SQL, and two matches is a question rather than a guess.

**Approval is required for anything that changes stock**, and how risky an
action is comes from arithmetic, not judgement: `policy.js` classifies from the
quantity against what is actually on hand. Corrections are always the sensitive
case — they change what the records say without anything having moved — so they
warn, need a second confirmation, and never get a reason Foundry made up.

**Revalidation happens twice**: when a person approves, and again inside the
write transaction. A proposal built against 48 units will not run against 31; it
is invalidated and recalculated, and a changed quantity supersedes rather than
edits, so what was approved is provably what ran (there is a hash over it).

**Executing twice is impossible.** Every execution claims a unique idempotency
key inside the same transaction as the mutation, so a double-click, a refresh or
a replayed POST returns the first result instead of moving stock again. A
*failed* attempt rolls its claim back, so a legitimate retry still works.

**"It ran" and "it is correct" are separate claims.** After the engine returns,
the balances are re-read and compared with what the proposal expected — source
down, destination up, total unchanged for a transfer, the exact serial in
exactly one place, the named lot and not generic stock. If verification fails
the person is told the result could not be confirmed, never "done".

Undo is a new, validated movement in the opposite direction. The ledger is
append-only, so nothing is ever deleted; a correction can only be corrected
again, with its own reason.

Foundry will not invent operations it does not have. A stockout gets no action
because purchasing does not exist — it says so instead.

## Bringing data in

A business that already keeps stock somewhere has to get it into Foundry before
anything else is worth doing, and the honest version of that job is data entry:
someone else's spreadsheet, with someone else's headings, exported on a bad day.
Foundry does that work rather than asking the customer to reformat a file first.

```
file or paste → rows (deterministic)      → column mapping (rules, then model)
              → row validation (deterministic, one workspace)
              → stored plan + every row   → preview → approval (a person)
              → re-validation             → catalog service + Mission 1 receives
              → verification              → report
```

**Reading the file is arithmetic, not intelligence.** `xlsx-reader.js` unzips
and parses the workbook, `parser.js` finds the header among title rows and blank
lines, drops empty columns, and skips a second export stacked underneath the
first. No model is involved in reading bytes, and pasted data with no header at
all is treated as data rather than losing its first record to an invented one.

**Columns are named by rules first.** `fields.js` recognises the headings that
real exports use — "QTY ON HAND", "Whse", "Item Code" — and the ones Foundry
deliberately does not import, so a preview can say "Unit Cost and Supplier were
left out, Foundry does not track those" instead of silently dropping them or
finding them a home nearby. The model is asked about two things only: columns
nothing matched, and columns matched on a catch-all word that often means
something else ("Ref A" holding SN-88213 is a serial, whatever the heading
says). It answers with column-to-field pairs and never sees the database.

**What the model says is checked before it is kept.** A column index that is not
in the file, a field claimed twice, a heading Foundry matched exactly, a
quantity mapped onto a column of words — each is dropped, with the reason shown
on the preview. The file's *type* follows from the columns that survive, not
from the model's claim about it.

**Nothing is invented.** A row with no quantity creates the product with no
opening stock and says so. `03/04/2025` is left blank unless something else in
that column settles which number is the month. A location Foundry does not
recognise stops that row rather than resolving to the nearest one — and when it
does recognise a near-miss, the correction is shown before approval, never
after. Serial numbers, lot codes and expiry dates are only ever copied.

**Duplicates are found deterministically and never merged.** A matching code or
name is decisive and the existing product is added to, never replaced or
renamed. A resemblance ("Copper Elbow 1/2 in." and "1/2in Copper Elbow") is
reported for a person to judge and the products are created separately unless
they say otherwise.

**Opening balances are real movements.** There is no path in the importer that
writes a balance: every unit arrives through a Mission 1 `receive` with the note
"Initial inventory import" and a reference back to the import and row it came
from. The activity ledger explains every figure a customer sees on day one.

**A file cannot be imported twice.** The execution claims a unique idempotency
key derived from the hash of what was approved, so a resubmitted form is
answered with the first run's result. Correcting a mapping changes that hash,
which withdraws the approval — an approval always refers to something still true.

**Rows fail on their own.** One unusable row on line 4,000 does not discard
3,999 good ones; it is recorded as failed with its reason, the rest import, and
the run reports itself as partial. Progress is read back from what has been
written rather than held in memory, so an interrupted import can be resumed and
resuming skips what already happened.

**Afterwards, Foundry counts the result rather than reporting its own
intentions.** `verification.js` re-reads the items, the movements and the
balances and compares them with the plan; "438 products created" and "there are
438 products" are kept as separate claims, and a mismatch says so.

A spreadsheet dropped into the Ask Foundry box goes to the same preview rather
than being refused for arriving at the wrong text box.

## Replenishment and purchasing

An inventory manager's job is not only knowing what is on the shelf. It is
knowing what to buy, from whom, how much, when, what is already coming, what
arrived and what didn't. Mission 6 is that job — and nothing beyond it. There is
no ledger, no invoice, no payment and no customer order anywhere in it.

```
usage + on hand + on order  → replenishment engine (deterministic)
                            → recommendation with its full working
                            → draft purchase order → approval (a person)
                            → ordered, and counted as incoming
                            → delivery → Mission 1 receive → verification
```

**The engine is arithmetic, and the arithmetic is shown.** No model is consulted
when deciding what to buy. The method is the ordinary reorder-point one, chosen
because it can be explained in two sentences:

```
safety stock  = configured, or usage × 7 days
reorder point = configured, or usage × (lead time + 7 days review) + safety
order up to   = configured, or reorder point + 30 days of cover
order         = (order up to) − on hand − on order
                → rounded up to whole packs → supplier minimum → order multiple
```

Every one of those inputs appears on the screen with its source, and every
rounding step is listed in order. It is not a forecast, it assumes recent usage
continues, and it says so. Where the history is too thin to support even that,
it declines to recommend rather than inventing a number.

**On order is a first-class figure.** On hand is what physically exists; on order
is what a person has committed to and not yet received. They are never blended.
A draft order is *not* incoming stock — only APPROVED, ORDERED and
PARTIALLY_RECEIVED count, because those are the ones a supplier has been told
about. There is deliberately no "available" figure netting off customer demand:
Foundry has no sales orders, so any such number would be invented.

**Knowing when not to buy is the same feature.** Asking "what should I order?"
three times in a morning produces one order, not three, because the first one is
counted the moment it is approved. A line with enough already inbound produces an
explicit "no additional order" with the position that justifies it. Mission 3
was upgraded to match: a stockout warning stands down when a delivery lands
before the shelf empties, and an empty shelf with stock booked in says what is
coming instead of asking for another order.

**Purchase orders follow the Mission 4 philosophy.** Foundry drafts; a person
with `APPROVE_PO` approves; the approval is recorded against a hash of exactly
what was on screen. Approval is where quantities stop being editable, because
the receiving screen checks deliveries against them.

**Receiving goes through Mission 1 and only Mission 1.** There is no path from a
purchase order to a balance that skips the engine: every unit arrives as a real
`receive` referencing its PO number, so the ledger explains it and
`verifyIntegrity` still holds. Short deliveries leave the remainder outstanding;
over-deliveries are refused until someone explicitly accepts them, and the
difference is recorded either way. A receipt claims a unique key before any
stock moves, so a refreshed page returns the first receipt rather than booking
the van in twice. Cancelling an order removes what has not arrived from the
incoming figure and never touches what has.

**Suppliers are purchasing partners, not accounts.** A supplier belongs to one
workspace — two inventories buying from "ABC Footwear" have two records, because
they are two different relationships. The supplier-item link carries the part
Foundry actually reasons about: what they call it, how they pack it, the minimum,
the multiple, the lead time and the last unit cost, stored per inventory unit so
suppliers who pack differently can be compared at all.

**Supplier choice compares facts only.** Preferred status, cost, lead time,
minimum and multiple. There is no reliability score, because Foundry has never
measured delivery performance across enough orders to say anything honest about
it. Speed outranks price only when stock would run out before the cheaper option
could arrive, and the trade is then stated in money.

**Prices and lateness are reported, never judged.** A price change shows both
figures and suggests a look. An order is only ever called late when its expected
date came from a stated lead time or a person — an order whose date Foundry
assumed has no date worth measuring against, so it is never reported as late.

Foundry does not contact suppliers. The printable purchase order is a document
someone prints, saves as a PDF or attaches to their own email, and it says so on
its face.

## Testing

`npm test` runs 437 unit and integration tests: the four archetypes and their
combinations, negative-stock rejection, transfer atomicity, duplicate serials,
lot shortfalls, the ledger, search, tenancy, authorization, cross-process
concurrency, persistence across a restart, the configuration layer, and the
whole attention layer — including the test that a healthy inventory produces
exactly zero findings, and the tests that a model cannot introduce a number,
an action or a finding of its own — and the import pipeline end to end, which
runs entirely without an AI provider, and the whole replenishment engine —
including the cases that must produce *no* purchase.

`npm run test:live` is the part that can fail because the intelligence is
wrong rather than because the plumbing is. It is skipped without an API key.

`npm run test:e2e` starts its own server against an empty database and drives
Chromium through each mission's acceptance script. Screenshots are written to
`artifacts/screenshots/`.

## Deliberately absent

Foundry does not sell, price, forecast beyond current usage, or value
inventory, and it has no placeholder buttons for any of it. It plans purchases
and records them; it does not do accounting. It carries out only
inventory work a person has approved: there are no autonomous actions, no
scheduled transfers, and nothing in the background that changes stock. Accounts payable, the general ledger, invoices, payments, customer
orders, CRM, payroll, manufacturing, supplier portals, EDI, barcodes, kits,
warehouse bins, integrations and workflow builders belong on top of a proven
engine, not beside an unproven one. Nothing orders from a supplier by itself:
there is no autonomous purchasing and no scheduled ordering.
