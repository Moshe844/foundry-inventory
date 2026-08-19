'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const workspaceService = require('../../domain/workspace-service');
const { asyncRoute } = require('../middleware');

const router = express.Router();

function safeNext(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

router.get('/login', (req, res) => {
  if (req.account) return res.redirect(req.user ? '/' : '/inventories');
  return res.render('auth/login', {
    title: 'Sign in',
    csrfToken: res.locals.csrfToken,
    flash: res.locals.flash,
    next: safeNext(req.query.next),
    email: '',
    appName: res.locals.appName,
  });
});

router.post(
  '/login',
  asyncRoute(async (req, res) => {
    const account = authService.authenticate(req.db, req.body.email, req.body.password);
    if (!account) {
      return res.status(401).render('auth/login', {
        title: 'Sign in',
        csrfToken: res.locals.csrfToken,
        flash: [{ type: 'error', message: 'That email and password do not match an account.' }],
        next: safeNext(req.body.next),
        email: req.body.email || '',
        appName: res.locals.appName,
      });
    }
    // Sign in is to the account. Which inventory opens is a separate choice,
    // remembered on the account itself so it survives signing out.
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.accountId = account.id;
      const workspaceId = workspaceService.defaultWorkspaceFor(req.db, account.id);
      if (workspaceId) req.session.workspaceId = workspaceId;
      req.session.save(() => res.redirect(workspaceId ? safeNext(req.body.next) : '/inventories'));
    });
    return undefined;
  })
);

router.get('/register', (req, res) => {
  if (req.account) return res.redirect(req.user ? '/' : '/inventories');
  return res.render('auth/register', {
    title: 'Create your account',
    csrfToken: res.locals.csrfToken,
    flash: res.locals.flash,
    form: {},
    appName: res.locals.appName,
  });
});

router.post(
  '/register',
  asyncRoute(async (req, res) => {
    let created;
    try {
      created = authService.createAccount(req.db, {
        name: req.body.name,
        email: req.body.email,
        password: req.body.password,
      });
    } catch (err) {
      return res.status(err.status || 400).render('auth/register', {
        title: 'Create your account',
        csrfToken: res.locals.csrfToken,
        flash: [{ type: 'error', message: err.message }],
        form: req.body,
        appName: res.locals.appName,
      });
    }

    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.accountId = created.accountId;
      req.session.flash = [
        {
          type: 'success',
          message: `Welcome to Foundry, ${created.name.split(' ')[0]}. Create your first inventory to begin.`,
        },
      ];
      req.session.save(() => res.redirect('/inventories'));
    });
    return undefined;
  })
);

router.post('/logout', (req, res) => {
  if (!req.session) return res.redirect('/login');
  return req.session.destroy(() => {
    res.clearCookie('foundry.sid');
    res.redirect('/login');
  });
});

module.exports = router;
