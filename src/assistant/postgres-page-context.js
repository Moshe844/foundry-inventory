'use strict';

// A page path is a hint, not authority. Every record is reloaded in the
// current workspace before it can supply an argument.
const PAGES=[
  {route:/^\/inventory\/([^/]+)$/,sql:`SELECT i.id,i.name,s.code FROM items i LEFT JOIN skus s
    ON s.item_id=i.id AND s.workspace_id=i.workspace_id AND s.is_active=1
    WHERE i.workspace_id=$1 AND i.id=$2 AND i.is_active=1`,
  present:(rows)=>({product:rows[0].name,...(rows.length===1&&rows[0].code?{sku:rows[0].code}:{}),
    recordReference:rows[0].name})},
  {route:/^\/purchasing\/orders\/([^/]+)$/,sql:`SELECT po_number FROM purchase_orders
    WHERE workspace_id=$1 AND id=$2`,present:(rows)=>({purchaseOrder:rows[0].po_number,
      recordReference:rows[0].po_number})},
  {route:/^\/(?:sales\/)?orders\/([^/]+)$/,sql:`SELECT order_number FROM sales_orders
    WHERE workspace_id=$1 AND id=$2`,present:(rows)=>({salesOrder:rows[0].order_number,
      recordReference:rows[0].order_number})},
  {route:/^\/suppliers\/([^/]+)$/,sql:`SELECT name FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'`,
    present:(rows)=>({supplier:rows[0].name,recordReference:rows[0].name})},
  {route:/^\/sales\/customers\/([^/]+)$/,sql:`SELECT name FROM customers
    WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'`,
    present:(rows)=>({customer:rows[0].name,recordReference:rows[0].name})},
  {route:/^\/transfers\/([^/]+)$/,sql:`SELECT transfer_number FROM inventory_transfers
    WHERE workspace_id=$1 AND id=$2`,present:(rows)=>({recordReference:rows[0].transfer_number})},
  {route:/^\/fulfilment\/([^/]+)$/,sql:`SELECT shipment_number FROM sales_shipments
    WHERE workspace_id=$1 AND id=$2`,present:(rows)=>({recordReference:rows[0].shipment_number})},
  {route:/^\/returns\/([^/]+)$/,sql:`SELECT return_number FROM customer_returns
    WHERE workspace_id=$1 AND id=$2`,present:(rows)=>({recordReference:rows[0].return_number})},
  {route:/^\/supplier-returns\/([^/]+)$/,sql:`SELECT return_number FROM supplier_returns
    WHERE workspace_id=$1 AND id=$2`,present:(rows)=>({recordReference:rows[0].return_number})},
];

async function load(database,workspaceId,sourcePath){
  const path=require('./agent-navigation-path').localPath(sourcePath);
  if(!path||path.length>300)return null;
  // The location is general environment context, independent of these optional
  // legacy record hints. A list, form or unfamiliar screen may share a detail
  // route's prefix without being a record ID. Missing record enrichment must
  // never erase its valid location or limit what the native browser discovers.
  const location={path};
  const pathname=new URL(path,'https://stockchief.invalid').pathname;
  for(const page of PAGES){
    const matched=page.route.exec(pathname);if(!matched)continue;
    let id;try{id=decodeURIComponent(matched[1]);}catch{return location;}
    if(id.length>150)return location;
    const rows=(await database.query(page.sql,[workspaceId,id])).rows;
    return rows.length?{path,...page.present(rows)}:location;
  }
  return location;
}

module.exports={load};
