'use strict';
// The existing inventory-summary read and authenticated startup context share
// one projection. Callers retain their current membership/read permission
// gates. This supplies facts only; it never chooses or executes a workflow.
async function read(database,workspaceId){
 const row=(await database.query(`SELECT
  (SELECT COUNT(*) FROM items WHERE workspace_id=$1 AND is_active=1) AS products,
  (SELECT COUNT(*) FROM items WHERE workspace_id=$1) AS products_ever,
  (SELECT COUNT(*) FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
   WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1) AS skus,
  (SELECT COALESCE(SUM(b.on_hand),0) FROM balances b
   JOIN skus s ON s.id=b.sku_id AND s.workspace_id=b.workspace_id
   JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
   WHERE b.workspace_id=$1 AND s.is_active=1 AND i.is_active=1) AS on_hand`,[workspaceId])).rows[0];
 const value={products:Number(row.products),productsEver:Number(row.products_ever),skus:Number(row.skus),onHand:Number(row.on_hand)};
 if(!Object.values(value).every(Number.isSafeInteger))throw Error('INVENTORY_SUMMARY_PRECISION_REQUIRED');
 return value;
}
const scope='Active products and active SKUs; physical units across all locations. productsEver includes inactive product records. On-hand units do not establish sellable or costed units.';
async function context(database,workspaceId,actor){
 const permissions=require('../actions/permissions');
 if(!permissions.can(actor,permissions.VIEW))return null;
 return {...await read(database,workspaceId),scope,complete:true};
}
module.exports={read,context};
