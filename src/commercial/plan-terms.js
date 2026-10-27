'use strict';
const {ValidationError}=require('../domain/errors'),entitlements=require('./entitlements'),{newId}=require('../lib/util');
async function review(db,accountId){
 const subscription=await entitlements.subscriptionFor(db,accountId);
 if(!subscription)return {subscription:null,current:null,next:null,canAccept:false,reason:'Choose a subscription to review its included allowances. Your saved business records stay in place.'};
 const next=(await db.query("SELECT * FROM commercial_plan_versions WHERE plan_id=$1 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1",[subscription.plan_id])).rows[0];
 const current=subscription.plan_version_id?(await db.query('SELECT * FROM commercial_plan_versions WHERE id=$1',[subscription.plan_version_id])).rows[0]:null;
 if(!next||!current)return {subscription,current,next,canAccept:false,reason:'This subscription has no comparable saved terms. Review the available plans before changing it; no price or allowance has changed.'};
 const amount=subscription.billing_interval==='ANNUAL'?'annual_amount_minor':'monthly_amount_minor';
 if(next.currency!==current.currency||Number(next[amount])!==Number(current[amount]))return {subscription,current,next,canAccept:false,reason:'The updated offer has a different price. Review a plan change to see its billing amount before approving it.'};
 return {subscription,current,next,canAccept:true,changed:next.id!==current.id};
}
async function accept(db,accountId,input){return db.transaction(async c=>{await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR UPDATE',[accountId]);const r=await review(c,accountId);if(!r.canAccept)throw new ValidationError(r.reason);if(!r.changed)return {unchanged:true};if(input.confirm!=='1'||input.currentVersion!==r.current.id||input.nextVersion!==r.next.id)throw new ValidationError('Review the current and updated plan terms before accepting them.');await c.query('UPDATE account_subscriptions SET plan_version_id=$2,updated_at=now() WHERE account_id=$1',[accountId,r.next.id]);await c.query(`INSERT INTO commercial_change_audit(id,subject_type,subject_id,action,before_state,after_state,reason,actor_account_id) VALUES($1,'subscription',$2,'owner_accepts_updated_terms',$3::jsonb,$4::jsonb,'Owner reviewed and accepted updated allowances and credit definition; price, usage history and billing period unchanged.',$5)`,[newId('termsaudit'),r.subscription.id,JSON.stringify({planVersionId:r.current.id,meters:r.current.meters}),JSON.stringify({planVersionId:r.next.id,meters:r.next.meters}),accountId]);return {accepted:true};},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={review,accept};
