'use strict';

// Job 181: one log of everything StockChief did and why, with undo where
// possible. Alone on every plan. The log keeps the plan's activity history
// (90 days on Starter, a year on Growth, everything on Pro and Custom); Pro
// and Custom export it, and Custom reads it through the API.
//
// The log is built on the records StockChief already keeps, not on a copy:
//  - completed agent actions (prepared changes, the action map's proposal
//    capabilities). Each now writes one 'Agent action completed' audit entry
//    with what allowed it: the owner's approval, a saved routine, a taught
//    rule or a plan approved in Ask;
//  - the work a job records in its own table (warehouse choices, releases,
//    supplier emails, holds, claims and the rest), as the daily record of job
//    204 has shown it since it was built (WORK below);
//  - the audit trail entries a job writes when it acts on its own (SOURCES).
// Each entry says what it did, why, which rule or limit allowed it, and its
// evidence: the record, the recorded facts and its audit trail.
//
// Undo is offered only where it is truly safe, through the job's own undo,
// which rechecks that nothing changed since (UNDO). Work with outside effects
// that cannot be recalled (a sent email, a bought label, an order sent to a
// supplier, stock that physically moved, posted money) shows its correction
// path instead. Every undo is audited once ('Agent action undone'); a replay
// changes nothing.

const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const {ValidationError,NotFoundError}=require('../domain/errors');

const JOB=181,key='agent-activity',path='/autopilot/reviews/'+key,COMPLETED='Agent action completed',UNDONE='Agent action undone';
const titles=new Map(require('../commercial/agent-plan-v3.json').map(r=>[r.id,r.job]));
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const planNames={starter:'Starter',growth:'Growth',pro:'Pro',enterprise:'Custom'};
const SENT='The email was sent and cannot be recalled.';

