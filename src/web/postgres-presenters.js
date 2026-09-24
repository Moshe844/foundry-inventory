'use strict';

const projections=require('../projections/postgres-service');
const commerce=require('../operations/postgres-commerce');
const reports=require('../accounting/postgres-reports');
const autonomy=require('../autopilot/postgres-service');

function number(value){return Number(value||0);}
function today(){return new Date().toISOString().slice(0,10);}
function monthStart(value=today()){return `${value.slice(0,7)}-01`;}
function daysBetween(from,to){return Math.max(0,Math.floor((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86400000));}
function checkedText(value){
  if(!value)return 'not yet';
  const elapsed=Math.max(0,Date.now()-Date.parse(value));
  if(elapsed<60000)return 'just now';
  if(elapsed<3600000)return `${Math.floor(elapsed/60000)} minutes ago`;
  if(elapsed<86400000)return `${Math.floor(elapsed/3600000)} hours ago`;
  return `${Math.floor(elapsed/86400000)} days ago`;
}

async function home(database,workspaceId){
  const [brief,state]=await Promise.all([
    projections.brief(database,workspaceId),autonomy.getState(database,workspaceId),
  ]);
  const needs=brief.needs.slice(0,6).map((item)=>({title:item.title,because:item.why,
    href:item.href,link:item.href,action:item.actionLabel||'Open'}));
  const lastLookedAt=state.lastEvaluatedAt;
  const stale=!lastLookedAt||Date.now()-Date.parse(lastLookedAt)>86400000;
  const hasInventory=brief.stats.itemCount>0;
  const hasLocations=brief.stats.locationCount>0;
  let next=null;
  if(!hasLocations)next={title:'Add the place where you keep stock',recommendation:'StockChief needs a location before it can record physical inventory.',href:'/locations/new',action:'Add a location'};
  else if(!hasInventory)next={title:'Add your inventory records',recommendation:'Import a file, connect a system, or enter the first product manually.',href:'/onboarding',action:'Add a source'};
  const activity=brief.activity.slice(0,6).map((row)=>({headline:`${row.item_name} inventory changed`,
    detail:`${row.quantityDelta>0?'+':''}${row.quantityDelta} at ${row.location_name}${row.reference?` · ${row.reference}`:''}`,
    verified:true,link:'/activity'}));
  return {brief,home:{needsYou:needs,needsYouTotal:brief.needs.length,coverageErrors:[],handling:[],setup:null,
    status:{paused:state.paused,pausedReason:state.pausedReason,suspended:state.suspended,
      suspendedReason:state.suspendedReason,lastLookedAt,lastEvaluatedText:checkedText(lastLookedAt),checkStale:stale},
    did:{headline:'No automatic work completed in the last day.',actions:activity,counts:{handled:activity.length,
      positionsWatched:brief.stats.skuCount}},readiness:{evidenceGaps:[],evidenceGapCount:0,notes:[]},
    guidance:{operationalReady:hasInventory&&hasLocations,checklistActive:false,steps:[],next,
      examples:['What needs my attention?','What is running low?','What did you handle today?']}},
    isEmpty:brief.stats.itemCount===0,whatsNext:[],noticed:[],operationSummary:
      `${brief.stats.available} units are available. ${brief.needs.length} exception${brief.needs.length===1?'':'s'} need${brief.needs.length===1?'s':''} you.`,homeSignature:[brief.stats.itemCount,
      brief.stats.unitsOnHand,brief.stats.openOrders,brief.stats.openPurchases,brief.needs.length,state.updatedAt].join(':'),
  };
}

async function inventoryPosition(database,workspaceId){
  const result=await database.query(`WITH sku_position AS (
      SELECT s.id,COALESCE(SUM(b.on_hand),0)::bigint AS on_hand,
        COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a
          JOIN sales_order_lines sol ON sol.id=a.sales_order_line_id
          WHERE a.workspace_id=s.workspace_id AND sol.sku_id=s.id),0)::bigint AS committed,
        COALESCE((SELECT SUM(pol.quantity_units-pol.quantity_received_units) FROM purchase_order_lines pol
          JOIN purchase_orders po ON po.id=pol.purchase_order_id
          WHERE pol.workspace_id=s.workspace_id AND pol.sku_id=s.id
            AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')),0)::bigint AS incoming
      FROM skus s LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id
      JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 GROUP BY s.id,s.workspace_id
    ) SELECT COUNT(*)::bigint AS skus,COALESCE(SUM(on_hand),0)::bigint AS on_hand,
      COALESCE(SUM(committed),0)::bigint AS committed,COALESCE(SUM(incoming),0)::bigint AS incoming,
      COUNT(*) FILTER (WHERE on_hand<=0)::bigint AS empty_count,
      COUNT(*) FILTER (WHERE committed>on_hand)::bigint AS shortage_count,
      COUNT(*) FILTER (WHERE incoming>0)::bigint AS incoming_count,
      COUNT(*) FILTER (WHERE on_hand>0 AND committed<=on_hand)::bigint AS healthy_count
    FROM sku_position`,[workspaceId]);
  const [locations,cost,names]=await Promise.all([
    database.query('SELECT COUNT(*)::bigint AS count FROM locations WHERE workspace_id=$1 AND is_active=1',[workspaceId]),
    database.query(`SELECT COALESCE(SUM(quantity_units),0)::bigint AS units,
      COALESCE(SUM(total_cost_minor),0)::bigint AS cost FROM accounting_inventory_cost_balances WHERE workspace_id=$1`,[workspaceId]),
    database.query(`SELECT name FROM items WHERE workspace_id=$1 AND is_active=1 ORDER BY lower(name) LIMIT 12`,[workspaceId]),
  ]);
  const row=result.rows[0];const groups=[];
  const add=(count,key,name,detail,tone,icon)=>{if(number(count)>0)groups.push({key,name,detail,tone,icon,
    count:number(count),itemIds:[],href:`/inventory/table?group=${encodeURIComponent(key)}`});};
  add(row.shortage_count,'shortage','Promised but not available','Customer commitments exceed physical stock.','hot','alert');
  add(row.empty_count,'empty','Out of stock','No physical units are currently on hand.','hot','box');
  add(row.incoming_count,'incoming','On the way','A purchase or transfer is already expected.','quiet','arrive');
  add(row.healthy_count,'healthy','Available now','Physical stock covers current commitments.','ok','check');
  return {position:{tooLarge:number(row.skus)>250000,groups,productNames:names.rows.map((entry)=>entry.name),totals:{locations:number(locations.rows[0].count),
    skus:number(row.skus),onHand:number(row.on_hand),committed:number(row.committed),incoming:number(row.incoming)}},
    stockValue:{totalUnits:number(cost.rows[0].units),totalCostMinor:number(cost.rows[0].cost)}};
}

async function purchasing(database,workspaceId){
  const [orders,suppliers,catalogue,locations]=await Promise.all([commerce.purchaseOrders(database,workspaceId),
    commerce.suppliers(database,workspaceId),commerce.catalogue(database,workspaceId),commerce.locations(database,workspaceId)]);
  const open=orders.filter((order)=>['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(order.status))
    .map((order)=>({...order,outstanding_units:order.units_outstanding}));
  const now=today();
  const late=open.filter((order)=>order.expected_date&&order.expected_date<now)
    .map((order)=>({...order,daysLate:daysBetween(order.expected_date,now)}));
  const drafts=orders.filter((order)=>['DRAFT','AWAITING_APPROVAL'].includes(order.status))
    .map((order)=>({...order,hasCosts:number(order.total)>0}));
  return {orders,suppliers,catalogue,locations,open,late,arriving:open.filter((order)=>!late.some((entry)=>entry.id===order.id)),drafts,
    plan:{blocked:[],recommendations:[],bySupplier:[],covered:[]},ahead:{shortages:[]},
    setup:{lines:0,alreadySet:true},aiConfigured:true};
}

function nextForOrder(order){
  if(order.status==='DRAFT')return {text:'Draft — nothing is committed yet',detail:'Review and confirm the order.',rank:80,action:'Review draft',href:`/orders/${order.id}`};
  if(order.status==='BACKORDERED')return {text:'Waiting for stock',detail:'This order has a physical shortage.',rank:100,action:'Review shortage',href:`/orders/${order.id}`};
  if(order.status==='PARTIALLY_FULFILLED')return {text:'Partly fulfilled',detail:'Some units still need to leave.',rank:60,action:'Continue fulfilment',href:`/orders/${order.id}`};
  if(order.status==='CONFIRMED')return {text:'Ready to fulfil',detail:'Inventory is committed to this customer.',rank:40,action:'Fulfil order',href:`/orders/${order.id}`};
  if(order.status==='FULFILLED'&&number(order.balance_minor)>0)return {text:'Delivered — payment is still due',detail:'The customer invoice remains open.',rank:30,action:'Review payment',href:`/orders/${order.id}`};
  if(order.status==='FULFILLED')return {text:'Delivered and settled',detail:'Nothing remains open.',rank:0,action:null,href:`/orders/${order.id}`};
  return {text:'Cancelled',detail:'No further work is planned.',rank:0,action:null,href:`/orders/${order.id}`};
}

async function sales(database,workspaceId){
  const [rows,customers,catalogue,locations,connections]=await Promise.all([commerce.salesOrders(database,workspaceId),
    commerce.customers(database,workspaceId),commerce.catalogue(database,workspaceId),commerce.locations(database,workspaceId),
    database.query(`SELECT COUNT(*)::bigint AS count FROM workspace_connectors
      WHERE workspace_id=$1 AND status='connected' AND paused_at IS NULL
        AND provider_type IN ('shopify','square','clover','woocommerce','reference_webhook')`,[workspaceId])]);
  const orders=rows.map((order)=>({...order,customer:{id:order.customer_id,name:order.customer_name},
    totals:{ordered:number(order.units_ordered),fulfilled:number(order.units_fulfilled)},
    pricing:{totalMinor:number(order.total_minor)},currency:order.currency||'USD',next:nextForOrder(order),
    fulfilmentLabel:order.status==='FULFILLED'?'Delivered':null}));
  const active=orders.filter((order)=>['DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED'].includes(order.status));
  const stuck=active.filter((order)=>order.next.rank>=80).length;
  const summary=!orders.length?'No customer orders yet.':stuck?`${stuck} customer order${stuck===1?' needs':'s need'} attention.`:
    active.length?`${active.length} customer order${active.length===1?' is':'s are'} moving.`:'No active customer order is waiting.';
  return {orders,customers,catalogue,locations,completedSales:[],summary,status:null,view:'all',
    sellingConnectionCount:number(connections.rows[0].count)};
}

async function money(database,workspaceId,input={}){
  const to=String(input.to||today());const from=String(input.from||monthStart(to));
  const [pnl,balance,receivables,payables,inventory,confirmed,changed,needItems]=await Promise.all([
    reports.profitAndLoss(database,workspaceId,{from,to}),reports.balanceSheet(database,workspaceId,{asOf:to}),
    database.query(`SELECT id,invoice_number,due_date,balance_minor,currency FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND status IN ('OPEN','PARTIALLY_PAID') ORDER BY due_date NULLS LAST,id`,[workspaceId]),
    database.query(`SELECT id,bill_number,due_date,balance_minor,currency FROM accounting_supplier_bills
      WHERE workspace_id=$1 AND status IN ('OPEN','PARTIALLY_PAID','DISPUTED') ORDER BY due_date NULLS LAST,id`,[workspaceId]),
    database.query(`SELECT COALESCE(SUM(b.on_hand),0)::bigint AS units,
      COALESCE((SELECT SUM(quantity_units) FROM accounting_inventory_cost_balances WHERE workspace_id=$1),0)::bigint AS cost_units,
      COALESCE((SELECT SUM(total_cost_minor) FROM accounting_inventory_cost_balances WHERE workspace_id=$1),0)::bigint AS cost_minor
      FROM balances b WHERE b.workspace_id=$1`,[workspaceId]),
    database.query(`SELECT id,order_number FROM sales_orders WHERE workspace_id=$1
      AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') ORDER BY needed_by NULLS LAST,created_at LIMIT 20`,[workspaceId]),
    database.query(`SELECT posting_date AS at,description AS what FROM accounting_journal_entries
      WHERE workspace_id=$1 AND status='POSTED' AND posting_date BETWEEN $2 AND $3
      ORDER BY posting_date DESC,entry_number DESC LIMIT 6`,[workspaceId,from,to]),projections.needs(database,workspaceId),
  ]);
  const receivableMinor=receivables.rows.reduce((sum,row)=>sum+number(row.balance_minor),0);
  const payableMinor=payables.rows.reduce((sum,row)=>sum+number(row.balance_minor),0);
  const cashMinor=balance.assets.filter((account)=>account.subtype==='CASH').reduce((sum,account)=>sum+number(account.net_minor),0);
  const comingUp=[...payables.rows.map((row)=>({direction:'out',date:row.due_date,href:'/accounting/payables',
    what:row.bill_number||'supplier bill',amountMinor:number(row.balance_minor)})),
  ...receivables.rows.map((row)=>({direction:'in',date:row.due_date,href:'/accounting/receivables',
    what:row.invoice_number||'customer invoice',amountMinor:number(row.balance_minor)}))]
    .filter((row)=>row.date).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const gross=pnl.revenueMinor-pnl.cogsMinor;
  const symbol=(pnl.currency||'USD')==='USD'?'$':`${pnl.currency||'USD'} `;
  const amount=(minor)=>`${symbol}${(number(minor)/100).toFixed(2)}`;
  return {from,to,pnl,balance,receivableMinor,payableMinor,story:{currency:pnl.currency||'USD',from,to,
    status:{caughtUp:true,headline:'Books need attention'},profit:{netMinor:pnl.netIncomeMinor,
      revenueMinor:pnl.revenueMinor,cogsMinor:pnl.cogsMinor,expensesMinor:pnl.operatingExpenseMinor,
      marginPct:pnl.revenueMinor?Math.round((gross/pnl.revenueMinor)*1000)/10:null,
      why:[`${amount(pnl.revenueMinor)} revenue, ${amount(pnl.cogsMinor)} stock sold, ${amount(pnl.operatingExpenseMinor)} other costs, and ${amount(pnl.netIncomeMinor)} net income this period.`]},
    position:{suppliersCommittedMinor:payableMinor,customersOweMinor:receivableMinor,cashMinor,
      inventoryMinor:number(inventory.rows[0].cost_minor),inventoryUnits:number(inventory.rows[0].units),
      confirmedCustomerOrders:confirmed.rows},inventory:{missingCostUnits:Math.max(0,
        number(inventory.rows[0].units)-number(inventory.rows[0].cost_units))},comingUp,
    attention:needItems.filter((item)=>['accounting','provider'].includes(item.kind)).map((item)=>({title:item.title,
      why:item.why,href:item.href,actionLabel:item.actionLabel})),changed:changed.rows,noticed:[],
    fees:{totalMinor:0,needsPlacingMinor:0,documents:[]}}};
}

module.exports={home,inventoryPosition,purchasing,sales,money};
