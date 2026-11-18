'use strict';

const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId}=require('../lib/util');
const provider=require('./shopify-billing');
const entitlements=require('./entitlements');
const DAYS=14*86400000;
const scoped=c=>({query:c.query.bind(c),transaction:fn=>fn(c)});
const ownerFor=row=>({appId:row.app_id,shopId:row.shop_id,shop:row.shop,appHandle:row.app_handle,developmentStore:row.development_store});
async function get(db,accountId){return (await db.query('SELECT * FROM commercial_shopify_subscriptions WHERE account_id=$1',[accountId])).rows[0]||null;}
async function assertNoStripe(db,accountId){
 const sub=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[accountId])).rows[0];
 if(sub?.stripe_subscription_id)throw new ValidationError('Your StockChief subscription is billed through Stripe. Keep using that subscription; a second Shopify subscription was not requested.');
 if((await db.query("SELECT 1 FROM commercial_checkout_attempts WHERE account_id=$1 AND status IN('CREATED','OPEN') LIMIT 1",[accountId])).rows.length)
   throw new ValidationError('A Stripe checkout is already in progress. Finish or close it before choosing Shopify billing.');
 return sub;
}
async function assertNoShopify(db,accountId){
 const row=await get(db,accountId);
 const sub=(await db.query('SELECT source FROM account_subscriptions WHERE account_id=$1',[accountId])).rows[0];
 // An expired browser reservation is not evidence that Shopify never charged.
 // Keep provider ownership until an explicit, reviewed migration clears it.
 if(sub?.source==='SHOPIFY'||row)throw new ValidationError('This subscription is managed through Shopify. Use Shopify to manage the plan; no second Stripe checkout was created.');
}
async function reserve(db,account,owner){
 if(!account?.email_verified_at)throw new AuthorizationError('Verify your StockChief email before choosing a Shopify plan.');
 if(owner.appId!==provider.configuration().appId)throw new ValidationError('This installation belongs to another Shopify app.');
 return db.transaction(async c=>{
  await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[account.id]);
  const current=await assertNoStripe(c,account.id);
  if(current?.source!=='SHOPIFY'&&entitlements.operationalAccess(current).canOperate)throw new ValidationError('Your existing StockChief plan already provides access. Connect the store using your current plan.');
  if((await c.query("SELECT 1 FROM workspace_connectors c JOIN workspaces w ON w.id=c.workspace_id WHERE c.provider_type='shopify' AND c.provider_account_id=$1 AND c.status='connected' AND w.owner_account_id<>$2 LIMIT 1",[owner.shop,account.id])).rows.length)throw new AuthorizationError('This store is already connected to another owner.');
  const prior=await get(c,account.id);
  if(prior&&(prior.shop_id!==owner.shopId||prior.app_id!==owner.appId))throw new ValidationError('This account already uses another Shopify store for billing.');
  const other=(await c.query('SELECT account_id FROM commercial_shopify_subscriptions WHERE app_id=$1 AND shop_id=$2 FOR UPDATE',[owner.appId,owner.shopId])).rows[0];
  if(other&&other.account_id!==account.id)throw new AuthorizationError('This Shopify subscription belongs to another StockChief account.');
  return (await c.query(`INSERT INTO commercial_shopify_subscriptions(account_id,app_id,shop_id,shop,app_handle,development_store,reserved_until)
   VALUES($1,$2,$3,$4,$5,$6,now()+interval '1 hour') ON CONFLICT(account_id) DO UPDATE SET reserved_until=now()+interval '1 hour',updated_at=now() RETURNING *`,[account.id,owner.appId,owner.shopId,owner.shop,owner.appHandle,owner.developmentStore])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
function verifiedHistory(events,owner){
 if(new Set(events.map(e=>e.id)).size!==events.length)throw new ValidationError('Shopify billing history contains duplicate event identities.');
 for(const event of events)if(event.shop?.id!==owner.shopId||event.shop?.myshopifyDomain!==owner.shop||event.subject?.id!==owner.appId)throw new ValidationError('Shopify history belongs to another subscription.');
 const created=events.filter(e=>e.eventType==='SUBSCRIPTION_CREATED').map(e=>Date.parse(e.occurredAt)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
 return {firstSubscriptionAt:created?new Date(created).toISOString():null,charges:events.filter(e=>e.eventType==='CHARGE_RECURRING'&&e.chargeId&&e.amount?.currencyCode==='USD').map(e=>({id:e.chargeId,occurredAt:e.occurredAt,amountMinor:provider.money(e.amount.amount),planId:e.planHandle}))};
}
function reusableDevelopmentCancellation(binding,request){
 return binding?.development_store===true&&request?.status==='NO_CHARGE'
  &&Array.isArray(request.charges)&&request.charges.every(charge=>charge.amountMinor===0)
  &&Array.isArray(request.provider_evidence)&&request.provider_evidence.length===0;
}
async function retireDevelopmentCancellation(c,accountId,binding,request,contract,history){
 if(!reusableDevelopmentCancellation(binding,request)||!contract.developmentStore||contract.amountMinor!==0
  ||history.charges.some(charge=>charge.amountMinor!==0))throw new ValidationError('Your Shopify cancellation and refund request is being handled. Contact support before subscribing again.');
 // Trial normalization can synthesize periodStart=now. Require Shopify's actual
 // new billing cycle, so rereading a cancelled trial cannot reactivate access.
 const start=Date.parse(contract.providerState.currentBillingCycle?.startTime),requested=new Date(request.requested_at).getTime();
 if(contract.status!=='ACTIVE'||!Number.isFinite(start)||!Number.isFinite(requested)||start<=requested||start!==Date.parse(contract.periodStart))
  throw Object.assign(new ValidationError('Choose a new development-store test plan in Shopify before StockChief can reactivate access.'),{code:'shopify_development_plan_pending'});
 const audit='\n\nRetired no-charge development cancellation after a verified new $0 Shopify cycle: '+JSON.stringify({
  requestId:request.id,status:request.status,requestedAt:request.requested_at,subscriptionStartedAt:request.subscription_started_at,
  charges:request.charges,providerEvidence:request.provider_evidence,lastError:request.last_error,updatedAt:request.updated_at,
  newPlanId:contract.planId,newPeriodStart:contract.periodStart});
 const saved=await c.query("UPDATE support_requests SET body=body||$3,updated_at=now() WHERE account_id=$1 AND request_key=$2 AND status='RESOLVED' RETURNING id",[accountId,'shopify-guarantee:'+request.id,audit]);
 if(saved.rows.length!==1)throw new ValidationError('Your completed Shopify test cancellation needs its resolved support record before you can subscribe again.');
 await c.query('DELETE FROM commercial_shopify_guarantees WHERE account_id=$1 AND id=$2',[accountId,request.id]);
}
async function apply(db,accountId,owner,remote,events,options={}){
 const contract=remote===null?null:provider.contract(remote.providerState||remote,owner,options);
 const history=verifiedHistory(events,owner);
 return db.transaction(async c=>{
  await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);
  const account=(await c.query('SELECT * FROM accounts WHERE id=$1',[accountId])).rows[0];
  if(!account?.email_verified_at)throw new AuthorizationError('Verify your StockChief email before activation.');
  await assertNoStripe(c,accountId);
  const row=await get(c,accountId);if(!row||row.shop_id!==owner.shopId||row.app_id!==owner.appId||row.shop!==owner.shop)throw new AuthorizationError('This Shopify subscription is not assigned to this account.');
  const current=(await c.query('SELECT * FROM account_subscriptions WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
  if(current&&current.source!=='SHOPIFY'&&entitlements.operationalAccess(current).canOperate)throw new ValidationError('The existing StockChief subscription has been kept.');
  if(!contract){
   if(current?.source==='SHOPIFY')await c.query("UPDATE account_subscriptions SET status='CANCELLED',current_period_end=LEAST(COALESCE(current_period_end,now()),now()),cancel_at_period_end=0,cancelled_at=COALESCE(cancelled_at,now()),updated_at=now() WHERE account_id=$1 AND source='SHOPIFY'",[accountId]);
   await c.query("UPDATE commercial_shopify_subscriptions SET status=CASE WHEN status='PENDING' THEN status ELSE 'CANCELLED' END,verified_at=now(),provider_state='null',updated_at=now() WHERE account_id=$1",[accountId]);return {active:false};
  }
  const plan=await require('./service').getSelfServicePlan(scoped(c),contract.planId);
  const acceptedVersion=(current?.plan_id===plan.id?current.plan_version_id:null)||plan.active_plan_version_id;
  if(!acceptedVersion)throw new ValidationError('The accepted StockChief plan version could not be verified.');
  if(Object.keys(await require('./control-service').resourceExcess(scoped(c),{accountId,workspaceId:null},plan.id,{planVersionId:acceptedVersion})).length)throw new ValidationError('Your existing inventory exceeds this Shopify plan. Choose a plan that covers your saved resources.');
  if(current?.refunded_at)throw new ValidationError('This refunded account is read-only during its retention period. Contact support before subscribing again.');
  const request=(await c.query('SELECT * FROM commercial_shopify_guarantees WHERE account_id=$1 FOR UPDATE',[accountId])).rows[0];
  if(request)await retireDevelopmentCancellation(c,accountId,row,request,contract,history);
  await c.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,current_period_start,current_period_end,trial_ends_at,cancel_at_period_end,source,provider_state)
   VALUES($1,$2,$3,$4,$5,'MONTHLY',$6,$7,$8,$9,'SHOPIFY',$10::jsonb)
   ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id,status=EXCLUDED.status,billing_interval='MONTHLY',current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,trial_ends_at=EXCLUDED.trial_ends_at,cancel_at_period_end=EXCLUDED.cancel_at_period_end,source='SHOPIFY',provider_state=EXCLUDED.provider_state,updated_at=now()`,
   [current?.id||newId('sub'),accountId,plan.id,acceptedVersion,contract.status,contract.periodStart,contract.periodEnd,contract.trialEndsAt,contract.cancelAtPeriodEnd?1:0,JSON.stringify({...owner,contract:contract.providerState})]);
  await c.query("UPDATE commercial_shopify_subscriptions SET status='ACTIVE',plan_id=$2,verified_at=now(),first_subscription_at=COALESCE(first_subscription_at,$3),provider_state=$4::jsonb,updated_at=now() WHERE account_id=$1",[accountId,plan.id,history.firstSubscriptionAt,JSON.stringify({contract:contract.providerState,history:events})]);
  const provisioned=account.plan==='commercial_pending'||current?.source!=='SHOPIFY'?await require('./context').run({database:scoped(c),scope:{accountId,workspaceId:null}},()=>require('../domain/postgres-auth-service').provisionFirstWorkspace(scoped(c),accountId)):{workspaceId:account.last_workspace_id,created:false};
  return {active:true,planId:plan.id,...provisioned};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function reconcile(db,accountId,options={}){
 const row=await get(db,accountId);if(!row)return {skipped:'not_shopify'};
 const owner={appId:row.app_id,shopId:row.shop_id,shop:row.shop,appHandle:row.app_handle,developmentStore:row.development_store};
 const p=options.provider||provider,remote=await p.active(owner),events=row.first_subscription_at&&Array.isArray(row.provider_state?.history)?row.provider_state.history:await p.history(owner);
 return apply(db,accountId,owner,remote,events,options);
}
async function startInstallation(db,account,installation){
 if(!account?.email_verified_at)throw new AuthorizationError('Verify your StockChief email before choosing a Shopify plan.');
 await assertNoStripe(db,account.id);
 const existing=await get(db,account.id);
 const request=(await db.query('SELECT * FROM commercial_shopify_guarantees WHERE account_id=$1',[account.id])).rows[0];
 if(request&&!reusableDevelopmentCancellation(existing,request))throw new ValidationError('Your Shopify refund request is being handled. Contact support before choosing another plan.');
 if(existing){if(existing.shop!==installation.shop||existing.app_id!==provider.configuration().appId||provider.configuration().clientId!==installation.client_id)throw new AuthorizationError('This installation belongs to another billing store.');return provider.selectionUrl(ownerFor(existing));}
 if(installation.status!=='AUTHORIZED'||!installation.ciphertext)throw new ValidationError('Complete a fresh Shopify authorization before choosing billing.');
 const result=require('../connections/credentials').decrypt(installation);
 const owner=await provider.readIdentity(result.credentials,installation.shop);
 await reserve(db,account,owner);return provider.selectionUrl(owner);
}
async function installationState(db,account,installation){
 if(!account?.email_verified_at||!installation)return null;
 const binding=await get(db,account.id);
 if(binding){
  if(binding.shop!==installation.shop)throw new AuthorizationError('Choose the Shopify store that manages this account’s billing.');
  try{await reconcile(db,account.id);}catch(error){if(error.code!=='shopify_development_plan_pending')throw error;}
 }
 const sub=await entitlements.subscriptionFor(db,account.id);
 const guarantee=binding?await quote(db,account.id):null;
 return {source:sub?.source||null,canOperate:entitlements.operationalAccess(sub).canOperate,canChoosePlan:provider.configured()&&!sub?.stripe_subscription_id&&(!guarantee?.request||guarantee.canChoosePlan)&&(!entitlements.operationalAccess(sub).canOperate||sub?.source==='SHOPIFY'),bound:Boolean(binding)};
}
async function enqueueDue(db,{now=Date.now()}={}){
 const rows=(await db.query("SELECT account_id FROM commercial_shopify_subscriptions WHERE status='ACTIVE' AND (verified_at IS NULL OR verified_at<now()-interval '5 minutes') ORDER BY verified_at NULLS FIRST LIMIT 30")).rows;
 for(const row of rows)await require('../operations/postgres-job-queue').enqueue(scoped(db),{kind:'commercial.shopify-reconcile',idempotencyKey:'shopify-billing:'+row.account_id+':'+Math.floor(now/300000),payload:{accountId:row.account_id},maxAttempts:8});
 const refunds=(await db.query("SELECT id,account_id FROM commercial_shopify_guarantees WHERE status IN('AWAITING_SHOPIFY','PARTIAL','REVIEW') AND updated_at<now()-interval '15 minutes' ORDER BY updated_at LIMIT 20")).rows;
 for(const row of refunds)await require('../operations/postgres-job-queue').enqueue(scoped(db),{kind:'commercial.shopify-guarantee',idempotencyKey:'shopify-guarantee:'+row.id+':'+Math.floor(now/900000),payload:{accountId:row.account_id,requestId:row.id},maxAttempts:8});
 return {subscriptions:rows.length,refunds:refunds.length};
}
async function quote(db,accountId,{now=Date.now()}={}){
 const row=await get(db,accountId);if(!row)return null;
 const request=(await db.query('SELECT * FROM commercial_shopify_guarantees WHERE account_id=$1',[accountId])).rows[0]||null;
 const start=row.first_subscription_at?new Date(row.first_subscription_at).getTime():NaN,deadline=Number.isFinite(start)?new Date(start+DAYS):null;
 return {provider:'shopify',request,deadline,eligible:row.status==='ACTIVE'&&Boolean(deadline)&&now>=start&&now<=deadline.getTime(),canChoosePlan:!request||reusableDevelopmentCancellation(row,request),developmentStore:row.development_store,subscription:row};
}
const refundInstructions=(id,shop,charges)=>'Eligible refund request '+id+' for '+shop+'. Cancel renewal and issue refunds for paid app charges or credits removing unpaid charges in Shopify Partner Dashboard. Confirm provider evidence before resolving. Charges: '+JSON.stringify(charges);
async function requestRefund(db,accountId){const receivedAt=Date.now();return db.transaction(async c=>{
 await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);await assertNoStripe(c,accountId);
 const state=await quote(c,accountId,{now:receivedAt});if(state?.request)return state.request;
 if(!state?.eligible)throw new ValidationError('The verified 14-day Shopify refund window is not available. Support can check a payment still being confirmed.');
 const owner=state.subscription,history=verifiedHistory(owner.provider_state?.history||[],{appId:owner.app_id,shopId:owner.shop_id,shop:owner.shop});
 const row=(await c.query(`INSERT INTO commercial_shopify_guarantees(id,account_id,subscription_started_at,charges,requested_at) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *`,[newId('shopifyrefund'),accountId,owner.first_subscription_at,JSON.stringify(history.charges),new Date(receivedAt).toISOString()])).rows[0];
 const account=(await c.query('SELECT email FROM accounts WHERE id=$1',[accountId])).rows[0];
 await c.query(`INSERT INTO support_requests(id,account_id,request_key,contact_email,subject,body,source_path,requester_hash)
  VALUES($1,$2,$3,$4,'Shopify 14-day subscription refund',$5,'/billing/refund',$6) ON CONFLICT(request_key) DO NOTHING`,[newId('support'),accountId,'shopify-guarantee:'+row.id,account.email,
  refundInstructions(row.id,owner.shop,history.charges),require('node:crypto').createHash('sha256').update('shopify-guarantee:'+accountId).digest('hex')]);
 await require('../operations/postgres-job-queue').enqueue(scoped(c),{kind:'commercial.shopify-guarantee',idempotencyKey:row.id,payload:{accountId,requestId:row.id},maxAttempts:12});return row;
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function cancellation(db,accountId,{defer=true,provider:p=provider}={}){
 const row=await get(db,accountId);if(!row)throw new ValidationError('No Shopify subscription was found.');await assertNoStripe(db,accountId);
 const owner={appId:row.app_id,shopId:row.shop_id,shop:row.shop,appHandle:row.app_handle,developmentStore:row.development_store};
 const current=await p.active(owner);if(!current){await reconcile(db,accountId,{provider:p});return {alreadyCancelled:true};}
 const result=await p.cancel(owner,{defer});
 await db.transaction(async c=>{await c.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[accountId]);await assertNoStripe(c,accountId);
  await c.query("UPDATE account_subscriptions SET cancel_at_period_end=$2::bigint,status=CASE WHEN $2::bigint=0 THEN 'CANCELLED' ELSE status END,current_period_end=CASE WHEN $2::bigint=0 THEN now() ELSE current_period_end END,cancelled_at=CASE WHEN $2::bigint=0 THEN now() ELSE cancelled_at END,updated_at=now() WHERE account_id=$1 AND source='SHOPIFY'",[accountId,defer?1:0]);
  if(!defer)await c.query("UPDATE commercial_shopify_subscriptions SET status='CANCELLED',updated_at=now() WHERE account_id=$1",[accountId]);
 },{isolation:'SERIALIZABLE',retrySafe:true});return result;
}
async function processGuarantee(db,job,options={}){
 const row=(await db.query('SELECT * FROM commercial_shopify_guarantees WHERE id=$1 AND account_id=$2',[job.payload.requestId,job.payload.accountId])).rows[0];
 if(!row||['REFUNDED','NO_CHARGE'].includes(row.status))return {replayed:true};
 if(new Date(row.requested_at)-new Date(row.subscription_started_at)>DAYS)throw new ValidationError('The saved Shopify refund request is outside the 14-day window.');
 await cancellation(db,row.account_id,{defer:false,provider:options.provider||provider});
 const binding=await get(db,row.account_id),owner={appId:binding.app_id,shopId:binding.shop_id,shop:binding.shop,developmentStore:binding.development_store};
 const events=await (options.provider||provider).history(owner),history=verifiedHistory(events,owner);
 // Keep the request durable even when Shopify is unavailable at submission.
 // Refresh charge identities here so later upgrade charges are included too.
 const charges=[...new Map([...row.charges,...history.charges].map(c=>[c.id,c])).values()];
 await db.query('UPDATE commercial_shopify_guarantees SET charges=$2::jsonb WHERE id=$1',[row.id,JSON.stringify(charges)]);
 await db.query('UPDATE support_requests SET body=$2 WHERE request_key=$1',['shopify-guarantee:'+row.id,refundInstructions(row.id,owner.shop,charges)]);
 const charged=charges.filter(c=>c.amountMinor>0),refunds=events.filter(e=>e.eventType==='EARNING_REFUND'&&charged.some(c=>c.id===e.earningChargeId)&&e.grossAmount?.currencyCode==='USD');
 const refunded=charged.length>0&&charged.every(c=>refunds.filter(r=>r.earningChargeId===c.id).reduce((sum,r)=>sum+provider.money(String(r.grossAmount.amount).replace(/^-/,'')),0)>=c.amountMinor);
 const status=refunded?'REFUNDED':binding.development_store&&!charged.length?'NO_CHARGE':refunds.length?'PARTIAL':'AWAITING_SHOPIFY';
 await db.query('UPDATE commercial_shopify_guarantees SET status=$2,provider_evidence=$3::jsonb,updated_at=now() WHERE id=$1',[row.id,status,JSON.stringify(refunds)]);
 if(['REFUNDED','NO_CHARGE'].includes(status))await db.query("UPDATE support_requests SET status='RESOLVED' WHERE request_key=$1",['shopify-guarantee:'+row.id]);
 return {status,refundConfirmed:refunded};
}
module.exports={get,assertNoStripe,assertNoShopify,reserve,apply,reconcile,quote,requestRefund,cancellation,processGuarantee,verifiedHistory,startInstallation,installationState,enqueueDue,ownerFor};

