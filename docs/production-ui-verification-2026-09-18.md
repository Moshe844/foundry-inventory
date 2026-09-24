# StockChief operational fixes and real mailbox verification

## Release decision

**Not yet approved for production launch.** Billing and subscriptions were not added. The outstanding operational and deployment requirements remain requirements, not completed features or waived release gates.

These changes and tests use isolated databases. Live mailbox verification runs in an OBSERVE workspace with no scheduled workers. No supplier or customer was contacted, no physical inventory was changed, and no payment, accounting-provider posting or postage purchase was executed by the live mailbox tests.

## Implemented operational fixes

- Automatic repair recovery no longer replays consequential work while the operation is paused, watching only, stopped for repairs, or running a read-only/preparation turn. It can still verify an effect already proved by records. Resume permits eligible, authorized recovery again.
- Granted learning changes no longer automatically update purchasing settings while paused or blocked for purchasing. Explicit human decisions remain distinct from automatic rollout.
- Gmail and Microsoft mailbox polling follows all provider pages, deduplicates message identities, and fails visibly when pagination repeats or exceeds the safety limit. Microsoft polling overlaps the previous check by fifteen minutes. The successful watermark uses the beginning of the check, not the end, so processing time cannot create a gap.
- Mailbox authorization no longer marks generic connection discovery as a successful mail check. First checks preserve the initial lookback rather than starting from an invented successful watermark.
- Paused or disconnected mailboxes cannot be polled. Failed authorization visibly says no mailbox is authorized, offers retry, and disables checking; it no longer advertises a ready inbox.
- Cross-origin OAuth returns preserve a route back to the signed-in local StockChief session, including failed consent and reconnect flows.
- Ask recognizes explicit outbound instructions without depending on a model classifier. Explicit Subject and Body fields are preserved literally, and an explicitly requested Gmail or Outlook sender is resolved to that provider. Missing or ambiguous senders require clarification instead of substitution.
- Message preparation screens exclude unavailable mailboxes and require a sender choice when multiple usable mailboxes exist and none has been chosen. If an explicitly chosen sender later becomes unavailable, the screen leaves the choice empty and explains why; it does not default to the remaining provider. Saving or cancelling is still possible without a usable sender, while sending requires a choice.
- A nested reading cancellation preserves the enclosing catalogue job's actual deadline reason rather than incorrectly reporting a connection failure. A provider that ignores cancellation still cannot keep the user waiting indefinitely.

## Real Gmail UI verification

The owner completed Google's account choice and consent. The connected identity displayed in StockChief is `mysolutionstesting@gmail.com`.

The first live Ask draft exposed a real defect: it ignored the requested subject and used the other mailbox as its sender. That draft was **not sent**. The subject/body/sender fix was implemented before continuing.

The corrected draft, prepared through Ask and reviewed on the message screen, used:

- Recipient and sender: the designated Gmail account itself, explicitly approved by the owner.
- Subject: `StockChief mailbox verification TEST-20260918-B`.
- Body: `This is a controlled mailbox test. No purchase, customer order, inventory movement or financial transaction is requested.`

The StockChief Send control showed the sent record. An independent Gmail frontend search verified actual inbox delivery of the exact subject/body, rather than relying only on provider acceptance.

The manual StockChief check captured the test as **Not for StockChief**, because its contents explicitly request no operational work. The owner workflow's **This is business** control brought it into review. Its page correctly showed an untrusted sender, no operational mutation and nothing requiring an answer. A model-written reply referred to absent order/shipment/invoice records in this empty workspace; it did not invent transaction figures, but it was unnecessarily generic for a controlled test. That generated text was replaced with a literal acknowledgment before sending.

The approved reply was sent only to the same account. Gmail's frontend showed one conversation with two messages and the exact acknowledgment: `Acknowledged: this is the controlled StockChief mailbox verification test. No operational action is required.` StockChief showed the sent reply and Waiting on them. A subsequent repeated mailbox check left the captured message history at one, rather than duplicating the original business message. The non-business reply itself does not establish automatic purchasing-document reconciliation.

