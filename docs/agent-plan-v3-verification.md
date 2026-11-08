# Agent plan verification

Verification is on the draft branch using synthetic business records and disposable PostgreSQL databases. The table follows all 214 jobs in the Agent plan v3 PDF. Every listed plan assignment has an independent policy test. The last column records the operational evidence from this change. A row marked **Policy only** still needs a scenario that enters through StockChief and verifies its stored or external result. Other suites may already exercise parts of the job.

The permitted modes are **Alone**, **Trained** (after an owner rule), **Draft** (a person approves), **Suggest** and **Excluded**. Section 11 governs rows 35 and 213 by owner decision. Pro also needs the paid EDI add-on for row 185. Custom purchasing requires contract limits.

Run `npm run test:agent-plans` with Node 22, PostgreSQL and Playwright Chromium to repeat the plan and workflow tests.

## Release checks

- Exercise the eligible and denied plan modes through the UI, Ask, direct requests and queued work after a downgrade. Verify the inventory, money, document or provider result and replay each write.
- Use Orderful's demo retail relationship to run the inbound order, acknowledgment, ship notice and invoice. Match the retailer's accepted documents to StockChief records.
- Use ShipBob's sandbox to submit a test sales order and reconcile the resulting provider order, shipment, tracking and inventory with StockChief. Exercise retries using the same order reference.
- Keep the $49 AI pack pending. Qualify it with actual provider invoices and the corresponding usage ledger, including failed work. Checkout reads settled model spending, imported provider statement allocations and committed customer credits for the same closed review period. Current policy allows a maximum $29.40 of provider spend per pack. The November 8 staging check found 4,008 settled model calls and zero OpenAI or Anthropic statement lines in the preceding 30 days. Test fixtures do not qualify a sale.
- Measure a representative business week against timed manual work. The report accepts measured samples for five types of completed work. Customer weekly savings still require customer timing samples and completed production events.

## Jobs and plan permissions

