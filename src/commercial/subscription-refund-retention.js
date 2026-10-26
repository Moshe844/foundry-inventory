'use strict';
const {ValidationError}=require('../domain/errors'),jobs=require('../operations/postgres-job-queue');
const scoped=c=>({query:c.query.bind(c),transaction:fn=>fn(c)}),id=v=>typeof v==='string'?v:v?.id;
async function observe(c,event,accountId){const refund=event.data.object,pi=id(refund.payment_intent);
 if(refund.status!=='succeeded'){
  await c.query("UPDATE commercial_subscription_refund_retention SET status='REVIEW' WHERE refund_id=$1 AND status<>'PURGED'",[refund.id]);return {held:true};
 }
 const sub=(await c.query('SELECT * FROM account_subscriptions WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];if(!sub?.stripe_subscription_id)return {skipped:'no_subscription'};
 const receipt=(await c.query(`SELECT * FROM commercial_revenue_events WHERE account_id=$1 AND kind='SUBSCRIPTION' AND (detail->>'paymentIntentId'=$2 OR detail->'paymentIntentIds' ? $2) AND (detail->>'stripeSubscriptionId'=$3 OR EXISTS(SELECT 1 FROM commercial_billing_events e WHERE e.status='PROCESSED' AND e.event_type='invoice.paid' AND e.payload#>>'{data,object,id}'=commercial_revenue_events.detail->>'invoiceId' AND coalesce(e.payload#>>'{data,object,subscription}',e.payload#>>'{data,object,parent,subscription_details,subscription}')=$3)) ORDER BY occurred_at LIMIT 1`,[accountId,pi,sub.stripe_subscription_id])).rows[0];
 // Attribution must be backed by the subscription invoice cash reconciliation.
 // A refund of an add-on or an unrelated payment cannot lock a workspace.
 if(!receipt||receipt.detail?.stripeCashVerified!==true)return {held:true,reason:'subscription_cash_not_verified'};
 const now=new Date(event.created*1000),deadline=new Date(now.getTime()+30*86400000);
 const workspaces=(await c.query('SELECT id FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL ORDER BY id',[accountId])).rows.map(w=>w.id);
 await c.query(`INSERT INTO commercial_subscription_refund_retention(refund_id,account_id,stripe_subscription_id,refunded_at,delete_after,workspace_ids) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(refund_id) DO NOTHING`,[refund.id,accountId,sub.stripe_subscription_id,now.toISOString(),deadline.toISOString(),JSON.stringify(workspaces)]);
 await c.query(`UPDATE account_subscriptions SET refunded_at=coalesce(refunded_at,$2),refund_deletion_at=least(coalesce(refund_deletion_at,$3),$3),updated_at=now() WHERE account_id=$1 AND stripe_subscription_id=$4`,[accountId,now.toISOString(),deadline.toISOString(),sub.stripe_subscription_id]);
 await jobs.enqueue(scoped(c),{kind:'commercial.subscription-refund-cancel',idempotencyKey:'subscription-refund:'+refund.id,payload:{refundId:refund.id,accountId},maxAttempts:12});return {readOnly:true,deleteAfter:deadline.toISOString()};
}
async function cancel(db,job,options={}){
 const row=(await db.query('SELECT r.*,f.status AS refund_status,f.payment_intent_id FROM commercial_subscription_refund_retention r JOIN commercial_stripe_refunds f ON f.id=r.refund_id WHERE r.refund_id=$1 AND r.account_id=$2',[job.payload.refundId,job.payload.accountId])).rows[0];
 if(!row||row.refund_status!=='succeeded'||row.status==='REVIEW')return {skipped:'refund_not_confirmed'};
 if(row.status==='PURGED')return {replayed:true};
 const current=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[row.account_id])).rows[0];if(current?.stripe_subscription_id!==row.stripe_subscription_id)return {skipped:'subscription_replaced'};
 const provider=options.provider||require('./stripe-billing'),before=await provider.retrieveSubscription(row.stripe_subscription_id,options.providerOptions||{});
 if(before.id!==row.stripe_subscription_id||id(before.customer)!==current.stripe_customer_id)throw new ValidationError('The provider subscription does not match this refunded account.');
 const result=before.status==='canceled'?before:await provider.cancelImmediately({subscriptionId:row.stripe_subscription_id,refundId:row.refund_id},options.providerOptions||{});
 if(result.id!==row.stripe_subscription_id||id(result.customer)!==current.stripe_customer_id||result.status!=='canceled')throw new ValidationError('Subscription cancellation is not confirmed. The refunded inventory remains read-only while StockChief retries.');
 return db.transaction(async c=>{await c.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR UPDATE',[row.account_id]);
  const changed=await c.query(`UPDATE account_subscriptions SET status='CANCELLED',cancel_at_period_end=0,cancelled_at=coalesce(cancelled_at,now()),updated_at=now() WHERE account_id=$1 AND stripe_subscription_id=$2 AND refunded_at IS NOT NULL RETURNING id`,[row.account_id,row.stripe_subscription_id]);if(changed.rows.length!==1)throw new ValidationError('The refunded subscription changed while its cancellation was being verified.');
  await c.query("UPDATE commercial_subscription_refund_retention SET status='READ_ONLY',cancellation_confirmed_at=coalesce(cancellation_confirmed_at,now()) WHERE refund_id=$1 AND status<>'PURGED'",[row.refund_id]);
  await jobs.enqueue(scoped(c),{kind:'commercial.refund-retention-delete',idempotencyKey:'refund-retention:'+row.refund_id,payload:{refundId:row.refund_id,accountId:row.account_id},availableAt:new Date(row.delete_after).getTime(),maxAttempts:12});return {cancelled:true,readOnlyUntil:row.delete_after};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
const quote=s=>'"'+String(s).replaceAll('"','""')+'"';
async function purgeWorkspace(c,workspaceId){
 // Explicit test ledgers are retained until independently reconciled. Deleting
 // one must never reset an already authorized certification ceiling.
 if((await c.query("SELECT 1 FROM stockchief_runtime.codex_pilots WHERE workspace_id=$1 AND coalesce(admission_kind,'PILOT')<>'COMMERCIAL'",[workspaceId])).rows.length)throw new ValidationError('This inventory has an explicit certification spending ledger that must be retained and reconciled before deletion.');
 const busy=(await c.query(`SELECT EXISTS(SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND status='RUNNING') OR EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND status IN ('RUNNING','AMBIGUOUS')) OR EXISTS(SELECT 1 FROM commercial_model_cost_holds WHERE workspace_id=$1 AND status IN ('RESERVED','UNKNOWN')) AS blocked`,[workspaceId])).rows[0];if(busy.blocked)throw new ValidationError('Unfinished external work must reconcile before this inventory can be deleted.');
 const allowed=(await c.query('SELECT stockchief_workspace_purge_allowed($1) AS allowed',[workspaceId])).rows[0].allowed;if(!allowed)throw new ValidationError('The verified refund retention period has not ended.');
 await c.query(`INSERT INTO commercial_retained_model_receipts(hold_id,account_id,provider,model,maximum_minor,actual_minor,status,created_at) SELECT id,account_id,provider,model,maximum_minor,actual_minor,status,created_at FROM commercial_model_cost_holds WHERE workspace_id=$1 ON CONFLICT(hold_id) DO NOTHING`,[workspaceId]);
 // Discover tenant tables and non-tenant children from actual foreign keys.
 // Keep account-level payment/refund receipts; remove the workspace's content.
 const tables=(await c.query(`SELECT c.oid::text AS oid,n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname IN ('public','stockchief_runtime') AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND NOT a.attisdropped)`)).rows;
 const tenantOids=new Set(tables.map(r=>r.oid));const known=new Map(tables.map(r=>[r.oid,{...r,predicate:'workspace_id=$1'}]));
 const edges=(await c.query(`SELECT con.conrelid::text child,con.confrelid::text parent,con.confdeltype AS action,bool_or(NOT a.attnotnull) AS nullable,bool_and(NOT a.attnotnull) AS all_nullable,con.confmatchtype AS match_type,n.nspname AS schema,cl.relname AS name,array_agg(a.attname::text ORDER BY k.i) AS columns,array_agg(a.attname::text ORDER BY k.i) FILTER(WHERE NOT a.attnotnull) AS nullable_columns,array_agg(p.attname::text ORDER BY k.i) AS parent_columns FROM pg_constraint con JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace CROSS JOIN LATERAL generate_subscripts(con.conkey,1) k(i) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=con.conkey[k.i] JOIN pg_attribute p ON p.attrelid=con.confrelid AND p.attnum=con.confkey[k.i] WHERE con.contype='f' AND n.nspname IN ('public','stockchief_runtime') GROUP BY con.oid,n.nspname,cl.relname`)).rows;
 let added=true;while(added){added=false;for(const e of edges)if(known.has(e.parent)&&!known.has(e.child)){const parent=known.get(e.parent);known.set(e.child,{oid:e.child,schema:e.schema,name:e.name,predicate:'('+e.columns.map(quote).join(',')+') IN (SELECT '+e.parent_columns.map(quote).join(',')+' FROM '+quote(parent.schema)+'.'+quote(parent.name)+' WHERE '+parent.predicate+')'});added=true;}}
 // A malformed historical foreign key must never cascade into a different
 // tenant. Refuse the entire deletion before touching any scoped business row.
 for(const e of edges)if(known.has(e.parent)&&tenantOids.has(e.child)){
  const parent=known.get(e.parent),filter='('+e.columns.map(quote).join(',')+') IN (SELECT '+e.parent_columns.map(quote).join(',')+' FROM '+quote(parent.schema)+'.'+quote(parent.name)+' WHERE '+parent.predicate+')';
  if((await c.query('SELECT 1 FROM '+quote(e.schema)+'.'+quote(e.name)+' WHERE workspace_id IS DISTINCT FROM $1 AND '+filter+' LIMIT 1',[workspaceId])).rows.length)throw new ValidationError('A record references another inventory. Reconcile that link before deleting; no inventory records were removed.');
 }
 // Empty tables cannot participate in a live dependency cycle. Include only
 // tables containing this workspace, retaining the full scoped delete filter.
 const active=new Map();for(const [oid,r] of known){if((await c.query('SELECT 1 FROM '+quote(r.schema)+'.'+quote(r.name)+' WHERE '+r.predicate+' LIMIT 1',[workspaceId])).rows.length)active.set(oid,r);}
 const order=[];
 while(active.size){
  const ready=[...active].filter(([oid])=>!edges.some(e=>!e.detached&&e.parent===oid&&e.child!==oid&&active.has(e.child)));
  if(!ready.length){
   // Detach only a nullable link on rows authorized for permanent deletion
   // in this workspace. All constraints and immutable triggers stay enabled.
   // A failure to complete the whole deletion rolls the detachment back.
   let detached=false;
   for(const e of edges.filter(e=>!e.detached&&e.nullable&&(e.match_type==='s'||e.all_nullable)&&tenantOids.has(e.child)&&active.has(e.child)&&active.has(e.parent)&&e.child!==e.parent)){
    const parent=known.get(e.parent),filter='('+e.columns.map(quote).join(',')+') IN (SELECT '+e.parent_columns.map(quote).join(',')+' FROM '+quote(parent.schema)+'.'+quote(parent.name)+' WHERE '+parent.predicate+')';
    await c.query('SAVEPOINT stockchief_purge_link');
    try{await c.query('UPDATE '+quote(e.schema)+'.'+quote(e.name)+' SET '+e.nullable_columns.map(k=>quote(k)+'=NULL').join(',')+' WHERE workspace_id=$1 AND '+filter,[workspaceId]);await c.query('RELEASE SAVEPOINT stockchief_purge_link');e.detached=true;detached=true;break;}
    catch(error){await c.query('ROLLBACK TO SAVEPOINT stockchief_purge_link');await c.query('RELEASE SAVEPOINT stockchief_purge_link');if(!['23000','23502','23503','23514','P0001'].includes(error.code))throw error;}
   }
   if(!detached)throw new ValidationError('A linked record needs review before permanent deletion. No inventory records were removed.');
   continue;
  }
  for(const [oid,r] of ready){order.push(r);active.delete(oid);}
 }

 for(const r of order)await c.query('DELETE FROM '+quote(r.schema)+'.'+quote(r.name)+' WHERE '+r.predicate,[workspaceId]);
 await c.query('UPDATE accounts SET last_workspace_id=NULL WHERE last_workspace_id=$1',[workspaceId]);
 await c.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);return {deleted:true};
}
async function remove(db,job){return db.transaction(async c=>{
 const r=(await c.query('SELECT r.*,f.status AS refund_status FROM commercial_subscription_refund_retention r JOIN commercial_stripe_refunds f ON f.id=r.refund_id WHERE r.refund_id=$1 AND r.account_id=$2 FOR UPDATE OF r',[job.payload.refundId,job.payload.accountId])).rows[0];if(!r)throw new ValidationError('This refund retention record is unavailable.');if(r.status==='PURGED')return {replayed:true};if(r.status!=='READ_ONLY'||r.refund_status!=='succeeded'||new Date(r.delete_after)>new Date()||new Date(r.refunded_at).getTime()+30*86400000>Date.now())throw new ValidationError('The refund and 30-day retention period must be confirmed before deletion.');
 for(const workspaceId of r.workspace_ids){const w=(await c.query('SELECT owner_account_id FROM workspaces WHERE id=$1 FOR UPDATE',[workspaceId])).rows[0];if(!w)continue;if(w.owner_account_id!==r.account_id)throw new ValidationError('An inventory owner changed before deletion.');await c.query("SELECT set_config('stockchief.purge_workspace',$1,true)",[workspaceId]);await purgeWorkspace(c,workspaceId);}
 await c.query("UPDATE commercial_subscription_refund_retention SET status='PURGED',purged_at=now() WHERE refund_id=$1",[r.refund_id]);return {deleted:r.workspace_ids.length};
 },{isolation:'SERIALIZABLE',statementTimeoutMs:120000,retrySafe:true});}
module.exports={observe,cancel,remove,purgeWorkspace};
