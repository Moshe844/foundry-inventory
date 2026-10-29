'use strict';
const prefixes={purchase_orders:['PO'],sales_orders:['SO'],accounting_supplier_bills:['BILL'],accounting_customer_invoices:['INV'],accounting_payments:['PAY','RCPT'],sales_shipments:['SHP']};
async function next(client,workspaceId,kind,prefix){
 if(!prefixes[kind]?.includes(prefix))throw new Error('Unsupported business number kind.');
 // Keep the existing shipping/workflow lock names during rolling deployment.
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[kind==='sales_shipments'?'shipment-number:'+workspaceId:`number:${workspaceId}:${kind}`]);
 const result=await client.query(`INSERT INTO stockchief_runtime.business_number_counters(workspace_id,kind,prefix,last_number)
  VALUES($1,$2,$3,1) ON CONFLICT(workspace_id,kind,prefix) DO UPDATE SET last_number=business_number_counters.last_number+1
  RETURNING last_number`,[workspaceId,kind,prefix]);
 return prefix+'-'+String(result.rows[0].last_number).padStart(5,'0');
}
module.exports={next};