This proves this specific authorization, preparation, sending, delivery, intake, review, reply and replay path. The subsequent real authorization refresh is described below. It does **not** prove unattended long-lived token renewal, expired-consent recovery, signed webhook fallback, automatic supplier reconciliation, or all mailbox content types.

## Real Outlook UI verification

Microsoft consent returned a connected identity, `moshe@registeronepos.com`. StockChief's **Check Microsoft now** control completed and showed a successful fresh check with no new supplier messages requiring processing. No message has been sent from Outlook by this verification as of this report; a separate controlled self-test was requested from the owner.

This is real authorization and provider polling evidence, not Outlook delivery/reply or expiry certification.

## Browser fixture boundaries

`tests/e2e/operational-safety.e2e.js` exercises actual application pages and forms against `tests/helpers/operational-safety-server.js`. Fixtures establish interrupted repair work, a narrowly authorized supplier-setting proposal, and fake Gmail/Microsoft pages. The timer uses the real manager loop. Mutations and outcome assertions are through the browser UI, not database assertions or direct HTTP calls.

The mailbox pagination tests contain 75 unique messages per provider, a repeated identity between pages, replayed checks, pause/resume controls, and an intentionally repeating provider page. These are deterministic fault-injection tests, **not live busy-mailbox certification**. The catalogue timeout fixture uses an intentionally stalled reader and a shortened test deadline; it does not wait thirty real seconds.

Run `npm run test:operational-ui`. The suite is also included in `npm run test:e2e` and the full browser certification script. The six-month historical UI scenario and its boundaries are described in the September 17 report.

## Completed focused regression evidence

- Earlier complete local `npm run test:e2e` run: **162 passed, 0 failed, 0 skipped, 0 cancelled**, approximately eleven minutes. Log: `artifacts/ui-launch-verification-2026-09-18.log`. This run included eight operational safety checks. The final complete 175-test run below supersedes this earlier baseline and includes all added browser cases.
- Latest operational UI suite plus message HTTP regression checks: **21 passed, 0 failed, 0 skipped**. Log: `artifacts/operational-safety-final.log`. This contains ten browser safety checks and eleven existing HTTP integration checks; the latter are not browser tests.
- Operational browser safety suite, including the new catalogue cancellation screen: **9 passed, 0 failed, 0 skipped**. Log: `artifacts/operational-safety-ui.log`.
- Operational browser suite plus existing message HTTP integration checks, before adding the catalogue browser case: **19 passed, 0 failed, 0 skipped**. Log: `artifacts/operational-safety-message.log`.
- Manager, assistant, continuous operation, job runner and reading deadline regressions: **95 passed, 0 failed, 0 skipped**. Log: `artifacts/manager-message-regression.log`.
- Repair, learning and real-connector/supplier-communication integration regressions: **102 passed, 0 failed, 0 skipped**. Log: `artifacts/operational-safety-targeted.log`.

These test groups overlap and must not be added together as a unique scenario count. An attempted broad `npm test` run was interrupted to avoid competing with the live browser regression for CPU; its partial log is not a complete pass. No deployed browser or load certification was recorded from these local runs. Disposable connector fixtures can create their own token-refresh checkpoints; those are not evidence in the live verification workspace.

## Safe live verification workspace

Run `node --use-system-ca scripts/start-integration-verification.js --start` with Node 24 and the approved local OAuth configuration. The Windows trusted certificate store resolved the local provider connection problem while certificate validation stayed enabled. No insecure TLS bypass is used.

The launcher uses ignored `data/integration-verification/verification.sqlite`, refuses the configured business database path, and stores a random local owner login in ignored `data/integration-verification/login.json`. It binds port 4000 on loopback and does not launch schedulers. This workspace permits explicitly approved live mailbox side effects; it is not a production deployment or provider sandbox. OAuth credentials remain encrypted using the installation's configured encryption key. Do not share the login file, database or OAuth credentials.

