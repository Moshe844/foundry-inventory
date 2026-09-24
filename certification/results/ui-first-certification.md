# StockChief UI-First Pre-Subscription Certification

Generated: 2026-09-23T04:03:59.598Z

**Required UI scenarios: 89/89 passed.**

- Rendered Chromium suite: PASS
- Evidence source: most recent saved browser run
- A scenario passes this gate only when it has named rendered-browser evidence.
- Engine, HTTP, provider-contract, and direct database tests cannot satisfy this UI gate.

| # | Scenario | Browser evidence | Status |
|---:|---|---|:---:|
| 1 | Completely empty workspace | tests/e2e/onboarding-entry.e2e.js: skip opens a usable empty app with a durable source prompt and no fake back link | PASS |
| 2 | Small inventory setup | tests/e2e/imports.e2e.js: 4. the stock is real, and every unit has a movement | PASS |
| 4 | Opening inventory PDF | tests/e2e/import-safety.e2e.js: an opening-inventory PDF is recognized and applied as opening stock, never purchasing activity | PASS |
| 5 | Opening spreadsheet | tests/e2e/imports.e2e.js: 2. StockChief says what it read, and has created nothing; tests/e2e/imports.e2e.js: 4. the stock is real, and every unit has a movement | PASS |
| 7 | Ambiguous import | tests/e2e/onboarding.e2e.js: 2. StockChief surfaces the real conflicts and settles the rest itself | PASS |
| 8 | Duplicate import | tests/e2e/onboarding.e2e.js: 7. it survives a refresh, and re-running the migration changes nothing | PASS |
| 9 | Failed import | tests/e2e/import-safety.e2e.js: an unexpected import failure halfway leaves no products, movements, or balances behind | PASS |
| 10 | Connection and state-driven onboarding guidance | tests/e2e/onboarding-entry.e2e.js: skip opens a usable empty app with a durable source prompt and no fake back link | PASS |
| 11 | Receive inventory | tests/e2e/inventory.e2e.js: quantity item: receive 100 | PASS |
| 12 | Issue or sell inventory | tests/e2e/inventory.e2e.js: quantity item: issue 5 from Downtown leaves 95 | PASS |
| 13 | Transfer inventory | tests/e2e/inventory.e2e.js: quantity item: transfer 25 follows request through receipt | PASS |
| 14 | Insufficient transfer | tests/e2e/inventory.e2e.js: an insufficient transfer fails visibly and leaves every balance unchanged | PASS |
| 15 | Negative stock | tests/e2e/inventory.e2e.js: an issue that would create negative stock fails without a partial mutation | PASS |
| 16 | Physical count | tests/e2e/seasoned-business.e2e.js: A disputed physical count stays visible through recount and changes stock only after approval | PASS |
| 17 | Duplicate receipt | tests/e2e/purchasing.e2e.js: 8. a retried receipt does not duplicate the stock | PASS |
| 19 | Multi-location balance | tests/e2e/inventory.e2e.js: the inventory position reports the same numbers | PASS |
| 20 | Ledger reconstruction | tests/e2e/inventory.e2e.js: the activity ledger explains everything that happened; tests/e2e/inventory.e2e.js: the inventory position reports the same numbers | PASS |
| 26 | Search by SKU | tests/e2e/inventory.e2e.js: search finds items, serials and lots and leads to the record | PASS |
| 27 | Search by product or attribute | tests/e2e/inventory.e2e.js: search finds items, serials and lots and leads to the record | PASS |
| 28 | Bulk rule | tests/e2e/catalog-rules.e2e.js: an owner applies replenishment rules to a selected product group in one browser action | PASS |
| 29 | Supplier-specific SKU | tests/e2e/purchasing.e2e.js: 5. the printable order is a document, not a transmission | PASS |
| 31 | Replenishment trigger | tests/e2e/seasoned-business.e2e.js: Backdated daily sales are entered through the UI and trigger replenishment of the consumed product | PASS |
| 32 | Pack size | tests/e2e/weekly-operations.e2e.js: replenishment chooses a 24-dollar packed order over a thousand-dollar low-unit-price minimum | PASS |
| 33 | Minimum order quantity | tests/e2e/weekly-operations.e2e.js: replenishment chooses a 24-dollar packed order over a thousand-dollar low-unit-price minimum | PASS |
| 34 | Existing incoming stock | tests/e2e/purchasing.e2e.js: 1. what should I order? — nothing, with the reason | PASS |
| 35 | Purchase order lifecycle | tests/e2e/purchasing.e2e.js: 3. StockChief prepares the order; nothing is committed yet; tests/e2e/purchasing.e2e.js: 4. approving makes it incoming without hiding its late arrival; tests/e2e/purchasing.e2e.js: 6. part of the shipment arrives; tests/e2e/purchasing.e2e.js: 7. the rest arrives and the order closes | PASS |
| 36 | Partial receipt | tests/e2e/purchasing.e2e.js: 6. part of the shipment arrives | PASS |
| 37 | Over-receipt | tests/e2e/purchasing-evidence.e2e.js: an over-receipt asks before changing stock and records the approved excess | PASS |
| 38 | Supplier price change | tests/e2e/purchasing-evidence.e2e.js: a supplier price change outside tolerance becomes one explicit browser decision | PASS |
| 39 | Supplier cancellation or backorder | tests/e2e/weekly-operations.e2e.js: overdue, unknown and too-late incoming orders are exceptions, not proven coverage | PASS |
| 40 | Duplicate PO execution | tests/e2e/seasoned-business.e2e.js: Calendar ticks and page refreshes do not duplicate supplier orders | PASS |
| 41 | Supplier invoice with PO | tests/e2e/weekly-operations.e2e.js: verified invoice correction posts one payable, preserves original history and clears its exception | PASS |
| 42 | Supplier invoice without PO | tests/e2e/purchasing-evidence.e2e.js: a supplier invoice without a purchase order asks for the missing match and creates no stock | PASS |
| 43 | Invoice versus receipt | tests/e2e/weekly-operations.e2e.js: the actual supplier invoice can differ from its PO without posting or paying a disputed bill | PASS |
| 44 | Shipment notice | tests/e2e/purchasing-evidence.e2e.js: a shipment notice updates incoming evidence and ETA but never on-hand stock | PASS |
| 45 | Packing slip | tests/e2e/weekly-operations.e2e.js: a real UI purchase receipt automatically fills the remaining customer shortages | PASS |
| 46 | Supplier question | tests/e2e/mail-replies.e2e.js: a supplier question gets a reply grounded in the real purchase order | PASS |
| 47 | Customer question | tests/e2e/mail-replies.e2e.js: a customer delivery question gets a reply grounded in the actual order and commitment | PASS |
| 48 | Edit prepared response | tests/e2e/mail-replies.e2e.js: the exact edited reply is the only version sent and the message moves to waiting | PASS |
| 49 | Duplicate email notification | tests/e2e/operational-safety.e2e.js: operational safety and mailbox pagination are verified through screens | PASS |
| 50 | Malicious document instructions | tests/e2e/mail-replies.e2e.js: malicious inbound instructions change no authority and create no business action | PASS |
| 51 | Create Sales Order | tests/e2e/sales-shipping-money.e2e.js: the UI creates, reserves, partially fulfils and cancels one order without losing its story | PASS |
| 52 | Commit inventory | tests/e2e/seasoned-business.e2e.js: Approving commits an order but does not prematurely receive stock | PASS |
| 53 | Shortage | tests/e2e/weekly-operations.e2e.js: 150 open orders reserve only 100 physical units, not the 50 incoming units | PASS |
| 54 | Partial fulfillment | tests/e2e/sales-shipping-money.e2e.js: the UI creates, reserves, partially fulfils and cancels one order without losing its story | PASS |
| 55 | Cancellation | tests/e2e/sales-shipping-money.e2e.js: the UI creates, reserves, partially fulfils and cancels one order without losing its story | PASS |
| 56 | Return | tests/e2e/returns-shipping.e2e.js: a customer return is authorized, quarantined, inspected, restocked and refunded in the UI | PASS |
| 57 | Shipping address from communication | tests/e2e/sales-shipping-money.e2e.js: a carrier order cannot be created without its own destination | PASS |
| 58 | Real shipment creation abstraction | tests/e2e/returns-shipping.e2e.js: a carrier label is bought through the provider abstraction before stock leaves | PASS |
| 59 | Tracking progression | tests/e2e/sales-shipping-money.e2e.js: picking and packing move no stock; carrier handoff moves it once and tracking reaches delivered | PASS |
| 60 | Shipping exception | tests/e2e/returns-shipping.e2e.js: a verified carrier exception appears on the shipment and in Needs you | PASS |
| 61 | Customer payment link | tests/e2e/payment-window.e2e.js: a successful Stripe popup closes and returns to a visibly paid order | PASS |
| 62 | Direct card payment | tests/e2e/payment-window.e2e.js: a successful Stripe popup closes and returns to a visibly paid order | PASS |
| 63 | Partial customer payment | tests/e2e/money-lifecycle.e2e.js: a customer partial payment leaves exactly one hundred fifty receivable | PASS |
| 64 | Final customer payment | tests/e2e/money-lifecycle.e2e.js: the final customer payment clears the receivable | PASS |
| 65 | Payment hold | tests/e2e/sales-shipping-money.e2e.js: a required deposit visibly blocks picking until the exact payment is recorded | PASS |
| 66 | Offline payment | tests/e2e/money-lifecycle.e2e.js: a customer partial payment leaves exactly one hundred fifty receivable | PASS |
| 67 | Supplier partial payment | tests/e2e/money-lifecycle.e2e.js: a supplier partial payment leaves exactly six hundred payable | PASS |
| 68 | Supplier final payment | tests/e2e/money-lifecycle.e2e.js: the final supplier payment clears the payable without moving stock | PASS |
| 69 | Duplicate processor webhook | tests/e2e/connector-webhooks.e2e.js: two Stripe lifecycle webhooks for one cumulative payment record money once | PASS |
| 70 | Refund | tests/e2e/money-lifecycle.e2e.js: a cash refund is visible, traceable and never changes physical inventory | PASS |
| 71 | Purchase order accounting | tests/e2e/purchasing.e2e.js: 4. approving makes it incoming without hiding its late arrival | PASS |
| 72 | Supplier invoice accounting | tests/e2e/weekly-operations.e2e.js: verified invoice correction posts one payable, preserves original history and clears its exception | PASS |
| 73 | Receiving accounting | tests/e2e/seasoned-business.e2e.js: A real receipt updates visible stock, verifies the delivery and resolves the need | PASS |
| 74 | Supplier payment accounting | tests/e2e/money-lifecycle.e2e.js: the final supplier payment clears the payable without moving stock | PASS |
| 75 | Sale accounting | tests/e2e/sales-shipping-money.e2e.js: picking and packing move no stock; carrier handoff moves it once and tracking reaches delivered | PASS |
| 76 | Partial customer payment accounting | tests/e2e/money-lifecycle.e2e.js: a customer partial payment leaves exactly one hundred fifty receivable | PASS |
| 77 | Return and refund accounting | tests/e2e/money-lifecycle.e2e.js: a cash refund is visible, traceable and never changes physical inventory | PASS |
| 78 | Inventory and accounting reconciliation | tests/e2e/money-lifecycle.e2e.js: inventory valuation visibly reconciles the cost subledger to inventory control | PASS |
| 79 | Accountant explanation | tests/e2e/weekly-operations.e2e.js: Ask profit and loss honors the calendar quarter and includes records beyond the display limit | PASS |
| 80 | Books reconstruction | tests/e2e/money-lifecycle.e2e.js: the browser proves balanced books and traces a ledger row to its immutable source entry | PASS |
| 81 | Ask-me-first | tests/e2e/actions.e2e.js: 3. StockChief proposes a specific transfer, and nothing has moved | PASS |
| 82 | Authorized automatic transfer | tests/e2e/autopilot-authority.e2e.js: qualifying work runs and displays the exact policy version and dated evidence | PASS |
| 83 | Transfer outside limit | tests/e2e/autopilot-authority.e2e.js: work above the policy boundary remains full-sized in Needs you | PASS |
| 84 | Independent authority domains | tests/e2e/autonomy-entry.e2e.js: authorising customer payment requests never authorises supplier purchasing | PASS |
| 85 | Automatic payment-request communication | tests/e2e/payment-automation.e2e.js: explicit authority creates one provider request and sends one grounded email; tests/e2e/payment-automation.e2e.js: without job authority the same routine request is prepared and visibly waits | PASS |
| 86 | Pause | tests/e2e/autopilot-authority.e2e.js: Pause blocks the run and Resume lets the same eligible work continue | PASS |
| 87 | Resume | tests/e2e/autopilot-authority.e2e.js: Pause blocks the run and Resume lets the same eligible work continue | PASS |
| 88 | Explain decision | tests/e2e/autopilot.e2e.js: 7. "why did you do that" answers from the record, not from memory | PASS |
| 89 | One business story | tests/e2e/complete-business-day.e2e.js: one complete business day stays linked from customer demand through books and owner reporting | PASS |
| 90 | Needs You prioritization | tests/e2e/weekly-operations.e2e.js: a failed exception source produces an incomplete-review warning instead of an all-clear | PASS |
| 91 | Shopify event | tests/e2e/connector-webhooks.e2e.js: a signed Shopify order is committed once and appears as a real customer order | PASS |
| 92 | Square event | tests/e2e/connector-webhooks.e2e.js: Square payment lifecycle events issue stock once and the completed sale is visible | PASS |
| 93 | Connector outage | tests/e2e/operational-safety.e2e.js: authorization failures are visible and cannot masquerade as an operational mailbox | PASS |
| 94 | Retry after outage | tests/e2e/operational-safety.e2e.js: a temporary refresh outage preserves consent and a retry works without reconnecting | PASS |
| 96 | Credential security | tests/e2e/operational-safety.e2e.js: a different identity after refresh quarantines the mailbox rather than reading or sending as another account | PASS |
| 98 | Migration | tests/e2e/migration-scale.e2e.js: an owner starts and completes a migration entirely in the browser with their own export | PASS |
| 99 | Migration reconciliation | tests/e2e/migration-scale.e2e.js: a real browser reviews an unfamiliar mapping and proves a frozen live-source cutover | PASS |
| 100 | Complete business day | tests/e2e/connector-webhooks.e2e.js: a signed Shopify order is committed once and appears as a real customer order; tests/e2e/connector-webhooks.e2e.js: Square payment lifecycle events issue stock once and the completed sale is visible; tests/e2e/complete-business-day.e2e.js: one complete business day stays linked from customer demand through books and owner reporting | PASS |

## Missing Browser Journeys