| # | Job | Starter $199 | Growth $499 | Pro $999 | Custom | Workflow evidence |
|---:|---|---|---|---|---|---|
| 1 | Tells you how many of any item, size, lot or serial you have, and where. | Alone | Alone | Alone | Alone | Starter can trace a lot and an issued serial. The mixed-order test checks the live stock after partial shipment and recall. |
| 2 | Explains why a stock number changed, with every move behind it. | Alone | Alone | Alone | Alone | Recorded receipt changes the position from 0 to 4. The review returns both balances and the movement. |
| 3 | Checks every day for negative stock, stuck transfers and odd adjustments. | Suggest | Alone | Alone | Alone | Warehouse discrepancy review locates negative stock, repeated negative adjustments and overdue transfers. Tested all plans and the Starter suggestion. Proactive delivery still needs verification. |
| 4 | Plans today's cycle count: which shelves to count, by value and risk. | Suggest | Draft | Alone | Alone | A two-warehouse SKU prioritizes the shelf with two negative adjustments ahead of a shelf with three units and no corrections. Starter receives one suggestion. |
| 5 | Turns a count sheet or shelf photo into stock adjustments. | Excluded | Excluded | Trained | Alone | Policy only |
| 6 | Posts small count differences on its own, under your $ limit. | Excluded | Excluded | Alone | Alone | An owner-set limit posts a physical count using the inventory ledger and accounting transaction. Verified tier, shadow, amount, evidence and replay checks. |
| 7 | Sends staff a count list on their phone and checks it as they go. | Excluded | Trained | Alone | Alone | Policy only |
| 8 | Asks for a recount when a count looks wrong, before anything is posted. | Excluded | Excluded | Alone | Alone | An above-limit difference requires a matching independent count submission before the owner may approve. Verified downgrade and stale stock handling. |
| 9 | Finds dead and slow stock and suggests: discount, return or move it. | Suggest | Draft | Trained | Alone | Policy only |
| 10 | Flags likely shrink or theft patterns (same item, same shift, again). | Excluded | Alone | Alone | Alone | Two recorded count corrections for the same SKU at the same warehouse and local time band produce one two-unit loss flag. Starter is denied. |
| 11 | Moves stock to the right bin after a wrong put-away or mis-scan. | Excluded | Excluded | Trained | Alone | Policy only |
| 12 | Reserves stock for big customers or upcoming orders. | Excluded | Excluded | Trained | Alone | The agent checks strict reservation requests during discovery, preparation and execution. Starter and Growth direct preparations were denied. Order-level reservation under a standing customer rule remains to be verified. |
| 13 | Tracks kits and bundles: shows how many you can build now and reorders the parts. | Suggest | Draft | Alone | Alone | Policy only |
| 14 | Creates simple assembly (build) orders and uses up the parts from stock. | Excluded | Trained | Alone | Alone | The agent gates work-order creation, start and completion. The Starter preparation and discovery checks deny work-order creation. Material consumption through an eligible agent scenario remains open. |
| 15 | Sorts every item into A, B and C classes each month. Classes drive counts and safety stock. | Alone | Alone | Alone | Alone | Policy only |
| 16 | Plans the yearly stocktake: freeze, count teams, differences and sign-off. | Excluded | Draft | Alone | Alone | Policy only |
| 17 | Shows stock by age and suggests a write-down for old stock. A person approves write-downs. | Suggest | Alone | Alone | Alone | Policy only |
| 18 | Shows what to order and why: sales speed, stock, incoming, lead time. | Alone | Alone | Alone | Alone | For the same SKU under all four plans, five available and seven incoming against a target of thirty yield an eighteen-unit reorder explanation. The review uses the live replenishment calculation, supplier lead time and recorded issue history. |
| 19 | Drafts purchase orders from the reorder list, grouped by supplier. | Draft | Trained | Alone | Alone | Replenishment tests exercise a single-supplier PO. Multi-supplier grouping still needs a scenario. |
| 20 | Places reorders on its own, under your $ limits per PO and per week. Growth: only to your Autopilot suppliers, with small limits. | Excluded | Alone | Alone | Alone | Growth repeat PO, supplier and SKU scope, per-order limits and a downgrade before delivery. External mail was simulated. |
| 21 | Keeps reorder points and min/max up to date from real sales. | Suggest | Trained | Alone | Alone | Policy only |
| 22 | Picks the cheapest or fastest supplier for each item. | Suggest | Suggest | Trained | Alone | A linked supplier is ranked from saved terms and measured lead time. Starter receives a suggestion. Automatic supplier switching and a competitive two-supplier case need verification. |
| 23 | Tops up an order to hit the supplier's minimum or free shipping. | Suggest | Trained | Alone | Alone | A seven-unit shortage with a supplier selling pairs of three-unit cases produced twelve units. It rose to eighteen when the extra six dollars cost less than shipping or a separate sixteen-dollar minimum required it. Starter got a suggestion. A stale approval was refused. |
| 24 | Combines small orders into one PO to save shipping. | Excluded | Trained | Alone | Alone | Policy only |
| 25 | Splits big POs by budget, warehouse or delivery date. | Excluded | Excluded | Trained | Alone | Policy only |
| 26 | Plans buying to a monthly budget (open-to-buy). | Excluded | Excluded | Excluded | Alone | Custom open-to-buy subtracts posted bill lines and unbilled order commitments once. Authenticated page, scheduled run, separate currencies, competing budget edits and lower-plan denials tested. Automated PO budget allocation remains open. |
| 27 | Orders in full cases, packs or pallets, not loose units. | Excluded | Trained | Alone | Alone | Verified six packs of three on the stored eighteen-unit PO. All eligible tiers expose saved pack terms. Starter could neither generate this agent order nor approve a higher-plan pack proposal after a downgrade. |
| 28 | Emails approved POs to the supplier. | Draft | Alone | Alone | Alone | Approved PO reaches the supplier outbox. No external mailbox delivery was tested. |
| 29 | Asks the supplier to confirm each PO and saves the ship date. | Excluded | Trained | Alone | Alone | A scoped supplier follow-up is created by the replenishment workflow under approved limits. Confirmation replies stop a queued request. Growth requires an active trained supplier rule for an unattended confirmation. Authenticated mail delivery is outstanding. |
| 30 | Chases late supplier deliveries. | Excluded | Alone | Alone | Alone | A Growth owner can approve a delivery chase for a PO. The test revokes the tier after queuing and confirms zero provider sends, including for an older queued message. Sending through a real mailbox remains open. |
| 31 | Updates a PO when the supplier changes qty, price or date (asks over your limit). | Excluded | Excluded | Trained | Alone | Policy only |
| 32 | Finds old open POs that will never arrive, so "incoming" is real. | Suggest | Alone | Alone | Alone | A four-unit approved PO overdue by two days with one unit received shows three units still due. Starter sees the supplier follow-up suggestion. The report does not cancel the order automatically. |
| 33 | The moment an item hits its reorder point, sends you a ready PO with a "Send to supplier" button. | Draft | Draft | Alone | Alone | Policy only |
| 34 | Uses real supplier lead times (actual vs promised) in every reorder. | Alone | Alone | Alone | Alone | Three received purchase orders, including split receipts, produce five observed planning days versus four configured. The replenishment engine reads the observed value. Existing replenishment cycle, concurrency and scale tests passed. |
| 35 | Gives suppliers a link, no login, to confirm a PO, change the date or upload their invoice or ship notice. | Draft | Alone | Alone | Alone | Starter owner-approved PO and Growth repeat PO produce scoped links. Chromium submitted a confirmation and a file. Service tests cover date validation, invoices and ship notices. |
| 36 | Shares your stock and a 12-week forecast with key suppliers every week. | Excluded | Draft | Alone | Alone | Policy only |
| 37 | Drop-ship: a customer order becomes a PO for the supplier to ship direct, with tracking passed back. | Excluded | Draft | Alone | Alone | Policy only |
| 38 | Plans import orders to fill a 20 ft or 40 ft container by volume and weight. | Excluded | Excluded | Trained | Alone | Policy only |
| 39 | Tracks ocean and air shipments and deposits, and keeps ETAs up to date. | Excluded | Alone | Alone | Alone | Policy only |
| 40 | Handles POs in other currencies and alerts you when exchange rates change landed cost. | Suggest | Alone | Alone | Alone | Policy only |
| 41 | Turns staff purchase requests ("we need more tape") into an approval, then a PO. | Excluded | Alone | Alone | Alone | Staff warehouse restrictions, submission, repeat submission, owner decision, decline, downgrade and draft PO quantity verified on PostgreSQL. Browser-form HTTP requests use login and CSRF. |
| 42 | Manages blanket POs: scheduled releases against a supplier contract. | Excluded | Excluded | Trained | Alone | Policy only |
| 43 | Fills the receiving form from the packing slip. A person taps confirm. | Excluded | Draft | Alone | Alone | Policy only |
| 44 | Checks what arrived against the PO: short, over or wrong item. | Suggest | Alone | Alone | Alone | A partial receipt of one out of four shows three still due. A wrong item and over-delivery still need scenarios. |
| 45 | Opens a claim with the supplier for short or damaged items. | Excluded | Excluded | Trained | Alone | Policy only |
| 46 | Adds photos of damaged boxes to the claim. | Excluded | Draft | Alone | Alone | Policy only |
| 47 | Prints labels and tells staff where to put each item away. | Excluded | Trained | Alone | Alone | Policy only |
| 48 | Sends arrived stock straight to waiting backorders. | Excluded | Trained | Alone | Alone | Policy only |
| 49 | Updates item cost with landed cost: freight, duty and fees. | Excluded | Excluded | Trained | Alone | Policy only |
| 50 | Tells sales and customers when a waited-for item is back in stock. | Excluded | Draft | Alone | Alone | Policy only |
| 51 | Puts new stock on QC hold until it passes inspection, so it can't be sold early. | Excluded | Trained | Alone | Alone | Policy only |
| 52 | Creates sales orders from customer emails and PDFs. | Excluded | Draft | Alone | Alone | Policy only |
| 53 | Repeats a customer's usual order from one sentence ("same as last month"). | Excluded | Trained | Alone | Alone | Ask prepares a repeat draft from a named customer and previous calendar month at current prices. Tested current totals, all tiers, ambiguous history, shadow, downgrade, stale quotes and replay. Autonomous execution with trained authority and natural-language model routing still need verification. |
| 54 | Checks each order for stock, credit, address and price problems. | Suggest | Alone | Alone | Alone | The open-order check showed four unreserved units and an overdue invoice on a partially allocated order. Verified Starter gets a suggestion and higher tiers see address, price and receivable checks. |
| 55 | Holds orders for customers who are overdue. | Excluded | Suggest | Alone | Alone | Pro and Custom with an owner-enabled rule and active automation blocked an order for an overdue receivable. A partial payment kept the hold. Full payment released the same draft. Growth gets a suggestion and neither lower tier can enable the rule. |
| 56 | Releases orders to the warehouse in the best pick order. | Excluded | Trained | Alone | Alone | Policy only |
| 57 | Builds pick lists and pick waves by zone. | Excluded | Trained | Alone | Alone | The agent gates wave creation, scanning, packing, shortages and refresh before proposal generation and again at execution. Starter discovery and scan proposal denials were exercised. Full physical wave verification per eligible tier remains open. |
| 58 | Picks the cheapest shipping rate that still meets the promise date. | Suggest | Trained | Alone | Alone | Policy only |
| 59 | Buys shipping labels (within your $ per label). | Draft | Alone | Alone | Alone | Policy only |
| 60 | Tells customers their order has shipped, with tracking. | Alone | Alone | Alone | Alone | Policy only |
| 61 | Splits an order when part is out of stock and ships the rest. | Excluded | Excluded | Trained | Alone | Policy only |
| 62 | Watches tracking and flags late or lost parcels. | Excluded | Alone | Alone | Alone | Tracking review identifies overdue parcels and carrier exceptions through the owner page. Tested all plans and clearing the exception. Live carrier updates still need verification. |
| 63 | Files carrier claims for lost or damaged parcels. | Excluded | Excluded | Trained | Alone | Policy only |
| 64 | Manages backorders: who's waiting and what ships first. | Suggest | Draft | Alone | Alone | Backorder review shows unallocated quantities in priority order and distinguishes partially allocated orders. Starter sees a suggestion. Automatic release and dispatch remain open. |
| 65 | Shares out scarce stock between orders by your priority rules. | Excluded | Excluded | Trained | Alone | Starter and Growth cannot prepare a change to an order’s allocation priority through Ask. Rule-based, multi-order allocation on eligible tiers still needs testing. |
| 66 | Books freight pickups for pallets (LTL). | Excluded | Excluded | Excluded | Alone | Policy only |
| 67 | Creates standing and recurring customer orders on their schedule. | Excluded | Trained | Alone | Alone | Policy only |
| 68 | Takes pre-orders on incoming stock and fills them as soon as it arrives. | Excluded | Draft | Alone | Alone | Policy only |
| 69 | Checks the ship-to address before buying a label. | Alone | Alone | Alone | Alone | Policy only |
| 70 | Prepares international paperwork: commercial invoice, HS codes and customs forms. | Excluded | Draft | Alone | Alone | Policy only |
| 71 | Plans delivery routes for your own vans. | Excluded | Excluded | Trained | Alone | Policy only |
| 72 | Answers customer emails about stock, delivery dates and order status. | Excluded | Trained | Alone | Alone | Policy only |
| 73 | Writes a quote from a customer's request in minutes. | Excluded | Excluded | Trained | Alone | Policy only |
| 74 | Follows up on open quotes after the number of days you choose. | Excluded | Trained | Alone | Alone | Policy only |
| 75 | Turns an accepted quote into an order. | Excluded | Draft | Alone | Alone | Policy only |
| 76 | Uses each customer's own price list, discounts and terms. | Excluded | Alone | Alone | Alone | Policy only |
| 77 | Suggests new selling prices when costs go up, to protect margin. | Suggest | Suggest | Draft | Draft | Policy only |
| 78 | Finds customers who stopped buying and drafts a check-in. | Excluded | Excluded | Trained | Alone | Two fulfilled orders for the same customer, backdated by 100 days, produce a check-in draft naming the customer. A recent shipment prevents that draft. Growth direct access is denied. |
| 79 | Adds "customers also buy" items to quotes. | Suggest | Draft | Alone | Alone | A fulfilled coffee order and grinder produce a matching companion-item suggestion. Writing the item to a quote is outstanding. |
| 80 | Checks credit limits before big orders. | Suggest | Alone | Alone | Alone | Policy only |
| 81 | Sends a customer their account statement when asked. | Excluded | Trained | Alone | Alone | Policy only |
| 82 | Flags orders priced below cost or with a wrong discount. | Alone | Alone | Alone | Alone | Policy only |
| 83 | Takes orders by WhatsApp, SMS or a simple B2B order page. | Excluded | Excluded | Trained | Alone | Policy only |
| 84 | Answers stock and delivery questions in your website chat, inside your rules. | Excluded | Excluded | Alone | Alone | Policy only |
| 85 | Shows true net margin per item, channel and customer, after marketplace fees, shipping and returns. | Suggest | Alone | Alone | Alone | Policy only |
| 86 | Builds a clearance plan with the cash it should bring back. A person approves prices. | Suggest | Draft | Draft | Draft | Policy only |
| 87 | Checks prices match across channels and flags minimum advertised price (MAP) breaks. | Excluded | Alone | Alone | Alone | Policy only |
| 88 | Scores each customer's health and flags the ones buying less. | Suggest | Alone | Alone | Alone | The customer health review counts a recorded carrier handoff, and identifies new activity. The four-plan access test also runs this review. |
| 89 | Emails suppliers about orders, dates and questions. | Excluded | Trained | Alone | Alone | General supplier email preparation is denied on Starter. An eligible PO-specific follow-up retains a scoped supplier link and requires fresh send authority. Provider acceptance from a real mailbox remains unverified. |
| 90 | Scores each supplier: on time, fill rate, price changes, errors. | Suggest | Alone | Alone | Alone | Fully received PO produces 100% fill on a supplier scorecard. Multiple suppliers with late and disputed deliveries still need a populated scenario. |
| 91 | Spots supplier price increases on invoices and price lists. | Suggest | Alone | Alone | Alone | Recorded invoice 50% over approved price is linked to its PO. Supplier price-list comparison still needs a positive source document. |
| 92 | Compares quotes from several suppliers for the same item. | Excluded | Draft | Alone | Alone | Two separate supplier mailbox messages with quotations for the same SKU create source-linked rows at $1.25 and $1.50. Growth, Pro and Custom receive the comparison. Starter is denied. |
| 93 | Sends requests for quotes (RFQs) to several suppliers. | Excluded | Excluded | Trained | Alone | Policy only |
| 94 | Drafts a negotiation email with your data ("you were late 6 times"). | Excluded | Excluded | Draft | Trained | Policy only |
| 95 | Switches to your backup supplier when the main one is out, or doesn't confirm in the days you set. | Excluded | Excluded | Trained | Alone | Policy only |
| 96 | Keeps supplier lead times, MOQs and contacts up to date from their emails. | Excluded | Trained | Alone | Alone | Policy only |
| 97 | Tracks supplier rebates and volume discounts so you claim them. | Excluded | Suggest | Alone | Alone | Policy only |
| 98 | Reads supplier invoices and matches them to the PO and the receipt. | Draft | Draft | Alone | Alone | Each of the four paid tiers prepares an invoice from a supplier-linked source email. Approval posts one payable against real received units. Repeat approval preserves one bill and leaves stock and cash unchanged. Starter document 51 is held until upgrade. Unattended mailbox-to-payable processing and authenticated provider delivery still need qualification. |
| 99 | Flags invoice errors: wrong price, double billing, items never received. | Suggest | Alone | Alone | Alone | Overbilled quantity and higher price correctly produce two differences. A duplicate with changed evidence is rejected and the disputed invoice stays out of the pay run. |
| 100 | Disputes wrong invoices with the supplier. | Excluded | Excluded | Trained | Alone | Policy only |
| 101 | Creates customer invoices when orders ship. | Excluded | Trained | Alone | Alone | Policy only |
| 102 | Sends payment reminders on your schedule. | Excluded | Trained | Alone | Alone | Policy only |
| 103 | Matches customer payments to invoices. | Excluded | Trained | Alone | Alone | Policy only |
| 104 | Prepares the weekly supplier payment run. You approve and pay. | Excluded | Draft | Alone | Alone | A posted bill due this week appears in the payment run. Expected review amount subtracts the documented early discount. No payment is posted. |
| 105 | Tracks supplier credit notes and makes sure they get used. | Excluded | Suggest | Alone | Alone | A shipped supplier return appears with its expected $1.00 credit. Applying CN-101 through an approved agent action reduces the source bill once, updates the queue and records $1.00 on the ROI report. |
| 106 | Shows how much cash is tied up in stock, and what to free up. | Alone | Alone | Alone | Alone | Stock value report ran as one step in a Growth playbook. |
| 107 | Prepares refunds and credits. A person always approves. | Excluded | Excluded | Draft | Draft | Starter and Growth refund preparation and an existing Pro proposal after downgrade have denial tests. A complete refund still needs a money-safe test. |
| 108 | Catches early-payment discounts (like 2% off in 10 days) and puts them in the payment run. | Suggest | Alone | Alone | Alone | A posted $2.00 bill with original 2/10 net 30 terms produces a $0.04 opportunity and $1.96 payment review amount after supplier terms change. |
| 109 | Forecasts cash for 13 weeks: PO payments due vs money coming in. | Excluded | Suggest | Alone | Alone | Thirteen forecast weeks are returned per currency. A bill for half a PO is in its due week. Only the unbilled half appears in the later supplier-terms week. |
| 110 | Tracks purchase budget vs actual, by month and category. | Suggest | Alone | Alone | Alone | Monthly category budgets compare posted purchases in their original currency. Tested a partial bill, owner edits with revision checks, Starter suggestions and Growth, Pro and Custom figures. |
| 111 | Creates a return (RMA) from a customer's return email. | Excluded | Trained | Alone | Alone | Policy only |
| 112 | Sends the return label and instructions. | Excluded | Trained | Alone | Alone | Ask refuses Starter return-postage preparation, and discovery omits the locked action. A provider receipt and delivered customer instructions still need verification. |
| 113 | Decides restock, repair or scrap by your rules. | Excluded | Excluded | Trained | Alone | Starter and Growth cannot prepare an agent return inspection. Eligible automated disposition based on explicit rules and an inspection still needs verification. |
| 114 | Puts returned items back into stock after staff check them. | Excluded | Draft | Alone | Alone | Starter agent preparation to receive a customer return was denied. An eligible received return with inspection and restock needs an agent scenario. |
| 115 | Sends faulty goods back to the supplier and tracks the credit. | Excluded | Excluded | Trained | Alone | The agent gates supplier return requests, authorization, shipment and credit reconciliation. A shipped return followed by a Pro-approved credit reduces the correct open bill once. The lower tiers cannot prepare the reconciliation. |
| 116 | Spots items and customers with high return rates. | Suggest | Alone | Alone | Alone | Return rates use physically received goods and fulfilled units by customer and SKU. Verified an actual receipt updates the result and Starter sees only a suggestion. |
| 117 | Shows stock across all locations in one answer. | Alone | Alone | Alone | Alone | One SKU was received at Dispatch and transferred to Annex. The review reports nine units at Dispatch and three at Annex from the posted physical records. |
| 118 | Suggests transfers to balance stock between locations. | Suggest | Trained | Alone | Alone | Growth cannot enable autonomous transfers. |
| 119 | Makes transfers on its own, under your unit limit. | Excluded | Excluded | Alone | Alone | Growth transfer execution is gated; Pro can configure unit limits. An actual completed transfer per tier remains open. |
| 120 | Sets reorder points per location. | Excluded | Trained | Alone | Alone | Policy only |
| 121 | Picks the best warehouse to ship each order from. | Excluded | Draft | Alone | Alone | Policy only |
| 122 | Plans a re-slot: fast movers near packing, with a move list. | Excluded | Excluded | Draft | Alone | Policy only |
| 123 | Tracks stock at 3PLs and consignment locations. | Excluded | Alone | Alone | Alone | Policy only |
| 124 | Checks transfers arrived complete and chases ones stuck in transit. | Excluded | Alone | Alone | Alone | Policy only |
| 125 | Rolls up stock across several companies or inventories. | Excluded | Excluded | Excluded | Alone | Custom cross-inventory summary ran on test data. A Growth and a Pro attempt were blocked. |
| 126 | Finds duplicates, missing cost or weight, and bad SKUs, and fixes them in bulk. | Suggest | Draft | Trained | Alone | Policy only |
| 127 | Creates products from a supplier catalog or price list. | Excluded | Draft | Alone | Alone | Policy only |
| 128 | Writes product titles and descriptions for each sales channel. | Excluded | Draft | Alone | Alone | Policy only |
| 129 | Fills missing barcodes, weights and sizes from supplier data. | Excluded | Draft | Alone | Alone | Policy only |
| 130 | Builds sizes and colors (variants) from a spreadsheet. | Excluded | Draft | Alone | Alone | Policy only |
| 131 | Suggests categories and tags for new products. | Excluded | Alone | Alone | Alone | Policy only |
| 132 | Retires discontinued items and points staff to the replacement. | Excluded | Excluded | Trained | Alone | Policy only |
| 133 | Reads an import file and maps the columns. | Draft | Alone | Alone | Alone | Policy only |
| 134 | Keeps units straight: case vs each, kg vs lb. | Excluded | Alone | Alone | Alone | Policy only |
| 135 | Reads supplier price lists and updates costs (asks if over 5%). | Excluded | Excluded | Trained | Alone | Policy only |
| 136 | Reads spec sheets and safety sheets and saves the key facts. | Excluded | Draft | Alone | Alone | Policy only |
| 137 | Reads bills of lading and customs papers and links them to the PO. | Excluded | Draft | Alone | Alone | Policy only |
| 138 | Watches a shared inbox and sorts every email: order, invoice, question, junk. | Excluded | Alone | Alone | Alone | Policy only |
| 139 | Reads handwritten count sheets and delivery notes. | Excluded | Draft | Alone | Alone | Policy only |
| 140 | Counts boxes and reads labels from a shelf photo. | Excluded | Excluded | Draft | Trained | Policy only |
| 141 | Does the paperwork from a voice note ("3 boxes of X just came in"). | Excluded | Draft | Alone | Alone | Policy only |
| 142 | Files every document on the right PO, order or product. | Excluded | Alone | Alone | Alone | Policy only |
| 143 | Reads contracts and pulls out prices, terms and end dates. | Suggest | Suggest | Alone | Alone | Policy only |
| 144 | Forecasts demand for each item, with seasons. | Suggest | Alone | Alone | Alone | Confirmed sales on fifteen prior weekdays produced the expected seven- and thirty-day forecasts. Growth and higher see the selected model and its held-out error. Starter gets one suggestion. |
| 145 | Plans stock for a promotion or sale and drafts the POs. | Excluded | Excluded | Draft | Alone | Policy only |
| 146 | Forecasts new products using similar items. | Excluded | Suggest | Alone | Alone | A matching category and compatible units yielded 30 projected units from confirmed orders on a comparison SKU. An unrelated item returned no estimate. Verified Starter denial, Growth suggestion and both higher tiers. |
| 147 | Plans ahead for holidays and supplier shutdowns (e.g. Chinese New Year). | Excluded | Suggest | Alone | Alone | Policy only |
| 148 | Spots trends early: an item suddenly selling faster. | Suggest | Alone | Alone | Alone | The rising-demand review identifies a newly shipped SKU from an actual recorded carrier handoff. |
| 149 | Answers "what if" questions ("what if sales go up 20%?"). | Excluded | Alone | Alone | Alone | Growth, Pro and Custom model the 30-day effect of a sales percentage specified by the user. Three shipped units in 90 days produce baseline demand of 1 and projected demand of 1.2 at +20%. A 100% decrease yields zero. Starter direct access refused. This covers sales volume scenarios. |
| 150 | Sets safety stock by how often you can afford to run out. | Excluded | Draft | Alone | Alone | Policy only |
| 151 | Shows when each item will run out, and what running out costs. | Alone | Alone | Alone | Alone | A fulfilled parcel and recorded prices produced the tested available units, projected stockout date and daily gross margin at risk on all four plans. |
| 152 | Answers any question in plain words, in any language. | Alone | Alone | Alone | Alone | Policy only |
| 153 | Shows the records behind every answer. | Alone | Alone | Alone | Alone | Policy only |
| 154 | Builds a report from one sentence. | Alone | Alone | Alone | Alone | One-sentence governed report generated, saved and queried locally. Provider outputs were simulated. Graph and schedule browser regressions exercised the reports service. |
| 155 | Emails reports on a schedule. | Alone | Alone | Alone | Alone | Report schedule saved against PostgreSQL. External email delivery needs a provider run. |
| 156 | Sends a briefing: what happened and what needs you. | Alone | Alone | Alone | Alone | Policy only |
| 157 | Explains changes ("why did margin drop in March?"). | Excluded | Alone | Alone | Alone | The prior two calendar months use posted revenue and cost of goods. In the test revenue grew $2, costs grew $3 and gross profit fell $1. Starter was denied. Growth, Pro and Custom opened the underlying ledger. The report explains the accounting change. Operational causes such as mix still need analysis. |
| 158 | Month-end stock value and cost of goods report. | Excluded | Alone | Alone | Alone | A historical $30 inventory purchase and two cost-of-goods postings produce $15 of month-end stock and $9 cost of goods for the selected month. The current-month receipt is excluded. Growth, Pro and Custom see the ledger-backed result and Starter is denied. |
| 159 | Board or investor pack with charts. | Excluded | Excluded | Excluded | Alone | Policy only |
| 160 | Exports any answer to Excel or PDF. | Alone | Alone | Alone | Alone | Both saved Ask answers and native goals export prose to Excel and PDF on every plan. Existing table exports and phone download controls tested. |
| 161 | Monthly ROI report: hours saved (counted from real actions) and $ caught vs your plan price. | Alone | Alone | Alone | Alone | Seven- and thirty-day reports count five kinds of evidenced work. One approved staff PO saves six minutes using the recorded sample. An open $1.50 price difference, a $1.00 applied supplier credit and the account base price are listed separately. Accounting exports count only once after the provider record has been verified. Figures in these tests use fictional business data. |
| 162 | Stock health report: turns, GMROI and days of supply per item. | Suggest | Alone | Alone | Alone | Policy only |
| 163 | Forecast accuracy, fill rate and on-time-in-full, for customers and suppliers. | Excluded | Alone | Alone | Alone | Policy only |
| 164 | Supplier review pack you can send to the supplier each quarter. | Excluded | Excluded | Alone | Alone | Pro playbook queries the prior quarter. An actual supplier review with a populated quarter and delivery remains open. |
| 165 | Year-end stocktake and valuation pack for your accountant. | Excluded | Alone | Alone | Alone | Policy only |
| 166 | Low stock and stock-out alerts. | Alone | Alone | Alone | Alone | Low-stock report runs as a playbook step. End-to-end alert delivery remains open. |
| 167 | Watch rules in plain words ("tell me if any Nike item drops under 20"). | Alone | Alone | Alone | Alone | Policy only |
| 168 | Late POs, late shipments and overdue invoices. | Alone | Alone | Alone | Alone | Operational exceptions review includes overdue purchase orders, customer and supplier invoices and shipped parcels. Verified open and cleared records using business dates. External alert delivery remains open. |
| 169 | Sales channel problems: oversell risk, sync stopped. | Alone | Alone | Alone | Alone | Policy only |
| 170 | Cost and margin alerts: cost up, margin under your %. | Excluded | Alone | Alone | Alone | Policy only |
| 171 | Unusual activity: big adjustment, changes at night. | Excluded | Excluded | Alone | Alone | Policy only |
| 172 | Passes an alert to the next person if no one answers. | Excluded | Excluded | Alone | Alone | Policy only |
| 173 | Sends alerts by push, SMS or email: you choose per alert. | Alone | Alone | Alone | Alone | Policy only |
| 174 | Needs you: one list of every decision, approve similar ones in one tap. | Alone | Alone | Alone | Alone | Policy only |
| 175 | Lets you approve from email or phone. | Alone | Alone | Alone | Alone | Policy only |
| 176 | Sends each approval to the right person by role and amount. | Excluded | Excluded | Alone | Alone | Policy only |
| 177 | Gives staff tasks (count this shelf, pick this order) and checks they're done. | Excluded | Draft | Alone | Alone | Policy only |
| 178 | Writes step-by-step SOPs from how your team really works. | Excluded | Draft | Alone | Alone | Policy only |
| 179 | Answers staff "how do I…" questions inside the app. | Alone | Alone | Alone | Alone | Policy only |
| 180 | Daily team summary: who did what, and what's late. | Excluded | Alone | Alone | Alone | Policy only |
| 181 | Logs everything it did and why, with undo where possible. | Alone | Alone | Alone | Alone | Policy only |
| 182 | Watches Shopify, Amazon, eBay and Woo sync and fixes common errors. | Suggest | Alone | Alone | Alone | Policy only |
| 183 | Sets stock buffers per channel so you never oversell. | Excluded | Draft | Alone | Alone | Policy only |
| 184 | Sends invoices and bills to QuickBooks or Xero. | Excluded | Excluded | Trained | Alone | A Pro-approved journal export was posted and independently verified through the QuickBooks adapter using simulated HTTP. A queued export after downgrade produced no provider call. Starter/Growth discovery and proposal preparation were denied. Xero and bill/invoice-level synchronization remain unqualified. |
| 185 | Handles EDI orders, ship notices (ASN) and invoices with big retailers. Pro: paid add-on. | Excluded | Excluded | Alone | Alone | Orderful test-stream adapter and scheduled rule exercised with simulated provider responses. A validated 850 creates one sales order. A confirmed order, recorded warehouse handoff and posted invoice produce an 855, 856 and 810. Unknown submission outcomes require provider document reconciliation. Changes are retained for review and block outbound documents. Starter, Growth, Pro without a paid grant and queued work after downgrade were denied. Retailer certification, amendment resolution and authenticated sandbox acceptance remain open. |
| 186 | Sends orders to your 3PL and reads their stock and shipping back. | Excluded | Draft | Alone | Alone | ShipBob test API adapter connects a verified channel, approves and submits an order, recovers a lost response without duplicate orders, and reads split tracking and inventory quantities. Growth manual, Pro warehouse rule, shadow period, revoked authority and queued downgrade tested with simulated transport. Live sandbox credentials and qualification outstanding. |
| 187 | Reads your Gmail or Outlook and drafts replies. | Excluded | Draft | Alone | Alone | Policy only |
| 188 | Answers you in Slack, Teams or WhatsApp. | Excluded | Excluded | Alone | Alone | Policy only |
| 189 | Starts jobs from your other systems (API) and sends webhooks. | Excluded | Excluded | Excluded | Alone | Policy only |
| 190 | Moves your data in from your old system on day one. | Excluded | Draft | Alone | Alone | Policy only |
| 191 | Warns before stock expires and suggests where to sell it first. | Alone | Alone | Alone | Alone | Expiring inventory is paired to an unfilled order due before expiry, verified by its order number. Expiry-prioritized goods then ship. |
| 192 | Picks oldest or soonest-to-expire first (FIFO / FEFO) when reserving. | Excluded | Draft | Alone | Alone | Policy only |
| 193 | Traces a recall in minutes: which customers got which lot. | Alone | Alone | Alone | Alone | The posted stock issue identifies which customer received the lot and the number of units, across two fulfillments. Starter can trace after a downgrade. |
| 194 | Blocks recalled or expired lots from being shipped. | Excluded | Alone | Alone | Alone | Owner recalls a batch through the authenticated form. Normal issue and earliest-expiry fulfillment both refuse it, including after downgrade. Release and stale revision checked. |
| 195 | Shows a serial number's full history. | Alone | Alone | Alone | Alone | A scanned serial has its receipt and issue in order. After handoff the exact serial lookup shows it as issued. |
| 196 | Links certificates (CoA, safety sheets) to lots and flags missing ones. | Excluded | Draft | Alone | Alone | An owner marks a certificate required, then supplies an expired and a current document. The coverage review changes status each time. Starter direct write denied. |
| 197 | Prepares audit and compliance reports. | Excluded | Draft | Alone | Alone | The lot audit lists the logged recall, responsible person, time and reason, with two decisions after release. Other compliance reports are outside this scenario. |
| 198 | Shadow mode: for 14 days it only watches, then shows what it would have done and saved. | Alone | Alone | Alone | Alone | New-account purchasing stays in shadow mode for 14 days. Full coverage and the end-of-shadow comparison remain open. |
| 199 | Shows how sure it is on every action, and asks when it isn't sure enough. | Alone | Alone | Alone | Alone | Policy only |
| 200 | Gives you a data health score on day one, with a fix list. | Alone | Alone | Alone | Alone | Policy only |
| 201 | Pauses itself if spend or volume looks unusual (circuit-breaker). | Excluded | Alone | Alone | Alone | Policy only |
| 202 | Vacation mode: sends approvals to a deputy while the owner is away. | Excluded | Alone | Alone | Alone | Policy only |
| 203 | Hides costs and margins from roles that shouldn't see them. | Excluded | Alone | Alone | Alone | Policy only |
| 204 | Daily "what I did" digest, with one-tap undo. | Excluded | Alone | Alone | Alone | Policy only |
| 205 | Needs two people to approve anything over the $ you set. | Excluded | Excluded | Alone | Alone | Policy only |
| 206 | Suggests what to automate next each month, with the hours it would save. | Alone | Alone | Alone | Alone | Policy only |
| 207 | Follows rules you write in plain words ("always split POs over $10k"). Starter: up to 5. | Alone | Alone | Alone | Alone | Five Starter reorder instructions saved; sixth rejected and existing rule edited. Other rule types need scenarios. |
| 208 | Learns from your approvals and stops asking about what you always OK. | Excluded | Alone | Alone | Alone | Policy only |
| 209 | Suggests a new rule when it sees you fix the same thing again and again. | Excluded | Alone | Alone | Alone | Policy only |
| 210 | Tests a new rule on past data first and shows what it would have done. | Excluded | Alone | Alone | Alone | Policy only |
| 211 | Learns each customer's and supplier's habits. | Excluded | Alone | Alone | Alone | Policy only |
| 212 | Reads your SOP documents and follows them. | Excluded | Excluded | Alone | Alone | Policy only |
| 213 | Runs your custom playbooks (multi-step jobs), on a schedule too. | Excluded | Trained | Alone | Alone | Saved playbooks include eligible operational reviews. Growth cap, scheduled execution, replay and permission changes are verified. Parameterized lookups are run on demand. |
| 214 | Remembers how each manager likes their reports and approvals. | Excluded | Excluded | Excluded | Alone | Policy only |
