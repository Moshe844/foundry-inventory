'use strict';

const exact=require('../domain/exact-quantity');
const {hash}=require('../pricing/postgres-promotions');

async function read(db,workspaceId,orderId,receipts){
  const rows=(await db.query(`SELECT x.*,l.purchase_order_line_id,l.sales_order_line_id,pl.sku_id,p.currency,
    d.state,d.purchase_receipt_id,d.original,o.purchase_order_id,o.sales_order_id,
    e.status AS journal_status,e.source_type,e.source_record_id,e.metadata,
    (SELECT base_currency FROM accounting_settings WHERE workspace_id=x.workspace_id AND enabled=1) AS books_currency,
    coalesce((SELECT sum(j.credit_minor-j.debit_minor) FROM accounting_journal_lines j
      JOIN accounting_accounts a ON a.workspace_id=j.workspace_id AND a.id=j.account_id
      WHERE j.workspace_id=x.workspace_id AND j.entry_id=e.id AND a.system_key='RECEIVED_NOT_INVOICED'),0)::text AS rni_minor,
    EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=e.workspace_id
      AND r.reversal_of_entry_id=e.id AND r.status='POSTED') AS reversed
    FROM stockchief_runtime.agent_direct_dispatch_lines x
    JOIN stockchief_runtime.agent_direct_order_lines l ON l.workspace_id=x.workspace_id AND l.id=x.direct_order_line_id
    JOIN stockchief_runtime.agent_direct_dispatches d ON d.workspace_id=x.workspace_id AND d.id=x.dispatch_id
    JOIN stockchief_runtime.agent_direct_orders o ON o.workspace_id=d.workspace_id AND o.id=d.direct_order_id
    JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id
    JOIN purchase_order_lines pl ON pl.workspace_id=l.workspace_id AND pl.id=l.purchase_order_line_id AND pl.purchase_order_id=p.id
    LEFT JOIN accounting_journal_entries e ON e.workspace_id=x.workspace_id AND e.id=x.journal_entry_id
    WHERE x.workspace_id=$1 AND o.purchase_order_id=$2 ORDER BY x.id`,[workspaceId,orderId])).rows;
  const byId=new Map(rows.map(row=>[row.id,row])),seen=new Set(),result=new Map();
  for(const receipt of receipts){
    let target=result.get(receipt.purchase_order_line_id);
    if(!target){
      target={purchase_order_line_id:receipt.purchase_order_line_id,quantity:'0',secondary:'0',value:0,proven:true,tracking:[]};
      result.set(receipt.purchase_order_line_id,target);
    }
    target.quantity=exact.add(target.quantity,receipt.quantity_units);
    target.secondary=exact.add(target.secondary,receipt.secondary_quantity||0);
    const source=byId.get(receipt.direct_dispatch_line_id);
    const metadata=typeof source?.metadata==='string'?JSON.parse(source.metadata):source?.metadata||{};
    const original=source?.original?.lines?.find(line=>line.lineId===source.direct_order_line_id);
    const valid=source&&source.state==='APPLIED'&&source.purchase_receipt_id===receipt.receipt_id&&
      source.purchase_order_line_id===receipt.purchase_order_line_id&&source.sku_id===receipt.sku_id&&
      receipt.location_id===null&&JSON.parse(receipt.movement_ids||'[]').length===0&&
      exact.canonical(source.quantity)===exact.canonical(receipt.quantity_units)&&
      exact.canonical(source.secondary_quantity||0)===exact.canonical(receipt.secondary_quantity||0)&&
      source.journal_status==='POSTED'&&!source.reversed&&source.source_type==='sale_fulfillment'&&
      source.source_record_id===source.sales_order_id&&metadata.salesOrderLineId===source.sales_order_line_id&&
      metadata.supplierDirect?.dispatchLineId===source.id&&metadata.supplierDirect?.receiptId===receipt.receipt_id&&
      Number(metadata.cogsMinor)===Number(source.cost_minor)&&Number(source.rni_minor)===Number(source.cost_minor)&&
      source.currency===source.books_currency&&original&&
      exact.canonical(original.quantity)===exact.canonical(source.quantity)&&
      hash({lots:original.lots,serials:original.serials})===hash(source.tracking)&&!seen.has(source.id);
    if(!valid){target.proven=false;continue;}
    seen.add(source.id);
    target.value+=Number(source.cost_minor);
    if(source.tracking.lots.length)target.tracking.push(...source.tracking.lots.map(lot=>({lot_code:lot.lotCode,
      quantity:lot.quantity,secondary:lot.secondaryQuantity,serials:[]})));
    else target.tracking.push({lot_code:null,quantity:source.quantity,secondary:source.secondary_quantity,
      serials:source.tracking.serials.map(serial=>({serial:serial.serial,secondary:serial.weight}))});
  }
  return result;
}

module.exports={read};