## Outstanding launch requirements

The actual Production operations UI initially reported **8 of 28 checks pass**. After the real Gmail/Microsoft authorization refresh checks, it reports **9 of 28 checks pass** with token refresh marked PASS and **Production gate is blocked**. The provider service records that real refresh automatically; no certification evidence was manually manufactured to turn the screen green. This is a local empty-workspace snapshot, not a product-completeness percentage or deployed-release certification.

- Implement and validate the certified shared multi-writer database topology required by the existing production contract. SQLite remains explicitly single-writer; a readiness flag is not a migration.
- Choose production hosting and an immutable release identity. Prove off-site backup, hosted restore, rollback, monitored support, retention, password-recovery delivery and alert delivery/acknowledgment.
- Complete real provider expiration/refresh, signed webhooks, fallback and replay qualification. Verify payment settlement/refunds, customer-funded shipping and delivery events, and accounting-provider sync/posting/reconciliation in designated test accounts before live financial activity.
- Complete two consecutive deployed-release browser regressions, production-like load/worker qualification, and an independent uncoached walkthrough.
- Implement and test the remaining unsupported subrequirements in the ten complex weekly business jobs. In particular, complete transfer-versus-purchase economics, invoice/receipt/price variance resolution, scale allocation with all requested constraints and full multi-domain Monday operations are not established. Recorded-price supplier-pack economics and six-month completion performance now have the specific browser evidence below, not universal procurement coverage.
- Extend exact calendar-period and scope handling to all older financial lookups. Product-specific quarter profitability, the additional financial totals and supplier review below are verified; that does not make every report accurate.

The core notice → decide → prepare → execute → verify → report promise is better covered in specific inventory and purchasing workflows, but an unattended end-to-end operator across all requested domains is **not yet demonstrated**.

## Further gap closure: purchasing, historical reports and mailbox safety

### Supplier performance

`src/forecasting/supplier-reliability.js` now reviews the full committed-order cohort, rather than only the last twelve delivered orders. Overdue unreceived orders count as missed completion promises. A small on-time partial receipt no longer makes an ultimately late completed order on time. Unfinished orders with future promised dates are not counted as on-time successes or late failures. The supplier page distinguishes committed orders, completed-by-promise performance and recent first-receipt timing.

`src/forecasting/questions.js` carries the requested exact review dates into supplier scoring and reports the cohort, completion count, overdue count and rated denominator. Ambiguous supplier names require clarification. Ask's six-month scenario uses March 18 through September 18, not a silently substituted thirty-day or approximate 180-day review. Recent first-receipt lead-time samples remain a separate planning measurement; these changes do not implement a universal invoice-price-variance review.

### Supplier economics

`src/purchasing/replenishment.js` compares known same-currency order totals after applying case packs, minimum quantities and order multiples when the needed inventory-unit quantity is known. Explicit supplier preferences remain explicit policy. Unknown prices are not treated as free, and different currencies are not compared without exchange-rate evidence. `src/purchasing/purchase-intent.js` passes inventory-unit requirements into this comparison without treating explicitly requested cases as individual units.

The browser scenario requires twelve units: the dollar-per-unit supplier has a thousand-unit minimum and costs $1,000, while the two-dollar supplier's cases of six cost $24 for the required twelve units. StockChief chooses the latter and discloses that freight, tax and supplier-wide minimum spend are excluded. This is a real improvement in recorded-price/pack economics, **not complete global procurement optimization**. Forecast-derived targets and transfer-versus-buying economics still require further work.

### Calendar periods and complete totals

`src/attention/report-period.js` resolves numeric rolling days/weeks/months, including real calendar-month subtraction with month-end clamping. Exact calendar boundaries now reach profit and loss, customer payments, supplier spend, period profit-versus-cash and location profitability through `src/attention/query-service.js`.

