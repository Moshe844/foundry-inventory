'use strict';
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const wallet=require('./wallet');
const release=require('./release');
const stripe=require('./stripe-billing');
const entitlements=require('../entitlements/postgres-service');
async function packs(database){return (await database.query("SELECT * FROM commercial_usage_packs WHERE status<>'RETIRED' ORDER BY category,units")).rows;}
async function topups(database,scope){await wallet.assertScope(database,scope);return (await database.query(
 'SELECT * FROM commercial_auto_topups WHERE account_id=$1 AND workspace_id=$2',[scope.accountId,scope.workspaceId])).rows;}
async function packFor(database,id,options){const pack=(await database.query('SELECT * FROM commercial_usage_packs WHERE id=$1',[id])).rows[0];
 if(!pack||pack.status!=='APPROVED'&&!(options.testMode&&process.env.NODE_ENV==='test'))throw new ValidationError('This usage pack is provisional and cannot be purchased.');
 if(!pack.stripe_price_id)throw new ValidationError('The usage pack has no configured Stripe price.');return pack;}
async function beginPurchase(database,scope,input,options={}){
 await release.assertCheckoutOpen(database,options);await wallet.assertScope(database,scope);
 if(!scope.workspaceId)throw new ValidationError('Choose the inventory receiving this usage pack.');
 const subscription=await entitlements.subscriptionFor(database,scope.accountId);
 if(!subscription?.stripe_customer_id||!entitlements.operationalAccess(subscription).canOperate)throw new ValidationError('An operational subscription is required to purchase additional usage.');
 const pack=await packFor(database,input.packId,options);
 if(!input.idempotencyKey)throw new ValidationError('A purchase requires its stable request key.');
 const purchase=await database.transaction(async(client)=>{
  await wallet.lock(client,scope,pack.category);
  const prior=(await client.query('SELECT * FROM commercial_usage_purchases WHERE account_id=$1 AND idempotency_key=$2',
   [scope.accountId,input.idempotencyKey])).rows[0];
  if(prior){if(prior.pack_id!==pack.id||prior.workspace_id!==scope.workspaceId)throw new ValidationError('That purchase key was already used for another pack.');return prior;}
  return (await client.query(`INSERT INTO commercial_usage_purchases(id,account_id,workspace_id,pack_id,category,units,amount_minor,currency,kind,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'MANUAL',$9) RETURNING *`,[newId('purchase'),scope.accountId,scope.workspaceId,pack.id,pack.category,
   pack.units,pack.amount_minor,pack.currency,input.idempotencyKey])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(['PAID','REFUNDED','REVIEW','EXPIRED'].includes(purchase.status))return {purchase,url:`${input.origin}/billing`};
 const session=await (options.provider||stripe).createAddonCheckout({purchaseId:purchase.id,accountId:scope.accountId,
  workspaceId:scope.workspaceId,customerId:subscription.stripe_customer_id,priceId:pack.stripe_price_id,
  successUrl:`${input.origin}/billing?purchase=pending`,cancelUrl:`${input.origin}/billing?purchase=cancelled`},options.providerOptions||{});
 await database.query("UPDATE commercial_usage_purchases SET stripe_session_id=$2,status=CASE WHEN status='CREATED' THEN 'OPEN' ELSE status END WHERE id=$1",[purchase.id,session.id]);
 return {purchase,url:session.url};
}
async function saveTopup(database,scope,input,options={}){
 await wallet.assertScope(database,scope);if(!wallet.CATEGORIES.has(input.category)||!scope.workspaceId)throw new ValidationError('Choose an inventory and usage category.');
 const enabled=input.enabled===true;let pack=null;let paymentMethodId=null;
 const cap=Number(input.monthlyCapMinor||0);if(!Number.isSafeInteger(cap)||cap<0)throw new ValidationError('Enter a valid monthly spending cap.');
 if(enabled){await release.assertCheckoutOpen(database,options);pack=await packFor(database,input.packId,options);
  if(pack.category!==input.category||cap<Number(pack.amount_minor)||input.explicitConsent!==true)throw new ValidationError('Explicit consent and a cap covering at least one selected pack are required.');
  const subscription=await entitlements.subscriptionFor(database,scope.accountId);const provider=options.provider||stripe;
  if(!subscription?.stripe_subscription_id||!entitlements.operationalAccess(subscription).canOperate)
    throw new ValidationError('An operational Stripe subscription is required for auto-top-up.');
  const remote=await provider.retrieveSubscription(subscription?.stripe_subscription_id,options.providerOptions||{});
  paymentMethodId=typeof remote.default_payment_method==='string'?remote.default_payment_method:remote.default_payment_method?.id;
  if(!paymentMethodId)throw new ValidationError('Save a payment method in the billing portal before enabling auto-top-up.');
  const method=await provider.retrievePaymentMethod(paymentMethodId,options.providerOptions||{});
  if((typeof method.customer==='string'?method.customer:method.customer?.id)!==subscription.stripe_customer_id)throw new ValidationError('The saved payment method belongs to another billing account.');
 }
 return database.transaction(async(client)=>{await wallet.lock(client,scope,input.category);
  return (await client.query(`INSERT INTO commercial_auto_topups(account_id,workspace_id,category,enabled,pack_id,monthly_cap_minor,payment_method_id,consented_at,consent_version)
  VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $4 THEN now() END,CASE WHEN $4 THEN '2026-10-v1' END)
  ON CONFLICT(account_id,workspace_id,category) DO UPDATE SET enabled=EXCLUDED.enabled,pack_id=EXCLUDED.pack_id,
  monthly_cap_minor=EXCLUDED.monthly_cap_minor,payment_method_id=EXCLUDED.payment_method_id,
  consented_at=EXCLUDED.consented_at,consent_version=EXCLUDED.consent_version,updated_at=now() RETURNING *`,
  [scope.accountId,scope.workspaceId,input.category,enabled,pack?.id||null,cap,paymentMethodId])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function runTopup(database,scope,category,options={}){
 await release.assertCheckoutOpen(database,options);await wallet.assertScope(database,scope);
 const created=await database.transaction(async(client)=>{await wallet.lock(client,scope,category);
  const settings=(await client.query('SELECT * FROM commercial_auto_topups WHERE account_id=$1 AND workspace_id=$2 AND category=$3 FOR UPDATE',
   [scope.accountId,scope.workspaceId,category])).rows[0];if(!settings?.enabled)return null;
  const state=await entitlements.meterState(client,scope,category);if(state.included<=0||state.remaining>=state.included*.1)return null;
  const pack=await packFor(client,settings.pack_id,options);
  const spending=(await client.query(`SELECT COALESCE(SUM(amount_minor),0) AS spent,
  COUNT(*) FILTER(WHERE status IN ('CREATED','OPEN','REVIEW','FAILED')) AS pending FROM commercial_usage_purchases
   WHERE account_id=$1 AND workspace_id=$2 AND category=$3 AND kind='AUTO' AND created_at>=date_trunc('month',now())`,
   [scope.accountId,scope.workspaceId,category])).rows[0];
  if(Number(spending.pending)>0||Number(spending.spent)+Number(pack.amount_minor)>Number(settings.monthly_cap_minor))return null;
  const sub=await entitlements.subscriptionFor(client,scope.accountId);if(!entitlements.operationalAccess(sub).canOperate)return null;
  const id=newId('topup');const purchase=(await client.query(`INSERT INTO commercial_usage_purchases
   (id,account_id,workspace_id,pack_id,category,units,amount_minor,currency,kind,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'AUTO',$1) RETURNING *`,[id,scope.accountId,scope.workspaceId,pack.id,category,
   pack.units,pack.amount_minor,pack.currency])).rows[0];return {purchase,settings,sub};
 },{isolation:'SERIALIZABLE',retrySafe:true});
 if(!created)return {triggered:false};
 try{const intent=await (options.provider||stripe).createTopupPayment({purchaseId:created.purchase.id,accountId:scope.accountId,
   customerId:created.sub.stripe_customer_id,paymentMethodId:created.settings.payment_method_id,
   amountMinor:Number(created.purchase.amount_minor),currency:created.purchase.currency},options.providerOptions||{});
  await database.query("UPDATE commercial_usage_purchases SET stripe_payment_intent_id=$2,status=CASE WHEN status='CREATED' THEN 'OPEN' ELSE status END WHERE id=$1",
   [created.purchase.id,intent.id]);return {triggered:true,purchaseId:created.purchase.id};
 }catch(error){await database.query("UPDATE commercial_usage_purchases SET status='REVIEW',error_message=$2 WHERE id=$1 AND status<>'PAID'",
 [created.purchase.id,String(error.message).slice(0,500)]);return {triggered:true,requiresAttention:true};}
}
async function receivePayment(client,event){
 const object=event.data.object;const id=object.metadata?.stockchief_purchase_id;
 if(!id)return false;
 const purchase=(await client.query('SELECT * FROM commercial_usage_purchases WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!purchase)throw new ValidationError('Stripe referenced an unknown usage purchase.');
 const scope={accountId:purchase.account_id,workspaceId:purchase.workspace_id};await wallet.lock(client,scope,purchase.category);
 const subscription=await entitlements.subscriptionFor(client,purchase.account_id);
 const customer=typeof object.customer==='string'?object.customer:object.customer?.id;
 if(customer!==subscription?.stripe_customer_id||object.metadata.stockchief_account_id!==purchase.account_id)
  throw new ValidationError('The usage payment belongs to another billing account.');
 const session=event.type.startsWith('checkout.');const paid=session?object.payment_status==='paid':object.status==='succeeded';
 const intent=session?(typeof object.payment_intent==='string'?object.payment_intent:object.payment_intent?.id):object.id;
 if(!paid){if(event.type==='payment_intent.payment_failed'||event.type==='checkout.session.async_payment_failed'){
  await client.query("UPDATE commercial_usage_purchases SET status='FAILED' WHERE id=$1 AND status NOT IN ('PAID','REFUNDED')",[id]);
  if(purchase.kind==='AUTO')await client.query('UPDATE commercial_auto_topups SET enabled=false WHERE account_id=$1 AND workspace_id=$2 AND category=$3',
    [purchase.account_id,purchase.workspace_id,purchase.category]);}return true;}
 if(Number(session?object.amount_subtotal:object.amount_received)!==Number(purchase.amount_minor)||String(object.currency).toUpperCase()!==purchase.currency||!intent)
  throw new ValidationError('Stripe payment amount or currency differs from the purchase.');
 if(purchase.stripe_session_id&&session&&purchase.stripe_session_id!==object.id||purchase.stripe_payment_intent_id&&purchase.stripe_payment_intent_id!==intent)
  throw new ValidationError('The usage payment identity differs from the purchase.');
 await client.query(`INSERT INTO commercial_usage_grants(id,account_id,workspace_id,category,purchase_id,units,expires_at)
  VALUES($1,$2,$3,$4,$5,$6,now()+interval '12 months') ON CONFLICT(purchase_id) DO NOTHING`,
 [newId('grant'),purchase.account_id,purchase.workspace_id,purchase.category,id,purchase.units]);
 await client.query("UPDATE commercial_usage_purchases SET status=CASE WHEN status='REFUNDED' THEN status ELSE 'PAID' END,paid_at=COALESCE(paid_at,now()),stripe_payment_intent_id=$2,stripe_session_id=COALESCE(stripe_session_id,$3) WHERE id=$1",
 [id,intent,session?object.id:null]);
 await client.query(`INSERT INTO commercial_revenue_events(id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail)
 VALUES($1,$2,$3,'ADDON',$4,$5,to_timestamp($6),$7::jsonb) ON CONFLICT(source_id) DO NOTHING`,
 [newId('revenue'),purchase.account_id,`addon:${intent}`,purchase.amount_minor,purchase.currency,event.created||Math.floor(Date.now()/1000),JSON.stringify({purchaseId:id,paymentIntentId:intent,actual:true})]);
 await client.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
  VALUES($1,$2,$3,'MISSING_STRIPE_FEE',$4::jsonb) ON CONFLICT(fingerprint) DO NOTHING`,
  [newId('critical'),purchase.account_id,`stripe-payment-fee:${intent}`,JSON.stringify({paymentIntentId:intent,purchaseId:id,severity:'CRITICAL'})]);
 await require('./stripe-financials').reconcileForPayment(client,intent);
 return true;
}
async function receiveRefund(client,event){const refund=event.data.object;if(refund.status!=='succeeded')return false;
 const intent=typeof refund.payment_intent==='string'?refund.payment_intent:refund.payment_intent?.id;
 const purchase=(await client.query('SELECT * FROM commercial_usage_purchases WHERE stripe_payment_intent_id=$1 FOR UPDATE',[intent])).rows[0];
 if(!purchase)return false;await wallet.lock(client,{accountId:purchase.account_id},purchase.category);
 if(String(refund.currency).toUpperCase()!==purchase.currency)throw new ValidationError('Refund currency does not match the usage purchase.');
 const grant=(await client.query('SELECT * FROM commercial_usage_grants WHERE purchase_id=$1 FOR UPDATE',[purchase.id])).rows[0];
 if(!grant)return false; // Payment/grant reconciliation will reapply the verified refund later.
 const added=await client.query(`INSERT INTO commercial_revenue_events(id,account_id,source_id,kind,amount_minor,currency,occurred_at,detail)
 VALUES($1,$2,$3,'REFUND',$4,$5,to_timestamp($6),$7::jsonb) ON CONFLICT(source_id) DO NOTHING RETURNING id`,
 [newId('revenue'),purchase.account_id,`refund:${refund.id}`,-Number(refund.amount),String(refund.currency).toUpperCase(),event.created,
 JSON.stringify({purchaseId:purchase.id})]);if(!added.rows.length)return true;
 const total=Number((await client.query("SELECT -SUM(amount_minor) AS amount FROM commercial_revenue_events WHERE account_id=$1 AND kind='REFUND' AND detail->>'purchaseId'=$2",
 [purchase.account_id,purchase.id])).rows[0].amount);
 const consumed=Number((await client.query(`SELECT COALESCE(SUM(a.units),0) AS units FROM commercial_usage_allocations a
 JOIN commercial_usage_events e ON e.id=a.event_id WHERE a.grant_id=$1 AND e.status IN ('RESERVED','COMMITTED')`,[grant.id])).rows[0].units);
 const requested=Math.min(Number(grant.units),Math.floor(Number(grant.units)*total/Number(purchase.amount_minor)));
 const revoke=Math.min(requested,Number(grant.units)-consumed);
 await client.query('UPDATE commercial_usage_grants SET revoked_units=$2 WHERE id=$1',[grant.id,revoke]);
 await client.query("UPDATE commercial_usage_purchases SET status=$2 WHERE id=$1",[purchase.id,total>=Number(purchase.amount_minor)?'REFUNDED':'PAID']);
 if(requested>revoke)await client.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
 VALUES($1,$2,$3,'REFUNDED_SPENT_USAGE',$4::jsonb) ON CONFLICT(fingerprint) DO UPDATE SET detail=EXCLUDED.detail,status='OPEN'`,
 [newId('critical'),purchase.account_id,`refund-spent:${purchase.id}`,JSON.stringify({requested,revoke,consumed})]);return true;
}
module.exports={packs,topups,beginPurchase,saveTopup,runTopup,receivePayment,receiveRefund};
