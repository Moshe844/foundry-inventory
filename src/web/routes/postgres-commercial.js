'use strict';

const express=require('express');
const config=require('../../config');
const commercial=require('../../commercial/service');
const billingProvider=require('../../commercial/stripe-billing');
const entitlements=require('../../entitlements/postgres-service');
const commercialControl=require('../../commercial/control-service');
const commercialCatalog=require('../../commercial/catalog');
const auth=require('../../domain/postgres-auth-service');
const lifecycle=require('../../domain/postgres-account-lifecycle');
const {newId}=require('../../lib/util');
const {requireAccount,asyncRoute}=require('../middleware');
const {commercialScope}=require('../commercial-middleware');
const {AuthorizationError,ValidationError}=require('../../domain/errors');

function renderPublic(req,res,view,data={}){return res.render(view,{...data,csrfToken:res.locals.csrfToken,flash:res.locals.flash,
  account:res.locals.account,origin:res.locals.origin,assetVersion:res.locals.assetVersion},(error,body)=>{
    if(error)throw error;return res.render('public/layout',{...data,body,account:res.locals.account,origin:res.locals.origin,
      assetVersion:res.locals.assetVersion,title:data.title||'StockChief',description:data.description||
      'StockChief runs inventory operations and brings owners only the exceptions that require judgement.'});});}

function commercialAdmin(req,res,next){const configured=config.commercial.adminEmails.includes(String(req.account?.email||'').toLowerCase());
  if(configured)return next();return req.db.query('SELECT 1 FROM commercial_admin_accounts WHERE account_id=$1',[req.account?.id])
    .then((result)=>result.rows.length?next():next(new AuthorizationError(
      'This commercial control is restricted to StockChief administrators.'))).catch(next);}
function requireBillingOwner(req,res,next){if(req.user&&req.user.role!=='owner')return next(new AuthorizationError(
  'Only a workspace owner can manage its StockChief subscription.'));return next();}
function requireVerifiedEmail(req,res,next){if(!req.account?.email_verified_at)return next(new AuthorizationError(
  'Verify your email before starting subscription billing.'));return next();}