Customer-payment and supplier-spend totals include all matching records before limiting displayed rows. They exclude later-quarter and future-dated activity. Supplier cash payments are included even when that supplier has no purchases during the selected period; purchases and cash are explicitly different measures. This does not certify every older report, every historical balance or all entity-scope requirements.

### Preparation is not approval or recovery execution

General purchasing requests prepare work rather than approving orders or executing other authorized inventory jobs. `src/web/routes/manager.js` passes the preparation boundary explicitly and recognizes an unambiguous simple replenishment request without needing a model reader. `src/manager/loop.js` preserves both preparation and planning modes when calling the runner. `src/autopilot/runner.js` does not replay interrupted execution during a preparation-only request. A browser scenario seeds existing purchasing authority, asks to prepare only, and requires a real draft with the owner-visible Approve order control still present.

### Real existing-consent refresh

The owner-only **Refresh mailbox authorization** control refreshes the existing Gmail/Microsoft grant and verifies the same mailbox profile without reading inbox contents, sending mail or expanding permissions. A changed profile identity quarantines the connection and blocks subsequent mailbox operations. Temporary provider failures preserve existing consent and offer retry instead of incorrectly declaring it revoked.

After restarting the isolated verification server, the real Gmail UI reported authorization refreshed and verified for `mysolutionstesting@gmail.com`. The real Microsoft UI reported authorization refreshed and verified for `moshe@registeronepos.com`. No inbox contents were read by these refresh controls and no mail was sent. This establishes these two real refresh/profile paths now, **not multi-month unattended token-expiry certification**. Outlook send/reply verification remains unperformed pending the separately requested self-test authorization.

### Additional browser acceptance

`tests/e2e/weekly-operations.e2e.js` runs against an isolated historical fixture with real domain records and an unavailable model. The browser checks all of the following without database assertions or direct API test requests:

- Sixteen committed orders on the supplier screen, including twelve ordinary completed deliveries, one late full completion after an earlier partial receipt, one overdue unreceived order, one not-yet-due order and one older completed order.
- A six-calendar-month Ask review excluding that older order: fifteen committed orders, thirteen complete, one overdue unfinished, and 85.7% on-time completion across fourteen rated orders.
- The $24-versus-$1,000 supplier comparison with unknown-price and excluded-cost disclosures.
- Prior-quarter posted profit of $40 from $100 revenue and $60 product cost, excluding current-quarter entries.
- All twelve prior-quarter customer payments, totaling $120, not only the ten displayed rows.
- $91 in prior-quarter supplier purchases and $55 in supplier cash, including a paid-only supplier and records beyond the display limit.
- A preparation-only Ask request with existing purchasing authority that leaves the actual order draft awaiting owner approval.

The operational safety browser suite additionally exercises both providers' refresh identity, a temporary refresh failure followed by successful retry, and mismatched-identity quarantine. Those provider responses are fake fault-injection responses, distinct from the two real refresh checks above. Historical fixture setup uses domain services and deliberately backdated fixture records; it is not a claim that a live business has operated under this release for six months.

The complete bounded regression exposed old assertions that expected the former unready-mailbox banner, a supplier setup that fabricated authorization by setting only its display name, a plan card instead of the now-prepared order, and delivered-only supplier wording. The fixtures/assertions were corrected to prove actual authorization state, saved-message review, a real draft with its pack size, and committed-order evidence. The scheduler isolation test now injects its failure into the actual manager-loop entry point used for both observing and acting workspaces.

## Final completed regression evidence

