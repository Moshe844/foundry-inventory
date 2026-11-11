'use strict';

const exact=require('../domain/exact-quantity');
const {ValidationError}=require('../domain/errors');
const sources='stockchief_runtime.agent_preorder_sources';
const claims='stockchief_runtime.agent_preorder_claims';

async function offered(db,workspaceId,pageId){
  return (await db.query(`SELECT sku_id,purchase_order_line_id FROM ${sources} WHERE workspace_id=$1 AND page_id=$2 ORDER BY sku_id`,
    [workspaceId,pageId])).rows;
}

async function selectOrder(db,ctx,page,number){
  const matches=(await db.query(`SELECT l.id AS purchase_order_line_id,l.sku_id
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND lower(p.po_number)=lower($2) AND l.sku_id=ANY($3::text[])
      AND coalesce(l.destination_location_id,p.destination_location_id)=$4
    ORDER BY l.sku_id,l.id`,[ctx.workspaceId,number,page.sku_ids,page.location_id])).rows;
  if(matches.length!==page.sku_ids.length)throw new ValidationError('Choose a placed purchase order with one line for each offered SKU at this warehouse.');
  await current(db,ctx,page,matches,{lock:true});
  return matches;
}

async function current(db,ctx,page,selection,{lock=false,allowReceived=false}={}){
  if(!selection.length)return [];
  const wanted=new Map(selection.map(line=>[line.purchase_order_line_id,line.sku_id]));
  if(wanted.size!==selection.length||selection.length!==page.sku_ids.length||new Set(wanted.values()).size!==selection.length){
    throw new ValidationError('Choose one exact incoming order line for each product on the preorder page.');
  }
  const ids=[...wanted.keys()].sort();
  const rows=(await db.query(`SELECT l.id,l.sku_id,p.id AS purchase_order_id,p.expected_date,p.status,p.ordered_at,
    coalesce(l.destination_location_id,p.destination_location_id) AS location_id,
    (l.quantity_units-l.quantity_received_units)::text AS incoming,to_jsonb(l)->>'supplier_supply_hold_id' AS supply_hold
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND l.id=ANY($2::text[]) ORDER BY l.id${lock?' FOR UPDATE OF l,p':''}`,[ctx.workspaceId,ids])).rows;
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const statuses=allowReceived?['ORDERED','PARTIALLY_RECEIVED','RECEIVED']:['ORDERED','PARTIALLY_RECEIVED'];
  if(rows.length!==selection.length||rows.some(row=>!statuses.includes(row.status)||!row.ordered_at||
    !row.expected_date||row.status!=='RECEIVED'&&row.expected_date<today||row.location_id!==page.location_id||
    row.sku_id!==wanted.get(row.id)||!page.sku_ids.includes(row.sku_id))){
    throw new ValidationError('Each preorder product needs a placed purchase order with a current expected date and the same receiving location.');
  }
  if(!allowReceived&&rows.some(row=>row.supply_hold))
    throw new ValidationError('The supplier reported that these goods are unavailable. New preorders are paused until availability is confirmed.');
  return rows.map(row=>({...row,incoming:row.supply_hold?'0':row.incoming,today}));
}