// The audit trail entries jobs write when they act on their own, by job.
// `when` narrows an action that is shared with the owner's own work:
// automatic (after.automatic), routine (after.routine), upkeep (a routine
// reservation change), notOwner (not sent by the owner) or notNotice (not
// already shown from a supplier notice). `undo` names the job's own undo,
// `record` finds its record; otherwise `fix` is the correction path and
// `outside` marks effects that cannot be recalled.
const SOURCES=[
 {job:4,actions:['Saved automatic daily cycle-count plan'],why:'Shelves were due a count by value, movement and their last count.',rule:'Your daily cycle-count plan',page:'/autopilot/daily-cycle-counts',fix:'Change or drop the plan before counting starts.'},
 {job:9,actions:['Slow stock step taken on its own'],why:'Stock sat unsold longer than your slow stock rule allows.',rule:'Your slow stock limit',page:'/autopilot/slow-stock',undo:'slowStock'},
 {job:11,actions:['Stock records moved to the bin where the stock was found'],when:'automatic',why:'A scan found the stock in another bin than recorded.',rule:'Your routine bin correction limit',page:'/warehouse/bin-corrections',undo:'binCorrection'},
 {job:12,actions:['Reserved stock for a customer','Topped up a customer reservation','Cut a reservation to the stock on hand','Released an expired customer reservation','Passed reserved stock to the customer’s order'],when:'upkeep',
  why:'A customer’s protected stock needed topping up, trimming or handing to their order.',rule:'Your protected stock for that customer',page:'/autopilot/protected-stock',undo:'protection',record:r=>r.after.changeId},
 {job:16,actions:['Annual stocktake planned from the yearly rule','Annual stocktake freeze started on schedule','Annual stocktake recount requested on its own'],why:'Your yearly stocktake was due.',rule:'Your yearly stocktake rule',page:'/autopilot/annual-stocktakes',fix:'Change or stop the stocktake on its page.'},
 {job:21,actions:['Updated reorder point and target from sales'],when:'routine',why:'Recent sales and lead time changed what you need on the shelf.',rule:'Your routine reorder point updates',page:'/planning/reorder-refresh',undo:'reorderRefresh'},
 {job:32,actions:['StockChief closed goods that will not arrive'],why:'Goods stayed late past your waiting time.',rule:'Your rule for goods that will not arrive',page:'/autopilot/stale-incoming',undo:'staleIncoming',record:r=>r.after.closeId},
 {job:37,actions:['Supplier-direct purchase approved'],when:'routine',why:'A customer order ships straight from the supplier.',rule:'Your routine supplier-direct purchases',page:'/autopilot/direct-shipments',outside:true,fix:'The supplier has the order. Ask them to cancel, then cancel the purchase order.'},
 {job:37,actions:['Supplier-direct shipment recorded'],when:'automatic',why:'The supplier confirmed it shipped to your customer.',rule:'Your routine supplier-direct purchases',page:'/autopilot/direct-shipments',outside:true,fix:'The goods left the supplier. Correct the order or invoice on its page.'},
 {job:39,actions:['Forwarder freight update applied'],why:'Your forwarder sent a new status or arrival date within your day limit.',rule:'Your routine freight updates and their day limit',page:'/autopilot/inbound-freight',fix:'Change the arrival date on the freight shipment.'},
 {job:39,actions:['Carrier tracking update applied'],why:'The carrier reported a new arrival date within your day limit.',rule:'Your arrival change limit',page:'/autopilot/inbound-freight',fix:'Set the arrival date back on the shipment.'},
 {job:39,actions:['Purchase order date moved with its shipment'],why:'The shipment’s arrival moved, so the warehouse date moved by the same days.',rule:'Your arrival change limit',page:'/autopilot/inbound-freight',fix:'Undo the move on the shipment while the order still shows that date.'},
 {job:40,actions:['StockChief checked exchange-rate costs'],why:'Foreign purchases are checked against today’s rate.',rule:'Your exchange-rate alert rule',page:'/autopilot/purchase-fx',none:true},
 {job:49,actions:['Delivery cost posted to stock on its own'],why:'A freight, duty or fee bill matched a delivery.',rule:'Your delivery cost limit',page:'/autopilot/landed-cost-bills',undo:'landedCost',
  lookup:`SELECT d.document_number AS ref,r.bill_line_id AS id FROM stockchief_runtime.agent_landed_cost_bills r JOIN landed_cost_documents d ON d.workspace_id=r.workspace_id AND d.id=r.document_id
   WHERE r.workspace_id=$1 AND d.document_number=ANY($2::text[])`},
 {job:52,actions:['Customer order from email created and confirmed by StockChief','Customer order from email prepared by StockChief for approval'],why:'A customer emailed an order.',rule:'Your limits for customer orders',page:'/orders',fix:'Change or cancel the order on its page.'},
 {job:54,actions:['Order check found problems'],why:'An order was created, confirmed, changed or due its daily check.',rule:'Your order check settings',page:'/autopilot/reviews/sales-order-checks',fix:'Fix the problem on the order; the check runs again.'},
 {job:55,actions:['Order put on credit hold'],why:'The customer had invoices overdue past your rule.',rule:'Your overdue customer order rule',page:'/autopilot/reviews/overdue-customer-orders',fix:'Release the hold on the order if it should ship.'},
 {job:58,actions:['Chose a shipping rate'],why:'The shipment needed a carrier service that arrives in time.',rule:'Your shipping rate rule',page:'/settings/shipping',fix:'Choose another rate on the shipment before the label is bought.'},
 {job:59,actions:['Bought a shipping label within your limits'],why:'The shipment was ready and the label cost was within your limit.',rule:'Your label spending limit',page:'/settings/shipping',outside:true,fix:'A bought label cannot be taken back here. Void it with the carrier from the shipment.'},
 {job:60,actions:['Sent a tracking email on its own'],why:'The order shipped.',rule:'Your tracking email setting',page:'/settings/shipping',outside:true,fix:SENT},
 {job:61,actions:['StockChief split an order and sent the ready part to picking'],why:'Part of the order was in stock and your split rules allow shipping it now.',rule:'Your order split rules',page:'/autopilot/order-splits',undo:'orderSplit'},
 {job:62,actions:['Told a customer their parcel is late'],why:'The carrier showed the parcel running late.',rule:'Your delay email routine',page:'/settings/shipping',outside:true,fix:SENT},
 {job:64,actions:['StockChief set stock aside for waiting orders'],why:'Stock arrived or was freed for orders waiting on it.',rule:'Your backorder rule and its unit limit',page:'/autopilot/backorders',undo:'backorderRun'},
 {job:65,actions:['StockChief shared scarce stock by your rules'],why:'There was not enough stock for every order.',rule:'Your scarce stock sharing rules',page:'/autopilot/stock-sharing',undo:'backorderRun'},
 {job:66,actions:['Freight pickup held for a person'],why:'Packed pallets repeated an authorized freight lane, but a fact did not match.',rule:'Your freight booking rule',page:'/autopilot/freight-pickups',fix:'Check the pallets and quote the shipment yourself, or book it with the carrier.'},
 {job:68,actions:['Reserved arrived stock for accepted preorder'],why:'Stock arrived for a preorder the customer had accepted.',rule:'Your preorder routine',page:'/autopilot/preorders',fix:'Take it back from picking on Preorders until the box is packed.'},
 {job:69,actions:['Applied the carrier’s address formatting','Held a label for an address check'],why:'The carrier checked the delivery address.',rule:'Your address check routine',page:'/settings/shipping',fix:'Confirm or change the address on the shipment before the label is bought.'},
 {job:70,actions:['Export papers prepared on its own','Export papers held for a person'],why:'A packed shipment was leaving the country and needed its paperwork.',rule:'Your confirmed exporter and product trade facts',page:'/autopilot/export-papers',fix:'Stop the draft or confirm the missing facts on International paperwork. Nothing was filed or sent.'},
 {job:71,actions:['Van manifest published'],when:'automatic',why:'Packed local deliveries were ready for the vans.',rule:'Your van route routine',page:'/autopilot/van-routes',fix:'Stop or replan the manifest on Van routes.'},
 {job:78,actions:['Prepared a private customer check-in'],why:'A customer was due a check-in by your rule.',rule:'Your routine customer check-ins',page:'/autopilot/customer-check-ins',fix:'It is a private draft. Edit or discard it on Customer check-ins.'},
 {job:85,actions:['StockChief checked net margins'],why:'Orders are checked against your net margin rule.',rule:'Your net margin rule',page:'/autopilot/net-contribution',none:true},
 {job:86,actions:['Clearance plan prepared on its own'],why:'Stock was slow and your clearance rule allows a plan.',rule:'Your clearance rule',page:'/autopilot/clearance-plans',fix:'Cancel the plan on Clearance plans before its prices change.'},
 {job:87,actions:['StockChief checked channel prices'],why:'Channel prices are compared with yours and with minimum advertised prices.',rule:'Your channel price checks',page:'/autopilot/reviews/channel-prices',none:true},
 {job:93,actions:['Supplier reminded about an RFQ on its own'],why:'A supplier had not answered your request for quotes.',rule:'Your supplier quote rule',page:'/autopilot/supplier-rfqs',outside:true,fix:SENT},
 {job:93,actions:['Supplier quotation captured from an RFQ reply on its own'],why:'A supplier replied with prices.',rule:'Your supplier quote rule',page:'/autopilot/supplier-rfqs',fix:'Nothing is accepted until you choose a quotation.'},
 {job:94,actions:['Routine supplier lead-time note sent on its own'],why:'A supplier delivered later than its stated lead time.',rule:'Your routine supplier lead-time notes',page:'/autopilot/supplier-negotiations',outside:true,fix:SENT},
 {job:95,actions:['Reorder preference switched to backup supplier'],when:'automatic',why:'The main supplier was out or did not confirm in time.',rule:'Your backup supplier rule',page:'/autopilot/reviews/backup-suppliers',fix:'Switch reordering back to the main supplier on its rule.'},
 {job:97,actions:['Supplier rebate claim prepared','Supplier credit note matched to rebate claim'],when:'automatic',why:'Your purchases reached a supplier rebate.',rule:'Your supplier benefit settings',page:'/autopilot/supplier-benefits',fix:'Discard or correct it on Supplier benefits.'},
 {job:97,actions:['Supplier rebate claim queued to send'],when:'automatic',why:'Your purchases reached a supplier rebate.',rule:'Your supplier benefit settings',page:'/autopilot/supplier-benefits',outside:true,fix:SENT},
 {job:102,actions:['Payment reminder sent by StockChief on the owner’s schedule'],why:'An invoice reached a reminder day on your schedule.',rule:'Your customer reminder schedule',page:'/autopilot/reviews/invoice-reminders',outside:true,fix:SENT},
 {job:111,actions:['Return created on its own from a customer email'],why:'A customer emailed a return request that matched your rule.',rule:'Your return-email rule',page:'/autopilot/reviews/customer-return-emails',fix:'Cancel the return on its page if it should not go ahead.'},
 {job:112,actions:['Chose a return label within your limits','Bought a return label within your limits'],why:'A return needed a label and its cost was within your limit.',rule:'Your return label rule',page:'/settings/shipping',outside:true,fix:'A bought label cannot be taken back here. Void it with the carrier.'},
 {job:120,actions:['Updated location reorder thresholds'],when:'routine',why:'Sales at that location changed.',rule:'Your location reorder routine',page:'/planning/location-reorder',fix:'Change the thresholds on Location reorder.'},
 {job:122,actions:['Approved a warehouse re-slot move on its own'],why:'A fast-moving product sat far from packing.',rule:'Your routine warehouse re-slots',page:'/autopilot/warehouse-slotting',undo:'reslot',
  lookup:`SELECT t.transfer_number AS ref,m.plan_id||':'||m.move_hash AS id FROM stockchief_runtime.agent_slotting_moves m JOIN inventory_transfers t ON t.workspace_id=m.workspace_id AND t.id=m.transfer_id
   WHERE m.workspace_id=$1 AND t.transfer_number=ANY($2::text[])`},
 {job:126,actions:['Catalog fix made on its own'],why:'A product had a duplicate, a missing cost or weight, or a bad SKU.',rule:'Your daily catalog fix limit',page:'/autopilot/catalog-fixes',undo:'catalogFix'},
 {job:127,actions:['Supplier catalog products created by StockChief'],why:'A supplier catalog listed products you do not have yet.',rule:'Your supplier catalog setting',page:'/autopilot/supplier-catalogs',fix:'Undo the catalog on Supplier catalogs while its products are unused.'},
 {job:131,actions:['Product category or tags set on their own'],why:'A product had no category or tags.',rule:'Your daily category limit',page:'/autopilot/product-categories',undo:'category'},
 {job:132,actions:['Discontinued products retired on their own'],when:'notNotice',why:'Products stopped selling past your dead stock rule.',rule:'Your dead stock retirement rule',page:'/autopilot/discontinued-products',fix:'Bring each product back on Discontinued products.'},
 {job:133,actions:['Import columns mapped by StockChief'],why:'A file you imported had columns to read.',rule:'Your column mapping setting',page:'/imports',fix:'Check the mapping before the import runs.'},
 {job:135,actions:['Supplier cost updated on its own from a price list'],why:'A supplier price list changed a cost within your limit.',rule:'Your supplier cost limit',page:'/autopilot/supplier-price-updates',undo:'supplierCost',record:r=>r.reference+':'+r.after.ordinal},
 {job:137,actions:['Original shipping evidence filed on purchase order','Original shipping evidence added to existing PO filing'],when:'automatic',why:'A shipping document matched a purchase order.',rule:'Your document reading setting',page:'/autopilot/shipping-documents',fix:'Review the filed document on the purchase order.'},
 {job:142,actions:['Original document filed on exact record'],when:'automatic',why:'A document in your mailbox matched one record exactly.',rule:'Your automatic filing scope',page:'/autopilot/document-filing',fix:'Review the filed document on its record.'},
 {job:143,actions:['Contract prices and terms read'],why:'A contract was filed.',rule:'Your automatic contract reading',page:'/autopilot/contracts',none:true},
 {job:144,actions:['Updated demand forecasts used for planning'],why:'New sales changed the forecast.',rule:'Your forecast setting',page:'/planning/forecasts',fix:'Keep a product on plain sales history on Forecasts.'},
 {job:146,actions:['Updated new product forecasts used for planning'],why:'A new product’s similar item sold.',rule:'Your forecast setting',page:'/planning',fix:'Choose another similar item for the product.'},
 {job:148,actions:['Updated demand trends used for planning'],why:'A product began selling faster or slower than expected.',rule:'Your forecast setting',page:'/planning',fix:'Dismiss the trend on its product.'},
 {job:150,actions:['Updated safety stock for your service target'],when:'routine',why:'Forecast error and late deliveries changed the stock you need for your service target.',rule:'Your service target and routine updates',page:'/planning/safety-stock',undo:'safetyStock'},
 {job:157,actions:['StockChief checked the month for big changes'],why:'A month closed.',rule:'Your monthly change check',page:'/autopilot/reviews',none:true},
 {job:158,actions:['StockChief made the month-end stock report'],why:'A month closed.',rule:'Your month-end report',page:'/autopilot/reviews',none:true},
 {job:159,actions:['StockChief built the board pack'],why:'Your board pack day came.',rule:'Your monthly board pack schedule',page:'/autopilot/reviews',none:true},
 {job:161,actions:['StockChief made the monthly ROI report'],why:'A month closed.',rule:'Your monthly ROI report',page:'/autopilot/reviews',none:true},
 {job:162,actions:['StockChief checked stock health'],why:'Stock turns and days of supply are checked on a schedule.',rule:'Your stock health check',page:'/autopilot/reviews/stock-health',none:true},
 {job:163,actions:['StockChief updated the forecast and delivery report'],why:'Forecast accuracy and deliveries are checked on a schedule.',rule:'Your service level report',page:'/autopilot/reviews',none:true},
 {job:172,actions:['Unanswered alert passed on','Unanswered approval passed on'],why:'Nobody answered within your hours.',rule:'Your escalation hours',page:'/needs-you',fix:'Answer it in Needs you.'},
 {job:156,actions:['Daily briefing delivered'],why:'Your briefing time came.',rule:'Your briefing time',page:'/autopilot/reviews/report-emails',none:true},
 {job:156,actions:['Daily briefing emailed'],why:'Your briefing time came.',rule:'Your briefing time and people',page:'/autopilot/reviews/report-emails',outside:true,fix:'Change the briefing time or people on Report emails.'},
 {job:164,actions:['StockChief prepared a supplier review pack'],why:'A quarter ended and the supplier had orders in it.',rule:'Your supplier review packs',page:'/autopilot/reviews/quarterly-supplier-pack',none:true},
 {job:164,actions:['StockChief sent a supplier review pack'],why:'A quarter ended and the supplier had orders in it.',rule:'Your supplier review packs and mailbox',page:'/autopilot/reviews/quarterly-supplier-pack',outside:true,fix:'The supplier has the pack. Send them a correction from your mailbox.'},
 {job:165,actions:['StockChief made the year-end stock pack'],why:'Your financial year ended.',rule:'Your year-end month',page:'/autopilot/reviews',none:true},
 {job:165,actions:['StockChief sent the year-end stock pack to the accountant'],why:'Your financial year ended.',rule:'Your year-end month and accountant address',page:'/autopilot/reviews',outside:true,fix:'The accountant has the pack. Send them a correction from your mailbox.'},
 {job:173,actions:['Alert text queued','Alert push queued'],why:'An alert you chose to get by text or push opened.',rule:'Your alert channels',page:'/autopilot/alert-devices',outside:true,fix:'Choose which alerts come by text or push on each alert page.'},
 {job:176,actions:['Approval sent to a team member'],why:'An approval was waiting and your routing sends it to one person.',rule:'Your approval routing rules and limits',page:'/autopilot/approval-routing',fix:'Change the routing rule or the person’s limit.'},
 {job:177,actions:['Staff tasks handed out'],why:'Work was waiting and team members could do it.',rule:'Your staff task limits',page:'/warehouse/staff-tasks',undo:'staffTasks',record:r=>r.id},
 {job:178,actions:['Team procedure published to staff by StockChief'],why:'How your team works changed.',rule:'Your procedure updates setting',page:'/autopilot/team-procedures',fix:'Restore the earlier staff version on Team procedures.'},
 {job:190,actions:['Old system migration approved by StockChief','Inventory opened by StockChief after the migration matched'],why:'Your old system’s data matched after the move.',rule:'Your migration setting',page:'/autopilot/reviews/erp-migrations',fix:'Review the migration and correct records on their pages.'},
 {job:196,actions:['Original lot certificate linked'],when:'automatic',why:'A certificate in your mailbox matched a lot.',rule:'Your lot certificate mailbox scope',page:'/autopilot/lot-certificates',fix:'Withdraw the link on Lot certificates.'},
 {job:197,actions:['Compliance report produced on its own'],why:'Your compliance report schedule was due.',rule:'Your compliance report schedule',page:'/autopilot/compliance-reports',fix:'Discard the report and produce a new one.'},
 {job:201,actions:['Paused unusual automatic activity'],why:'Spending or volume looked unusual.',rule:'The circuit-breaker',page:'/autopilot/reviews/unusual-automatic-activity',fix:'Check the activity, then resume automatic work.'},
 {job:202,actions:['Approval sent to vacation deputy'],why:'You were away and your deputy may approve it.',rule:'Your vacation dates and deputy',page:'/autopilot/reviews/vacation-deputy',fix:'End the vacation; waiting approvals come back to you.'},
 // Alert emails: the job is in the entry (166 to 180, 204).
 {job:null,actions:['Alert email queued'],when:'notOwner',why:'New alerts opened.',rule:'Your alert email setting',outside:true,fix:SENT}
];
const byAction=new Map();
for(const s of SOURCES)for(const a of s.actions){if(byAction.has(a))throw new Error('Duplicate agent activity source: '+a);byAction.set(a,s);}
const WHEN={always:null,automatic:"e.after_state->>'automatic'='true'",routine:"e.after_state->>'routine'='true'",
 upkeep:"e.after_state->>'authority' IN ('UPKEEP','ORDER')",notOwner:"NOT (e.after_state ? 'sentByOwner')",
 notNotice:'NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_product_retirement_notices n WHERE n.workspace_id=e.workspace_id AND n.id=e.reference)'};
const whenActions=Object.fromEntries(Object.keys(WHEN).map(w=>[w,SOURCES.filter(s=>(s.when||'always')===w).flatMap(s=>s.actions)]));

