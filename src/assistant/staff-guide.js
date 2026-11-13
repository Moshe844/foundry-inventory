'use strict';

// Job 179: answers staff "how do I…" questions inside the app, on every plan.
// Each topic is shown only to people whose role and permissions can do it,
// only when the current plan includes the work it describes (topic.job), and
// links to the page where it is done. Staff limited to some warehouses get
// the topics whose pages they can open. Ask reaches the same guide through
// read.staff_guide.

const permissions=require('../actions/permissions');
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');

const physical=['OPERATE','REQUEST_TRANSFER','PICK_TRANSFER','DISPATCH_TRANSFER','RECEIVE_TRANSFER'];
const shared={
  tasks:{title:'See my tasks',permission:'VIEW',job:177,role:'staff',terms:'task tasks my assigned assignment todo work late due job jobs',path:'Open My tasks. Each task opens its work: a pick wave, a put-away sheet, a delivery check, a bin move or a count. It is checked off when that work is recorded.',href:'/warehouse/staff-tasks',action:'Open my tasks'},
  putaway:{title:'Put away received goods',permission:physical,job:47,terms:'put away putaway shelve shelf bin label receipt received goods store',path:'Open Warehouse stock, choose the location and open its put-away sheet. Scan the product and the bin, or tap to confirm. If you used another bin, confirm where the goods went.',href:'/warehouse/stock',action:'Open warehouse stock'},
  move:{title:'Move stock to the right bin',permission:['REQUEST_TRANSFER','OPERATE'],job:11,terms:'move wrong bin relocate misplaced found stock correction scan',path:'Choose Report stock in the wrong bin. Scan the product where you found it, count both bins and send it. To carry out a prepared move, open it and scan the product, the old bin and the new bin.',href:'/warehouse/bin-corrections/found',action:'Report stock in the wrong bin'},
  transfer:{title:'Receive a stock transfer',permission:['VIEW_TRANSFERS','RECEIVE_TRANSFER'],job:124,terms:'transfer transfers arrive arrived arrival receive incoming warehouse',path:'Open Transfer arrivals, choose the transfer and enter what physically arrived. Record anything lost or damaged.',href:'/transfers/arrival-follow-up',action:'Open transfer arrivals'},
  request:{title:'Ask for a purchase',permission:'VIEW',job:41,role:'staff',terms:'request purchase buy need more running out supplies reorder',path:'Open Purchase requests, choose the product, the quantity and where it is needed, and send it. The owner decides whether to buy it.',href:'/purchasing/requests',action:'Request a purchase'},
  procedures:{title:'Follow a team procedure',permission:'VIEW',job:178,terms:'procedure procedures sop steps instructions process standard',path:'Open Team procedures and choose the one for your warehouse and task. It lists the steps your team records, approved by the owner.',href:'/team-procedures',action:'Open team procedures'}
};
const topics=[
  {title:'Set up inventory',permission:'ADMIN',terms:'setup import spreadsheet products onboarding',path:'Choose the source of your product records. Review the proposed products, variants and locations before approving the import.',tell:'We are starting from a spreadsheet.',href:'/onboarding?add=1',action:'Choose a source'},
  {title:'Record a sale',permission:'OPERATE',terms:'new sales order customer selling',path:'Open a new order. Choose the customer, add the items and quantities, check delivery and prices, then save the draft.',tell:'Help me record a sale.',href:'/orders/new',action:'Record a sale'},
  {title:'Find an item or barcode',permission:'VIEW',terms:'find inventory product variant item code sku barcode scan serial lot',path:'Open Inventory and search by product name, SKU or barcode. Open the matching item to check its quantities and locations.',tell:'Where is this item in stock?',href:'/inventory',action:'Open inventory'},
  {title:'Receive stock',permission:'RECEIVE_PO',terms:'receive receiving delivery delivered arrival stock goods purchase order po unload',path:'Choose the placed purchase order. Enter the units that physically arrived and the receiving location, then review the receipt.',tell:'We received part of a purchase order.',href:'/purchasing/receive',action:'Receive stock'},
  {title:'Move stock',permission:'REQUEST_TRANSFER',capability:'inventory.transfers',terms:'move transfer relocate stock warehouse location',path:'Select the source and destination, add the items and quantities, and save the transfer request. Follow the transfer record through dispatch and receipt.',tell:'Move stock to another warehouse.',href:'/transfers/new',action:'Request a transfer'},
  {title:'Fix a count',permission:'ADJUST',terms:'correct count variance recount adjust discrepancy stock',path:'Choose the location and enter the quantity physically counted. Review the difference before approving a stock adjustment.',tell:'I counted 12 units at Main Warehouse.',href:'/warehouse/counts/new',action:'Report a count'},
  {title:'Complete my assigned count',permission:'COUNT_STOCK',job:177,terms:'count assigned shelf blind physical count phone mobile counter counting',path:'Open Needs you and choose Open my count. Count the stock at each listed shelf, enter the physical quantity and save. The owner reviews any differences.',tell:'Where is my assigned count?',href:'/needs-you',action:'Find my count'},
  {title:'Set low-stock and reorder rules',permission:'MANAGE_REPLENISHMENT',capability:'planning.transfer_before_buy',terms:'reorder point low stock replenishment minimum planning',path:'Open planning, find the SKU and location, and review its demand, reorder point, target and supplier.',tell:'Show the reorder point for this product.',href:'/planning',action:'Review planning'},
  {title:'Set up suppliers and purchase orders',permission:'MANAGE_SUPPLIERS',terms:'add supplier create vendor purchase order po price pack lead time',path:'Open the supplier record. Enter the ordering contact and product terms, including price, pack size, minimum and lead time.',tell:'Help me add a supplier.',href:'/suppliers',action:'Set up purchasing'},
  {title:'Draft a purchase order',permission:'CREATE_PO',terms:'draft purchase order po buy reorder supplier vendor',path:'Choose the supplier and add the required items, quantities and expected delivery. Save the draft and send it for approval before placing the order.',tell:'Help me draft a purchase order.',href:'/purchasing/orders/new',action:'Draft a purchase order'},
  {title:'Receive a purchase order',permission:'RECEIVE_PO',terms:'book book-in receive po partial short shipment physical delivery',path:'Open the placed PO, compare each line with the delivery, and receive only the quantity that arrived. Leave the rest open.',tell:'Only part of our purchase order arrived.',href:'/purchasing/orders',action:'View purchase orders'},
  {title:'Pick and pack a shipment',permission:'VIEW_SALES',also:['FULFILL_SALES'],terms:'pick packing pack ship shipment fulfillment fulfilment parcel box handover',path:'Open Fulfilment and choose the shipment. Match the items and quantities to the order, record the packed box, and confirm handover when the shipment actually leaves.',tell:'What is ready to pick and pack?',href:'/fulfilment',action:'Open fulfilment'},
  {title:'Inspect a customer return',permission:'VIEW_SALES',also:['INSPECT_CUSTOMER_RETURN'],terms:'inspect return returns returned damaged inspection restock quarantine',path:'Open the original customer order and its return. Record the quantities actually received and their condition. Save the inspection for the disposition or refund decision.',tell:'Help me inspect a customer return.',href:'/orders',action:'Find the customer order'},
  {title:'Check a transfer in transit',permission:'VIEW_TRANSFERS',capability:'inventory.transfers',terms:'in transit dispatch transfer arrival route warehouse shipment',path:'Open Transfers and choose the transfer. Review its dispatch status and quantities, then check the destination receipt for shortages or damage.',tell:'Has this warehouse transfer arrived?',href:'/transfers',action:'View transfers'},
  {title:'Control automatic work',permission:'ADMIN',job:20,terms:'change automatic authority purchasing rules autopilot automation',path:'Open StockChief AI, select a job and review the available controls. The inventory setting and each job’s plan limit both apply.',tell:'Show my purchasing authority.',href:'/autopilot',action:'Review automatic work'},
  {title:'Find what needs attention',permission:'VIEW',terms:'needs attention inbox decisions approvals action pending',path:'Open Needs you and choose a decision. Review its source and the action awaiting your permission.',tell:'What needs my attention?',href:'/needs-you',action:'Open Needs you'},
  // Recently added work (jobs 11, 16, 41, 47, 51, 57, 124, 166, 177, 178, 180).
  {title:'Pick orders on a wave',permission:'MANAGE_FULFILLMENT_WAVES',job:57,terms:'pick picking picker wave waves order orders scan list zone shortage short',path:'Open Warehouse operations and choose the wave. Start it, then scan the bin label and the product for each line, in the order shown. If a bin is short, report the shortage with what you found.',href:'/warehouse/operations',action:'Open pick waves'},
  shared.putaway,
  {title:'Inspect a delivery on hold',permission:'RECEIVE_PO',job:51,terms:'inspect inspection qc quality hold held check checklist delivery release pass fail',path:'Open Delivery quality checks and choose the held delivery. Do each check on the goods, then mark it passed or failed. A pass releases the goods for sale.',href:'/autopilot/delivery-quality',action:'Open delivery checks'},
  shared.move,
  shared.tasks,
  {title:'Give staff their tasks',permission:'ADMIN',job:177,role:'owner',terms:'assign task tasks staff team give work delegate picker late',path:'Open Staff tasks. Approve the assignments StockChief prepared, give waiting work to a person, or choose which work StockChief may hand out.',href:'/warehouse/staff-tasks',action:'Open staff tasks'},
  shared.procedures,
  {title:'Write a procedure from your team’s work',permission:'ADMIN',job:178,terms:'write procedure procedures sop steps document team process',path:'Open Team procedures, choose the work and the warehouse, and preview the steps your team recorded. Edit the text if you need to, then publish it to staff.',href:'/autopilot/team-procedures',action:'Write a procedure'},
  {title:'Read the daily team summary',permission:'ADMIN',job:180,terms:'team summary daily who did what late report staff yesterday',path:'Open the daily team summary to see who did what yesterday and what is late. Choose a mailbox there to get it by email.',href:'/autopilot/reviews/daily-team-summary',action:'Open team summary'},
  {title:'Take back a customer return',permission:['VIEW_SALES','OPERATE'],terms:'return returns returned customer refund exchange rma',path:'Open the customer order and start a return for the items coming back. When they arrive, receive them, then inspect each item and choose to restock, scrap or repair it. A person issues any refund.',href:'/orders',action:'Open customer orders'},
  shared.transfer,
  shared.request,
  {title:'Pause StockChief',permission:'VIEW',terms:'pause stop halt emergency',path:'Open StockChief AI and press Pause automatic work. Anyone can pause. Resume it from the same page.',href:'/autopilot',action:'Open StockChief AI'},
  {title:'Get low-stock alerts by email',permission:'ADMIN',job:166,terms:'low stock alert alerts email out notify running',path:'Open Low stock and stock-out alerts. Choose the mailbox to email you from, and an alert level for products without a reorder point.',href:'/autopilot/reviews/low-stock-alerts',action:'Open stock alerts'},
  {title:'Check batches that expire soon',permission:'VIEW',terms:'batch batches lot lots expiry expire expiring date',path:'Open Batch expiry to see each batch, where it is and when it expires.',href:'/warehouse/batches',action:'Open batch expiry'},
  {title:'Plan the year-end stocktake',permission:'ADMIN',job:16,terms:'stocktake annual year end yearly full count freeze',path:'Open Yearly stocktake. Choose the count date, the locations and the count team. On the day, StockChief freezes those locations and sends each counter a list.',href:'/autopilot/annual-stocktakes',action:'Plan the stocktake'}
];
const filler=new Set('a an and are as at can do does for from how i in is it me my of on our please stockchief the to we what where with you'.split(' '));
// Staff limited to some warehouses: only pages they can open.
const warehouseTopics=[
  {title:'Find stock in my warehouse',permission:'VIEW',terms:'find item barcode scan search stock sku warehouse bin',path:'Open Warehouse stock, select an assigned location, and search by product, SKU or barcode.',href:'/warehouse/stock',action:'Find stock'},
  {title:'Complete my assigned count',permission:'COUNT_STOCK',job:177,terms:'count assigned shelf blind physical count phone mobile counter counting',path:'Open Warehouse stock and choose Open my count. Enter the physical quantity at each listed shelf and save. The owner reviews any differences.',href:'/warehouse/stock',action:'Find my count'},
  {title:'Receive a delivery at my warehouse',permission:'OPERATE',terms:'receive delivery received shipment arrived',path:'Open the assigned location, find the SKU and choose Receive. Enter the quantity and any required lot or serial details.',href:'/warehouse/stock',action:'Open warehouse stock'},
  {title:'Report a physical count for review',permission:'ADJUST',terms:'report adjust count discrepancy',path:'Choose the assigned location and SKU, open Record count, enter the physical quantity and submit it for owner review.',href:'/warehouse/stock',action:'Open warehouse stock'},
  shared.tasks,shared.putaway,shared.move,shared.transfer,shared.request,shared.procedures
];
// Light stemming so "tasks" finds "task" and "picking" finds "pick".
const stem=w=>w.length>5&&w.endsWith('ing')?w.slice(0,-3):w.length>3&&w.endsWith('s')&&!w.endsWith('ss')?w.slice(0,-1):w;
function words(text){return [...new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>!filler.has(w)).map(stem))];}
const allowed=(actor,topic)=>[topic.permission].flat().every(p=>permissions.can(actor,p))&&(!topic.role||(topic.role==='owner')===(actor.role==='owner'));