function safeReturnPath(value){return typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')?value:'/';}
function saveSession(req){return new Promise((resolve,reject)=>req.session.save((error)=>error?reject(error):resolve()));}
function capabilityName(capability){return ({
  'connection.email':'connected supplier and customer email',
  'connection.commerce':'commerce connections',
  'connection.accounting':'accounting connections',
  'email.auto_extract':'automatic business-email and document processing',
  'email.response_generation':'prepared supplier and customer replies',
  'shipping.automation':'shipping automation within your rules',
  'accounting.explanations':'evidence-backed accounting explanations',
  'forecasting.basic':'demand and stockout forecasting',
  'authority.advanced':'advanced authority and automatic-work policies',
})[capability]||capability.replaceAll('.',' ').replaceAll('_',' ');}

function createPostgresCommercialRouter(database,options={}){const router=express.Router();const provider=options.billingProvider||billingProvider;
  router.get('/',asyncRoute(async(req,res,next)=>{if(req.account)return next();await commercial.track(database,{eventName:'landing_viewed',
    anonymousId:req.sessionID,sourcePath:'/'});return renderPublic(req,res,'public/home',{title:'The AI inventory operator',nav:'home',
      description:'StockChief notices, decides and carries out routine inventory operations—then brings owners the exceptions that need judgement.'});}));
  router.get('/demo',asyncRoute(async(req,res)=>{await commercial.track(database,{eventName:'demo_opened',anonymousId:req.sessionID,
    accountId:req.account?.id||null,sourcePath:'/demo'});return renderPublic(req,res,'public/demo',{title:'See StockChief in action',nav:'demo',
      description:'Follow a realistic business day from sale and shortage through supplier, receiving, fulfillment, payment and accounting.'});}));
  router.get('/how-stockchief-works',asyncRoute(async(req,res)=>renderPublic(req,res,'public/how-it-works',{
    title:'How StockChief works',nav:'how',description:'See how StockChief turns business signals into governed, verified operational work.'})));
  router.get('/capabilities',asyncRoute(async(req,res)=>renderPublic(req,res,'public/capabilities',{
    title:'Capabilities',nav:'capabilities',description:'Explore the inventory, purchasing, order, communication, shipping, payment and accounting work StockChief handles today.'})));
  router.get('/integrations',asyncRoute(async(req,res)=>renderPublic(req,res,'public/integrations',{
    title:'Integrations',nav:'integrations',description:'See how StockChief connects commerce, email, shipping, payments, accounting and custom systems—and the qualification status of each.'})));
  router.get('/switching',asyncRoute(async(req,res)=>renderPublic(req,res,'public/switching',{
    title:'Switching to StockChief',nav:'switching',description:'Bring inventory records into StockChief through preview, clarification, reconciliation and controlled approval.'})));
  router.get('/pricing',asyncRoute(async(req,res)=>{const plans=await commercial.listPlans(database);await commercial.track(database,{eventName:'pricing_viewed',
    anonymousId:req.sessionID,accountId:req.account?.id||null,sourcePath:'/pricing'});return renderPublic(req,res,'public/pricing',{
    title:'Pricing',nav:'pricing',plans,checkoutCancelled:req.query.checkout==='cancelled'});}));
  router.get(['/control','/trust'],asyncRoute(async(req,res)=>renderPublic(req,res,'public/trust',{title:'Control and trust',nav:'control',
    description:'Understand StockChief authority, approvals, evidence, tenant isolation, credentials and operational recovery.'})));
  router.get('/privacy',asyncRoute(async(req,res)=>renderPublic(req,res,'public/legal',{
    title:'Privacy',heading:'Privacy notice',kind:'privacy',supportEmail:config.supportEmail})));
  router.get('/terms',asyncRoute(async(req,res)=>renderPublic(req,res,'public/legal',{
    title:'Terms',heading:'Terms of service',kind:'terms',supportEmail:config.supportEmail})));
  router.get('/contact',asyncRoute(async(req,res)=>renderPublic(req,res,'public/contact',{title:'Talk to StockChief',nav:'contact',supportEmail:config.supportEmail})));
  router.post('/commercial/events',asyncRoute(async(req,res)=>{const allowed=new Set(['plan_selected','signup_started','upgrade_viewed']);
    if(!allowed.has(req.body.eventName))return res.status(204).end();await commercial.track(database,{eventName:req.body.eventName,
      anonymousId:req.sessionID,accountId:req.account?.id||null,planId:req.body.planId||null,sourcePath:req.body.sourcePath||null});
    return res.status(204).end();}));
  router.get('/billing',requireAccount,requireBillingOwner,asyncRoute(async(req,res)=>{const scope=commercialScope(req);
    const summary=await entitlements.summary(database,scope);const usageWarnings=await commercialControl.usageWarnings(database,scope,{summary});
    const pendingChanges=(await database.query(`SELECT change.*,plan.public_name AS target_plan_name
      FROM commercial_subscription_changes change JOIN commercial_plans plan ON plan.id=change.to_plan_id
      WHERE change.account_id=$1 AND change.status='PENDING' ORDER BY change.created_at DESC`,[scope.accountId])).rows;
    let invoices=[];if(summary.subscription?.stripe_customer_id&&options.loadInvoices!==false){try{
      invoices=(await provider.listInvoices(summary.subscription.stripe_customer_id,options.providerOptions||{})).data||[];}catch{invoices=[];}}
    return res.page('commercial/billing',{title:'Plan and billing',nav:'settings',room:true,summary,usageWarnings,invoices,
      pendingChanges,billingConfigured:config.commercial.configured,plans:await commercial.listPlans(database)});}));
  router.get('/upgrade',requireAccount,requireBillingOwner,asyncRoute(async(req,res)=>{const capability=String(req.query.capability||'').trim();
    const scope=commercialScope(req);const returnPath=safeReturnPath(req.query.return);const current=await entitlements.subscriptionFor(database,scope.accountId);
    const currentCapability=await entitlements.capabilityState(database,scope,capability,{subscription:current});
    if(currentCapability.enabled){req.flash('success','This capability is already active on your current plan.');await saveSession(req);
      return res.redirect(303,returnPath);}
    const plans=await commercial.listPlans(database);const currentPlan=plans.find((plan)=>plan.id===current?.plan_id);
    const candidates=plans.filter((plan)=>Number(plan.display_order)>Number(currentPlan?.display_order||0)
      &&plan.entitlements.some((entry)=>entry.capability===capability&&Number(entry.enabled)));
    await commercial.track(database,{eventName:'upgrade_viewed',accountId:req.account.id,planId:current?.plan_id||null,
      sourcePath:returnPath});return res.page('commercial/upgrade',{title:'Upgrade StockChief',nav:'settings',room:true,
      capability,capabilityLabel:capabilityName(capability),current,candidates,returnPath});}));
  router.post('/billing/checkout',requireAccount,requireBillingOwner,requireVerifiedEmail,asyncRoute(async(req,res)=>{
    const scope=commercialScope(req);const current=await entitlements.subscriptionFor(database,scope.accountId);
    const origin=options.publicOrigin==='request'?res.locals.origin:(options.publicOrigin||config.connections.publicOrigin||res.locals.origin);
    if(current?.stripe_customer_id&&current?.stripe_subscription_id)return res.redirect(303,
      `/billing/change?plan=${encodeURIComponent(req.body.planId||'')}&interval=${req.body.interval==='annual'?'annual':'monthly'}`);
    req.session.checkoutSelection={planId:req.body.planId,interval:req.body.interval==='annual'?'annual':'monthly'};await saveSession(req);
    const checkout=await commercial.beginCheckout(database,req.account,{planId:req.body.planId,interval:req.body.interval,
      promoCode:req.body.promoCode,origin,returnPath:req.body.returnPath||'/onboarding'},{provider,providerOptions:options.providerOptions});
    await commercial.track(database,{eventName:'billing_checkout_started',accountId:req.account.id,planId:req.body.planId,
      sourcePath:req.get('referer')||'/pricing'});return res.redirect(303,checkout.url);}));
  router.get('/billing/checkout/complete',requireAccount,asyncRoute(async(req,res)=>{const session=await provider.retrieveCheckout(req.query.session_id,
    options.providerOptions||{});if(session.metadata?.stockchief_account_id!==req.account.id)throw new AuthorizationError('That checkout belongs to another account.');
    let subscription=session.subscription;if(typeof subscription==='string')subscription=await provider.retrieveSubscription(subscription,options.providerOptions||{});
    if(session.status!=='complete'||!subscription)throw new ValidationError('Stripe has not completed this subscription checkout.');
    const saved=await database.transaction((client)=>commercial.upsertSubscription(client,subscription),{isolation:'SERIALIZABLE'});
    if(!saved||!entitlements.operationalAccess(saved).canOperate)throw new ValidationError('The subscription is not active yet. No workspace was created.');
    await commercial.completeCheckoutAttempt(database,session.id);
    const provisioned=await auth.provisionFirstWorkspace(database,req.account.id);req.session.workspaceId=provisioned.workspaceId;
    await commercial.trackOnce(database,{eventName:'subscription_activated',accountId:req.account.id,
      planId:session.metadata?.stockchief_plan_id||null,sourcePath:'/billing/checkout/complete'});
    await commercial.trackOnce(database,{eventName:'first_workspace_setup_completed',accountId:req.account.id,
      planId:saved.plan_id,sourcePath:'/billing/checkout/complete',detail:{workspaceId:provisioned.workspaceId}});
    req.flash('success','Your plan is active. Your first inventory is ready to set up.');return req.session.save(()=>res.redirect(303,'/onboarding'));}));
  router.get('/billing/change',requireAccount,requireBillingOwner,requireVerifiedEmail,asyncRoute(async(req,res)=>{
    const scope=commercialScope(req);const quote=await commercial.subscriptionChangeQuote(database,scope.accountId,{planId:req.query.plan,
      interval:req.query.interval},{provider,providerOptions:options.providerOptions});
    return res.page('commercial/change',{title:'Review plan change',nav:'settings',room:true,quote});}));
  router.post('/billing/change',requireAccount,requireBillingOwner,requireVerifiedEmail,asyncRoute(async(req,res)=>{
    const scope=commercialScope(req);const changed=await commercial.requestSubscriptionChange(database,scope.accountId,{planId:req.body.planId,
      interval:req.body.interval,requestedByAccountId:req.account.id},{provider,providerOptions:options.providerOptions});
    req.flash('success',changed.status==='APPLIED'?`${changed.quote.target.public_name} is active.`:
      `${changed.quote.target.public_name} is scheduled for ${new Date(changed.quote.effectiveAt).toLocaleDateString()}.`);
    return req.session.save(()=>res.redirect(303,'/billing'));}));
  router.post('/billing/cancel',requireAccount,requireBillingOwner,requireVerifiedEmail,asyncRoute(async(req,res)=>{
    await commercial.setSubscriptionCancellation(database,commercialScope(req).accountId,true,{provider,providerOptions:options.providerOptions});
    req.flash('success','Cancellation is scheduled for the end of the paid period. Your records remain available.');
    return req.session.save(()=>res.redirect(303,'/billing'));}));
  router.post('/billing/reactivate',requireAccount,requireBillingOwner,requireVerifiedEmail,asyncRoute(async(req,res)=>{
    await commercial.setSubscriptionCancellation(database,commercialScope(req).accountId,false,{provider,providerOptions:options.providerOptions});
    req.flash('success','Your subscription will renew normally.');return req.session.save(()=>res.redirect(303,'/billing'));}));
  router.post('/billing/portal',requireAccount,requireBillingOwner,asyncRoute(async(req,res)=>{const scope=commercialScope(req);
    const subscription=await entitlements.subscriptionFor(database,scope.accountId);
    if(!subscription?.stripe_customer_id)throw new ValidationError('A billing account has not been created yet.');
    const portal=await provider.createPortal({accountId:scope.accountId,requestId:newId('portal'),customerId:subscription.stripe_customer_id,
      returnUrl:`${options.publicOrigin==='request'?res.locals.origin:(options.publicOrigin||config.connections.publicOrigin||res.locals.origin)}/billing`},options.providerOptions||{});
    return res.redirect(303,portal.url);}));
  router.get('/commercial-admin',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>res.page('commercial/admin',{
    title:'Commercial control',nav:'settings',room:true,plans:await commercial.listPlans(database,{includeDrafts:true,includePrivate:true}),
    capabilities:commercialCatalog.CAPABILITIES.map((row)=>commercialCatalog.capability(row[0])),
    meters:commercialCatalog.METERS.map((row)=>commercialCatalog.meter(row[0])),
    costRates:(await database.query('SELECT * FROM commercial_cost_rates ORDER BY provider,operation,effective_from DESC')).rows,
    commercialAudit:(await database.query('SELECT * FROM commercial_change_audit ORDER BY created_at DESC LIMIT 50')).rows,
    economics:await commercialControl.portfolioEconomics(database)})));
  router.post('/commercial-admin/plans/:id',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{const monthly=Math.max(0,Math.round(Number(req.body.monthlyAmount||0)*100));
    const annual=Math.max(0,Math.round(Number(req.body.annualAmount||0)*100));const approved=req.body.packagingApproved==='1';
    const existing=(await database.query('SELECT * FROM commercial_plans WHERE id=$1',[req.params.id])).rows[0];
    if(!existing)throw new ValidationError('That commercial plan does not exist.');if(approved&&!Number(existing.sales_only)&&
      (!monthly||!annual||!String(req.body.stripeMonthlyPriceId||'').trim()||!String(req.body.stripeAnnualPriceId||'').trim()))
      throw new ValidationError('Before approving real checkout, set both public prices and both Stripe Price IDs.');
    if(approved&&!Number(existing.sales_only)){const incomplete=(await database.query(`SELECT definition.label
      FROM commercial_meter_definitions definition LEFT JOIN commercial_plan_meters meter
        ON meter.meter=definition.meter AND meter.plan_id=$1
      WHERE definition.kind='USAGE' AND definition.customer_visible=1
        AND (meter.meter IS NULL OR meter.included_units IS NULL OR meter.overage_mode IS NULL
          OR meter.overage_mode='CONTRACT'
          OR (meter.overage_mode='BILL' AND (meter.overage_block_units IS NULL OR meter.overage_block_units<=0
            OR meter.overage_amount_minor IS NULL)))
      ORDER BY definition.label`,[req.params.id])).rows;
      if(incomplete.length)throw new ValidationError(`Before approving checkout, set a complete included allowance and overage policy for: ${incomplete.map((row)=>row.label).join(', ')}.`);}
    await database.query(`UPDATE commercial_plans SET
      public_name=$2,outcome=$3,audience=$4,monthly_amount_minor=NULLIF($5,0),annual_amount_minor=NULLIF($6,0),
      stripe_monthly_price_id=NULLIF($7,''),stripe_annual_price_id=NULLIF($8,''),trial_days=$9,grace_days=$10,
      is_public=$11,is_recommended=$12,status=$13,packaging_status=$14,
      packaging_approved_at=CASE WHEN $14='APPROVED' THEN COALESCE(packaging_approved_at,now()) ELSE NULL END,
      packaging_approved_by_account_id=CASE WHEN $14='APPROVED' THEN $15 ELSE NULL END,updated_at=now() WHERE id=$1`,[req.params.id,req.body.publicName,
      req.body.outcome,req.body.audience,monthly,annual,req.body.stripeMonthlyPriceId||'',req.body.stripeAnnualPriceId||'',
      Math.max(0,Number(req.body.trialDays||0)),Math.max(0,Number(req.body.graceDays||7)),req.body.isPublic==='1'?1:0,
      req.body.isRecommended==='1'?1:0,['DRAFT','ACTIVE','ARCHIVED'].includes(req.body.status)?req.body.status:'DRAFT',
      approved?'APPROVED':'PROPOSED',req.account.id]);
    const after=(await database.query('SELECT * FROM commercial_plans WHERE id=$1',[req.params.id])).rows[0];
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'plan',subjectId:req.params.id,
      action:'updated',beforeState:existing,afterState:after,reason:'Commercial plan edited',sourceIp:req.ip});
    await commercialControl.snapshotPlanVersion(database,req.params.id,{actorAccountId:req.account.id,
      reason:'Plan settings changed',sourceIp:req.ip});
    req.flash('success','Commercial plan updated.');return res.redirect(303,`/commercial-admin#${req.params.id}`);}));
  router.post('/commercial-admin/plans/:id/entitlements/:capability',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{
    const definition=commercialCatalog.assertCapabilityKey(req.params.capability);const enabled=req.body.enabled==='1'?1:0;
    if(enabled&&definition.readiness==='DISABLED')throw new ValidationError('That capability is not production-ready and cannot be sold.');
    const before=(await database.query('SELECT * FROM commercial_plan_entitlements WHERE plan_id=$1 AND capability=$2',
      [req.params.id,req.params.capability])).rows[0]||null;
    await database.query(`INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled) VALUES($1,$2,$3)
      ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled`,[req.params.id,req.params.capability,enabled]);
    const after=(await database.query('SELECT * FROM commercial_plan_entitlements WHERE plan_id=$1 AND capability=$2',
      [req.params.id,req.params.capability])).rows[0];
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'plan_entitlement',
      subjectId:`${req.params.id}:${req.params.capability}`,action:'updated',beforeState:before,afterState:after,
      reason:'Plan entitlement changed',sourceIp:req.ip});
    await commercialControl.snapshotPlanVersion(database,req.params.id,{actorAccountId:req.account.id,
      reason:`Entitlement ${req.params.capability} changed`,sourceIp:req.ip});
    req.flash('success','Plan entitlement updated.');return res.redirect(303,`/commercial-admin#${req.params.id}`);}));
  router.post('/commercial-admin/plans/:id/meters/:meter',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{
    commercialCatalog.assertMeterKey(req.params.meter);const before=(await database.query(
      'SELECT * FROM commercial_plan_meters WHERE plan_id=$1 AND meter=$2',[req.params.id,req.params.meter])).rows[0]||null;
    const nullable=(value)=>String(value??'').trim()===''?null:Math.max(0,Math.round(Number(value)));
    const overageMode=['PAUSE','BILL','PURCHASE','CONTRACT'].includes(req.body.overageMode)?req.body.overageMode:'PAUSE';
    const overageBlockUnits=nullable(req.body.overageBlockUnits);
    const overageAmountMinor=String(req.body.overageAmount||'').trim()===''?null:Math.max(0,Math.round(Number(req.body.overageAmount)*100));
    if(overageMode==='BILL'&&(!overageBlockUnits||overageAmountMinor===null))throw new ValidationError(
      'Billed overage needs a positive block size and a price.');
    await database.query(`UPDATE commercial_plan_meters SET label=$3,included_units=$4,hard_limit=$5,
      overage_block_units=$6,overage_amount_minor=$7,overage_mode=$8 WHERE plan_id=$1 AND meter=$2`,[req.params.id,req.params.meter,
      req.body.label,nullable(req.body.includedUnits),nullable(req.body.hardLimit),overageBlockUnits,overageAmountMinor,overageMode]);
    const after=(await database.query('SELECT * FROM commercial_plan_meters WHERE plan_id=$1 AND meter=$2',
      [req.params.id,req.params.meter])).rows[0];
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'plan_meter',
      subjectId:`${req.params.id}:${req.params.meter}`,action:'updated',beforeState:before,afterState:after,
      reason:'Plan usage policy changed',sourceIp:req.ip});
    await commercialControl.snapshotPlanVersion(database,req.params.id,{actorAccountId:req.account.id,
      reason:`Meter ${req.params.meter} changed`,sourceIp:req.ip});
    req.flash('success','Usage allowance updated.');return res.redirect(303,`/commercial-admin#${req.params.id}`);}));
  router.post('/commercial-admin/promos',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{const code=String(req.body.code||'').trim().toUpperCase();
    if(!/^[A-Z0-9_-]{3,40}$/.test(code))throw new ValidationError('Use 3–40 letters, numbers, dashes or underscores for the promo code.');
    const discount=Math.max(0,Math.min(100,Number(req.body.discountPercent||0)));
    if(discount>0&&!String(req.body.stripePromotionCodeId||'').trim())throw new ValidationError(
      'A discounted promotion needs its Stripe promotion code ID so checkout charges the approved amount.');
    const before=(await database.query('SELECT * FROM commercial_promo_codes WHERE code=$1',[code])).rows[0]||null;
    await database.query(`INSERT INTO commercial_promo_codes(code,active,plan_id,trial_days,discount_percent,stripe_promotion_code_id,
      redemption_limit,starts_at,ends_at) VALUES($1,$2,NULLIF($3,''),$4,$5,NULLIF($6,''),$7,NULLIF($8,'')::timestamptz,
      NULLIF($9,'')::timestamptz) ON CONFLICT(code) DO UPDATE SET active=EXCLUDED.active,plan_id=EXCLUDED.plan_id,trial_days=EXCLUDED.trial_days,
      discount_percent=EXCLUDED.discount_percent,stripe_promotion_code_id=EXCLUDED.stripe_promotion_code_id,
      redemption_limit=EXCLUDED.redemption_limit,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at`,[code,
      req.body.active==='1'?1:0,req.body.planId||'',Math.max(0,Number(req.body.trialDays||0)),discount,
      req.body.stripePromotionCodeId||'',String(req.body.redemptionLimit||'').trim()===''?null:Math.max(1,Number(req.body.redemptionLimit)),
      req.body.startsAt||'',req.body.endsAt||'']);
    const after=(await database.query('SELECT * FROM commercial_promo_codes WHERE code=$1',[code])).rows[0];
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'promotion',subjectId:code,
      action:before?'updated':'created',beforeState:before,afterState:after,reason:'Promotion configuration changed',sourceIp:req.ip});
    req.flash('success','Promotion saved.');return res.redirect(303,'/commercial-admin#promotions');}));
  router.post('/commercial-admin/grants',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{const account=(await database.query(
      'SELECT * FROM accounts WHERE email=$1',[String(req.body.email||'').trim().toLowerCase()])).rows[0];
    if(!account)throw new ValidationError('No StockChief account uses that email.');const plan=await commercial.getPlan(database,req.body.planId);
    const existing=(await database.query('SELECT stripe_subscription_id FROM account_subscriptions WHERE account_id=$1',[account.id])).rows[0];
    if(existing?.stripe_subscription_id)throw new ValidationError(
      'This account has a Stripe subscription. Change or cancel it in Stripe before granting admin-funded access.');
    const status=req.body.kind==='trial'?'TRIALING':'COMP';const trialEnds=status==='TRIALING'
      ?new Date(Date.now()+Math.max(1,Number(req.body.days||1))*86400000).toISOString():null;
    const before=(await database.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[account.id])).rows[0]||null;
    const saved=(await database.query(`INSERT INTO account_subscriptions
      (id,account_id,plan_id,plan_version_id,status,billing_interval,trial_ends_at,source)
      VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'
        ORDER BY version_number DESC LIMIT 1),$4,'CUSTOM',$5,'ADMIN') ON CONFLICT(account_id) DO UPDATE SET
      plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id,status=EXCLUDED.status,billing_interval='CUSTOM',
      trial_ends_at=EXCLUDED.trial_ends_at,source='ADMIN',updated_at=now() RETURNING *`,
    [newId('sub'),account.id,plan.id,status,trialEnds])).rows[0];
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'subscription_grant',subjectId:saved.id,
      action:before?'updated':'created',beforeState:before,afterState:saved,reason:`Admin ${status==='COMP'?'comp access':'trial'} grant`,sourceIp:req.ip});
    req.flash('success',`${plan.public_name} ${status==='COMP'?'comp access':'trial'} granted.`);
    return res.redirect(303,'/commercial-admin#grants');}));
  router.post('/commercial-admin/overrides',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{const account=(await database.query(
      'SELECT id FROM accounts WHERE email=$1',[String(req.body.email||'').trim().toLowerCase()])).rows[0];
    if(!account)throw new ValidationError('No StockChief account uses that email.');const capability=String(req.body.capability||'').trim();
    const definition=commercialCatalog.assertCapabilityKey(capability);const enabled=req.body.enabled==='1'?1:0;
    if(enabled&&definition.readiness==='DISABLED')throw new ValidationError('That capability is not production-ready and cannot be granted.');
    const created=(await database.query(`INSERT INTO commercial_entitlement_overrides
      (id,account_id,capability,enabled,ends_at,reason,source) VALUES($1,$2,$3,$4,NULLIF($5,'')::timestamptz,$6,'ADMIN') RETURNING *`,
    [newId('override'),account.id,capability,enabled,req.body.endsAt||'',req.body.reason||'Commercial override'])).rows[0];
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'entitlement_override',
      subjectId:created?.id||`${account.id}:${capability}`,action:'created',afterState:{accountId:account.id,capability,enabled,
        endsAt:req.body.endsAt||null},reason:req.body.reason||'Commercial override',sourceIp:req.ip});
    req.flash('success','Customer-specific entitlement override saved.');return res.redirect(303,'/commercial-admin#grants');}));
  router.post('/commercial-admin/meter-overrides',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{const account=(await database.query(
      'SELECT id FROM accounts WHERE email=$1',[String(req.body.email||'').trim().toLowerCase()])).rows[0];
    if(!account)throw new ValidationError('No StockChief account uses that email.');const meter=String(req.body.meter||'').trim();
    commercialCatalog.assertMeterKey(meter);const limit=Math.round(Number(req.body.limitUnits));
    if(!Number.isSafeInteger(limit)||limit<0)throw new ValidationError('The customer-specific limit must be zero or a positive whole number.');
    await database.query(`INSERT INTO commercial_entitlement_overrides
      (id,account_id,meter,limit_units,ends_at,reason,source) VALUES($1,$2,$3,$4,NULLIF($5,'')::timestamptz,$6,'ADMIN')`,
    [newId('override'),account.id,meter,limit,req.body.endsAt||'',req.body.reason||'Commercial limit override']);
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'meter_override',
      subjectId:`${account.id}:${meter}:${Date.now()}`,action:'created',afterState:{accountId:account.id,meter,limit,
        endsAt:req.body.endsAt||null},reason:req.body.reason||'Commercial limit override',sourceIp:req.ip});
    req.flash('success','Customer-specific usage limit saved.');return res.redirect(303,'/commercial-admin#limits');}));
  router.post('/commercial-admin/cost-rates',requireAccount,commercialAdmin,asyncRoute(async(req,res)=>{
    const created=await commercialControl.saveCostRate(database,{provider:req.body.provider,operation:req.body.operation,
      unit:req.body.unit,costPerUnitMinor:req.body.costPerUnitMinor,currency:req.body.currency||'USD',
      effectiveFrom:req.body.effectiveFrom,effectiveUntil:req.body.effectiveUntil,source:req.body.source||'ADMIN',
      actorAccountId:req.account.id});
    await commercialControl.audit(database,{actorAccountId:req.account.id,subjectType:'cost_rate',subjectId:created.id,
      action:'created',afterState:created,reason:'Variable-cost assumption changed',sourceIp:req.ip});
    req.flash('success','Variable-cost rate saved. Existing historical cost events were not rewritten.');
    return res.redirect(303,'/commercial-admin#cost-rates');
  }));
  return router;}

module.exports={createPostgresCommercialRouter,renderPublic,commercialAdmin};
