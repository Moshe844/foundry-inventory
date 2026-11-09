'use strict';
const permissions=require('./permissions');
function costs(actor){return permissions.can(actor,permissions.VIEW_PURCHASING)||permissions.can(actor,permissions.VIEW_ACCOUNTING);}
const readPermissions=Object.freeze({inventory_valuation:permissions.VIEW_ACCOUNTING,inventory_cost_movements:permissions.VIEW_ACCOUNTING,
  purchase_costs:permissions.VIEW_PURCHASING,supplier_items:permissions.VIEW_PURCHASING,
  accounting:permissions.VIEW_ACCOUNTING,payments:permissions.VIEW_ACCOUNTING,
  business_analysis:permissions.VIEW_ACCOUNTING,sales_activity:permissions.VIEW_ACCOUNTING});
async function review(db,ctx){
 const rows=(await db.query('SELECT name,role,permissions FROM users WHERE workspace_id=$1 ORDER BY name,id LIMIT 101',[ctx.workspaceId])).rows;
 return {rows:rows.slice(0,100).map(actor=>({'Team member':actor.name,Role:actor.role,
  'Purchase costs':costs(actor)?'Allowed':'Hidden','Accounting and margins':permissions.can(actor,permissions.VIEW_ACCOUNTING)?'Allowed':'Hidden',link:'/settings/people'})),
  more:rows.length>100,summary:'These are current role permissions. Stock quantities remain available to people with inventory access.'};
}
module.exports={costs,readPermissions,definition:{id:203,key:'financial-permissions',label:'Cost and margin visibility by role',readPage:review}};
