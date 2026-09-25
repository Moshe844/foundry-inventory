'use strict';

const express = require('express');
const auth = require('../../domain/postgres-auth-service');
const passwordRecovery=require('../../domain/postgres-password-recovery');
const monitoring=require('../../operations/postgres-monitoring');
const config=require('../../config');

function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function sessionCall(req, method) {
  return new Promise((resolve, reject) => req.session[method]((error) => error ? reject(error) : resolve()));
}

function createPostgresAuthRouter(database) {
  const router = express.Router();
  router.get('/login', (req,res) => {
    if (req.account) return res.redirect(req.user ? '/' : '/inventories');
    return res.render('auth/login', { title:'Sign in',csrfToken:res.locals.csrfToken,flash:res.locals.flash,
      next:safeNext(req.query.next),email:'',appName:res.locals.appName });
  });
  router.post('/login', async (req,res,next) => {
    try {
      const account = await auth.authenticate(database,req.body.email,req.body.password);
      if (!account) return res.status(401).render('auth/login', {
        title:'Sign in',csrfToken:res.locals.csrfToken,
        flash:[{ type:'error',message:'That email and password do not match an account.' }],
        next:safeNext(req.body.next),email:req.body.email || '',appName:res.locals.appName,
      });
      await sessionCall(req,'regenerate');
      req.session.accountId=account.id;
      const workspaceId=await auth.defaultWorkspaceFor(database,account.id);
      if(workspaceId)req.session.workspaceId=workspaceId;
      await sessionCall(req,'save');
      return res.redirect(workspaceId?safeNext(req.body.next):'/inventories');
    } catch(error) { return next(error); }
  });
  router.get('/register', (req,res) => {
    if(req.account)return res.redirect(req.user?'/':'/inventories');
    return res.render('auth/register', { title:'Create your account',csrfToken:res.locals.csrfToken,
      flash:res.locals.flash,form:{},appName:res.locals.appName });
  });
  router.post('/register', async (req,res,next) => {
    try {
      const created=await auth.createBusiness(database,req.body);
      await sessionCall(req,'regenerate');
      req.session.accountId=created.accountId;
      req.session.workspaceId=created.workspaceId;
      req.session.flash=[{ type:'success',message:'Your first inventory is ready. Add your records or explore first.' }];
      await sessionCall(req,'save');
      return res.redirect('/onboarding');
    } catch(error) {
      if(error.status && error.status<500)return res.status(error.status).render('auth/register', {
        title:'Create your account',csrfToken:res.locals.csrfToken,
        flash:[{ type:'error',message:error.message }],form:req.body,appName:res.locals.appName,
      });
      return next(error);
    }
  });
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
  return router;
}

module.exports = { createPostgresAuthRouter,safeNext };
