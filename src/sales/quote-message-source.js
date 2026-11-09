'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),P=require('../actions/permissions');
async function owner(db,ctx){
 const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can authorize a quotation message.');P.assertCan(user,P.MANAGE_SALES,'manage quotation messages');P.assertCan(user,P.VIEW_SALES,'review quoted terms');
}
async function facts(db,ctx,id,{jobId=null}={}){
 await owner(db,ctx);if(jobId)await require('../commercial/agent-plan').requireWorkspaceJob(db,ctx.workspaceId,jobId,'draft');
 const q=await require('./postgres-quotes').get(db,ctx.workspaceId,id),customer=(await db.query("SELECT id,name,email FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'",[ctx.workspaceId,q.customer_id])).rows[0];
 if(!customer||!/^\S+@\S+\.\S+$/.test(customer.email||''))throw new ValidationError('Confirm the active customer and their email before sending a quotation message.');
 const today=await require('../lib/business-time').today(db,ctx.workspaceId);
 if(q.status!=='OPEN'||q.sales_order_id||q.valid_until<today)throw new ValidationError('Use an open, unexpired quotation. Accepted or declined quotes need no follow-up, and expired terms need a new review.');
 if((await db.query('SELECT 1 FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=$2 LIMIT 1',[ctx.workspaceId,id])).rowCount)throw new ValidationError('A newer quotation replaces this one. Use the actual current revision.');
 const pricing=require('../pricing/postgres-promotions');if(pricing.quoteHash(q.pricing)!==q.pricing_hash)throw new ValidationError('The saved quotation terms do not match their integrity record. Review the quotation.');
 if(pricing.quoteHash(await pricing.prepareQuote(db,ctx,q.input))!==q.pricing_hash)throw new ValidationError('Current prices or customer terms no longer match this quote. Review a current quotation before sending a message.');
 if(Object.keys(q.line_units||{}).length){const units=(await db.query('SELECT s.id,i.unit_label,i.secondary_unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])',[ctx.workspaceId,q.input.lines.map(l=>l.skuId)])).rows;if(units.some(r=>q.line_units[r.id]?.quantity!==r.unit_label||q.line_units[r.id]?.price!==(r.secondary_unit_label||r.unit_label)))throw new ValidationError('The product units changed after this quotation was saved. Review a current revision before sending a message.');}
 return {q,customer,today};
}
module.exports={owner,facts};
