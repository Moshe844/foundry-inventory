'use strict';

const express = require('express');
const auth = require('../../domain/postgres-auth-service');
const passwordRecovery=require('../../domain/postgres-password-recovery');
const monitoring=require('../../operations/postgres-monitoring');
const accountLifecycle=require('../../domain/postgres-account-lifecycle');
const commercial=require('../../commercial/service');
const commercialRelease=require('../../commercial/release');
const config=require('../../config');
const { ValidationError }=require('../../domain/errors');

function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function sessionCall(req, method) {
  return new Promise((resolve, reject) => req.session[method]((error) => error ? reject(error) : resolve()));
}
function selfServiceSelection(plans,requested){return requested
  ? plans.find((plan)=>plan.id===requested&&!plan.sales_only)||null
  : null;}
function pendingSelection(account,sessionSelection={}){return {
  planId:sessionSelection.planId||account?.pending_commercial_plan_id||'',
  interval:(sessionSelection.interval||account?.pending_billing_interval||'monthly').toLowerCase(),
  promoCode:sessionSelection.promoCode??account?.pending_promo_code??'',
};}

function matchingPasswords(body){
  // Legacy API/test clients do not send confirmation; the browser form requires it.
  // Whenever a confirmation is supplied, the server must reject a mismatch.
  if(Object.hasOwn(body,'confirmPassword')&&String(body.password||'')!==String(body.confirmPassword||''))
    throw new ValidationError('Passwords do not match. Enter the same password twice.');
}

