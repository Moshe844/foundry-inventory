'use strict';

const permissions=require('../actions/permissions');
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');

const topics=[
  {title:'Set up inventory',permission:'ADMIN',terms:'setup import spreadsheet products onboarding',path:'Choose the source of your product records. Review the proposed products, variants and locations before approving the import.',tell:'We are starting from a spreadsheet.',href:'/onboarding?add=1',action:'Choose a source'},
  {title:'Record a sale',permission:'OPERATE',terms:'new sales order customer selling',path:'Open a new order. Choose the customer, add the items and quantities, check delivery and prices, then save the draft.',tell:'Help me record a sale.',href:'/orders/new',action:'Record a sale'},
  {title:'Find an item or barcode',permission:'VIEW',terms:'find inventory product variant item code sku barcode scan serial lot',path:'Open Inventory and search by product name, SKU or barcode. Open the matching item to check its quantities and locations.',tell:'Where is this item in stock?',href:'/inventory',action:'Open inventory'},
  {title:'Receive stock',permission:'RECEIVE_PO',terms:'receive receiving delivery delivered arrival stock goods purchase order po unload',path:'Choose the placed purchase order. Enter the units that physically arrived and the receiving location, then review the receipt.',tell:'We received part of a purchase order.',href:'/purchasing/receive',action:'Receive stock'},
  {title:'Move stock',permission:'REQUEST_TRANSFER',capability:'inventory.transfers',terms:'move transfer relocate stock warehouse location',path:'Select the source and destination, add the items and quantities, and save the transfer request. Follow the transfer record through dispatch and receipt.',tell:'Move stock to another warehouse.',href:'/transfers/new',action:'Request a transfer'},
  {title:'Fix a count',permission:'ADJUST',terms:'correct count variance recount adjust discrepancy stock',path:'Choose the location and enter the quantity physically counted. Review the difference before approving a stock adjustment.',tell:'I counted 12 units at Main Warehouse.',href:'/warehouse/counts/new',action:'Report a count'},
  {title:'Complete my assigned count',permission:'COUNT_STOCK',job:177,terms:'count assigned shelf blind physical count phone mobile counter counting',path:'Open Needs you and choose Open my count. Count the stock at each listed shelf, enter the physical quantity and save. The owner reviews any differences.',tell:'Where is my assigned count?',href:'/needs-you',action:'Find my count'},
  {title:'Set low-stock and reorder rules',permission:'MANAGE_REPLENISHMENT',terms:'reorder point low stock replenishment minimum planning',path:'Open planning, find the SKU and location, and review its demand, reorder point, target and supplier.',tell:'Show the reorder point for this product.',href:'/planning',action:'Review planning'},
  {title:'Set up suppliers and purchase orders',permission:'MANAGE_SUPPLIERS',terms:'add supplier create vendor purchase order po price pack lead time',path:'Open the supplier record. Enter the ordering contact and product terms, including price, pack size, minimum and lead time.',tell:'Help me add a supplier.',href:'/suppliers',action:'Set up purchasing'},
  {title:'Draft a purchase order',permission:'CREATE_PO',terms:'draft purchase order po buy reorder supplier vendor',path:'Choose the supplier and add the required items, quantities and expected delivery. Save the draft and send it for approval before placing the order.',tell:'Help me draft a purchase order.',href:'/purchasing/orders/new',action:'Draft a purchase order'},
  {title:'Receive a purchase order',permission:'RECEIVE_PO',terms:'book book-in receive po partial short shipment physical delivery',path:'Open the placed PO, compare each line with the delivery, and receive only the quantity that arrived. Leave the rest open.',tell:'Only part of our purchase order arrived.',href:'/purchasing/orders',action:'View purchase orders'},
  {title:'Pick and pack a shipment',permission:'VIEW_SALES',also:['FULFILL_SALES'],terms:'pick packing pack ship shipment fulfillment fulfilment parcel box handover',path:'Open Fulfilment and choose the shipment. Match the items and quantities to the order, record the packed box, and confirm handover when the shipment actually leaves.',tell:'What is ready to pick and pack?',href:'/fulfilment',action:'Open fulfilment'},
  {title:'Inspect a customer return',permission:'VIEW_SALES',also:['INSPECT_CUSTOMER_RETURN'],terms:'inspect return returns returned damaged inspection restock quarantine',path:'Open the original customer order and its return. Record the quantities actually received and their condition. Save the inspection for the disposition or refund decision.',tell:'Help me inspect a customer return.',href:'/orders',action:'Find the customer order'},
  {title:'Check a transfer in transit',permission:'VIEW_TRANSFERS',capability:'inventory.transfers',terms:'in transit dispatch transfer arrival route warehouse shipment',path:'Open Transfers and choose the transfer. Review its dispatch status and quantities, then check the destination receipt for shortages or damage.',tell:'Has this warehouse transfer arrived?',href:'/transfers',action:'View transfers'},
  {title:'Control automatic work',permission:'ADMIN',job:20,terms:'change automatic authority purchasing rules autopilot automation',path:'Open StockChief AI, select a job and review the available controls. The inventory setting and each job’s plan limit both apply.',tell:'Show my purchasing authority.',href:'/autopilot',action:'Review automatic work'},
  {title:'Find what needs attention',permission:'VIEW',terms:'needs attention inbox decisions approvals action pending',path:'Open Needs you and choose a decision. Review its source and the action awaiting your permission.',tell:'What needs my attention?',href:'/needs-you',action:'Open Needs you'}
];
const filler=new Set('a an and are as at can do does for from how i in is it me my of on our please stockchief the to we what where with you'.split(' '));
const warehouseTopics=[
  {title:'Find stock in my warehouse',permission:'VIEW',terms:'find item barcode scan search stock sku warehouse bin',path:'Open Warehouse stock, select an assigned location, and search by product, SKU or barcode.',href:'/warehouse/stock',action:'Find stock'},
  {title:'Complete my assigned count',permission:'COUNT_STOCK',job:177,terms:'count assigned shelf blind physical count phone mobile counter counting',path:'Open Warehouse stock and choose Open my count. Enter the physical quantity at each listed shelf and save. The owner reviews any differences.',href:'/warehouse/stock',action:'Find my count'},
  {title:'Receive a delivery at my warehouse',permission:'OPERATE',terms:'receive delivery received shipment arrived',path:'Open the assigned location, find the SKU and choose Receive. Enter the quantity and any required lot or serial details.',href:'/warehouse/stock',action:'Open warehouse stock'},
  {title:'Report a physical count for review',permission:'ADJUST',terms:'report adjust count discrepancy',path:'Choose the assigned location and SKU, open Record count, enter the physical quantity and submit it for owner review.',href:'/warehouse/stock',action:'Open warehouse stock'}
];
function words(text){return [...new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[])].filter(w=>!filler.has(w));}