// Work recorded in a job's own table (shown by the daily record since it was
// built): its job, why it acts, what allowed it and how it is undone.
const WORK={
 'supplier-details':{job:96,why:'A supplier email gave new terms, lead times or contacts.',rule:'Your routine supplier email updates',undo:'supplierDetails',fix:'Correct the values on the supplier.'},
 'po-delivery-date':{job:31,why:'A supplier gave a new delivery date.',rule:'Your routine PO delivery-date updates',fix:'Change the date on the purchase order.'},
 'container-plan':{job:38,why:'Containers needed loading from real reorder needs.',rule:'Your container planning',none:true},
 'blanket-release':{job:42,why:'A release was due on the supplier contract.',rule:'Your contract release schedule',undo:'blanketRelease',outside:true,fix:'Once sent, ask the supplier to cancel, then cancel the purchase order.'},
 'container-order':{job:38,why:'A container order was due by your rule.',rule:'Your container order rule',undo:'containerOrder',outside:true,fix:'Once sent, ask the supplier to cancel, then cancel the purchase order.'},
 'product-facts':{job:136,why:'A supplier document stated product facts.',rule:'Your product facts setting',fix:'Correct each fact on its page.'},
 'channel-copy':{job:128,why:'Product facts were ready for a channel.',rule:'Your routine channel writing',fix:'Edit or replace the copy on its page.'},
 'team-procedure':{job:178,why:'Completed work showed how your team does it.',rule:'Your procedure setting',fix:'Edit it, or restore an earlier version, on Team procedures.'},
 'product-retirement':{job:132,why:'A supplier said the products are discontinued.',rule:'Your supplier retirement scope',fix:'Bring each product back on Discontinued products.'},
 'shutdown-purchase':{job:147,why:'A supplier shutdown was coming.',rule:'Your supplier shutdown planning',fix:'It is a draft. Change or cancel the purchase order before you approve it.'},
 'promotion-purchase':{job:145,why:'A promotion needed stock.',rule:'Your promotion planning',fix:'It is a draft. Change or cancel the purchase order before you approve it.'},
 'warehouse-routing':{job:121,why:'The order needed a warehouse to ship from.',rule:'Your warehouse routing rules',undo:'routing',fix:'Change the warehouse on the order.'},
 'pick-release':{job:56,why:'Orders were ready to pick.',rule:'Your warehouse release rule',undo:'release',fix:'Picking has started. Change the orders in the warehouse.'},
 'pick-wave':{job:57,why:'Orders were ready to pick together.',rule:'Your pick wave rule',undo:'wave',fix:'Picking has started. Finish or cancel the wave in the warehouse.'},
 'delivery-qc':{job:51,why:'A delivery came from a supplier or product you hold for inspection.',rule:'Your quality hold rule',fix:'Inspect the goods to release or return them.'},
 'supplier-rfq':{job:93,why:'You needed quotes for these products.',rule:'Your supplier quote rule',outside:true,fix:SENT},
 'supplier-claim':{job:45,why:'A delivery came short or damaged.',rule:'Your supplier claim rule',outside:true,fix:SENT},
 'channel-buffer':{job:183,why:'Your channel buffer changed what a channel may sell.',rule:'Your channel stock buffer',outside:true,fix:'Change the buffer; the channel then gets the new number.'},
 'annual-stocktake':{job:16,why:'Every count difference was within your count limit.',rule:'Your annual stocktake rule',fix:'Post a new count to correct any position.'},
 'partial-shipment':{job:61,why:'Part of the order was ready to ship.',rule:'Your partial shipment rule',outside:true,fix:'The goods left. Correct the order or invoice on its page.'},
 'return-label':{job:112,why:'A customer return needed a label.',rule:'Your return label rule',outside:true,fix:SENT},
 'supplier-credit-source':{job:105,why:'A supplier credit note matched a posted bill.',rule:'Your supplier credit setting',fix:'Posted money is corrected with a reversing entry on the bill.'},
 'supplier-invoice-source':{job:98,why:'A supplier invoice matched its purchase order and receipt.',rule:'Your supplier invoice routine',fix:'Posted money is corrected with a reversing entry on the bill.'},
 'customer-invoice':{job:101,why:'An order was ready to invoice.',rule:'Your customer invoice routine',fix:'Correct the invoice on its page.'},
 'export-papers':{job:70,why:'An international shipment needed paperwork.',rule:'Your export paperwork profile',fix:'Prepare corrected papers on the shipment.'},
 'return-disposition':{job:113,why:'Inspected returned goods matched your return rule.',rule:'Your routine return decisions',fix:'The goods moved. Move them again with a stock correction.'},
 'customer-page-order':{job:83,why:'A customer ordered through your private order page.',rule:'Your customer page drafting',fix:'It is a draft order. Change or cancel it on the order.'},
 'open-to-buy':{job:26,why:'A month needed a buying plan within your budget.',rule:'Your monthly buying budget',fix:'Change the plan on Monthly buying plans before you buy.'},
 'supplier-forecast':{job:36,why:'Your weekly forecast sharing was due.',rule:'Your weekly supplier forecast sharing',outside:true,fix:SENT},
 'carrier-claim':{job:63,why:'A parcel was lost or damaged.',rule:'Your carrier claim rule',outside:true,fix:'The claim is filed with the carrier. Follow it up on Carrier claims.'},
 'freight-pickup':{job:66,why:'Pallets were ready and the quote was within your limit.',rule:'Your freight booking rule',outside:true,fix:'The pickup is booked with the carrier. Cancel it with the carrier if it is not needed.'},
 'channel-recovery':{job:182,why:'A channel stock update did not confirm.',rule:'Your channel sync recovery setting',fix:'Review the channel stock on channel sync recovery.'},
 routine:{job:null,why:'Your routine work found something to do.',rule:'Handle routine work, within your limits',fix:'Open the recorded work.'}
};
const KINDS=new Map([['sales_order.create','sale'],['sales_order.repeat','sale'],['sales_quote.create','quote'],['manufacturing.create_work_order','production'],['catalog.supplier_price_list','prices']]);

