'use strict';
const access=require('../actions/permissions'),{NotFoundError}=require('../domain/errors');
async function overview(db,ctx){
 const user=(await db.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];access.assertCan(user,access.VIEW,'view production');
 const query=(sql)=>db.query(sql,[ctx.workspaceId]).then(r=>r.rows);
 const [settings,accounts,centres,boms,jobs,locations]=await Promise.all([
  query('SELECT * FROM manufacturing_settings WHERE workspace_id=$1'),
  query("SELECT id,code,name FROM accounting_accounts WHERE workspace_id=$1 AND active=1 AND is_control=0 AND account_type='ASSET' AND normal_balance='DEBIT' ORDER BY code"),
  query('SELECT * FROM manufacturing_work_centres WHERE workspace_id=$1 AND active=1 ORDER BY name'),
  query('SELECT b.*,s.code,i.name FROM manufacturing_boms b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.output_sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE b.workspace_id=$1 ORDER BY b.created_at DESC LIMIT 100'),
  query("SELECT w.*,to_char(w.needed_by,'YYYY-MM-DD') needed_by,s.code,i.name FROM manufacturing_work_orders w JOIN manufacturing_boms b ON b.workspace_id=w.workspace_id AND b.id=w.bom_id JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.output_sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE w.workspace_id=$1 ORDER BY w.created_at DESC LIMIT 100"),
  query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name')]);
 const visibleJobs=access.can(user,access.VIEW_ACCOUNTING)?jobs:jobs.map(j=>{const out={...j};for(const key of ['material_cost_minor','additional_cost_minor','wip_cost_minor','wip_account_id'])delete out[key];return out;});
 return {settings:access.can(user,access.MANAGE_ACCOUNTING)?settings[0]||null:null,accounts:access.can(user,access.MANAGE_ACCOUNTING)?accounts:[],centres,boms,jobs:visibleJobs,locations};
}
async function bom(db,ctx,id){
 const row=(await db.query('SELECT b.*,s.code,i.name FROM manufacturing_boms b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.output_sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE b.workspace_id=$1 AND b.id=$2',[ctx.workspaceId,id])).rows[0];
 if(!row)throw new NotFoundError('That BOM is not in this inventory.');
 const products=(await db.query('SELECT s.id,s.code,i.name,i.tracking_mode FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])',[ctx.workspaceId,row.definition.components.map(p=>p.skuId)])).rows;row.components=row.definition.components.map(part=>({...part,...products.find(p=>p.id===part.skuId)}));return row;
}
async function workOrder(db,ctx,id){
 const job=await require('./postgres-service').getWorkOrder(db,ctx.workspaceId,id),definition=await bom(db,ctx,job.bom_id);
 const events=(await db.query('SELECT e.*,u.name actor_name FROM manufacturing_events e JOIN users u ON u.workspace_id=e.workspace_id AND u.id=e.actor_user_id WHERE e.workspace_id=$1 AND e.work_order_id=$2 ORDER BY e.created_at,e.id',[ctx.workspaceId,id])).rows;
 const costs=(await db.query('SELECT * FROM manufacturing_added_costs WHERE workspace_id=$1 AND work_order_id=$2 ORDER BY id',[ctx.workspaceId,id])).rows;
 const expenses=(await db.query("SELECT l.id,l.debit_minor,e.description,a.name account_name FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND l.currency=$2 AND l.debit_minor>0 AND a.account_type='EXPENSE' AND e.status='POSTED' AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=e.workspace_id AND r.reversal_of_entry_id=e.id AND r.status='POSTED') ORDER BY e.created_at DESC,l.id LIMIT 100",[ctx.workspaceId,job.currency])).rows;const bookings=(await db.query("SELECT b.*,to_char(b.scheduled_on,'YYYY-MM-DD') AS scheduled_day,c.name centre_name FROM manufacturing_capacity_bookings b JOIN manufacturing_work_centres c ON c.workspace_id=b.workspace_id AND c.id=b.work_centre_id WHERE b.workspace_id=$1 AND b.work_order_id=$2 AND b.status='HELD' ORDER BY b.scheduled_on,b.operation",[ctx.workspaceId,id])).rows;const materials=(await db.query(`SELECT u.*,s.code,i.name,(SELECT coalesce(jsonb_agg(jsonb_build_object('id',serial.id,'serial',serial.serial) ORDER BY serial.serial),'[]'::jsonb) FROM serial_units serial WHERE serial.workspace_id=u.workspace_id AND serial.id IN (SELECT jsonb_array_elements_text(u.tracking->'serialUnitIds')) AND serial.status='issued') recoverable_serials,(SELECT coalesce(sum(r.quantity),0) FROM manufacturing_material_recoveries r WHERE r.workspace_id=u.workspace_id AND r.material_use_id=u.id) recovered_quantity FROM manufacturing_material_uses u JOIN skus s ON s.workspace_id=u.workspace_id AND s.id=u.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE u.workspace_id=$1 AND u.work_order_id=$2 ORDER BY u.component,u.id`,[ctx.workspaceId,id])).rows;return {job,definition,events,costs,expenses,bookings,materials};
}
module.exports={overview,bom,workOrder};
