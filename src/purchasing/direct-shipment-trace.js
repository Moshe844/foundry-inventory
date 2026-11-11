'use strict';

async function extend(db,ctx,definition){
  if(![193,195].includes(definition.id))return definition.sql;
  const native=definition.id===195?serialHistory(definition.sql):definition.sql;
  const installed=(await db.query("SELECT to_regclass('stockchief_runtime.agent_direct_dispatches') IS NOT NULL AS installed")).rows[0];
  if(!installed?.installed)return native;
  const present=await db.query(`SELECT 1 FROM stockchief_runtime.agent_direct_dispatches
    WHERE workspace_id=$1 AND state='APPLIED' LIMIT 1`,[ctx.workspaceId]);
  if(!present.rowCount)return native;
  if(definition.id===195)return serialHistory(`${definition.sql} UNION ALL
    SELECT u.serial AS "Serial",s.code AS "SKU",d.original->>'shippedAt' AS "When",'Supplier direct dispatch' AS "Action",
      'Out' AS "Direction",'Customer destination' AS "Location",o.order_number AS "Reference",
      coalesce(actor.name,'Recorded supplier evidence') AS "Recorded by",'/orders/'||o.id AS link,0 AS sequence
    FROM stockchief_runtime.agent_direct_serial_units t JOIN serial_units u ON u.workspace_id=t.workspace_id AND u.id=t.serial_unit_id
    JOIN stockchief_runtime.agent_direct_dispatch_lines x ON x.workspace_id=t.workspace_id AND x.id=t.dispatch_line_id
    JOIN stockchief_runtime.agent_direct_dispatches d ON d.workspace_id=x.workspace_id AND d.id=x.dispatch_id AND d.state='APPLIED'
    JOIN stockchief_runtime.agent_direct_orders p ON p.workspace_id=d.workspace_id AND p.id=d.direct_order_id
    JOIN sales_orders o ON o.workspace_id=p.workspace_id AND o.id=p.sales_order_id
    JOIN skus s ON s.workspace_id=u.workspace_id AND s.id=u.sku_id
    LEFT JOIN users actor ON actor.workspace_id=d.workspace_id AND actor.id=d.confirmed_by
    WHERE t.workspace_id=$1 AND lower(u.serial)=lower($2)`);
  return `WITH direct_lots AS(
    SELECT t.workspace_id,t.dispatch_line_id,l.sku_id,l.code,t.quantity FROM stockchief_runtime.agent_direct_lots t
      JOIN lots l ON l.workspace_id=t.workspace_id AND l.id=t.lot_id WHERE t.workspace_id=$1 AND lower(l.code)=lower($2)
    UNION ALL SELECT t.workspace_id,t.dispatch_line_id,l.sku_id,l.code,count(*)::numeric
      FROM stockchief_runtime.agent_direct_serial_units t JOIN serial_units u ON u.workspace_id=t.workspace_id AND u.id=t.serial_unit_id
      JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id WHERE t.workspace_id=$1 AND lower(l.code)=lower($2)
      GROUP BY t.workspace_id,t.dispatch_line_id,l.sku_id,l.code),combined AS(
    SELECT * FROM (${definition.sql}) native_history UNION ALL
    SELECT c.name AS "Customer",o.order_number AS "Order",'Supplier direct' AS "Type",s.code AS "SKU",l.code AS "Lot",l.quantity AS "Units issued",c.email AS "Contact",
      '/orders/'||o.id AS link FROM direct_lots l
      JOIN stockchief_runtime.agent_direct_dispatch_lines x ON x.workspace_id=l.workspace_id AND x.id=l.dispatch_line_id
      JOIN stockchief_runtime.agent_direct_dispatches d ON d.workspace_id=x.workspace_id AND d.id=x.dispatch_id AND d.state='APPLIED'
      JOIN stockchief_runtime.agent_direct_orders p ON p.workspace_id=d.workspace_id AND p.id=d.direct_order_id
      JOIN sales_orders o ON o.workspace_id=p.workspace_id AND o.id=p.sales_order_id
      JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id)
    SELECT "Customer","Order","Type","SKU","Lot",sum("Units issued") AS "Units issued","Contact",link FROM combined
      GROUP BY "Customer","Order","Type","SKU","Lot","Contact",link ORDER BY "Customer","Order","SKU","Lot",link`;
}

function serialHistory(sql){
  return `SELECT "Serial","SKU","When","Action","Direction","Location","Reference","Recorded by",link
    FROM (${sql}) history ORDER BY "When"::timestamptz,sequence,"SKU","Serial",link`;
}

module.exports={extend};
