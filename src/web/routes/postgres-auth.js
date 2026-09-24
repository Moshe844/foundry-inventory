'use strict';

const express = require('express');
const auth = require('../../domain/postgres-auth-service');

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
