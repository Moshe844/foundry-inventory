'use strict';

const permissions=require('../actions/permissions');

/** Canonical, workspace-scoped record destinations. No model-provided URL. */
const RECORDS=Object.freeze({
  custody_agreement:{description:'A rental or consignment agreement with custody, inspection, ownership and billing history.',permission:permissions.VIEW,collection:{href:'/custody',label:'Rentals and consignment'},sql:'SELECT id,agreement_number AS title FROM custody_agreements WHERE workspace_id=$1',href:row=>'/custody/'+encodeURIComponent(row.id)},
  manufacturing_work_order:{description:'A production work order with its material consumption, output, scrap and work-in-progress value.',permission:permissions.VIEW,collection:{href:'/manufacturing',label:'Manufacturing'},
    sql:'SELECT id,order_number AS title FROM manufacturing_work_orders WHERE workspace_id=$1',href:row=>'/manufacturing/work-orders/'+encodeURIComponent(row.id)},
  manufacturing_bom:{description:'An immutable production bill-of-materials revision.',permission:permissions.VIEW,collection:{href:'/manufacturing',label:'Manufacturing'},
    sql:"SELECT b.id,s.code||' · revision '||b.revision AS title FROM manufacturing_boms b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.output_sku_id WHERE b.workspace_id=$1",href:row=>'/manufacturing/boms/'+encodeURIComponent(row.id)},
  product:{description:'A product and its variants.',permission:permissions.VIEW,collection:{href:'/inventory',label:'Inventory'},
    sql:`SELECT id,name AS title FROM items WHERE workspace_id=$1 AND is_active=1`,
    href:(row)=>`/inventory/${encodeURIComponent(row.id)}`},
  sku:{description:'A particular product variant or SKU.',permission:permissions.VIEW,collection:{href:'/inventory/table',label:'Products and variants'},
    sql:`SELECT s.id,s.item_id,s.code AS title FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1`,
    href:(row)=>`/inventory/${encodeURIComponent(row.item_id)}#sku-${encodeURIComponent(row.id)}`},
  location:{description:'A specific inventory location.',permission:permissions.VIEW,collection:{href:'/locations',label:'Locations'},
    sql:`SELECT id,name AS title FROM locations WHERE workspace_id=$1 AND is_active=1`,
    href:(row)=>`/locations#location-${encodeURIComponent(row.id)}`},
  supplier:{description:'A supplier record.',permission:permissions.VIEW_PURCHASING,collection:{href:'/suppliers',label:'Suppliers'},
    sql:`SELECT id,name AS title FROM suppliers WHERE workspace_id=$1 AND status='active'`,
    href:(row)=>`/suppliers/${encodeURIComponent(row.id)}`},
  customer:{description:'A customer record.',permission:permissions.VIEW_SALES,collection:{href:'/customers',label:'Customers'},
    sql:`SELECT id,name AS title FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE'`,
    href:(row)=>`/sales/customers/${encodeURIComponent(row.id)}`},
  purchase_order:{description:'A specific supplier purchase order.',permission:permissions.VIEW_PURCHASING,collection:{href:'/purchasing',label:'Purchasing'},
    sql:`SELECT id,po_number AS title FROM purchase_orders WHERE workspace_id=$1`,
    href:(row)=>`/purchasing/orders/${encodeURIComponent(row.id)}`},
  sales_order:{description:'A specific customer order.',permission:permissions.VIEW_SALES,collection:{href:'/orders',label:'Customer orders'},
    sql:`SELECT id,order_number AS title FROM sales_orders WHERE workspace_id=$1`,
    href:(row)=>`/orders/${encodeURIComponent(row.id)}`},
  transfer:{description:'A specific inventory transfer.',permission:permissions.VIEW_TRANSFERS,collection:{href:'/transfers',label:'Stock transfers'},
    sql:`SELECT id,transfer_number AS title FROM inventory_transfers WHERE workspace_id=$1`,
    href:(row)=>`/transfers/${encodeURIComponent(row.id)}`},
  shipment:{description:'A shipment or fulfillment record.',permission:permissions.VIEW_SALES,collection:{href:'/fulfilment',label:'Fulfilment'},
    sql:`SELECT id,shipment_number AS title FROM sales_shipments WHERE workspace_id=$1`,
    href:(row)=>`/fulfilment/${encodeURIComponent(row.id)}`},
  customer_return:{description:'A customer return.',permission:permissions.VIEW_SALES,collection:{href:'/returns',label:'Customer returns'},
    sql:`SELECT id,return_number AS title FROM customer_returns WHERE workspace_id=$1`,
    href:(row)=>`/returns/${encodeURIComponent(row.id)}`},
  supplier_return:{description:'A supplier return.',permission:permissions.VIEW_PURCHASING,collection:{href:'/supplier-returns',label:'Supplier returns'},
    sql:`SELECT id,return_number AS title FROM supplier_returns WHERE workspace_id=$1`,
    href:(row)=>`/supplier-returns/${encodeURIComponent(row.id)}`},
  connection:{description:'A specific connected system.',permission:permissions.ADMIN,collection:{href:'/settings/connections',label:'Integrations'},
    sql:`SELECT id,display_name AS title FROM workspace_connectors WHERE workspace_id=$1`,
    href:(row)=>`/settings/connections/${encodeURIComponent(row.id)}`},
  mail_message:{description:'A captured business email message.',permission:permissions.VIEW,collection:{href:'/mail',label:'Business mailbox'},
    sql:`SELECT id,COALESCE(NULLIF(subject,''),external_message_id) AS title
      FROM connection_email_messages WHERE workspace_id=$1`,
    href:(row)=>`/mail/${encodeURIComponent(row.id)}`},
  journal_entry:{description:'A posted accounting journal entry.',permission:permissions.VIEW_ACCOUNTING,collection:{href:'/accounting/transactions',label:'Accounting journal'},
    sql:`SELECT id,entry_number::text AS title FROM accounting_journal_entries WHERE workspace_id=$1`,
    href:(row)=>`/accounting/entries/${encodeURIComponent(row.id)}`},
});

async function resolve(database,ctx,kind,reference){
  const contract=RECORDS[kind];if(!contract)return {unsupported:true};
  const query=String(reference||'').trim();if(!query)return {missing:true};
  const source=`(${contract.sql}) AS candidate`;
  const exact=(await database.query(`SELECT * FROM ${source}
    WHERE lower(id)=lower($2) OR lower(title)=lower($2) OR lower(regexp_replace(title,'(^[A-Za-z]+[- ]*)0+','\\1'))=lower($3) ORDER BY title LIMIT 9`,
  [ctx.workspaceId,query,require('../domain/postgres-search-service').compactReference(query)])).rows;
  const found=exact.length?exact:(await database.query(`SELECT * FROM ${source}
    WHERE strpos(lower(title),lower($2))>0 ORDER BY title LIMIT 9`,
  [ctx.workspaceId,query])).rows;
  if(found.length!==1)return found.length?{ambiguous:found.slice(0,8)}:{notFound:true};
  return {href:contract.href(found[0]),label:found[0].title,kind,id:found[0].id};
}

module.exports={RECORDS,resolve};