- Full frontend acceptance pack: **175 passed, 0 failed, 0 skipped, 0 cancelled**, approximately eleven minutes. Command: `npm run test:e2e`. Log: `artifacts/ui-production-final-2026-09-18.log`. This includes real configured-model browser scenarios, the six-month moving-calendar business, thirteen operational safety checks and eight weekly historical/purchasing checks. Parent tests are included in Node's count; this is not 175 independent business workflows or 175 live-provider integrations.
- Complete bounded unit/integration pack: **1,993 passed, 0 failed, 0 skipped, 0 cancelled**, approximately nine minutes. Command: `node --test --test-concurrency=2 tests/unit/*.test.js tests/integration/*.test.js`. Log: `artifacts/production-regression-final-2026-09-18.log`. These are backend regression checks, separately identified rather than presented as frontend evidence.
- Focused preparation, manager, scheduler, purchasing and mailbox regression: **164 passed, 0 failed, 0 skipped**, including the eight-test weekly browser scenario. Log: `artifacts/preparation-final-regression.log`. This overlaps the complete packs and is not an additional unique test total.
- Product contract validation passed: **512 routes, 484 user-facing routes, 38 capabilities, 26 destinations and 20 entity types**. `git diff --check` passed.

An earlier full browser attempt failed in the newly added preparation test because its locator expected a table row while the actual orders page renders story rows. The corrected test selects the real rendered order, checks the draft and opens the existing Approve order control; the final complete pack above passes. The earlier bounded unit/integration pack reported five outdated assertions; it is not presented as a passing run. Both failed-attempt logs remain available for traceability.

The isolated live verification server was restarted with the final code and the connected mailboxes preserved. The final Production operations page visibly remains **blocked, 9 of 28 checks passing**. Billing/subscription work remains excluded. Full local green regressions do not close the shared-database migration, remaining complex-job engineering, deployed operational certification or unperformed financial/shipping/accounting-provider qualification.

## Subsequent visible frontend verification

The preceding 175/1,993 totals describe the earlier completed revision, not certification of subsequent allocation and reporting changes. No further backend test pack is used as evidence for the visible browser checks below.

An isolated historical workspace was opened visibly in the Codex browser at `http://127.0.0.1:58828`. Its history was created with domain services before testing; browser actions did not use API shortcuts or database writes. Every one of its 150 customer-order detail screens was read in the browser before and after the receipt:

- Initially: 150 ordered units, 100 units actually held, 50 units waiting. The 50 units on an incoming purchase order were not treated as physical availability.
- The latest-created order with an earlier needed date received a physical reservation ahead of undated demand.
- Start picking was clicked for one customer. Its priority was then lowered to 200, while a previously backordered customer was promoted to priority 0 through the new allocation form. Both remained correctly reserved: the urgent customer took unpicked stock, not the active warehouse pick.
- Resubmitting unchanged priority/date values left order activity at four entries rather than creating duplicate allocation history.
- Book it in was clicked for the 50-unit incoming delivery. All 150 detail screens were read again: exactly 150 units held and zero units waiting. The list showed 149 ready to pick and one being picked; nothing was falsely marked shipped or paid.

Implementation changes also validate calendar dates and priority bounds, audit allocation-setting changes atomically, suppress unchanged reservation events, include kit-component commitments when physical stock disappears, and replace misleading "more stock arrived" history when reservations were actually redistributed.

The canonical exception queue no longer applies the former source preview caps to purchasing drafts, awaiting approvals, corrections, investigations, repair cases, predicted trouble, migration packages or actionable stock findings. Daily manager briefs use the same exception queue and retain their complete handled/handling/delivery counts instead of counting truncated previews. Failed exception projections retain a coverage warning; both briefing and Needs You must say the review is incomplete rather than giving a false all-clear. Expanded browser regression includes 25 distinct draft decisions and a deliberately failed projection. Those new automated checks are fault-injection/fixture evidence, not real-provider certification.

The first expanded automated attempt exposed a fixture that enabled purchasing authority before historical seeding, an omitted seed-time reconciliation, and a locator that counted the separate customer list. Those fixture issues were corrected. A subsequent headed-browser attempt closed during traversal; it is not counted as a passing test run. The independent visible Codex-browser verification above completed all 300 order-screen readings and the actual frontend forms.