async function read(db,ctx,question,{requireAgent=false}={}){
  const query=String(question||'').trim();if(query.length>200)throw new ValidationError('Enter a question of up to 200 characters.');
  const actor=(await db.query('SELECT role,permissions,warehouse_location_ids FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  permissions.assertCan(actor,permissions.VIEW,'open the staff guide');
  const account=await policy.accountState(db,ctx.workspaceId);
  const current=policy.usesAgentTerms(account);
  if(requireAgent||current)policy.requireJob(current?account.plan:null,179,'suggest');
  const caps=await require('../commercial/entitlements').capabilityStates(db,{workspaceId:ctx.workspaceId,accountId:account.accountId},['inventory.transfers']);
  const search=words(query),rows=[];
  const available=actor.role!=='owner'&&actor.warehouse_location_ids!==null?warehouseTopics:topics;
  for(const topic of available){
    if(!permissions.can(actor,topic.permission)||topic.also?.some(grant=>!permissions.can(actor,grant))||
      topic.capability&&!caps.get(topic.capability).enabled||topic.job&&(!current||!policy.permits(account.plan,topic.job,'suggest')))continue;
    const title=words(topic.title),terms=words(topic.terms);
    const score=search.reduce((sum,w)=>sum+(title.includes(w)?3:terms.includes(w)?1:0),0);
    if(!query||score>0)rows.push({topic,score});
  }
  return {query,topics:rows.sort((a,b)=>b.score-a.score).slice(0,query?3:topics.length).map(r=>r.topic)};
}
module.exports={read};