// The completed work, from every source, between two instants. The daily
// record (job 204) reads one business day; the log reads a range, newest first.
async function work(db,ctx,{from,to,page=1,order='ASC',history}){
 const installed=require('../db/schema-installed'),dir=order==='DESC'?'DESC':'ASC';
 const releasesInstalled=await installed.has(db,'stockchief_runtime.agent_pick_releases');
 const wavesInstalled=await installed.has(db,'stockchief_runtime.agent_pick_waves');
 const partial=require('../warehouse/partial-shipment-evidence');
 const conditions=Object.entries(WHEN).map(([w,sql],i)=>'(e.action=ANY($'+(8+i)+'::text[])'+(sql?' AND '+sql:'')+')').join(' OR ');
 let sql=`WITH actions AS (
  SELECT 'action' AS origin,p.id,p.action_type,p.summary,p.result,p.executed_at,
   (CASE WHEN p.action_type=ANY($6::text[]) THEN p.payload ELSE '{}'::jsonb END)||jsonb_build_object('sourceMessage',left(p.source_message,300)) AS payload,
   EXISTS(SELECT 1 FROM security_event_history e WHERE e.workspace_id=p.workspace_id AND e.reference=p.id AND e.action='Agent action undone') AS undone
  FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.status='EXECUTED' AND NOT(p.action_type='document.save_product_facts' AND coalesce(p.payload->>'queueReading','false')='true') AND p.action_type NOT IN('warehouse.release_partial_order','customer_return.send_label','shipping.prepare_export_papers','customer_invoice.prepare_document') AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_intakes q WHERE q.workspace_id=p.workspace_id AND q.bill_id=p.result->>'billId' AND q.status='POSTED') AND p.executed_at>=($2::text)::timestamptz AND p.executed_at<($3::text)::timestamptz
   AND ($5::text IS NULL OR p.executed_at>=$5::timestamptz) ORDER BY p.executed_at,p.id LIMIT $7
 ), routines AS (
  SELECT 'routine' AS origin,w.id,'routine' AS action_type,'Completed business routine: '||coalesce(w.recommended_action::jsonb->>'displayName',w.recommended_action::jsonb->>'poNumber','View recorded work') AS summary,
   '{}'::jsonb AS result,w.completed_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM work_items w WHERE w.workspace_id=$1 AND w.execution_status='COMPLETED' AND w.verification_status='VERIFIED'
   AND w.completed_at>=$2::text AND w.completed_at<$3::text AND ($5::text IS NULL OR w.completed_at>=$5::text)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=w.workspace_id AND p.id=w.proposal_id AND p.status='EXECUTED')
  ORDER BY w.completed_at,w.id LIMIT $7
 ), supplier_details AS (
  SELECT 'supplier-details' AS origin,s.message_id AS id,'supplier.email_terms' AS action_type,
   'Updated '||s.changed_count||' supplier fields from '||coalesce(p.name,'a known supplier') AS summary,
   '{}'::jsonb AS result,s.processed_at AS executed_at,'{}'::jsonb AS payload,s.undone_at IS NOT NULL AS undone
  FROM stockchief_runtime.agent_supplier_term_sources s JOIN suppliers p ON p.workspace_id=s.workspace_id AND p.id=s.supplier_id
  WHERE s.workspace_id=$1 AND s.processed_at>=$2::timestamptz AND s.processed_at<$3::timestamptz AND s.changed_count>0
   AND ($5::text IS NULL OR s.processed_at>=$5::timestamptz) ORDER BY s.processed_at,s.message_id LIMIT $7
 ), po_dates AS (
  SELECT 'po-delivery-date' AS origin,s.source_id AS id,'purchase_order.update_delivery_date' AS action_type,
   'Updated delivery promise for '||coalesce(s.source_snapshot->>'orderNumber','a purchase order')||' to '||(s.source_snapshot->>'proposedDate') AS summary,
   '{}'::jsonb AS result,s.processed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_po_date_sources s
  WHERE s.workspace_id=$1 AND s.changed AND s.instruction_hash IS NOT NULL AND s.processed_at>=$2::timestamptz AND s.processed_at<$3::timestamptz
   AND ($5::text IS NULL OR s.processed_at>=$5::timestamptz) ORDER BY s.processed_at,s.source_id LIMIT $7
 ), container_plans AS (
  SELECT 'container-plan' AS origin,p.id,'purchasing.plan_container' AS action_type,
   'Calculated container load: '||p.title||' · '||(r.result->>'loaded')||' cartons fitted, '||(r.result->>'remaining')||' left outside' AS summary,
   '{}'::jsonb AS result,r.completed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_container_runs r JOIN stockchief_runtime.agent_container_projects p ON p.workspace_id=r.workspace_id AND p.id=r.project_id
  WHERE r.workspace_id=$1 AND r.completed_at>=$2::timestamptz AND r.completed_at<$3::timestamptz AND (r.result->>'cartons')::int>0
   AND ($5::text IS NULL OR r.completed_at>=$5::timestamptz) ORDER BY r.completed_at,r.id LIMIT $7
 ), blanket_releases AS (
  SELECT 'blanket-release' AS origin,r.id,'purchasing.prepare_blanket_release' AS action_type,
   CASE WHEN r.sent_at IS NOT NULL THEN 'Supplier release ordered and queued to the supplier: ' ELSE 'Unapproved supplier release prepared: ' END||p.reference||' / '||o.po_number AS summary,
   jsonb_build_object('purchaseOrderId',o.id) AS result,r.prepared_at AS executed_at,jsonb_build_object('contractId',p.id) AS payload,false AS undone
  FROM stockchief_runtime.agent_blanket_releases r JOIN stockchief_runtime.agent_blanket_contracts p ON p.workspace_id=r.workspace_id AND p.id=r.contract_id
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  WHERE r.workspace_id=$1 AND r.automatic AND r.status='DRAFTED' AND r.prepared_at>=$2::timestamptz AND r.prepared_at<$3::timestamptz AND o.status<>'CANCELLED'
   AND ($5::text IS NULL OR r.prepared_at>=$5::timestamptz) ORDER BY r.prepared_at,r.id LIMIT $7
 ), container_orders AS (
  SELECT 'container-order' AS origin,o.id,'purchasing.plan_container' AS action_type,
   CASE WHEN o.status='DRAFTED' THEN 'Container order drafted for approval: ' ELSE 'Container order placed and queued to the supplier: ' END||s.name||' / '||p.po_number AS summary,
   jsonb_build_object('purchaseOrderId',p.id) AS result,o.created_at AS executed_at,jsonb_build_object('ruleId',o.rule_id) AS payload,o.status='UNDONE' AS undone
  FROM stockchief_runtime.agent_container_orders o JOIN stockchief_runtime.agent_container_order_rules cr ON cr.workspace_id=o.workspace_id AND cr.id=o.rule_id
  JOIN suppliers s ON s.workspace_id=cr.workspace_id AND s.id=cr.supplier_id JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id
  WHERE o.workspace_id=$1 AND o.automatic AND o.status IN ('DRAFTED','SENT','UNDONE') AND o.created_at>=$2::timestamptz AND o.created_at<$3::timestamptz
   AND ($5::text IS NULL OR o.created_at>=$5::timestamptz) ORDER BY o.created_at,o.id LIMIT $7
 ), product_facts AS (
  SELECT 'product-facts' AS origin,r.id,'document.save_product_facts' AS action_type,
   'Source-backed product facts saved: '||i.name AS summary,'{}'::jsonb AS result,s.saved_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_product_source_readings r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id
  JOIN LATERAL(SELECT min(f.saved_at) AS saved_at FROM stockchief_runtime.agent_sourced_product_facts f WHERE f.workspace_id=r.workspace_id AND f.reading_id=r.id HAVING count(*)>0)s ON true
  WHERE r.workspace_id=$1 AND s.saved_at>=$2::timestamptz AND s.saved_at<$3::timestamptz AND ($5::text IS NULL OR s.saved_at>=$5::timestamptz)
  ORDER BY s.saved_at,r.id LIMIT $7
 ), channel_copy AS (
  SELECT 'channel-copy' AS origin,v.copy_id AS id,'catalog.write_channel_copy' AS action_type,
   'Private channel copy exported: '||p.channel_name AS summary,'{}'::jsonb AS result,v.exported_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_channel_copy_versions v JOIN stockchief_runtime.agent_channel_copy_sets p ON p.workspace_id=v.workspace_id AND p.id=v.copy_id
  WHERE v.workspace_id=$1 AND v.exported_at>=$2::timestamptz AND v.exported_at<$3::timestamptz
   AND ($5::text IS NULL OR v.exported_at>=$5::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_channel_copy_versions older WHERE older.workspace_id=v.workspace_id AND older.document_hash=v.document_hash AND older.exported_at IS NOT NULL AND (older.exported_at,older.id)<(v.exported_at,v.id))
  ORDER BY v.exported_at,v.id LIMIT $7
 ), team_procedures AS (
  SELECT 'team-procedure' AS origin,v.procedure_id AS id,'team.write_procedure' AS action_type,
   'Private app procedure written: '||(v.document->>'title') AS summary,
   '{}'::jsonb AS result,v.created_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_team_procedure_versions v
  WHERE v.workspace_id=$1 AND v.created_at>=$2::timestamptz AND v.created_at<$3::timestamptz
   AND ($5::text IS NULL OR v.created_at>=$5::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_team_procedure_versions older WHERE older.workspace_id=v.workspace_id AND older.procedure_id=v.procedure_id
    AND older.document_hash=v.document_hash AND (older.created_at,older.id)<(v.created_at,v.id))
  ORDER BY v.created_at,v.id LIMIT $7
 ), product_retirements AS (
  SELECT 'product-retirement' AS origin,n.id,'catalog.retire_discontinued' AS action_type,
   'Retired '||(n.result->>'changedCount')||' discontinued products with replacement guidance: '||n.reference AS summary,
   '{}'::jsonb AS result,n.applied_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_product_retirement_notices n
  WHERE n.workspace_id=$1 AND n.applied_at>=$2::timestamptz AND n.applied_at<$3::timestamptz AND (n.result->>'changedCount')::int>0
   AND ($5::text IS NULL OR n.applied_at>=$5::timestamptz) ORDER BY n.applied_at,n.id LIMIT $7
 ), shutdown_purchases AS (
  SELECT 'shutdown-purchase' AS origin,p.id,'purchasing.plan_supplier_shutdown' AS action_type,
   'Prepared shutdown purchase draft: '||o.po_number||' from '||s.reference AS summary,
   jsonb_build_object('purchaseOrderId',o.id) AS result,p.purchase_created_at AS executed_at,jsonb_build_object('shutdownId',p.shutdown_id) AS payload,o.status='CANCELLED' AS undone
  FROM stockchief_runtime.agent_supplier_shutdown_plans p JOIN stockchief_runtime.agent_supplier_shutdowns s ON s.workspace_id=p.workspace_id AND s.id=p.shutdown_id
  JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.purchase_created_at>=$2::timestamptz AND p.purchase_created_at<$3::timestamptz
   AND ($5::text IS NULL OR p.purchase_created_at>=$5::timestamptz) ORDER BY p.purchase_created_at,p.id LIMIT $7
 ), supplier_claims AS (
  (SELECT 'supplier-claim' AS origin,c.id,'supplier.open_damage_claim' AS action_type,
   CASE WHEN c.snapshot->>'claimKind'='shortage' THEN 'Sent supplier shortage claim ' ELSE 'Sent supplier damage claim ' END||c.reference AS summary,
   jsonb_build_object('communicationId',m.id) AS result,m.sent_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_claims c JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id
  WHERE c.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz
   AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz) AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=c.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED')
  ORDER BY m.sent_at,c.id LIMIT $7)
  UNION ALL
  (SELECT 'supplier-claim' AS origin,c.id,'supplier.open_damage_claim' AS action_type,'Sent reminder '||h.number||' for supplier claim '||c.reference AS summary,
   jsonb_build_object('communicationId',m.id) AS result,m.sent_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_claim_chases h JOIN stockchief_runtime.agent_supplier_claims c ON c.workspace_id=h.workspace_id AND c.id=h.claim_id
  JOIN supplier_communications m ON m.workspace_id=h.workspace_id AND m.id=h.communication_id
  WHERE h.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz
   AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz) ORDER BY m.sent_at,h.id LIMIT $7)
 ), supplier_rfqs AS (
  SELECT 'supplier-rfq' AS origin,d.id,'supplier.request_quotes' AS action_type,'Sent supplier RFQ: '||(r.snapshot->>'reference')||' to '||s.name AS summary,
   jsonb_build_object('communicationId',m.id) AS result,m.sent_at::timestamptz AS executed_at,jsonb_build_object('requestId',d.request_id) AS payload,false AS undone
  FROM stockchief_runtime.agent_rfq_deliveries d JOIN stockchief_runtime.agent_rfq_requests r ON r.workspace_id=d.workspace_id AND r.id=d.request_id
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id
  WHERE d.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz
   AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz) AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=d.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED')
  ORDER BY m.sent_at,d.id LIMIT $7
 ), return_labels AS (
  SELECT 'return-label' AS origin,m.id,'customer_return.send_label' AS action_type,'Sent purchased return label and instructions: '||m.subject AS summary,
    '{}'::jsonb AS result,m.sent_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM customer_communications m WHERE m.workspace_id=$1 AND m.status='SENT' AND m.external_message_id IS NOT NULL
    AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz
    AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz)
    AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=m.workspace_id AND e.aggregate_id=m.id
      AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED' AND e.payload->'standingAuthority'->>'kind'='return_label')
  ORDER BY executed_at,m.id LIMIT $7
 ), partial_shipments AS (
  SELECT 'partial-shipment' AS origin,p.id,p.action_type,'Completed partial shipment for '||(p.payload#>>'{partialSummary,order}') AS summary,
    p.result,${partial.completedAtSql('p')} AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.action_type='warehouse.release_partial_order'
    AND ${partial.completionSql('p')}
    AND ${partial.completedAtSql('p')}>=$2::timestamptz
    AND ${partial.completedAtSql('p')}<$3::timestamptz
    AND ($5::text IS NULL OR ${partial.completedAtSql('p')}>=$5::timestamptz)
  ORDER BY executed_at,p.id LIMIT $7
 ), customer_page_orders AS (
  SELECT 'customer-page-order' AS origin,r.id,'customer_order.from_page' AS action_type,'Drafted original customer page request: '||r.reference AS summary,
   jsonb_build_object('salesOrderId',r.sales_order_id) AS result,r.processed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_customer_page_requests r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
  WHERE r.workspace_id=$1 AND r.status='DRAFTED' AND o.status<>'CANCELLED' AND r.processed_at>=$2::timestamptz AND r.processed_at<$3::timestamptz
   AND ($5::text IS NULL OR r.processed_at>=$5::timestamptz) ORDER BY r.processed_at,r.id LIMIT $7
 ), return_dispositions AS (
  SELECT 'return-disposition' AS origin,p.id,'customer_return.plan_disposition' AS action_type,'Approved rule-based return disposition: '||r.return_number AS summary,
   '{}'::jsonb AS result,p.applied_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_return_assessments p JOIN customer_returns r ON r.workspace_id=p.workspace_id AND r.id=p.return_id
  WHERE p.workspace_id=$1 AND p.status='APPLIED' AND p.proposal->>'byRules'='true' AND r.inspected_at IS NOT NULL
   AND p.applied_at>=$2::timestamptz AND p.applied_at<$3::timestamptz AND ($5::text IS NULL OR p.applied_at>=$5::timestamptz)
  ORDER BY p.applied_at,p.id LIMIT $7
 ), supplier_credits AS (
  SELECT 'supplier-credit-source' AS origin,a.credit_id id,'supplier_credit.apply_note' AS action_type,
   'Applied supplier credit '||a.source_number||' to '||b.bill_number AS summary,
   jsonb_build_object('intakeId',a.intake_id,'billId',b.id) AS result,a.approved_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_credit_applications a
  JOIN accounting_supplier_credits c ON c.workspace_id=a.workspace_id AND c.id=a.credit_id
  JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
  JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id AND j.status='POSTED'
  WHERE a.workspace_id=$1 AND a.approved_at>=$2::timestamptz AND a.approved_at<$3::timestamptz
   AND ($5::text IS NULL OR a.approved_at>=$5::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')
  ORDER BY a.approved_at,a.credit_id LIMIT $7
 ), supplier_invoices AS (
  SELECT 'supplier-invoice-source' AS origin,q.id,'purchase_order.record_supplier_invoice' AS action_type,'Read, matched and recorded supplier invoice: '||q.invoice_number AS summary,jsonb_build_object('billId',q.bill_id) AS result,b.opened_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_invoice_intakes q JOIN accounting_supplier_bills b ON b.workspace_id=q.workspace_id AND b.id=q.bill_id WHERE q.workspace_id=$1 AND q.status='POSTED' AND b.opened_at::timestamptz>=$2::timestamptz AND b.opened_at::timestamptz<$3::timestamptz AND ($5::text IS NULL OR b.opened_at::timestamptz>=$5::timestamptz) ORDER BY b.opened_at,q.id LIMIT $7
 ), customer_invoices AS (
  SELECT 'customer-invoice' AS origin,p.id,'customer_invoice.prepare_document' AS action_type,'Prepared customer invoice: '||(p.source_snapshot->'document'->'row'->>'invoice_number') AS summary,jsonb_build_object('documentId',p.id,'invoiceId',p.invoice_id) AS result,p.created_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_customer_invoice_documents p WHERE p.workspace_id=$1 AND p.created_at>=$2::timestamptz AND p.created_at<$3::timestamptz AND ($5::text IS NULL OR p.created_at>=$5::timestamptz) ORDER BY p.created_at,p.id LIMIT $7
 ), export_packets AS (
  SELECT 'export-papers' AS origin,p.id,'shipping.prepare_export_papers' AS action_type,'Prepared and owner-reviewed export packet: '||(p.source_snapshot->>'shipmentNumber') AS summary,
   '{}'::jsonb AS result,p.reviewed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_export_paper_packets p WHERE p.workspace_id=$1 AND p.status='REVIEWED' AND p.reviewed_pdf IS NOT NULL
   AND p.reviewed_at>=$2::timestamptz AND p.reviewed_at<$3::timestamptz AND ($5::text IS NULL OR p.reviewed_at>=$5::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_export_paper_packets prior WHERE prior.workspace_id=p.workspace_id AND prior.shipment_id=p.shipment_id AND prior.status='REVIEWED' AND (prior.reviewed_at,prior.id)<(p.reviewed_at,p.id))
  ORDER BY p.reviewed_at,p.id LIMIT $7
 ), annual_stocktakes AS (
  SELECT 'annual-stocktake' AS origin,p.id,'inventory.plan_annual_stocktake' AS action_type,'Signed off annual stocktake: '||p.title AS summary,
   p.signoff AS result,p.signed_off_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_annual_stocktakes p WHERE p.workspace_id=$1 AND p.status='SIGNED_OFF' AND p.signed_off_at>=$2::timestamptz AND p.signed_off_at<$3::timestamptz
   AND ($5::text IS NULL OR p.signed_off_at>=$5::timestamptz) ORDER BY p.signed_off_at,p.id LIMIT $7
 ), channel_buffers AS (
  SELECT 'channel-buffer' AS origin,e.id,'channel.set_stock_buffer' AS action_type,
   'Published buffered channel stock: '||s.code||' at '||l.name||' = '||(e.payload->>'value')||' units' AS summary,
   e.result,e.completed_at AS executed_at,jsonb_build_object('positionId',p.id) AS payload,false AS undone
  FROM stockchief_runtime.provider_effects e JOIN connection_commerce_positions p ON p.workspace_id=e.workspace_id AND p.id=e.aggregate_id
  JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
  WHERE e.workspace_id=$1 AND e.kind='commerce.position.publish' AND e.status='SUCCEEDED' AND e.payload->'channelBuffer'->>'id' IS NOT NULL AND e.result->>'verified'='true'
   AND e.completed_at>=$2::timestamptz AND e.completed_at<$3::timestamptz AND ($5::text IS NULL OR e.completed_at>=$5::timestamptz) ORDER BY e.completed_at,e.id LIMIT $7
 ), delivery_quality AS (
  (SELECT 'delivery-qc' AS origin,h.id,'inventory.inspect_delivery' AS action_type,
   'Applied delivery QC hold: '||trim_scale(h.quantity)||' units of '||s.code AS summary,
   jsonb_build_object('holdId',h.id) AS result,h.created_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_quality_holds h JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id
  WHERE h.workspace_id=$1 AND h.automatic AND h.created_at>=$2::timestamptz AND h.created_at<$3::timestamptz
   AND ($5::text IS NULL OR h.created_at>=$5::timestamptz) ORDER BY h.created_at,h.id LIMIT $7)
  UNION ALL
  (SELECT 'delivery-qc' AS origin,h.id,'inventory.inspect_delivery' AS action_type,
   'Released passed QC goods under your rule: '||trim_scale(h.quantity-h.returned_quantity-h.written_off_quantity)||' units of '||s.code AS summary,
   jsonb_build_object('holdId',h.id,'released',true) AS result,h.released_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_quality_holds h JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id
  WHERE h.workspace_id=$1 AND h.released_by_rule AND h.released_at>=$2::timestamptz AND h.released_at<$3::timestamptz
   AND ($5::text IS NULL OR h.released_at>=$5::timestamptz) ORDER BY h.released_at,h.id LIMIT $7)
 ), warehouse_routings AS (
  SELECT 'warehouse-routing' AS origin,r.id,'sales_order.route_warehouse' AS action_type,
   'Chose the shipping warehouse for '||o.order_number||': '||(r.plan->>'summary') AS summary,
   jsonb_build_object('orderId',r.sales_order_id) AS result,r.applied_at AS executed_at,'{}'::jsonb AS payload,r.status='UNDONE' AS undone
  FROM stockchief_runtime.agent_warehouse_routings r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
  WHERE r.workspace_id=$1 AND r.authorization_kind='AUTOMATIC' AND r.status IN ('APPLIED','UNDONE') AND r.applied_at>=$2::timestamptz AND r.applied_at<$3::timestamptz
   AND ($5::text IS NULL OR r.applied_at>=$5::timestamptz) ORDER BY r.applied_at,r.id LIMIT $7
 ), pick_releases AS (
  ${releasesInstalled?`SELECT 'pick-release' AS origin,r.id,'warehouse.release_orders' AS action_type,'Released orders to the warehouse: '||(r.plan->>'summary') AS summary,
   jsonb_build_object('locationId',r.location_id) AS result,r.released_at AS executed_at,'{}'::jsonb AS payload,r.status='UNDONE' AS undone
  FROM stockchief_runtime.agent_pick_releases r
  WHERE r.workspace_id=$1 AND r.authorization_kind='AUTOMATIC' AND r.status IN ('RELEASED','UNDONE') AND r.released_at>=$2::timestamptz AND r.released_at<$3::timestamptz
   AND ($5::text IS NULL OR r.released_at>=$5::timestamptz) ORDER BY r.released_at,r.id LIMIT $7`
  :`SELECT 'pick-release'::text,NULL::text,NULL::text,NULL::text,NULL::jsonb,NULL::timestamptz,NULL::jsonb,false WHERE false`}
 ), pick_waves AS (
  ${wavesInstalled?`SELECT 'pick-wave' AS origin,a.id,'warehouse.wave.create' AS action_type,'Started pick wave #'||f.wave_number||' at '||(a.plan->>'location')||' for '||jsonb_array_length(a.plan->'orders')||' orders' AS summary,
   jsonb_build_object('waveId',a.wave_id) AS result,a.started_at AS executed_at,'{}'::jsonb AS payload,a.status='UNDONE' AS undone
  FROM stockchief_runtime.agent_pick_waves a JOIN fulfillment_waves f ON f.workspace_id=a.workspace_id AND f.id=a.wave_id
  WHERE a.workspace_id=$1 AND a.started_kind='AUTOMATIC' AND a.status IN ('STARTED','UNDONE') AND a.started_at>=$2::timestamptz AND a.started_at<$3::timestamptz
   AND ($5::text IS NULL OR a.started_at>=$5::timestamptz) ORDER BY a.started_at,a.id LIMIT $7`
  :`SELECT 'pick-wave'::text,NULL::text,NULL::text,NULL::text,NULL::jsonb,NULL::timestamptz,NULL::jsonb,false WHERE false`}
 ), promotion_purchases AS (
  SELECT 'promotion-purchase' AS origin,p.id,'purchasing.plan_promotion_stock' AS action_type,
   'Prepared promotion purchase draft: '||o.po_number||' from '||s.reference AS summary,
   jsonb_build_object('purchaseOrderId',o.id) AS result,p.purchase_created_at AS executed_at,jsonb_build_object('promotionId',p.promotion_id) AS payload,o.status='CANCELLED' AS undone
  FROM stockchief_runtime.agent_promotion_stock_plans p JOIN stockchief_runtime.agent_promotion_stock s ON s.workspace_id=p.workspace_id AND s.id=p.promotion_id
  JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.purchase_created_at>=$2::timestamptz AND p.purchase_created_at<$3::timestamptz
   AND ($5::text IS NULL OR p.purchase_created_at>=$5::timestamptz) ORDER BY p.purchase_created_at,p.id LIMIT $7
 ), open_to_buy AS (
  SELECT 'open-to-buy' AS origin,p.id,'planning.open_to_buy' AS action_type,'Planned buying for '||to_char(p.month_start,'YYYY-MM')||' within your budget' AS summary,
   '{}'::jsonb AS result,p.created_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_open_to_buy_plans p WHERE p.workspace_id=$1 AND p.automatic AND p.created_at>=$2::timestamptz AND p.created_at<$3::timestamptz
   AND ($5::text IS NULL OR p.created_at>=$5::timestamptz) ORDER BY p.created_at,p.id LIMIT $7
 ), forecast_shares AS (
  SELECT 'supplier-forecast' AS origin,r.id,'supplier.share_forecast' AS action_type,'Shared the weekly stock forecast with '||s.name AS summary,
   jsonb_build_object('communicationId',m.id) AS result,m.sent_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_forecast_reports r JOIN supplier_communications m ON m.workspace_id=r.workspace_id AND m.id=r.communication_id
  JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
  WHERE r.workspace_id=$1 AND m.status='SENT' AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz)
   AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=r.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED' AND e.payload->'standingAuthority'->>'automatic'='true')
  ORDER BY m.sent_at,r.id LIMIT $7
 ), carrier_claims AS (
  SELECT 'carrier-claim' AS origin,c.id,'shipping.carrier_claim' AS action_type,'Filed a carrier claim on its own for '||coalesce(h.shipment_number,'a shipment') AS summary,
   jsonb_build_object('shipmentId',c.shipment_id) AS result,e.completed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_carrier_claims c JOIN stockchief_runtime.provider_effects e ON e.workspace_id=c.workspace_id AND e.id=c.effect_id AND e.status='SUCCEEDED'
  LEFT JOIN sales_shipments h ON h.workspace_id=c.workspace_id AND h.id=c.shipment_id
  WHERE c.workspace_id=$1 AND c.automatic AND e.completed_at>=$2::timestamptz AND e.completed_at<$3::timestamptz AND ($5::text IS NULL OR e.completed_at>=$5::timestamptz)
  ORDER BY e.completed_at,c.id LIMIT $7
 ), freight_pickups AS (
  SELECT 'freight-pickup' AS origin,p.id,'shipping.freight_pickup' AS action_type,'Booked a freight pickup under your rule for '||coalesce(h.shipment_number,'a shipment') AS summary,
   jsonb_build_object('shipmentId',p.shipment_id) AS result,e.completed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_freight_pickups p JOIN stockchief_runtime.provider_effects e ON e.workspace_id=p.workspace_id AND e.id=p.effect_id AND e.status='SUCCEEDED'
  LEFT JOIN sales_shipments h ON h.workspace_id=p.workspace_id AND h.id=p.shipment_id
  WHERE p.workspace_id=$1 AND p.rule_revision IS NOT NULL AND e.completed_at>=$2::timestamptz AND e.completed_at<$3::timestamptz AND ($5::text IS NULL OR e.completed_at>=$5::timestamptz)
  ORDER BY e.completed_at,p.id LIMIT $7
 ), channel_recovery AS (
  SELECT 'channel-recovery' AS origin,r.effect_id AS id,'channel_sync.recover' AS action_type,
   CASE WHEN r.outcome='VERIFIED' THEN 'Rechecked a stuck channel stock update and confirmed it' ELSE 'Rechecked a stuck channel stock update and held it for review' END||coalesce(': '||s.code,'') AS summary,
   '{}'::jsonb AS result,r.checked_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_channel_recovery_checks r JOIN stockchief_runtime.provider_effects e ON e.workspace_id=r.workspace_id AND e.id=r.effect_id
  LEFT JOIN connection_commerce_positions p ON p.workspace_id=e.workspace_id AND p.id=e.payload->>'positionId' LEFT JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
  WHERE r.workspace_id=$1 AND r.outcome IN ('VERIFIED','HELD') AND r.checked_at>=$2::timestamptz AND r.checked_at<$3::timestamptz AND ($5::text IS NULL OR r.checked_at>=$5::timestamptz)
  ORDER BY r.checked_at,r.effect_id LIMIT $7
 ), audit_work AS (
  SELECT 'audit' AS origin,e.id,e.action AS action_type,e.action AS summary,e.after_state AS result,e.created_at AS executed_at,
   jsonb_build_object('reference',e.reference) AS payload,false AS undone
  FROM security_event_history e WHERE e.workspace_id=$1 AND e.created_at>=$2::timestamptz AND e.created_at<$3::timestamptz
   AND ($5::text IS NULL OR e.created_at>=$5::timestamptz) AND (${conditions})
  ORDER BY e.created_at,e.id LIMIT $7
 ) SELECT * FROM (SELECT * FROM actions UNION ALL SELECT * FROM routines UNION ALL SELECT * FROM supplier_details UNION ALL SELECT * FROM po_dates UNION ALL SELECT * FROM container_plans UNION ALL SELECT * FROM blanket_releases UNION ALL SELECT * FROM container_orders UNION ALL SELECT * FROM channel_copy UNION ALL SELECT * FROM product_facts UNION ALL SELECT * FROM team_procedures UNION ALL SELECT * FROM product_retirements UNION ALL SELECT * FROM shutdown_purchases UNION ALL SELECT * FROM promotion_purchases UNION ALL SELECT * FROM warehouse_routings UNION ALL SELECT * FROM pick_releases UNION ALL SELECT * FROM pick_waves UNION ALL SELECT * FROM delivery_quality UNION ALL SELECT * FROM supplier_rfqs UNION ALL SELECT * FROM supplier_claims UNION ALL SELECT * FROM channel_buffers UNION ALL SELECT * FROM annual_stocktakes UNION ALL SELECT * FROM partial_shipments UNION ALL SELECT * FROM return_labels UNION ALL SELECT * FROM supplier_credits UNION ALL SELECT * FROM supplier_invoices UNION ALL SELECT * FROM customer_invoices UNION ALL SELECT * FROM export_packets UNION ALL SELECT * FROM return_dispositions UNION ALL SELECT * FROM customer_page_orders UNION ALL SELECT * FROM open_to_buy UNION ALL SELECT * FROM forecast_shares UNION ALL SELECT * FROM carrier_claims UNION ALL SELECT * FROM freight_pickups UNION ALL SELECT * FROM channel_recovery UNION ALL SELECT * FROM audit_work) all_work ORDER BY executed_at ${dir},origin ${dir},id ${dir} LIMIT 101 OFFSET $4`;
 // Newest first: each source keeps its newest rows for the page.
 if(dir==='DESC')sql=sql.replace(/ORDER BY ([^\n]*?) LIMIT \$7/g,(m,cols)=>'ORDER BY '+cols.split(',').map(c=>c.trim()+' DESC').join(',')+' LIMIT $7');
 const rows=(await db.query(sql,[ctx.workspaceId,from,to,(page-1)*100,history.activityAfter,[...KINDS.keys()],page*100+1,...Object.keys(WHEN).map(w=>whenActions[w])])).rows;
 const more=rows.length>100;if(more)rows.pop();
 return {rows,more};
}