function createPostgresAuthRouter(database,options={}) {
  const router = express.Router();
  router.get('/password-policy.js',(req,res)=>res.type('application/javascript').sendFile(require('node:path').join(__dirname,'../../lib/password-policy.js')));
  router.use((req,res,next)=>{res.locals.trialPolicy=require('../../commercial/self-service-trial').policy();res.locals.subscriptionTestMode=commercialRelease.stagingTestCheckout();if(req.account?.email_verified_at){const relevant=m=>m.code!=='verify_email_pending'&&!String(m.message||'').includes('Check your email to verify');res.locals.flash=(res.locals.flash||[]).filter(relevant);if(req.session?.flash)req.session.flash=req.session.flash.filter(relevant);}next();});
  const checkoutAvailable=()=>options.testMode===true&&process.env.NODE_ENV==='test'
    ?Promise.resolve(true):commercialRelease.isSubscriptionCheckoutOpen(database);
  router.get('/login', (req,res) => {
    if (req.account) return res.redirect(req.account.plan==='commercial_pending'
      ?(req.account.email_verified_at?'/complete-signup':'/verify-email/pending'):(req.user?'/':'/inventories'));
    return res.render('auth/login', { title:'Sign in',csrfToken:res.locals.csrfToken,flash:res.locals.flash,
      next:safeNext(req.query.next),email:'',appName:res.locals.appName,origin:res.locals.origin });
  });
  router.post('/login', async (req,res,next) => {
    try {
      const account = await auth.authenticate(database,req.body.email,req.body.password,{ip:req.ip||req.socket.remoteAddress});
      if (!account) return res.status(401).render('auth/login', {
        title:'Sign in',csrfToken:res.locals.csrfToken,
        flash:[{ type:'error',message:'That email and password do not match an account.' }],
        next:safeNext(req.body.next),email:req.body.email || '',appName:res.locals.appName,
        origin:res.locals.origin,
      });
      await sessionCall(req,'regenerate');
      req.session.accountId=account.id;req.session.accountAccessRevision=Number(account.platform_access_revision||0);
      try{require('../../domain/auth-service').checkPasswordStrength(req.body.password);}
      catch{req.session.passwordUpgradeRequired=true;req.session.passwordUpgradeNoticeDismissed=true;req.session.flash=[{type:'warning',message:'Please strengthen your password in Settings → Password to meet the current security requirements.'}];}
      req.session.cookie.maxAge=req.body.rememberMe==='1'?30*86400000:null;
      const workspaceId=await auth.defaultWorkspaceFor(database,account.id);
      if(workspaceId)req.session.workspaceId=workspaceId;
      await sessionCall(req,'save');
      if(account.plan==='commercial_pending')return res.redirect(account.email_verified_at?'/complete-signup':'/verify-email/pending');
      return res.redirect(workspaceId?safeNext(req.body.next):'/inventories');
    } catch(error) {
      if(error.status===429)return res.status(429).render('auth/login', {
        title:'Sign in',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],
        next:safeNext(req.body.next),email:req.body.email||'',appName:res.locals.appName,origin:res.locals.origin,
      });
      return next(error);
    }
  });
  router.get('/register', async (req,res,next) => {
    try {
    if(req.account){
      if(req.query.plan){const plan=selfServiceSelection(await commercial.listPlans(database),String(req.query.plan));if(plan)return res.redirect(303,require('../../commercial/plan-navigation').destination(plan,{account:req.account,subscription:await require('../../commercial/entitlements').subscriptionFor(database,req.account.id),interval:req.query.interval}));}
      if(req.account.plan==='commercial_pending')return res.redirect(req.account.email_verified_at
        ?`/complete-signup${req.query.plan?`?plan=${encodeURIComponent(req.query.plan)}`:''}`:'/verify-email/pending');
      if(req.user){
        return res.redirect(303,req.user.role==='owner'?'/settings/billing':'/');
      }
      return res.redirect('/inventories');
    }
    const plans=await commercial.listPlans(database);const requested=String(req.query.plan||'').trim();
    const selected=selfServiceSelection(plans,requested);
    await commercial.track(database,{eventName:'signup_started',anonymousId:req.sessionID,planId:selected?.id||null,sourcePath:'/register'});
    if(req.query.plan)await commercial.track(database,{eventName:'plan_selected',anonymousId:req.sessionID,planId:selected?.id||null,
      sourcePath:'/pricing'});
    return res.render('auth/register', { title:'Create your account',csrfToken:res.locals.csrfToken,
      flash:res.locals.flash,form:{},appName:res.locals.appName,origin:res.locals.origin,
      selectedPlan:selected?.id||'',selectedInterval:req.query.interval==='annual'?'annual':'monthly',
      selectedPromo:String(req.query.promo||'').trim().toUpperCase(),plans,
      paidSignup:config.commercial.requirePaidWorkspace,checkoutOpen:!config.commercial.requirePaidWorkspace||await checkoutAvailable() });
    } catch(error) { return next(error); }
  });
  router.post('/register', async (req,res,next) => {
    try {
      matchingPasswords(req.body);
      const paidRequired=config.commercial.requirePaidWorkspace;
      if(paidRequired)require('../../commercial/launch-interval').assertInterval(req.body.interval);
      const requestedPlanId=String(req.body.planId||'').trim();
      if(paidRequired&&requestedPlanId)await commercial.getSelfServicePlan(database,requestedPlanId);
      if(paidRequired&&String(req.body.promoCode||'').trim()&&!requestedPlanId)
        throw new ValidationError('Choose a plan before applying a promotion code.');
      if(paidRequired&&String(req.body.promoCode||'').trim())await commercial.validatePromotion(database,req.body.promoCode,
        requestedPlanId);
      const created=paidRequired?await auth.createPendingAccount(database,req.body):await auth.createBusiness(database,req.body);
      await sessionCall(req,'regenerate');
      req.session.accountId=created.accountId||created.id;req.session.accountAccessRevision=0;
      if(created.workspaceId)req.session.workspaceId=created.workspaceId;
      req.session.commercialSelection={planId:requestedPlanId,interval:req.body.interval==='annual'?'annual':'monthly',
        promoCode:String(req.body.promoCode||'').trim().toUpperCase()};
      if(paidRequired)await accountLifecycle.requestVerification(database,created.id,{origin:config.connections.publicOrigin||res.locals.origin});
      req.session.flash=[{ type:'success',message:paidRequired?'Check your email to verify the account.':'Your first inventory is ready. Add your records or explore first.' }];
      await commercial.trackOnce(database,{eventName:'signup_completed',anonymousId:req.sessionID,accountId:created.accountId||created.id,
        planId:requestedPlanId||null,sourcePath:'/register'});
      await sessionCall(req,'save');
      return res.redirect(paidRequired?'/verify-email/pending':'/onboarding');
    } catch(error) {
      if(error.status && error.status<500){const plans=await commercial.listPlans(database);
        const selected=selfServiceSelection(plans,String(req.body.planId||'').trim());return res.status(error.status).render('auth/register', {
        title:'Create your account',csrfToken:res.locals.csrfToken,
        flash:[{ type:'error',message:error.message }],form:req.body,appName:res.locals.appName,origin:res.locals.origin,
        selectedPlan:selected?.id||'',selectedInterval:req.body.interval==='annual'?'annual':'monthly',
        selectedPromo:String(req.body.promoCode||'').trim().toUpperCase(),plans,
        paidSignup:config.commercial.requirePaidWorkspace,checkoutOpen:!config.commercial.requirePaidWorkspace||await checkoutAvailable(),
      });}
      return next(error);
    }
  });
  router.get('/verify-email/pending',(req,res)=>{
    if(req.account?.email_verified_at)return res.redirect(req.account.plan==='commercial_pending'?'/complete-signup':req.user?'/':'/inventories');
    return res.render('auth/verify-pending',{title:'Verify your email',csrfToken:res.locals.csrfToken,
      flash:res.locals.flash,account:req.account,origin:res.locals.origin});
  });
  router.get('/complete-signup',async(req,res)=>{if(!req.account)return res.redirect('/login');if(req.user&&req.account.plan!=='commercial_pending'&&req.account.plan!=='trial'){const current=await require('../../commercial/entitlements').subscriptionFor(database,req.account.id);if(current?.stripe_subscription_id)return res.redirect('/billing');}
    const plans=await commercial.listPlans(database);
    const selection=pendingSelection(req.account,req.session.commercialSelection||req.session.checkoutSelection);
    const requested=selfServiceSelection(plans,String(req.query.plan||''));
    if(requested)selection.planId=requested.id;
    if(['monthly','annual'].includes(req.query.interval))selection.interval=req.query.interval;
    req.session.commercialSelection={...selection};delete req.session.checkoutSelection;
    if(!req.account.email_verified_at)return res.redirect(303,'/verify-email/pending');
    return res.render('auth/verified',{
      title:'Activate your StockChief plan',csrfToken:res.locals.csrfToken,flash:res.locals.flash,origin:res.locals.origin,
      selection,plans,existingWorkspace:Boolean(req.user),checkoutOpen:await checkoutAvailable()});});
  router.post('/complete-signup/trial',async(req,res,next)=>{try{
    if(!req.account)return res.redirect('/login');
    const result=await require('../../commercial/context').run({database,scope:{accountId:req.account.id,workspaceId:null}},()=>require('../../commercial/self-service-trial').activate(database,req.account.id));
    req.session.workspaceId=result.workspaceId;
    req.session.flash=[{type:'success',message:'Your trial inventory is ready. Choose where your records come from.'}];
    await sessionCall(req,'save');return res.redirect(303,'/onboarding');
  }catch(error){return next(error);}});
  router.post('/verify-email/resend',async(req,res,next)=>{try{if(req.account)await accountLifecycle.requestVerification(database,req.account.id,
      {origin:config.connections.publicOrigin||res.locals.origin});req.flash('success','A new verification link is on its way.');return res.redirect(303,'/verify-email/pending');}
    catch(error){return next(error);}});
  router.get('/verify-email',async(req,res,next)=>{try{const verification=await accountLifecycle.inspectVerification(database,req.query.token||'');
    return res.render('auth/verify-confirm',{title:'Verify your email',csrfToken:res.locals.csrfToken,flash:res.locals.flash,
      origin:res.locals.origin,token:req.query.token||'',verification});}catch(error){
      if(req.account?.plan==='commercial_pending'&&req.account.email_verified_at)return res.redirect('/complete-signup');
      if(error.status&&error.status<500)return res.status(error.status).render('auth/verify-pending',{
      title:'Verification link expired',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],account:req.account,
      origin:res.locals.origin});return next(error);}});
  router.post('/verify-email',async(req,res,next)=>{try{const verified=await accountLifecycle.consumeVerification(database,req.body.token||'');
    if(!req.account||req.account.id!==verified.accountId){await sessionCall(req,'regenerate');req.session.accountId=verified.accountId;await require('../../domain/postgres-account-access').stampSession(database,req.session,verified.accountId);}
    req.session.flash=(req.session.flash||[]).filter(message=>!message.message.includes('Check your email to verify'));
    res.locals.flash=(res.locals.flash||[]).filter(message=>!message.message.includes('Check your email to verify'));
    const account=await auth.getAccount(database,verified.accountId);
    await sessionCall(req,'save');
    return res.redirect(303,account.plan==='commercial_pending'?'/complete-signup':'/');}catch(error){if(error.status&&error.status<500)return res.status(error.status).render('auth/verify-pending',{
      title:'Verification link expired',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],account:req.account,
      origin:res.locals.origin});return next(error);}});
  router.get('/invite',async(req,res,next)=>{try{const invitation=await accountLifecycle.inspectInvitation(database,req.query.token||'');
    return res.status(invitation?.status==='PENDING'?200:400).render('auth/invite',{title:'Join a StockChief workspace',
      csrfToken:res.locals.csrfToken,flash:res.locals.flash,origin:res.locals.origin,invitation,token:req.query.token||'',account:req.account});}
    catch(error){return next(error);}});
  router.post('/invite',async(req,res,next)=>{try{const accepted=await accountLifecycle.acceptInvitation(database,req.body.token||'',{
      accountId:req.account?.id||null,name:req.body.name,password:req.body.password});if(!req.account){await sessionCall(req,'regenerate');req.session.accountId=accepted.accountId;await require('../../domain/postgres-account-access').stampSession(database,req.session,accepted.accountId);}
    req.session.workspaceId=accepted.workspaceId;await sessionCall(req,'save');return res.redirect(303,'/');}catch(error){if(error.status&&error.status<500){
      const invitation=await accountLifecycle.inspectInvitation(database,req.body.token||'');return res.status(error.status).render('auth/invite',{
        title:'Join a StockChief workspace',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],origin:res.locals.origin,
        invitation,token:req.body.token||'',account:req.account});}return next(error);}});
  router.get('/forgot-password',(req,res)=>res.render('auth/forgot-password',{
    title:'Reset your password',csrfToken:res.locals.csrfToken,flash:res.locals.flash,appName:res.locals.appName,
  }));
  router.post('/settings/password/remind-later',require('../middleware').requireAccount,async(req,res,next)=>{try{req.session.passwordUpgradeNoticeDismissed=true;await sessionCall(req,'save');return res.redirect(303,safeNext(req.body.returnTo));}catch(error){next(error);}});
  router.get('/settings/password',require('../middleware').requireAccount,(req,res)=>res.page('auth/change-password',{
    title:'Update your password',nav:null,error:null}));
  router.post('/settings/password',require('../middleware').requireAccount,async(req,res,next)=>{
    try{
      const verified=await auth.authenticate(database,req.account.email,req.body.currentPassword,{ip:req.ip||req.socket.remoteAddress});
      if(!verified||verified.id!==req.account.id)throw new ValidationError('Your current password did not match.');
      matchingPasswords(req.body);const passwordAuth=require('../../domain/auth-service');
      passwordAuth.checkPasswordStrength(req.body.password);const nextHash=passwordAuth.hashPassword(req.body.password);
      await database.transaction(async client=>{
        const changed=await client.query('UPDATE accounts SET password_hash=$3 WHERE id=$1 AND password_hash=$2 RETURNING id',[req.account.id,verified.password_hash,nextHash]);
        if(!changed.rows.length)throw new ValidationError('Your password changed in another session. Sign in again.');
        await client.query("DELETE FROM stockchief_runtime.sessions WHERE data->>'accountId'=$1 AND sid<>$2",[req.account.id,req.sessionID]);
      });
      delete req.session.passwordUpgradeRequired;req.flash('success','Password updated. Other signed-in sessions have been closed.');await sessionCall(req,'save');return res.redirect(303,'/');
    }catch(error){if(error.status&&error.status<500)return res.status(error.status).page('auth/change-password',{title:'Update your password',nav:null,error:error.message});return next(error);}
  });
  router.post('/forgot-password',async(req,res)=>{
    try{await passwordRecovery.request(database,req.body.email,{origin:config.connections.publicOrigin||res.locals.origin,
      ip:req.ip||req.socket.remoteAddress});}
    catch(error){try{await monitoring.raise(database,{severity:'ERROR',kind:'password_recovery.failed',
      title:'Password recovery could not be queued',detail:error.message,fingerprint:'password_recovery.failed'});}catch{}
    }
    return res.render('auth/forgot-password',{title:'Check your email',submitted:true,csrfToken:res.locals.csrfToken,
      flash:[{type:'success',message:'If an account uses that email, a reset link is on its way.'}],appName:res.locals.appName});
  });
  router.get('/reset-password',async(req,res,next)=>{try{const valid=await passwordRecovery.inspect(database,req.query.token||'');
    return res.status(valid?200:400).render('auth/reset-password',{title:'Choose a new password',csrfToken:res.locals.csrfToken,
      flash:res.locals.flash,token:req.query.token||'',valid:Boolean(valid),appName:res.locals.appName});}catch(error){return next(error);}});
  router.post('/reset-password',async(req,res,next)=>{try{matchingPasswords(req.body);
    await passwordRecovery.consume(database,req.body.token||'',req.body.password||'');
    req.flash('success','Your password has been changed. Sign in with the new password.');return res.redirect(303,'/login');}
  catch(error){if(error.status&&error.status<500)return res.status(error.status).render('auth/reset-password',{
    title:'Choose a new password',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],
    token:req.body.token||'',valid:true,appName:res.locals.appName});return next(error);}});
  router.post('/logout', async (req,res,next) => {
    if(!req.session)return res.redirect('/login');
    try {
      await sessionCall(req,'destroy');
      res.clearCookie('foundry.sid');
      return res.redirect('/login');
    } catch(error) { return next(error); }
  });
  router.post('/logout-all',async(req,res,next)=>{try{if(req.account)await database.query(`DELETE FROM stockchief_runtime.sessions
      WHERE data->>'accountId'=$1`,[req.account.id]);res.clearCookie('foundry.sid');return res.redirect(303,'/login');}catch(error){return next(error);}});
  return router;
}

module.exports = { createPostgresAuthRouter,safeNext };
