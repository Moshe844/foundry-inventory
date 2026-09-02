# Foundry — the product brief

**Status.** This is reconstructed, not original. It was assembled from the code,
its comments, the two readiness documents, and the working agreements of the
sessions that built the product. Where it states a rule, that rule is enforced
somewhere in `src/` and can be checked. Where it states an intention, the
intention was inferred and is marked as such.

It exists because it did not, and every session began by rebuilding intent from
whatever the code happened to say. Correct it freely — a wrong line here is
cheaper to fix than a wrong assumption repeated for a week.

---

## 1. What Foundry is

> Foundry continuously manages the routine inventory, purchasing, supplier
> communication, Sales Order and accounting work of an inventory-based business,
> while the owner supervises genuine exceptions.

One engine covers four kinds of inventory — quantity, variants, individually
serialised units, and lots or batches — and their combinations, without a second
application and without a codebase per customer.

### What makes it different

Every other inventory system is a ledger with forms: the operator observes what
happened, types it in, and the software stores and totals it. The operating
intelligence lives in the operator's head.

Foundry holds the operating model itself. It reads the business, watches it,
prepares the routine work, and brings back only what it cannot settle. Its
output is **decisions**, not records.

That is only worth anything if what it escalates can be trusted, which is why
the doctrine below is the product rather than a policy about it.

---

## 2. The doctrine: never state what cannot be supported

This is the spine. Everything else follows from it, and it is enforced in code
in at least these places:

- **Imported costs are ignored.** A cost typed into a spreadsheet is not
  evidence, and the accounting engine refuses amounts it cannot support.
  (`src/imports/fields.js` — recognised as ignorable, with the reason beside it.)
- **Demand is not guessed.** A product with no outbound history produces
  "Foundry cannot tell yet", never a reorder quantity.
  (`src/attention/query-service.js`, `src/purchasing/replenishment.js`.)
- **Variant grids are not populated speculatively.** Two colours by two sizes is
  four combinations; a shop that stocks three has told Foundry about three, and
  the fourth is deactivated. (`src/imports/executor.js`.)
- **Stock is not committed to a customer automatically.** Holding stock for one
  customer takes it from the next, so it is offered and not done.
  (`src/sales/sales-order-service.js`.)
- **Inventory received without cost evidence posts no journal entry**, and says
  so, rather than valuing it. (`src/accounting/operational-adapter.js`.)
- **A migration reconciles itself.** It counts what it created and compares that
  with the file; disagreement is reported rather than success.
  (`src/onboarding/migration-service.js`.)

The consequence — and the reason it matters commercially — is that **silence is
information**. When Foundry does not raise something, that is a fact. No system
that fills gaps with defaults can offer this.

### The model may never produce a number

A model classifies, extracts, and phrases. It never originates a figure.

Where a model writes prose over real figures, the prose is verified before it is
shown: every number in it must already appear in the computed answer, or the
sentence is discarded and the deterministic text is used. Language that accuses
or claims to have acted is refused the same way. See
`src/attention/answer-phrasing.js` and `src/attention/brief-service.js`; the
shared guard is `interpretation.numbersAreGrounded`.

A phrasing layer that can change a figure is not a phrasing layer.

---

## 3. Design principles

These governed the interface redesign and are the standard for new screens.
They are numbered as they were referred to in working sessions.

**§7 — A shortage is a decision, not a dead end.** When a customer order cannot
be covered, Foundry states what it already checked (other locations, incoming
orders, replenishment) and where the decision lives. The owner is never sent to
walk Inventory → Transfers → Purchasing by hand.

**§9 — Needs You is one inbox.** Everything requiring a person appears in one
place, and an entry may only appear if it answers four questions: what happened,
why Foundry stopped, what it recommends, and what it needs from you. An entry
that cannot answer them is not ready to be shown. This bar now applies to money
as well (`src/accounting/books-review.js`).

**§11 — Authority is two choices.** *Ask me first*, or *handle routine work
inside limits I approve*. Exact policies, hard limits and preferences sit under
one **Advanced** heading. Choosing the simple option grants nothing by itself:
capabilities are opted into individually.

**§13 — Settings are grouped as concepts a customer holds**, not as the tables
underneath. Technical and audit surfaces live behind *Advanced*.

**§15 — One pattern per idea.** One filter control, one activity timeline, one
inbox, one word per concept. Committed stock is "committed" everywhere. A
finding's action label is the same on every screen that shows it.

**§16 — Progress is honest.** Long work names its steps and shows elapsed time
rather than a spinner. A page that says "ready" means ready.

**§17 — Guidance disappears when it is done.** Setup checklists and next-step
prompts are derived from real records, never from a tour flag, and vanish when
the underlying condition is satisfied.

### Two rules learned the hard way

- **Never suggest a sentence the product will refuse.** A suggestion that fails
  teaches the owner that the feature does not work. (Twice found: Home and
  Suppliers.)
- **Never restate the same thing twice on one screen.** A count, a heading, and
  a footnote that all describe the same set will disagree eventually — and did:
  one morning screen said 9, 6, and 3 for "what needs me".

---

## 4. What the owner sees

Foundry is one thing pretending to be nothing: an employee who runs the
operation. So the navigation is what an owner does, not what the software
contains.

| | |
| --- | --- |
| **Home** | The briefing. A verdict — everything is under control, or N things need you — then what is about to happen: what is packed, what is ready to pick, when a customer wants their order, when a supplier's delivery is due. |
| **Needs you** | The only queue. Anything Foundry cannot settle alone arrives here, including mail somebody is waiting on an answer to. |
| **Inventory** | What you have, and how more of it arrives. Purchasing lives here. |
| **Orders** | A customer order end to end: promised, committed, picked, shipped, tracked, paid, and what the customer was told. Fulfilment and customer mail live here. |
| **Money** | The accountant's briefing first; the books underneath. |
| **Activity** | Everything that happened, in order. |

