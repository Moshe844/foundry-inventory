'use strict';
const {AuthorizationError,ValidationError,NotFoundError}=require('../domain/errors');
const permissions=require('../actions/permissions'),money=require('../domain/currency'),{newId}=require('../lib/util');
const capability='authority.advanced';
async function owner(c,ctx){const actor=(await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(actor?.role!=='owner')throw new AuthorizationError('Only an inventory owner can change team access.');}
async function history(c,ctx,subjectId,action,before,after){await c.query('INSERT INTO team_access_history(id,workspace_id,actor_id,subject_id,action,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6,$7)',[newId('teamchange'),ctx.workspaceId,ctx.actorId,subjectId,action,JSON.stringify(before),JSON.stringify(after)]);}
function roleState(row){return row?{Name:row.name,Permissions:JSON.parse(row.permissions).map(p=>permissions.LABELS[p]||p).join(', ')}:{};}
function memberState(row,roleName){return {Person:row.name,Role:roleName||row.role,'Purchase approval limit':row.po_approval_limit_minor===null?'No amount limit':money.format(Number(row.po_approval_limit_minor),row.po_approval_currency)};}
async function list(db,workspaceId){return (await db.query('SELECT id,name,permissions,revision FROM workspace_custom_roles WHERE workspace_id=$1 ORDER BY lower(name),id',[workspaceId])).rows;}
async function saveRole(db,ctx,input){return db.transaction(async c=>{
 await owner(c,ctx);await require('../commercial/enforcement').workspace(c,ctx.workspaceId,capability);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['team-access:'+ctx.workspaceId]);
 const name=String(input.name||'').trim(),grants=Array.isArray(input.permissions)?input.permissions:[input.permissions].filter(Boolean);
 if(!name||name.length>80)throw new ValidationError('Enter a role name up to 80 characters.');
 if(grants.some(p=>!permissions.ALL.includes(p)))throw new ValidationError('Choose only the listed permissions.');
 const encoded=permissions.encodeGrant(grants),prior=input.id?(await c.query('SELECT * FROM workspace_custom_roles WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,input.id])).rows[0]:null;
 if(input.id&&!prior)throw new NotFoundError('That role was not found in this inventory.');
 if(prior&&Number(input.revision)!==prior.revision)throw new ValidationError('This role changed. Reload the Team page before saving.');
 if((await c.query('SELECT 1 FROM workspace_custom_roles WHERE workspace_id=$1 AND lower(name)=lower($2) AND id<>$3',[ctx.workspaceId,name,prior?.id||''])).rowCount)throw new ValidationError('A role already uses that name.');
 if(!prior){const ent=require('../commercial/entitlements'),state=await ent.assertMeterCapacity(c,await ent.ownerScopeForWorkspace(c,ctx.workspaceId),'custom_roles',1);if(state.hardLimit===null&&state.used>=50)throw new ValidationError('This inventory already has its 50 custom roles. Reuse or edit an existing role.');}
 const id=prior?.id||newId('teamrole');
 if(prior){await c.query('UPDATE workspace_custom_roles SET name=$3,permissions=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,name,encoded]);await c.query("UPDATE users SET permissions=$3,access_revision=access_revision+1 WHERE workspace_id=$1 AND custom_role_id=$2 AND role<>'owner'",[ctx.workspaceId,id,encoded]);}
 else await c.query('INSERT INTO workspace_custom_roles(id,workspace_id,name,permissions) VALUES($1,$2,$3,$4)',[id,ctx.workspaceId,name,encoded]);
 await history(c,ctx,id,'Custom role changed',roleState(prior),roleState({name,permissions:encoded}));return {id};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
async function assign(db,ctx,userId,input){return db.transaction(async c=>{
 await owner(c,ctx);await require('../commercial/enforcement').workspace(c,ctx.workspaceId,capability);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['team-access:'+ctx.workspaceId]);
 const user=(await c.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,userId])).rows[0];
 if(!user)throw new NotFoundError('That person was not found in this inventory.');
 if(user.role==='owner')throw new ValidationError('Owners retain full authority. Choose a staff member or accountant.');
 if(Number(input.revision)!==user.access_revision)throw new ValidationError('This person’s access changed. Reload the Team page before saving.');
 const roleId=String(input.customRoleId||''),role=roleId?(await c.query('SELECT * FROM workspace_custom_roles WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,roleId])).rows[0]:null;
 if(roleId&&!role)throw new ValidationError('Choose a role from this inventory.');
 const base=role?'staff':String(input.baseRole||'staff');if(!['staff','accountant'].includes(base))throw new ValidationError('Choose Staff, Accountant or a custom role.');
 const limit=String(input.approvalLimit??'').trim(),currency=limit?money.code(input.currency):null,amount=limit?money.userToMinor(limit,currency,{label:'Purchase approval limit'}):null;
 const oldRole=user.custom_role_id?(await c.query('SELECT name FROM workspace_custom_roles WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,user.custom_role_id])).rows[0]?.name:null;
 let warehouseIds=user.warehouse_location_ids;
 if(input.warehouseScope!==undefined){
  if(!['ALL','SELECTED'].includes(input.warehouseScope))throw new ValidationError('Choose all warehouses or selected warehouses.');
  warehouseIds=input.warehouseScope==='ALL'?null:[...new Set((Array.isArray(input.warehouseIds)?input.warehouseIds:[input.warehouseIds]).filter(Boolean).map(String))];
  if(warehouseIds!==null){
   const valid=(await c.query("SELECT id FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1 AND kind IN ('warehouse','store') AND parent_location_id IS NULL AND custody_agreement_id IS NULL",[ctx.workspaceId,warehouseIds])).rows;
   if(valid.length!==warehouseIds.length)throw new ValidationError('Choose active warehouses or stores from this inventory.');
  }
 }
 await c.query('UPDATE users SET role=$3,custom_role_id=$4,permissions=$5,po_approval_limit_minor=$6,po_approval_currency=$7,access_revision=access_revision+1 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,user.id,base,role?.id||null,role?.permissions||null,amount,currency]);
 await c.query('UPDATE users SET warehouse_location_ids=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,user.id,warehouseIds===null?null:JSON.stringify(warehouseIds)]);
 if(JSON.stringify(user.warehouse_location_ids)!==JSON.stringify(warehouseIds)){
  const names=async ids=>ids===null?'All warehouses':ids.length?(await c.query('SELECT name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY name,id',[ctx.workspaceId,ids])).rows.map(l=>l.name).join(', '):'No warehouses assigned';
  await history(c,ctx,user.id,'Warehouse access changed',{Warehouses:await names(user.warehouse_location_ids)},{Warehouses:await names(warehouseIds)});
 }
 await history(c,ctx,user.id,'Team access changed',memberState(user,oldRole),memberState({...user,role:base,po_approval_limit_minor:amount,po_approval_currency:currency},role?.name));return {id:user.id};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
// Enforced independently of the current plan: a downgrade cannot remove a spending restriction.
async function assertPurchaseApproval(c,ctx,order){
 const actor=(await c.query('SELECT role,permissions,po_approval_limit_minor,po_approval_currency FROM users WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw new AuthorizationError('Your membership could not be verified.');
 permissions.assertCan(actor,permissions.APPROVE_PO,'approve purchase orders');
 if(actor.role==='owner'||actor.po_approval_limit_minor===null)return;
 if(actor.po_approval_currency!==order.currency)throw new AuthorizationError('This purchase uses a different currency from your approval limit. Ask an owner or an authorized manager to approve it.');
 const amount=await purchaseAmount(c,ctx.workspaceId,order);
 if(amount>Number(actor.po_approval_limit_minor))throw new AuthorizationError('This purchase totals '+money.format(amount,order.currency)+', above your '+money.format(Number(actor.po_approval_limit_minor),order.currency)+' approval limit. Ask an owner or an authorized manager to approve it.');
}
async function purchaseAmount(c,workspaceId,order){
 const scale=10**money.exponent(order.currency),totals=(await c.query(`SELECT
 (SELECT coalesce(sum(round(unit_cost::numeric*coalesce(secondary_quantity_ordered,quantity_units)*$3)),0)::text FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2) lines,
 (SELECT coalesce(sum(amount_minor),0)::text FROM purchase_order_charges WHERE workspace_id=$1 AND purchase_order_id=$2 AND kind<>'deposit') charges`,[workspaceId,order.id,scale])).rows[0];
 const amount=money.sum([money.integer(totals.lines),money.integer(totals.charges,'Purchase charges',{signed:true})]);
 if(amount<0)throw new ValidationError('The purchase total needs review before approval.');
 return amount;
}
module.exports={list,saveRole,assign,assertPurchaseApproval,purchaseAmount,capability};

