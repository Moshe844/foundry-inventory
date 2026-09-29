'use strict';

const express = require('express');
const auth = require('../../domain/postgres-auth-service');
const passwordRecovery=require('../../domain/postgres-password-recovery');
const monitoring=require('../../operations/postgres-monitoring');
const accountLifecycle=require('../../domain/postgres-account-lifecycle');
const commercial=require('../../commercial/service');
const config=require('../../config');

function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function sessionCall(req, method) {
  return new Promise((resolve, reject) => req.session[method]((error) => error ? reject(error) : resolve()));
}
function selfServiceSelection(plans,requested){return plans.find((plan)=>plan.id===requested&&!plan.sales_only)
  ||plans.find((plan)=>plan.id==='growth')||plans.find((plan)=>!plan.sales_only);}
function pendingSelection(account,sessionSelection={}){return {
  planId:account?.pending_commercial_plan_id||sessionSelection.planId||'growth',
  interval:account?.pending_billing_interval==='ANNUAL'||sessionSelection.interval==='annual'?'annual':'monthly',
  promoCode:account?.pending_promo_code||sessionSelection.promoCode||'',
};}

function createPostgresAuthRouter(database) {
  const router = express.Router();
  router.get('/login', (req,res) => {
    if (req.account) return res.redirect(req.user ? '/' : '/inventories');
    return res.render('auth/login', { title:'Sign in',csrfToken:res.locals.csrfToken,flash:res.locals.flash,
      next:safeNext(req.query.next),email:'',appName:res.locals.appName,origin:res.locals.origin });
  });
  router.post('/login', async (req,res,next) => {
    try {
      const account = await auth.authenticate(database,req.body.email,req.body.password);
      if (!account) return res.status(401).render('auth/login', {
        title:'Sign in',csrfToken:res.locals.csrfToken,
        flash:[{ type:'error',message:'That email and password do not match an account.' }],
        next:safeNext(req.body.next),email:req.body.email || '',appName:res.locals.appName,
        origin:res.locals.origin,
      });
      await sessionCall(req,'regenerate');
      req.session.accountId=account.id;
      req.session.cookie.maxAge=req.body.rememberMe==='1'?30*86400000:null;
      const workspaceId=await auth.defaultWorkspaceFor(database,account.id);
      if(workspaceId)req.session.workspaceId=workspaceId;
      await sessionCall(req,'save');
      if(account.plan==='commercial_pending')return res.redirect(account.email_verified_at?'/complete-signup':'/verify-email/pending');
      return res.redirect(workspaceId?safeNext(req.body.next):'/inventories');
    } catch(error) { return next(error); }
  });
  router.get('/register', async (req,res,next) => {
    try {
    if(req.account)return res.redirect(req.user?'/':'/inventories');
    const plans=await commercial.listPlans(database);const requested=String(req.query.plan||'growth');
    const selected=selfServiceSelection(plans,requested);
    await commercial.track(database,{eventName:'signup_started',anonymousId:req.sessionID,planId:selected?.id||null,sourcePath:'/register'});
    if(req.query.plan)await commercial.track(database,{eventName:'plan_selected',anonymousId:req.sessionID,planId:selected?.id||null,
      sourcePath:'/pricing'});
    return res.render('auth/register', { title:'Create your account',csrfToken:res.locals.csrfToken,
      flash:res.locals.flash,form:{},appName:res.locals.appName,origin:res.locals.origin,
      selectedPlan:selected?.id||'growth',selectedInterval:req.query.interval==='annual'?'annual':'monthly',
      selectedPromo:String(req.query.promo||'').trim().toUpperCase(),plans });
    } catch(error) { return next(error); }
  });
  router.post('/register', async (req,res,next) => {
    try {
      const paidRequired=config.commercial.requirePaidWorkspace;
      if(paidRequired)await commercial.getSelfServicePlan(database,req.body.planId||'growth');
      if(paidRequired&&String(req.body.promoCode||'').trim())await commercial.validatePromotion(database,req.body.promoCode,
        req.body.planId||'growth');
      const created=paidRequired?await auth.createPendingAccount(database,req.body):await auth.createBusiness(database,req.body);
      await sessionCall(req,'regenerate');
      req.session.accountId=created.accountId||created.id;
      if(created.workspaceId)req.session.workspaceId=created.workspaceId;
      req.session.commercialSelection={planId:req.body.planId||'growth',interval:req.body.interval==='annual'?'annual':'monthly',
        promoCode:String(req.body.promoCode||'').trim().toUpperCase()};
      if(paidRequired)await accountLifecycle.requestVerification(database,created.id,{origin:config.connections.publicOrigin||res.locals.origin});
      req.session.flash=[{ type:'success',message:paidRequired?'Check your email to verify the account.':'Your first inventory is ready. Add your records or explore first.' }];
      await commercial.trackOnce(database,{eventName:'signup_completed',anonymousId:req.sessionID,accountId:created.accountId||created.id,
        planId:req.body.planId||'growth',sourcePath:'/register'});
      await sessionCall(req,'save');
      return res.redirect(paidRequired?'/verify-email/pending':'/onboarding');
    } catch(error) {
      if(error.status && error.status<500){const plans=await commercial.listPlans(database);
        const selected=selfServiceSelection(plans,String(req.body.planId||'growth'));return res.status(error.status).render('auth/register', {
        title:'Create your account',csrfToken:res.locals.csrfToken,
        flash:[{ type:'error',message:error.message }],form:req.body,appName:res.locals.appName,origin:res.locals.origin,
        selectedPlan:selected?.id||'growth',selectedInterval:req.body.interval||'monthly',
        selectedPromo:String(req.body.promoCode||'').trim().toUpperCase(),plans,
      });}
      return next(error);
    }
  });
  router.get('/verify-email/pending',(req,res)=>res.render('auth/verify-pending',{title:'Verify your email',
    csrfToken:res.locals.csrfToken,flash:res.locals.flash,account:req.account,origin:res.locals.origin}));
  router.get('/complete-signup',async(req,res)=>{if(!req.account)return res.redirect('/login');if(req.user)return res.redirect('/');
    if(!req.account.email_verified_at)return res.redirect('/verify-email/pending');return res.render('auth/verified',{
      title:'Activate your StockChief plan',csrfToken:res.locals.csrfToken,flash:res.locals.flash,origin:res.locals.origin,
      selection:pendingSelection(req.account,req.session.commercialSelection)});});
  router.post('/verify-email/resend',async(req,res,next)=>{try{if(req.account)await accountLifecycle.requestVerification(database,req.account.id,
      {origin:config.connections.publicOrigin||res.locals.origin});req.flash('success','A new verification link is on its way.');return res.redirect(303,'/verify-email/pending');}
    catch(error){return next(error);}});
  router.get('/verify-email',async(req,res,next)=>{try{const verification=await accountLifecycle.inspectVerification(database,req.query.token||'');
    return res.render('auth/verify-confirm',{title:'Verify your email',csrfToken:res.locals.csrfToken,flash:res.locals.flash,
      origin:res.locals.origin,token:req.query.token||'',verification});}catch(error){if(error.status&&error.status<500)return res.status(error.status).render('auth/verify-pending',{
      title:'Verification link expired',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],account:req.account,
      origin:res.locals.origin});return next(error);}});
  router.post('/verify-email',async(req,res,next)=>{try{const verified=await accountLifecycle.consumeVerification(database,req.body.token||'');
    if(!req.account||req.account.id!==verified.accountId){await sessionCall(req,'regenerate');req.session.accountId=verified.accountId;}
    const account=await auth.getAccount(database,verified.accountId);
    const selection=pendingSelection(account,req.session.commercialSelection);await sessionCall(req,'save');
    return res.render('auth/verified',{title:'Email verified',csrfToken:res.locals.csrfToken,flash:res.locals.flash,
      origin:res.locals.origin,selection});}catch(error){if(error.status&&error.status<500)return res.status(error.status).render('auth/verify-pending',{
      title:'Verification link expired',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],account:req.account,
      origin:res.locals.origin});return next(error);}});
  router.get('/invite',async(req,res,next)=>{try{const invitation=await accountLifecycle.inspectInvitation(database,req.query.token||'');
    return res.status(invitation?.status==='PENDING'?200:400).render('auth/invite',{title:'Join a StockChief workspace',
      csrfToken:res.locals.csrfToken,flash:res.locals.flash,origin:res.locals.origin,invitation,token:req.query.token||'',account:req.account});}
    catch(error){return next(error);}});
  router.post('/invite',async(req,res,next)=>{try{const accepted=await accountLifecycle.acceptInvitation(database,req.body.token||'',{
      accountId:req.account?.id||null,name:req.body.name,password:req.body.password});if(!req.account){await sessionCall(req,'regenerate');req.session.accountId=accepted.accountId;}
    req.session.workspaceId=accepted.workspaceId;await sessionCall(req,'save');return res.redirect(303,'/');}catch(error){if(error.status&&error.status<500){
      const invitation=await accountLifecycle.inspectInvitation(database,req.body.token||'');return res.status(error.status).render('auth/invite',{
        title:'Join a StockChief workspace',csrfToken:res.locals.csrfToken,flash:[{type:'error',message:error.message}],origin:res.locals.origin,
        invitation,token:req.body.token||'',account:req.account});}return next(error);}});
  router.get('/forgot-password',(req,res)=>res.render('auth/forgot-password',{
    title:'Reset your password',csrfToken:res.locals.csrfToken,flash:res.locals.flash,appName:res.locals.appName,
  }));
  router.post('/forgot-password',async(req,res)=>{
    try{await passwordRecovery.request(database,req.body.email,{origin:config.connections.publicOrigin||res.locals.origin,
      ip:req.ip||req.socket.remoteAddress});}
    catch(error){try{await monitoring.raise(database,{severity:'ERROR',kind:'password_recovery.failed',
      title:'Password recovery could not be queued',detail:error.message,fingerprint:'password_recovery.failed'});}catch{}
    }
    return res.render('auth/forgot-password',{title:'Check your email',csrfToken:res.locals.csrfToken,
      flash:[{type:'success',message:'If an account uses that email, a reset link is on its way.'}],appName:res.locals.appName});
  });
  router.get('/reset-password',async(req,res,next)=>{try{const valid=await passwordRecovery.inspect(database,req.query.token||'');
    return res.status(valid?200:400).render('auth/reset-password',{title:'Choose a new password',csrfToken:res.locals.csrfToken,
      flash:res.locals.flash,token:req.query.token||'',valid:Boolean(valid),appName:res.locals.appName});}catch(error){return next(error);}});
  router.post('/reset-password',async(req,res,next)=>{try{await passwordRecovery.consume(database,req.body.token||'',req.body.password||'');
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