Then Connections and Settings, and Tell Foundry from anywhere.

This replaced a sidebar that named every department — Inventory, Sales,
Fulfilment, Mail, Purchasing, Accounting, Activity — which is the shape of an
ERP and the opposite of the point. Somebody who hired Keeper to run these
things should not have to operate seven of them.

**The test that matters:** if understanding one business event means bouncing
between Sales, Fulfilment, Mail, Purchasing and Accounting, the design has
failed. One customer order is one page and one story.

Nothing was removed. Every folded-in section keeps its own address, and the
section it now belongs to links to it plainly — Orders offers picking and
shipping, Inventory offers ordering and suppliers. Consolidating a navigation
only works if what went into a section is obvious from inside it; otherwise it
is not simpler, only emptier.

## 5. The vocabulary

Fixed words. Changing one means changing it everywhere.

| Concept | Word | Not |
|---|---|---|
| Stock held for a customer order | **committed** | reserved, allocated |
| Stock physically present | **on hand** | in stock, quantity |
| Ordered but not yet arrived | **on order** | incoming, expected |
| A product's sellable variation | **version** (UI) / SKU (data) | variant, option |
| Unfulfilled customer demand | **short** | backordered, waiting |
| What the business calls a product | **code** | SKU when speaking to owners |
| What is printed on the box | **barcode** | GTIN, UPC in owner-facing text |

---

## 6. Mission ladder

Numbered missions built the product. The last few:

- **14 — Accounting.** Double-entry ledger, costing, subledgers, banking,
  opening balances, reports. Posts from operational events rather than manual
  entry.
- **14.5 — Production readiness.** Treated as a release gate, not a label. See
  `docs/production-readiness.md`. Its private-beta blockers are deliberately
  listed as *deployment* gates that no local screen can close.
- **14.6 — Zero-training walkthrough.** Inventory, Purchasing, supplier email,
  Sales Orders, Needs You and Accounting walked by someone who has never been
  shown them, fixing every unclear step. Completed; see §7 below for what
  remains untested.
- **15 —** not yet defined at the time of writing.

---

## 7. Testing standard

- `npm test` — unit and integration.
- `npm run test:e2e` — browser, driving real pages.
- `npm run test:live` — live provider calls.
- `npm run test:all` — all three. **This is the gate.** Running only the first
  is how a browser regression or a provider-contract break reaches a release.

A test that cannot fail is worse than no test. Assertions containing `|| true`,
or matching text so loosely that any page passes, are defects.

Where a fixture reproduces a real defect, keep the real shape — a namespace
prefix, a subject-less email, a variant sheet with one row per size — and say in
the comment what it broke.

---

### A note on the live suite

`test:live` calls a real model, so a proportion of its assertions are about
model behaviour rather than Foundry's. A run on 2026-09-01 failed three of 57 —
a transient provider `400 Invalid request data`, and two assertions about what
the model said — and all three passed when re-run individually.

Treat a live failure as a question, not a verdict: re-run it before believing
it, and only investigate a failure that repeats. The other two suites are
deterministic and a failure there means what it says.

## 8. Known gaps

Honest, at the time of writing.

**Product**

- No barcode scanning, mobile receiving, or label printing. Barcodes are now
  *captured* on import so the data exists when scanning arrives.
- Stripe is written, not proven. The payment-provider seam is exercised end to
  end through a stub — request, hosted link, webhook, receipt, hold released —
  but the Stripe adapter itself has never run against a live Stripe account,
  because there is no key on this machine. The seam is proven; the wire format
  is not. Treat the first real call as the test it is.
- No carrier account. Fulfilment records a shipment, holds a carrier, service
  and tracking number, and turns that number into a working tracking link — but
  Foundry cannot buy a label, quote a real rate, or see a delivery scan. Marking
  a shipment delivered is the owner telling Foundry what they know, and the page
  says so. `src/sales/carriers.js` is the seam an integration would fill.
- Customer-facing documents do not print. Purchase orders do.
- Customers are told one thing: that their order shipped. A notice is written
  from the shipment's own record the moment a box goes out, and by default the
  owner sends it. There is no order confirmation and no delay notice.
- Inbound mail is sorted into needs a reply / waiting / handled, and every
  message says which words put it where. Foundry drafts the reply too, from
  facts it gathers first — the sender's orders, shipments, tracking and
  balances — and a draft that names a figure or a date those facts do not
  carry is thrown away before the owner sees it, with the reason shown. The
  owner reads and sends; nothing reaches anybody on its own.
- Reporting is thinner than established inventory systems.
- Not proven at scale: SQLite, single node.

**Verification**

- No connected commerce system (Shopify, Square) has been exercised for real.
  The Custom API connector has, end to end.
- Gmail has been exercised end to end — a purchase order sent from the owner's
  mailbox, the supplier's reply matched back to it, invoice attachments applied
  to stock, duplicates ignored.

**Process**

- No CI. Every suite runs by hand, on one machine. A 42,557-directory, 82 GB
  test leak went unnoticed for weeks as a direct result.
- Two agents have shared one working tree, which produced a test race and a
  large uncommitted backlog.
- 201 hand-written `field` blocks against 14 `include()` calls, and three
  stylesheets coexisting. This is the structural cause of most interface
  defects found during 14.6 — one number with three names, one finding with two
  labels, a hint styled as a bold label on thirteen screens.

**Deployment** — see `docs/production-readiness.md`. Support mailbox, password
recovery, error tracking proven by an injected failure, and a restore drill with
a measured recovery time all remain open, by design.
