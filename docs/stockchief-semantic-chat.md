# StockChief semantic chat

Production Ask uses semantic interpretation before executing any inventory read.
It does not route questions using the legacy phrase shortcuts. The model returns
a validated read plan, not SQL or a factual answer. Answers and evidence are
computed from the current workspace's records.

The reviewed relational read catalogue supports products, actual SKU variants,
SKU/location positions, ledger movements, locations, customer/supplier identities,
and purchase/sales order headers. Plans can combine predicates, count, aggregate,
group, sort and return selected fields. Arbitrary supplied catalogue facts and
variant-option names are discovered from the workspace; numeric facts support
aggregation. Absent values remain missing and incomplete measures are disclosed.
Specialized registered executors provide accounting, kits, purchasing, forecasts,
shipping, attention and operational reasoning; the semantic plan can combine up
to six reads without silently dropping subquestions.

Queries are parameterized and tenant-scoped. Fields, operators and aggregates
are allowlisted. Counts include all matches before evidence pagination. Ambiguous
singular identities trigger a follow-up. Dataset permissions and accounting
permissions are checked before retrieval. Session-scoped follow-ups carry the
prior question/plan only in the same workspace; independent questions do not
inherit hidden filters. Asking never executes a mutation. Instructions hand off
to the existing manager's reviewed workflow. Model interpretation times out
after 20 seconds with a retry message; no fabricated fallback figures appear.

Value questions distinguish recorded cost from selling value. Cost answers
disclose physical stock without reconciled cost evidence. Selling value uses
actual on-hand quantities and the latest maintained SKU prices, discloses missing
prices, and keeps currencies separate without assuming an exchange rate.
Follow-up submissions retain an immutable context snapshot, so refresh/back
does not reinterpret a reply against its own subsequent answer.

The exported legacy planner and explicit `semantic: false` option remain for
offline integrations. Older provider contracts are supported as a compatibility
path; real production providers receive `stockchief_semantic_query`.

This is not a guarantee of perfect understanding of every possible question.
Unregistered joins or measures, absent evidence, unclear references and novel
domain reasoning may require clarification or a new reviewed read model. New
read capabilities should extend this catalogue or a registered domain executor,
not add product-name or utterance-specific branches. Verification lives in
`semantic-chat.test.js` and `semantic-chat-http.test.js`; live model/browser
checks supplement, rather than replace, those deterministic tests.

Ask composer POSTs interpret once. Read results are consumed once after redirect;
action decisions continue directly to the registered manager workflow, not an
analytics clarification or an extra routing button. Sales requests from Ask
create review-only drafts, and their clarifications retain review-only mode.
Adding a missing supplier through that flow is not approval to place or send
the purchase order. Explicit source SKUs are resolved before approximate names;
missing or multiple exact identifiers are never replaced with a guessed item.
