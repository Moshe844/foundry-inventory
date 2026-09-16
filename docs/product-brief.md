# StockChief — the product brief

**Status.** This is reconstructed, not original. It was assembled from the code,
its comments, the two readiness documents, and the working agreements of the
sessions that built the product. Where it states a rule, that rule is enforced
somewhere in `src/` and can be checked. Where it states an intention, the
intention was inferred and is marked as such.

It exists because it did not, and every session began by rebuilding intent from
whatever the code happened to say. Correct it freely — a wrong line here is
cheaper to fix than a wrong assumption repeated for a week.

---

## 1. What StockChief is

> StockChief continuously manages the routine inventory, purchasing, supplier
> communication, Sales Order and accounting work of an inventory-based business,
> while the owner supervises genuine exceptions.

One engine covers four kinds of inventory — quantity, variants, individually
serialised units, and lots or batches — and their combinations, without a second
application and without a codebase per customer.

### What makes it different

Every other inventory system is a ledger with forms: the operator observes what
happened, types it in, and the software stores and totals it. The operating
intelligence lives in the operator's head.

StockChief holds the operating model itself. It reads the business, watches it,
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
  "StockChief cannot tell yet", never a reorder quantity.
  (`src/attention/query-service.js`, `src/purchasing/replenishment.js`.)
- **Variant grids are not populated speculatively.** Two colours by two sizes is
  four combinations; a shop that stocks three has told StockChief about three, and
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
information**. When StockChief does not raise something, that is a fact. No system
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
be covered, StockChief states what it already checked (other locations, incoming
orders, replenishment) and where the decision lives. The owner is never sent to
walk Inventory → Transfers → Purchasing by hand.

**§9 — Needs You is one inbox.** Everything requiring a person appears in one
place, and an entry may only appear if it answers four questions: what happened,
why StockChief stopped, what it recommends, and what it needs from you. An entry
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

StockChief is not an application. It is a colleague with a desk, and you do not
navigate a colleague — you read what they left you, settle what they could not,
and tell them things.

So the product is **three surfaces and one object**.

| | |
| --- | --- |
| **The Brief** (`/`) | What StockChief knows this morning, written as prose. Not sections — sentences. Every clause is a door. |
| **The Desk** (`/needs-you`) | The stack of decisions only the owner can make. One at a time, at full size, with a counter, evidence as a disclosure inside the decision. Not a queue to triage — a stack to clear. |
| **The Line** (`/ask`) | The running conversation: what happened, what you want, how you want this run. The primary way StockChief is taught. One box, posting to the intent router. |

And the object, which is the whole design in one word: **the story**.

A story has a subject, a spine of what has happened, a bright line marking now,
a ghosted spine of what StockChief intends to do, and sometimes a decision. A
customer order is a story. A purchase is a story. `src/web/story.js` builds
both, and `views/partials/spine.ejs` renders both — one component, two
subjects, which is also why this cost eight components rather than a hundred
and eleven templates.

Inventory, Money and Activity stopped being places. They are **lenses over the
same stories**: Money is every story with a financial consequence, what you hold
is every story about stock, Activity is all of them in time order.

### Why the previous arrangement was replaced

The sidebar before this one had already been consolidated from seven
departments to six, and it did not work, because only the doors were renamed.
Six nav entries sat on top of 185 routes and 111 templates; forty routes under
`/accounting` alone. One customer order still touched five addresses. The
owner was still the router — StockChief knew what had happened and then asked
which room to walk into to find out.

### The three rules that hold it

- **Nothing is more than one story deep.** Brief → story → evidence. Evidence
  is a disclosure inside the story, never a fourth page.
- **Every screen states the business's position, not the database's contents.**
  A screen that opens with a table has failed before it renders. The one table
  in the product is the four-line ledger on Money, because money genuinely is a
  column of figures.
- **Nothing is deleted — things are demoted.** Every screen taken off the main
  path kept its address and is listed, in full and grouped by the question it
  answers, at `/everything`. A navigation that hides things is worse than the
  sidebar it replaced, and that page is what makes the consolidation honest.

### Settings is a transcript

StockChief is taught by talking to it, so `/what-you-told-me` is the standing
rules in the words the owner said them, with what each has done since —
"acted 11×" is the trust surface, because a rule that has never fired is a rule
that is wrong or unnecessary, and nowhere else would show it. The forms are
still at `/settings` and behind it.

### The visual layer

`src/web/public/room.css` loads last. It redefines the tokens the three older
sheets read, so the ninety demoted screens inherit the palette rather than
looking foreign, and it provides the components the rewritten surfaces are
built from. Newsreader for prose, IBM Plex Sans for the interface, IBM Plex
Mono for labels and figures; the accent is StockChief's own teal, deepened, and
one warm copper that means exactly one thing: this needs a person.

Nothing in it draws a bordered, rounded, shadowed card by default. Border, fill
and shadow are spent on the one thing on a screen that needs lifting, because
if everything is lifted nothing is.

**The test that matters, unchanged:** if understanding one business event means
bouncing between Sales, Fulfilment, Mail, Purchasing and Accounting, the design
has failed. One customer order is one page and one story.

**And the second one:** remove the logo — is this generic inventory SaaS? The
dominant element on every rewritten screen is a sentence, set in a reading face
at reading size, with the database behind a disclosure. Generic ERP cannot do
that, because it does not know enough to write the sentence.

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
model behaviour rather than StockChief's. A run on 2026-09-01 failed three of 57 —
a transient provider `400 Invalid request data`, and two assertions about what
the model said — and all three passed when re-run individually.

Treat a live failure as a question, not a verdict: re-run it before believing
it, and only investigate a failure that repeats. The other two suites are
deterministic and a failure there means what it says.

## 8. Known gaps

Honest, at the time of writing.

**Product**

- Warehouse execution now supports hierarchical zones, aisles, shelves, bins,
  docks and staging locations; deterministic SKU/location/lot/serial barcode
  identities and aliases; durable mobile receiving, putaway, picking, counting
  and transfer tasks; containers; putaway rules; and printable Code 128 labels.
  Accepted stock-changing scans post through the canonical inventory engine.
  Duplicate offline scans are idempotent, wrong identities are rejected before
  movement, and interrupted tasks resume from stored progress. Existing stock
  is intentionally left at its existing location during migration; StockChief
  does not invent a bin for it.
- Stripe is written, not proven. The payment-provider seam is exercised end to
  end through a stub — request, hosted link, webhook, receipt, hold released —
  but the Stripe adapter itself has never run against a live Stripe account,
  because there is no key on this machine. The seam is proven; the wire format
  is not. Treat the first real call as the test it is.
- No carrier account. Fulfilment records a shipment, holds a carrier, service
  and tracking number, and turns that number into a working tracking link — but
  StockChief cannot buy a label, quote a real rate, or see a delivery scan. Marking
  a shipment delivered is the owner telling StockChief what they know, and the page
  says so. `src/sales/carriers.js` is the seam an integration would fill.
- Customer-facing documents do not print. Purchase orders do.
- Customers are told one thing: that their order shipped. A notice is written
  from the shipment's own record the moment a box goes out, and by default the
  owner sends it. There is no order confirmation and no delay notice.
- Inbound mail is sorted into needs a reply / waiting / handled, and every
  message says which words put it where. StockChief drafts the reply too, from
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