// What the existing daily record checked before offering undo of a prepared
// change: an unchanged draft order, open quote or unused production draft,
// or the latest purchase costs.
function reference(p){return p.result?.salesOrderId||p.result?.quoteId||p.result?.id;}
async function proposalStates(db,ctx,proposals,{lock=false}={}){
 const result=new Map(),suffix=lock?' FOR UPDATE':'';
 for(const [kind,table]of [['sale','sales_orders'],['quote','sales_quotations'],['production','manufacturing_work_orders']]){
  const ids=proposals.filter(p=>KINDS.get(p.action_type)===kind).map(reference).filter(Boolean);if(!ids.length)continue;
  const rows=(await db.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=ANY($2::text[])'+suffix,[ctx.workspaceId,ids])).rows;
  for(const row of rows)result.set(kind+':'+row.id,row);
 }
 const workIds=proposals.filter(p=>KINDS.get(p.action_type)==='production').map(reference).filter(Boolean);
 if(workIds.length){const used=(await db.query(`SELECT DISTINCT work_order_id FROM manufacturing_events WHERE workspace_id=$1 AND work_order_id=ANY($2::text[])
  UNION SELECT work_order_id FROM manufacturing_capacity_bookings WHERE workspace_id=$1 AND work_order_id=ANY($2::text[]) AND status='HELD'`,[ctx.workspaceId,workIds])).rows;
  for(const r of used){const row=result.get('production:'+r.work_order_id);if(row)row.laterWork=true;}}
 const quoteIds=proposals.filter(p=>KINDS.get(p.action_type)==='quote').map(reference).filter(Boolean);
 if(quoteIds.length){const newer=(await db.query('SELECT supersedes_id FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=ANY($2::text[])',[ctx.workspaceId,quoteIds])).rows;
  for(const r of newer){const row=result.get('quote:'+r.supersedes_id);if(row)row.laterWork=true;}}
 const skuIds=[...new Set(proposals.filter(p=>KINDS.get(p.action_type)==='prices').flatMap(p=>(p.payload.changes||[]).map(c=>c.skuId)))];
 if(skuIds.length){const costs=(await db.query(`SELECT p.* FROM skus s JOIN LATERAL(SELECT * FROM sku_purchase_costs p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1)p ON true
   WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id`+(lock?' FOR UPDATE OF s':''),[ctx.workspaceId,skuIds])).rows;
  for(const r of costs)result.set('cost:'+r.sku_id,r);}
 return result;
}
function proposalUndo(p,state){
 const kind=KINDS.get(p.action_type),row=state.get(kind+':'+reference(p));
 if(kind==='sale')return row?.status==='DRAFT'&&Number(row.version)===1?{allowed:true,reason:'Cancel the unchanged draft order'}:{allowed:false,reason:'Order changed; review its current state'};
 if(kind==='quote')return row?.status==='OPEN'&&!row.laterWork?{allowed:true,reason:'Withdraw the open quotation'}:{allowed:false,reason:'Quotation decided or revised; review its current state'};
 if(kind==='production')return row?.status==='DRAFT'&&!row.laterWork&&Number(row.wip_cost_minor)===0?{allowed:true,reason:'Cancel the unused production draft'}:{allowed:false,reason:'Production has later work; review its current state'};
 if(kind==='prices'){
  const changes=p.payload.changes||[],ids=p.result?.ids||[];
  const safe=changes.length&&changes.every(c=>c.before&&ids.includes(state.get('cost:'+c.skuId)?.id)&&
   Number(state.get('cost:'+c.skuId).amount_minor)===c.amountMinor&&state.get('cost:'+c.skuId).currency===c.currency);
  return {allowed:Boolean(safe),reason:safe?'Restore the preceding purchase costs':'Purchase costs changed or had no previous value; review their current state'};
 }
 return {allowed:false,reason:'Open the recorded work to review a correction'};
}

// Each job's own undo. `table` and its conditions say whether the record is
// still as StockChief left it (ready), already undone (done), or moved on;
// `run` is the job's undo, which rechecks everything under lock.
const status=(table,{id='t.id',ready,done})=>async(db,ws,items)=>{
 const ids=[...new Set(items.map(i=>i.record).filter(Boolean))];if(!ids.length)return new Map();
 const rows=(await db.query(`SELECT ${id} AS id,(${ready}) AS ready,(${done}) AS done FROM ${table} t WHERE t.workspace_id=$1 AND ${id}=ANY($2::text[])`,[ws,ids])).rows;
 return new Map(rows.map(r=>[r.id,r.done?'done':r.ready?'ready':'changed']));
};
const confirmed={confirmed:'yes'};
const UNDO={
 routing:{what:'Undo the warehouse choice. Refused once picking starts.',check:status('stockchief_runtime.agent_warehouse_routings',{ready:"t.status='APPLIED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../sales/agent-ship-from').undo(scoped(c),ctx,id,confirmed)},
 release:{what:'Take the orders back from the warehouse. Refused once picking starts.',check:status('stockchief_runtime.agent_pick_releases',{ready:"t.status='RELEASED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../warehouse/agent-pick-release').undo(scoped(c),ctx,id)},
 wave:{what:'Undo the pick wave. Refused once picking starts.',check:status('stockchief_runtime.agent_pick_waves',{ready:"t.status='STARTED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../warehouse/agent-pick-waves').undo(scoped(c),ctx,id)},
 supplierDetails:{what:'Put back the supplier details this email changed, if nothing changed them since.',check:status('stockchief_runtime.agent_supplier_term_sources',{id:'t.message_id',done:'t.undone_at IS NOT NULL',
   // Every value it changed is still the one this email set.
   ready:`t.undone_at IS NULL AND t.changed_count>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(t.source_snapshot->'changes') c
    JOIN stockchief_runtime.agent_supplier_term_heads h ON h.workspace_id=t.workspace_id AND h.supplier_id=t.source_snapshot->>'supplierId' AND h.target_id=c->>'targetId' AND h.field=c->>'field'
    WHERE c->'before' IS DISTINCT FROM c->'value' AND h.message_id<>t.message_id)`}),
  run:(c,ctx,id)=>require('../purchasing/agent-supplier-email-terms').undo(scoped(c),ctx,id,confirmed)},
 containerOrder:{what:'Cancel the draft container order before it is sent.',check:status('stockchief_runtime.agent_container_orders',{ready:"t.status='DRAFTED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../purchasing/agent-container-orders').undo(scoped(c),ctx,id,confirmed)},
 blanketRelease:{what:'Cancel the prepared release before it is sent.',check:status('stockchief_runtime.agent_blanket_releases',{ready:"t.status='DRAFTED' AND t.undone_at IS NULL AND t.sent_at IS NULL",done:'t.undone_at IS NOT NULL'}),
  run:(c,ctx,id)=>require('../purchasing/agent-blanket-releases').undo(scoped(c),ctx,id,confirmed)},
 slowStock:{what:'Undo the step while its transfer, return or clearance has not started.',check:status('stockchief_runtime.agent_slow_stock_steps',{ready:"t.status='DONE'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../forecasting/agent-slow-stock-steps').undo(scoped(c),ctx,id,confirmed)},
 binCorrection:{what:'Move the stock records back to the bin they were in.',check:status('stockchief_runtime.agent_bin_corrections',{ready:"t.status='COMPLETED' AND t.kind='RECORD'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../warehouse/agent-bin-corrections').undo(scoped(c),ctx,id,confirmed)},
 protection:{what:'Undo the reservation change.',check:status('stockchief_runtime.agent_stock_reservation_changes',{ready:"t.undone_at IS NULL AND t.kind NOT IN ('undone','order_arrived')",done:'t.undone_at IS NOT NULL'}),
  run:(c,ctx,id)=>require('../sales/agent-stock-protections').undo(scoped(c),ctx,id,{requestKey:'agent-activity-undo:'+id})},
 reorderRefresh:{what:'Put back the earlier reorder point and target, if nobody changed them since.',check:status('stockchief_runtime.agent_reorder_refresh_changes',{done:"t.status='UNDONE'",ready:`t.status='APPLIED' AND EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=t.workspace_id AND p.id=t.policy_id
   AND p.reorder_point::numeric IS NOT DISTINCT FROM t.after_minimum AND p.target_stock::numeric IS NOT DISTINCT FROM t.after_maximum)`}),
  run:(c,ctx,id)=>require('../forecasting/agent-reorder-refresh').undo(scoped(c),ctx,id)},
 safetyStock:{what:'Put back the earlier safety stock, if nobody changed it since.',check:status('stockchief_runtime.agent_safety_stock_changes',{done:"t.status='UNDONE'",ready:`t.status='APPLIED' AND EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=t.workspace_id AND p.id=t.policy_id
   AND p.safety_stock::numeric IS NOT DISTINCT FROM t.after_safety)`}),
  run:(c,ctx,id)=>require('../forecasting/agent-safety-stock').undo(scoped(c),ctx,id)},
 staleIncoming:{what:'Reopen the goods as still incoming, if the purchase order did not change.',check:status('stockchief_runtime.agent_incoming_closes',{ready:"t.status='CLOSED'",done:"t.status='REOPENED'"}),
  run:(c,ctx,id)=>require('../purchasing/agent-stale-incoming').reopen(scoped(c),ctx,id,confirmed)},
 landedCost:{what:'Take the delivery cost back out of stock with a reversing entry.',check:status('stockchief_runtime.agent_landed_cost_bills',{id:'t.bill_line_id',ready:"t.status='POSTED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../accounting/agent-landed-cost-bills').undo(scoped(c),ctx,id,confirmed)},
 backorderRun:{what:'Give the stock back, if picking has not started.',check:status('stockchief_runtime.agent_backorder_runs',{ready:"t.status='APPLIED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../sales/agent-backorders').undo(scoped(c),ctx,id,confirmed)},
 orderSplit:{what:'Undo the split while the box is not packed.',check:status('stockchief_runtime.agent_order_splits',{ready:"t.status='APPLIED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>require('../sales/agent-order-splits').undo(scoped(c),ctx,id,confirmed)},
 supplierCost:{what:'Put back the previous supplier cost, if nobody changed it since.',check:status('stockchief_runtime.agent_supplier_cost_updates',{id:"t.source_id||':'||t.ordinal",ready:"t.status='APPLIED'",done:"t.status='UNDONE'"}),
  run:(c,ctx,id)=>{const at=id.lastIndexOf(':');return require('../pricing/agent-supplier-price-updates').undo(scoped(c),ctx,id.slice(0,at),Number(id.slice(at+1)),confirmed);}},
 reslot:{what:'Cancel the move before staff start it.',check:status('stockchief_runtime.agent_slotting_moves',{id:"t.plan_id||':'||t.move_hash",
   ready:"t.undone_at IS NULL AND EXISTS(SELECT 1 FROM inventory_transfers x WHERE x.workspace_id=t.workspace_id AND x.id=t.transfer_id AND x.status='APPROVED')",done:'t.undone_at IS NOT NULL'}),
  run:(c,ctx,id)=>{const at=id.indexOf(':');return require('../forecasting/warehouse-slotting').undo(scoped(c),ctx,id.slice(0,at),{move:id.slice(at+1)});}},
 catalogFix:{what:'Undo the fix, if the product did not change since.',check:status('stockchief_runtime.agent_catalog_fixes',{done:"t.status='UNDONE'",
   // The product still holds what the fix set.
   ready:`t.status='DONE' AND CASE t.kind
    WHEN 'COST' THEN (SELECT p.id FROM sku_purchase_costs p WHERE p.workspace_id=t.workspace_id AND p.sku_id=t.sku_id ORDER BY p.created_at DESC,p.id DESC LIMIT 1)=t.applied->>'costId'
    WHEN 'WEIGHT' THEN EXISTS(SELECT 1 FROM skus s WHERE s.workspace_id=t.workspace_id AND s.id=t.sku_id AND s.weight_grams=(t.applied->>'grams')::numeric)
    WHEN 'SKU' THEN EXISTS(SELECT 1 FROM skus s WHERE s.workspace_id=t.workspace_id AND s.id=t.sku_id AND s.code=t.applied->>'after')
    ELSE EXISTS(SELECT 1 FROM skus s WHERE s.workspace_id=t.workspace_id AND s.id=t.sku_id AND s.is_active=0) END`}),
  run:(c,ctx,id)=>require('../catalog/agent-catalog-fixes').undo(scoped(c),ctx,id,confirmed)},
 category:{what:'Put back the earlier category or tags, if nobody changed them since.',check:status('stockchief_runtime.agent_product_classifications',{done:"t.status='UNDONE'",
   ready:`t.status='DONE' AND (t.kind<>'CATEGORY' OR EXISTS(SELECT 1 FROM catalogue_item_facts f WHERE f.workspace_id=t.workspace_id AND f.item_id=t.item_id AND f.category=t.applied->>'after'))`}),
  run:(c,ctx,id)=>require('../catalog/agent-product-classification').undo(scoped(c),ctx,id,confirmed)},
 // A batch of staff tasks is withdrawn only while every task in it is still waiting.
 staffTasks:{what:'Withdraw these tasks while nobody has done them.',
  check:async(db,ws,items)=>{
   const out=new Map(),ids=[...new Set(items.flatMap(i=>(i.row.result?.tasks||[]).map(t=>t.id)))];if(!ids.length)return out;
   const states=new Map((await db.query('SELECT id,status FROM stockchief_runtime.agent_staff_tasks WHERE workspace_id=$1 AND id=ANY($2::text[])',[ws,ids])).rows.map(r=>[r.id,r.status]));
   for(const i of items){const s=(i.row.result?.tasks||[]).map(t=>states.get(t.id));
    out.set(i.record,s.length&&s.every(x=>x==='CANCELLED')?'done':s.length&&s.every(x=>x==='ASSIGNED')?'ready':'changed');}
   return out;
  },
  run:async(c,ctx,id,row)=>{
   const tasks=(row.result?.tasks||[]).map(t=>t.id),now=(await c.query('SELECT id,status FROM stockchief_runtime.agent_staff_tasks WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,tasks])).rows;
   if(!now.length||now.some(t=>t.status!=='ASSIGNED'))throw new ValidationError('Some of these tasks were done or changed. Withdraw the others on Staff tasks.');
   for(const t of now)await require('../operations/agent-staff-tasks').withdraw(scoped(c),ctx,t.id);
   return {withdrawn:now.length};
  }}
};

// The 'Agent action completed' entry for a prepared change (job 181).
async function completed(c,ctx,{proposal,capability,job,automatic,missionPlanId,routineAuthority,trained,account}){
 const allowedBy=missionPlanId?{kind:'mission',planId:missionPlanId}:routineAuthority?{...routineAuthority,kind:'routine',routine:routineAuthority.kind||null}
  :automatic?{kind:'routine'}:{kind:'approval',approvedBy:ctx.actorId||null};
 await audit.record(c,ctx,{action:COMPLETED,reference:proposal.id,after:{job:job||null,capability,automatic:Boolean(automatic),summary:String(proposal.summary||'').slice(0,300),
  allowedBy,...(trained?{trained:true}:{}),plan:account?.plan||null,mode:job&&account?.plan?policy.allowance(account.plan,job):null}});
}

const limitText=v=>v==null||v===''?null:typeof v==='object'?Object.entries(v).filter(([,x])=>x!=null).map(([k,x])=>k+' '+x).join(', '):String(v);
function allowed(row,info,hook){
 if(row.origin==='action'){
  const a=hook?.allowedBy,plan=hook?.plan?planNames[hook.plan]:null;
  const base=!a?(row.result?.executionAuthority?'Your saved routine':'Your approval')
   :a.kind==='approval'?'Your approval':a.kind==='mission'?'A plan you approved in Ask':'Your saved routine'+(a.limit?' (limit '+limitText(a.limit)+')':'');
  return base+(hook?.trained?', taught from your example':'')+(hook?.automatic&&plan?' · '+plan+' plan':'');
 }
 const limit=row.origin==='audit'?limitText(row.result?.limit):null;
 return info.rule+(limit?' (limit '+limit+')':'');
}
// Internal record ids mean nothing to the owner; the record link opens them.
const internal=v=>/^[a-z][a-z-]*_[a-z0-9]{12,}$/i.test(String(v))||/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(v));
const label=k=>k.replace(/([A-Z])/g,' $1').toLowerCase().replace(/^./,c=>c.toUpperCase()).replace(/\bsku\b/i,'SKU');
function facts(after){
 if(!after||typeof after!=='object')return '';
 const skip=new Set(['automatic','routine','limit','authority','sentByOwner','job','more','undoable','runId','ruleRevision','changeId','closeId','planId','run','release','journalEntryId','effectId','communicationId','sourceFingerprint','sourceHash','evidence']);
 return Object.entries(after).filter(([k,v])=>!skip.has(k)&&!/Ids?$/.test(k)&&v!=null&&typeof v!=='object'&&!internal(v)).slice(0,6)
  .map(([k,v])=>label(k)+': '+(typeof v==='boolean'?(v?'yes':'no'):v)).join('; ').slice(0,240);
}
const linkFor=(row,info)=>{
 const p=row.payload||{},r=row.result||{};
 switch(row.origin){
  case 'supplier-credit-source':return r.intakeId?'/autopilot/supplier-credits/'+r.intakeId:'/money/bills/'+r.billId;
  case 'product-facts':return '/autopilot/product-facts/'+row.id;
  case 'supplier-invoice-source':return '/autopilot/supplier-invoices/'+row.id;
  case 'customer-invoice':return '/autopilot/customer-invoices/'+row.id;
  case 'blanket-release':return '/autopilot/blanket-releases/'+p.contractId;
  case 'container-order':return '/autopilot/container-orders/'+p.ruleId;
  case 'channel-copy':return '/autopilot/channel-copy/'+row.id;
  case 'customer-page-order':return '/autopilot/customer-order-pages?requestId='+row.id;
  case 'return-disposition':return '/autopilot/return-disposition?id='+row.id;
  case 'export-papers':return '/autopilot/export-papers/'+row.id;
  case 'return-label':return '/messages/customer/'+row.id;
  case 'annual-stocktake':return '/autopilot/annual-stocktakes/'+row.id;
  case 'channel-buffer':return '/autopilot/channel-buffers?position='+encodeURIComponent(p.positionId);
  case 'supplier-claim':return '/autopilot/supplier-claims/'+row.id;
  case 'supplier-rfq':return '/autopilot/supplier-rfqs/'+p.requestId;
  case 'delivery-qc':return '/autopilot/delivery-quality/'+row.id;
  case 'warehouse-routing':return '/orders/'+r.orderId+'/ship-from';
  case 'pick-release':return '/autopilot/pick-release#recent';
  case 'pick-wave':return '/warehouse/waves/'+r.waveId;
  case 'promotion-purchase':return '/autopilot/promotion-stock/'+p.promotionId;
  case 'shutdown-purchase':return '/autopilot/supplier-shutdowns/'+p.shutdownId;
  case 'product-retirement':return '/autopilot/discontinued-products/'+row.id;
  case 'team-procedure':return '/autopilot/team-procedures/'+row.id;
  case 'container-plan':return '/autopilot/container-plans/'+row.id;
  case 'po-delivery-date':return '/autopilot/po-delivery-dates/'+row.id;
  case 'supplier-details':return '/mail/'+row.id+'/supplier-details';
  case 'routine':return '/autopilot/work/'+row.id;
  case 'open-to-buy':return '/autopilot/open-to-buy';
  case 'supplier-forecast':return '/autopilot/supplier-forecasts';
  case 'carrier-claim':return '/autopilot/carrier-claims';
  case 'freight-pickup':return '/autopilot/freight-pickups';
  case 'channel-recovery':return '/autopilot/reviews/channel-sync-recovery';
  case 'audit':return info.page||'/audit?q='+encodeURIComponent(p.reference||row.summary);
  default:return '/actions/'+row.id;
 }
};

// The completed work presented as log entries: what, why, what allowed it,
// its evidence, and undo or its correction path.
async function describe(db,ctx,rows,timeZone){
 const ws=ctx.workspaceId,proposals=rows.filter(r=>r.origin==='action');
 const hooks=proposals.length?new Map((await db.query(`SELECT reference,after_state FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND reference=ANY($3::text[])`,
  [ws,COMPLETED,proposals.map(p=>p.id)])).rows.map(r=>[r.reference,r.after_state])):new Map();
 const state=await proposalStates(db,ctx,proposals);
 // Records behind audit trail entries that are found by lookup.
 const lookups=new Map();
 for(const s of SOURCES.filter(s=>s.lookup)){
  const refs=rows.filter(r=>r.origin==='audit'&&byAction.get(r.action_type)===s).map(r=>r.payload?.reference).filter(Boolean);
  if(refs.length)for(const r of (await db.query(s.lookup,[ws,refs])).rows)lookups.set(s.actions[0]+'|'+r.ref,r.id);
 }
 const items=rows.map(row=>{
  if(row.origin==='audit'){
   const s=byAction.get(row.action_type),ref=row.payload?.reference||null,after=row.result||{};
   const record=s.undo?(s.lookup?lookups.get(s.actions[0]+'|'+ref):s.record?s.record({id:row.id,reference:ref,after,result:after}):ref):null;
   return {row,info:{...s,job:s.job??(Number(after.job)||null)},undo:s.undo||null,record:record==null?null:String(record)};
  }
  const info=WORK[row.origin]||{job:null,why:'',rule:''};
  return {row,info:row.origin==='action'?{job:policy.actionJob(row.action_type,'automatic',row.payload)||null}:info,undo:info.undo||null,record:row.id};
 });
 // Batch the undo checks for each kind.
 const checks=new Map();
 for(const [kind,spec] of Object.entries(UNDO)){
  const mine=items.filter(i=>i.undo===kind&&i.record);if(!mine.length)continue;
  const found=await spec.check(db,ws,mine.map(i=>({record:i.record,row:i.row})));
  for(const i of mine)checks.set(i,found.get(i.record)||'changed');
 }
 const receipts=new Set((await db.query(`SELECT reference FROM security_event_history WHERE workspace_id=$1 AND action=$2 AND reference=ANY($3::text[])`,
  [ws,UNDONE,items.filter(i=>i.row.origin!=='action').map(i=>i.row.origin+':'+i.row.id)])).rows.map(r=>r.reference));
 // A job's own undo needs that job on the current plan.
 const account=await policy.accountState(db,ws),plan=policy.usesAgentTerms(account)?account.plan:null;
 const when=new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'});
 return items.map(i=>{
  const {row,info}=i,hook=row.origin==='action'?hooks.get(row.id):null,job=hook?.job||info.job||null;
  let undo=null,correction=null,undone=Boolean(row.undone)||receipts.has(row.origin+':'+row.id);
  if(row.origin==='action'){
   const decision=undone?{allowed:false,reason:'Already undone'}:proposalUndo(row,state);
   if(decision.allowed)undo={what:decision.reason};else correction=decision.reason;
  }else if(i.undo){
   const s=checks.get(i)||'changed';
   if(s==='done')undone=true;
   else if(s==='ready'&&(!job||policy.permits(plan,job,'draft')))undo={what:UNDO[i.undo].what};
   else correction=s==='ready'?'Your plan does not include undo for this job. Correct the record on its page.':(info.fix||'It changed since. Correct it on its page.');
  }else correction=info.none?'Nothing to undo: it only checked, planned or reported.':(info.outside?'Cannot be undone here. ':'')+(info.fix||'Open the record to correct it.');
  if(undone){undo=null;correction='Already undone.';}
  const reference=row.origin==='audit'?row.payload?.reference:row.id;
  const detail=row.origin==='audit'&&typeof row.result?.sku==='string'?' ('+row.result.sku+')':'';
  const what=row.origin==='audit'?row.summary+(reference&&!internal(reference)?': '+reference:'')+detail:row.summary;
  const why=row.origin==='action'?(row.payload?.sourceMessage?'Requested: '+row.payload.sourceMessage:(titles.get(job)||'Completed agent work.')):info.why;
  const evidence=row.origin==='audit'?facts(row.result):row.origin==='action'&&hook?.summary&&hook.summary!==row.summary?hook.summary:'';
  return {key:row.origin+':'+row.id,anchor:'entry-'+(row.origin+'-'+row.id).replace(/[^A-Za-z0-9_-]/g,'-'),origin:row.origin,id:row.id,job,jobTitle:titles.get(job)||null,at:new Date(row.executed_at).toISOString(),
   when:when.format(new Date(row.executed_at)),what,why,allowedBy:allowed(row,info,hook),evidence,
   trail:'/audit?q='+encodeURIComponent(reference||row.id),link:linkFor(row,info),status:undone?'Undone':'Completed',undo,correction};
 });
}

// One page of entries between two instants.
async function entries(db,ctx,{from,to,page=1,order='ASC',timeZone}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId);
 const {rows,more}=await work(db,ctx,{from,to,page,order,history});
 return {entries:await describe(db,ctx,rows,timeZone),more,history};
}
const row=e=>({When:e.when,Job:e.jobTitle||'StockChief',Action:e.what,Why:e.why,'Allowed by':e.allowedBy,'Undo or correction':e.undo?e.undo.what:e.correction,Status:e.status,link:e.link});

const DAY=/^\d{4}-\d{2}-\d{2}$/;
function range(filter,today){
 const text=String(filter||'').trim();
 if(!text)return {from:addDays(today,-6),to:today};
 const parts=text.split(/\s*(?:\.\.|to)\s*/);
 if(parts.length>2||!parts.every(p=>DAY.test(p)))throw new ValidationError('Enter a business date (YYYY-MM-DD) or two dates joined by "..".');
 const [from,to=from]=parts;if(from>to)throw new ValidationError('The end date must be on or after the start date.');
 if(Date.parse(to)-Date.parse(from)>366*86400000)throw new ValidationError('Choose up to a year at a time.');
 return {from,to};
}

// The log page and Ask's review (read.agent_review): newest first.
async function report(db,ctx,{filter='',page=1}={}){
 await require('./job-reviews').ownerState(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
 page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid log page.');
 const {calendarDate,timeZone}=await time.forWorkspace(db,ctx.workspaceId),span=range(filter,calendarDate);
 const result=await entries(db,ctx,{from:time.dayBoundary(span.from,timeZone),to:time.dayBoundary(span.to,timeZone,{nextDay:true}),page,order:'DESC',timeZone});
 const kept=result.history.activityAfter?' Your plan keeps the log since '+result.history.activityAfter.slice(0,10)+'.':'';
 return {rows:result.entries.map(row),more:result.more,
  activity:{entries:result.entries,from:span.from,to:span.to,undoAction:'/autopilot/activity/undo',returnTo:path+'?'+new URLSearchParams({filter:String(filter||'')}),
   exportAllowed:result.history.exportAllowed,download:path+'/download?'+new URLSearchParams({filter:String(filter||'')})},
  summary:'Everything StockChief did from '+span.from+' to '+span.to+' in '+timeZone+', newest first: what it did, why, what allowed it, and how to undo or correct it.'+kept};
}

// Undo one entry through its job's own undo. `job` is the page it came from:
// the log (181) or the daily record (204).
async function undo(db,ctx,{origin='action',id},{job=JOB}={}){
 origin=String(origin||'');id=String(id||'');
 if(!id||id.length>200||!(origin==='action'||origin==='audit'||WORK[origin]?.undo))throw new NotFoundError('Choose completed StockChief work from this inventory.');
 return db.transaction(async c=>{
  await require('./job-reviews').ownerState(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,job,'draft');
  const receipt=origin==='action'?id:origin+':'+id;
  if((await c.query('SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND reference=$2 AND action=$3',[ctx.workspaceId,receipt,UNDONE])).rowCount)return {replayed:true};
  let result,kind,record,what;
  if(origin==='action'){
   const history=await require('../commercial/agent-history').access(c,ctx.workspaceId);
   const p=(await c.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2 AND status='EXECUTED'
    AND ($3::timestamptz IS NULL OR executed_at>=$3::timestamptz) FOR UPDATE`,[ctx.workspaceId,id,history.activityAfter])).rows[0];
   if(!p)throw new NotFoundError('Choose completed agent work from this inventory.');
   const current=await proposalStates(c,ctx,[p],{lock:true}),decision=proposalUndo(p,current);
   if(!decision.allowed)throw new ValidationError(decision.reason+'. Open that record before correcting it.');
   kind=KINDS.get(p.action_type);record=reference(p);what={action:p.action_type,result:p.result};const key='agent-undo:'+id;
   if(kind==='sale')result=await require('../operations/postgres-business-workflows').cancelSalesOrderInTransaction(c,ctx,record,{idempotencyKey:key,reason:'Owner undid the agent-created draft'});
   if(kind==='quote')result=await require('../sales/postgres-quotes').decide(scoped(c),ctx,record,{accept:false,expectedHash:current.get('quote:'+record).pricing_hash});
   if(kind==='production')result=await require('../manufacturing/postgres-service').cancel(scoped(c),ctx,record,{confirmed:'yes',reason:'Owner undid the unused agent-created draft',idempotencyKey:key});
   if(kind==='prices'){
    result={ids:[]};for(const change of p.payload.changes){const before=change.before,saved=await require('../pricing/postgres-service').setPurchaseCostInTransaction(c,ctx,
     {skuId:change.skuId,amountMinor:before.amountMinor,currency:before.currency,expectedCurrentId:current.get('cost:'+change.skuId).id,source:'owner_undo_agent',sourceDetail:{proposalId:id}});result.ids.push(saved.id);}
   }
  }else{
   let row;
   if(origin==='audit'){
    const e=(await c.query('SELECT * FROM security_event_history WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0],s=e&&byAction.get(e.action);
    if(!s?.undo)throw new NotFoundError('This entry has no undo here. Open its record to correct it.');
    kind=s.undo;row={id:e.id,origin,result:e.after_state,payload:{reference:e.reference}};
    record=s.lookup?(await c.query(s.lookup,[ctx.workspaceId,[e.reference]])).rows[0]?.id:s.record?s.record({id:e.id,reference:e.reference,after:e.after_state,result:e.after_state}):e.reference;
    what={action:e.action,reference:e.reference};
   }else{kind=WORK[origin].undo;record=id;row={id,origin,result:{}};what={origin};}
   if(!record)throw new NotFoundError('The record behind this entry is no longer here.');
   const s=(await UNDO[kind].check(c,ctx.workspaceId,[{record:String(record),row}])).get(String(record));
   if(s!=='ready'&&s!=='done')throw new ValidationError('This changed since StockChief did it. Open its record to correct it.');
   result=await UNDO[kind].run(c,ctx,String(record),row);
   if(result?.replayed)return {replayed:true};
  }
  await audit.record(c,ctx,{action:UNDONE,reference:receipt,before:what,after:{...(result&&typeof result==='object'?result:{}),origin,kind:kind||null,from:job===JOB?'activity log':'daily record'}});
  return {replayed:false,result};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Pro and Custom: the log as a spreadsheet, newest first.
let exportsActive=0;
async function download(db,ctx,res,{filter=''}={}){
 await require('./job-reviews').ownerState(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
 require('../commercial/agent-history').requireExport(await require('../commercial/agent-history').access(db,ctx.workspaceId));
 const {calendarDate,timeZone}=await time.forWorkspace(db,ctx.workspaceId),span=range(filter,calendarDate);
 if(exportsActive>=2)throw new (require('../domain/errors').RateLimitError)('Two exports are already running. Try again shortly.');
 exportsActive++;
 try{
  const line=require('../operations/postgres-export-stream').line,out=[String.fromCharCode(0xfeff)+line(['When (UTC)','Job','What it did','Why','Allowed by','Evidence','Undo or correction','Status','Record'])];
  for(let page=1;page<=100;page++){
   const r=await entries(db,ctx,{from:time.dayBoundary(span.from,timeZone),to:time.dayBoundary(span.to,timeZone,{nextDay:true}),page,order:'DESC',timeZone});
   for(const e of r.entries)out.push(line([e.at,e.jobTitle||'StockChief',e.what,e.why,e.allowedBy,e.evidence,e.undo?e.undo.what:e.correction,e.status,e.link]));
   if(!r.more)break;
  }
  res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="stockchief-activity-'+span.from+'-'+span.to+'.csv"'});
  res.send(out.join(''));
 }finally{exportsActive--;}
}

// Custom: the log through the API.
async function api(db,auth,{filter='',page=1}={}){
 await require('../commercial/agent-history').requireApi(db,auth);
 page=Number(page||1);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid log page.');
 const {calendarDate,timeZone}=await time.forWorkspace(db,auth.workspaceId),span=range(filter,calendarDate);
 const r=await entries(db,auth,{from:time.dayBoundary(span.from,timeZone),to:time.dayBoundary(span.to,timeZone,{nextDay:true}),page,order:'DESC',timeZone});
 return {data:r.entries.map(e=>({at:e.at,job:e.job,action:e.what,why:e.why,allowedBy:e.allowedBy,evidence:e.evidence,undo:e.undo?e.undo.what:null,correction:e.correction,status:e.status,record:e.link})),
  nextPage:r.more?page+1:null};
}

const definition={id:JOB,key,label:'Everything StockChief did, and why',filterLabel:'Business date, or two dates joined by ".." (YYYY-MM-DD)',readPage:report};
module.exports={JOB,key,path,COMPLETED,UNDONE,SOURCES,WORK,UNDO,completed,work,describe,entries,row,report,undo,download,api,range,definition};