async function incomingCapacity(db,workspaceId,line,{excludeRequestId=null}={}){
  const result=(await db.query(`WITH commitments AS (
    SELECT pledge.purchase_order_line_id,CASE WHEN request.status='RECEIVED' THEN pledge.quantity
    WHEN native_order.status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') THEN greatest(0,
      least(pledge.quantity,coalesce(sales.quantity_ordered,0))-coalesce(sales.quantity_fulfilled,0)
      -coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=pledge.workspace_id AND a.sales_order_line_id=sales.id),0))
    ELSE 0 END AS quantity
    FROM ${claims} pledge
    JOIN stockchief_runtime.agent_customer_page_requests request ON request.workspace_id=pledge.workspace_id AND request.id=pledge.request_id
    LEFT JOIN sales_orders native_order ON native_order.workspace_id=request.workspace_id AND native_order.id=request.sales_order_id
    LEFT JOIN sales_order_lines sales ON sales.workspace_id=native_order.workspace_id AND sales.sales_order_id=native_order.id AND sales.sku_id=pledge.sku_id
    WHERE pledge.workspace_id=$1 AND pledge.sku_id=$4 AND pledge.location_id=$5 AND ($3::text IS NULL OR pledge.request_id<>$3)
  ), site_supply AS (
    SELECT coalesce(sum(greatest(l.quantity_units-l.quantity_received_units,0)),0) AS quantity FROM purchase_order_lines l
    JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    WHERE l.workspace_id=$1 AND l.sku_id=$4 AND coalesce(l.destination_location_id,p.destination_location_id)=$5
      AND p.status IN ('ORDERED','PARTIALLY_RECEIVED') AND p.ordered_at IS NOT NULL AND p.expected_date BETWEEN $8 AND $6
      AND to_jsonb(l)->>'supplier_supply_hold_id' IS NULL
  ), existing_demand AS (
    SELECT coalesce(sum(greatest(s.quantity_ordered-s.quantity_fulfilled-
      coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=s.workspace_id AND a.sales_order_line_id=s.id),0),0)),0) AS quantity
    FROM sales_order_lines s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    WHERE s.workspace_id=$1 AND s.sku_id=$4 AND (o.fulfillment_location_id=$5 OR o.fulfillment_location_id IS NULL)
      AND o.status IN ('BACKORDERED','PARTIALLY_FULFILLED') AND o.confirmed_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_customer_page_requests r JOIN ${claims} c
        ON c.workspace_id=r.workspace_id AND c.request_id=r.id AND c.sku_id=s.sku_id
        WHERE r.workspace_id=o.workspace_id AND r.sales_order_id=o.id)
  ) SELECT greatest(0,least($7::numeric-coalesce((SELECT sum(quantity) FROM commitments WHERE purchase_order_line_id=$2),0),
    site_supply.quantity-existing_demand.quantity-coalesce((SELECT sum(quantity) FROM commitments),0)))::text AS available
  FROM site_supply CROSS JOIN existing_demand`,
  [workspaceId,line.id,excludeRequestId,line.sku_id,line.location_id,line.expected_date,line.incoming,line.today])).rows[0];
  return exact.canonical(result.available);
}

async function requireCapacity(db,ctx,page,selection,requested,{excludeRequestId=null,lock=false}={}){
  const rows=await current(db,ctx,page,selection,{lock});
  const bySku=new Map(rows.map(row=>[row.sku_id,row]));
  const confirmed=[];
  for(const request of requested){
    const line=bySku.get(request.skuId);
    if(!line||exact.safeNumber(request.quantity)>exact.safeNumber(await incomingCapacity(db,ctx.workspaceId,line,{excludeRequestId}))){
      throw new ValidationError('There is no longer enough incoming stock for this preorder. Check the current quantity before confirming.');
    }
    confirmed.push({...line,quantity:exact.canonical(request.quantity)});
  }
  return confirmed;
}

async function claim(db,ctx,requestId,lines){
  await db.query(`INSERT INTO ${claims}(workspace_id,request_id,purchase_order_line_id,sku_id,location_id,quantity)
    SELECT $1,$2,line.id,line.sku_id,line.location_id,line.quantity FROM jsonb_to_recordset($3::jsonb)
      AS line(id text,sku_id text,location_id text,quantity numeric)`,[ctx.workspaceId,requestId,JSON.stringify(lines)]);
}