The full frontend rerun completed with **181 passed, 0 failed, 0 skipped, 0 cancelled**, approximately twelve minutes. Log: `artifacts/frontend-regression-allocation-2026-09-18.log`. A subsequent focused browser run against the final invoice, profit-disclosure and exception-cache changes completed with **15 passed, 0 failed, 0 skipped, 0 cancelled**, approximately 48 seconds. Log: `artifacts/final-allocation-invoice-frontend-2026-09-18.log`. These counts overlap and include parent tests; they must not be added as unique workflows. The full pack preceded those final changes, so it is not a complete regression certification of the final revision.

The visible browser also submitted a supplier invoice for 60 units at $2 against a purchase order for 50 units at $1, deliberately selecting paid in full. StockChief held the discrepancy for review, did not post a payable, did not record payment and did not change inventory. The payable screen now identifies that review instead of falsely saying every bill is paid. The focused browser run additionally verifies that this disputed invoice appears in Needs You. Historical profit answers disclose that unrecorded costs cannot be verified, rather than inventing that the real net figure must be lower.

Product contract validation passed for **513 routes, 485 user-facing routes, 38 capabilities, 26 destinations and 20 entity types**; `git diff --check` passed. These are static checks, not frontend or live-provider acceptance evidence. The isolated port-4000 integration verification server was restarted with the latest source, preserving mailbox connections.

These local changes do not certify production deployment, shared multi-writer storage or outstanding real shipping/payment/accounting integrations. Disputed-invoice resolution and the remaining complex operational jobs still require engineering and acceptance qualification. Shipping sandbox connection, accounting test-company choice and Outlook self-email authorization have been requested through the UI handoff; unperformed provider checks are not claimed complete. Subscription billing remains untouched.

## Subsequent invoice-resolution implementation

The unposted disputed-invoice gap now has an actual frontend completion path. Authorized accounting users can correct quantities, costs, dates and tax from source evidence; recheck unchanged invoice evidence against current PO/receipts; or dismiss an unposted duplicate while retaining its original record. A matching correction posts the supplier payable transactionally, not a payment or a stock receipt. Posted invoices cannot be edited or dismissed here. Quantity and supplier/PO/SKU association checks remain enforced; a stale browser submission is rejected. Review history retains the actor, reason, before/after amounts and original line values. Human-entered evidence reasons are not independent document-authenticity verification.

Browser regression: **19 passed, 0 failed, 0 skipped, 0 cancelled**, approximately 51 seconds. Log: `artifacts/invoice-resolution-frontend-2026-09-18.log`. This extends and overlaps the previous weekly browser pack; it is not 19 live-provider certifications. It exercises recheck ignoring edited fields, corrections still failing matching rules, stale-screen rejection, a matched correction with one stable journal link, disappearance of the resolved exception and duplicate dismissal without paying or crediting. The entire full browser regression has not been rerun against these additions.

Visible Codex-browser verification at `http://127.0.0.1:49913` received the test 50-unit delivery, submitted `VISIBLE-RESOLUTION-120` for 60 units at $2 and then corrected it through the new form to 50 units at $1. The screen changed DISPUTED → OPEN, retained the $120 → $50 review history, and stated that no payment or inventory change occurred. Opening the real posted entry displayed a $50 debit to Received, not yet invoiced and a $50 credit to Accounts payable, balanced at $50 each. These were isolated test records, not production bills or an external accounting-provider posting.

Static product-contract validation passed for **515 routes, 487 user-facing routes, 38 capabilities, 26 destinations and 20 entity types**. See `docs/launch-implementation-plan.md` for the selected hosting target and remaining storage, provider and deployed qualification work. No hosting resources or subscriptions have been purchased.

After the final cumulative same-PO-line quantity-accounting safeguard, the same focused frontend pack passed again: **19 passed, 0 failed, 0 skipped, 0 cancelled**, approximately 69 seconds. Final log: `artifacts/invoice-resolution-frontend-final-2026-09-18.log`. These two runs overlap completely and are not 38 unique tests or two complete deployed-release certifications. `git diff --check` passed. Render's sign-in screen is open for owner setup; no account registration, agreement acceptance or paid provisioning was performed by the agent.

