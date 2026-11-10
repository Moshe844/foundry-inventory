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
  ${require('../domain/stock-totals').totalsSql('$1')} AS stock`,[workspaceId])).rows[0];
 const counts={products:Number(row.products),productsEver:Number(row.products_ever),skus:Number(row.skus)};
 if(!Object.values(counts).every(Number.isSafeInteger))throw Error('INVENTORY_SUMMARY_PRECISION_REQUIRED');
 // The same on-hand total as Home and Stock: counted units, measured stock apart.
 const stock=require('../domain/stock-totals').read(row.stock);
 return {...counts,onHand:require('../domain/exact-quantity').safeNumber(stock.units,{signed:true,label:'On-hand quantity'}),measured:stock.measured};
}
const scope='Active products and active SKUs; on hand is whole units of counted products across all locations, with measured stock (kilograms, metres, litres) listed apart in its own units. productsEver includes inactive product records. On-hand units do not establish sellable or costed units.';
async function context(database,workspaceId,actor){
 const permissions=require('../actions/permissions');
 if(!permissions.can(actor,permissions.VIEW))return null;
 return {...await read(database,workspaceId),scope,complete:true};
}
module.exports={read,context};