async function read(db,ctx,question,{requireAgent=false}={}){
  const query=String(question||'').trim();if(query.length>200)throw new ValidationError('Enter a question of up to 200 characters.');
  const actor=(await db.query('SELECT role,permissions,warehouse_location_ids FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  permissions.assertCan(actor,permissions.VIEW,'open the staff guide');
  const account=await policy.accountState(db,ctx.workspaceId);
  const current=policy.usesAgentTerms(account);
  if(requireAgent||current)policy.requireJob(current?account.plan:null,179,'suggest');
  const caps=await require('../commercial/entitlements').capabilityStates(db,{workspaceId:ctx.workspaceId,accountId:account.accountId},['inventory.transfers','planning.transfer_before_buy']);
  const search=words(query),rows=[];
  const available=actor.role!=='owner'&&actor.warehouse_location_ids!==null?warehouseTopics:topics;
  for(const topic of available){
    if(!allowed(actor,topic)||topic.also?.some(grant=>!permissions.can(actor,grant))||topic.capability&&!caps.get(topic.capability).enabled||topic.job&&(!current||!policy.permits(account.plan,topic.job,'suggest')))continue;
    const title=words(topic.title),terms=words(topic.terms);
    const score=search.reduce((sum,w)=>sum+(title.includes(w)?3:terms.includes(w)?1:0),0);
    if(!query||score>0)rows.push({topic,score});
  }
  return {query,topics:rows.sort((a,b)=>b.score-a.score).slice(0,query?3:available.length).map(r=>r.topic)};
}
module.exports={read,topics,warehouseTopics};