## Subsequent PostgreSQL foundation and operational coverage

The earlier no-provisioning statements describe their original checkpoints. The owner has now signed in, personally supplied a different card for a separate StockChief Hobby workspace and approved only the $23.50/month isolated staging PostgreSQL database. `stockchief-staging` is Available in Virginia on PostgreSQL 17; 0.5 CPU / 1 GB RAM, 15 GB storage, autoscaling off. The environment is labelled Staging. Web/worker resources have not been purchased or deployed. No business data, mailbox grants or database secrets were transferred. The default public inbound rule remains unchanged: private-only restriction was blocked by the approval reviewer and the unsaved edit was discarded, pending owner approval.

The owner-facing Operations briefing now reads a selected since-Friday period across ten actual history sources and separates completed work, recorded evidence, pending work and exceptions. Financial dates are dates, not fabricated noon timestamps. Missing sources yield incomplete coverage rather than all-clear. Ask preserves the blanket operational request as a refused execution goal and offers the actual report; it does not silently turn "handle everything" into standing permission or claim unsupported actions occurred.

Incoming purchase quantities no longer suppress an arrival exception when the delivery is overdue, undated or projected later than depletion. Purchasing explanation/plan screens and Needs You expose that risk; StockChief avoids preparing a duplicate order for the same aggregate requirement. This is not full transfer-versus-buy optimization, seasonality or calendar-aware supplier procurement.

- Focused weekly operations plus PostgreSQL frontend: **28 passed, 0 failed, 0 skipped**, log `artifacts/operations-gap-frontend-2026-09-18.log`. This overlaps earlier invoice/allocation checks.
- Typed PostgreSQL DATE/TIMESTAMPTZ frontend: **8 passed, 0 failed, 0 skipped**, log `artifacts/typed-postgres-frontend-2026-09-18.log`. Its final financial-date assertion was strengthened and rerun below.
- Expanded full frontend attempt: **193 passed, 2 failed, 0 skipped**, log `artifacts/full-frontend-postgres-foundation-2026-09-18.log`, approximately thirteen minutes. One child assertion still expected the old false quiet purchasing plan after approving an order whose arrival is later than projected depletion; the parent consequently failed too. The passing total must not be called a complete green regression. Changes were also made during this run, so it is not exact-final-revision certification.
- Final purchasing plus typed PostgreSQL frontend: **27 passed, 0 failed, 0 skipped, 0 cancelled**, log `artifacts/final-purchasing-postgres-frontend-2026-09-18.log`, approximately 52 seconds. The purchasing assertion now requires the actual arrival warning, no false quiet plan and no duplicate Prepare button; it still verifies physical stock is unchanged until receiving, duplicate receipt safety and restart persistence. The final full pack has not been rerun.
- Supplemental native PostgreSQL worker/transaction pack: **8 passed, 0 failed, 0 skipped**, log `artifacts/postgres-worker-transactions-2026-09-18.log`. This includes two independent worker processes and atomically coupled qualification SQL effects, not UI or distributed inventory/accounting qualification.
- Compatible installed-dependency updates removed the audited advisories: npm reported **0 vulnerabilities**. Log `artifacts/dependency-audit-after-2026-09-18.json`. An audit result is not a general security certification.

All Node counts include parent tests and overlap; no combined unique-workflow count is claimed. The signed-in PostgreSQL frontend fixture uses actual private PostgreSQL sessions/history/runtime jobs with SQLite business services. It verifies shared logout, all 25 Friday receipt records and 31 Friday-through-Monday movement records, workspace isolation, real source failure, continued payment-source reads and a scoped queue retry. It does not run live provider transactions or a distributed business deployment. See `docs/postgresql-migration-status.md` for the explicit unfinished port.

StockChief is still not production-ready. Business storage migration, unsupported complex action orchestration, real shipping/payment/accounting qualification and deployed restoration/rollback/load/recovery remain open. Subscription implementation remains untouched.