async function assertCurrentClaim(db,ctx,page,selection,requestId,lines){
  const orderLines=await current(db,ctx,page,selection,{lock:true,allowReceived:true});
  const original=(await db.query(`SELECT c.sku_id,c.purchase_order_line_id,c.quantity::text,
    coalesce((SELECT sum(r.quantity_units) FROM purchase_order_receipt_lines r JOIN purchase_order_receipts receipt
      ON receipt.workspace_id=r.workspace_id AND receipt.id=r.receipt_id
      WHERE r.workspace_id=c.workspace_id AND r.purchase_order_line_id=c.purchase_order_line_id
        AND r.location_id=c.location_id AND receipt.created_at::timestamptz>=c.created_at),0)::text AS arrived
    FROM ${claims} c WHERE c.workspace_id=$1 AND c.request_id=$2`,[ctx.workspaceId,requestId])).rows;
  if(original.length!==lines.length||lines.some(line=>{
    const held=original.find(c=>c.sku_id===line.skuId);
    const purchase=held&&orderLines.find(row=>row.id===held.purchase_order_line_id&&row.sku_id===held.sku_id);
    return !purchase||exact.canonical(held.quantity)!==exact.canonical(line.quantity)||
      exact.safeNumber(exact.add(purchase.incoming,held.arrived))<exact.safeNumber(line.quantity);
  }))throw new ValidationError('The original incoming stock changed. Review this preorder before creating its order.');
}

async function hasArrived(db,ctx,requestId){
  const rows=(await db.query(`WITH targets AS (
      SELECT purchase_order_line_id,location_id FROM ${claims} WHERE workspace_id=$1 AND request_id=$2
    ), arrivals AS (
      SELECT t.purchase_order_line_id,l.id,'receipt' AS kind,l.quantity_units AS quantity,receipt.created_at::timestamptz AS happened
      FROM targets t JOIN purchase_order_receipt_lines l ON l.workspace_id=$1
        AND l.purchase_order_line_id=t.purchase_order_line_id AND l.location_id=t.location_id
      JOIN purchase_order_receipts receipt ON receipt.workspace_id=l.workspace_id AND receipt.id=l.receipt_id
    ), waiting AS (
      SELECT pledge.purchase_order_line_id,pledge.request_id,'claim',pledge.quantity,pledge.created_at
      FROM targets t JOIN ${claims} pledge ON pledge.workspace_id=$1
        AND pledge.purchase_order_line_id=t.purchase_order_line_id AND pledge.location_id=t.location_id
      JOIN stockchief_runtime.agent_customer_page_requests r ON r.workspace_id=pledge.workspace_id AND r.id=pledge.request_id
      LEFT JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
      WHERE r.status='RECEIVED' OR (r.status='DRAFTED' AND o.status<>'CANCELLED')
    )
    SELECT purchase_order_line_id,id,kind,quantity::text FROM (SELECT * FROM arrivals UNION ALL SELECT * FROM waiting) timeline
    ORDER BY purchase_order_line_id,happened,kind,id`,[ctx.workspaceId,requestId])).rows;
  const waiting=new Map(),expected=[];
  for(const event of rows){
    if(!waiting.has(event.purchase_order_line_id))waiting.set(event.purchase_order_line_id,{claims:[],next:0});
    const queue=waiting.get(event.purchase_order_line_id);
    let quantity=exact.safeNumber(event.quantity);
    if(event.kind==='claim'){
      const hold={remaining:quantity};
      queue.claims.push(hold);
      if(event.id===requestId)expected.push(hold);
      continue;
    }
    while(quantity&&queue.next<queue.claims.length){
      const hold=queue.claims[queue.next],covered=Math.min(quantity,hold.remaining);
      quantity=exact.safeNumber(exact.subtract(quantity,covered));
      hold.remaining=exact.safeNumber(exact.subtract(hold.remaining,covered));
      if(!hold.remaining)queue.next++;
    }
  }
  return expected.length>0&&expected.every(hold=>hold.remaining===0);
}

module.exports={offered,selectOrder,current,requireCapacity,claim,assertCurrentClaim,hasArrived};
