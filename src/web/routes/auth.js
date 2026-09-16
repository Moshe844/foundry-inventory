'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const workspaceService = require('../../domain/workspace-service');
const passwordRecovery = require('../../domain/password-recovery');
const config = require('../../config');
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
          message: `Welcome to StockChief, ${created.name.split(' ')[0]}. Create your first inventory to begin.`,
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

router.get('/forgot-password', (req, res) => res.render('auth/forgot-password', {
  title: 'Reset your password', csrfToken: res.locals.csrfToken,
  flash: res.locals.flash, appName: res.locals.appName,
}));

router.post('/forgot-password', asyncRoute(async (req, res) => {
  try {
    passwordRecovery.request(req.db, req.body.email, {
      origin: config.connections.publicOrigin || res.locals.origin,
      ip: req.ip || req.socket.remoteAddress,
    });
  } catch (error) {
    try {
      require('../../operations/monitoring').raise(req.db, {
        severity: 'ERROR', kind: 'password_recovery.failed',
        title: 'Password recovery could not be queued', detail: error.message,
        fingerprint: 'password_recovery.failed',
      });
    } catch { /* keep the public response account-neutral */ }
  }
  return res.render('auth/forgot-password', {
    title: 'Check your email', csrfToken: res.locals.csrfToken,
    flash: [{ type: 'success', message: 'If an account uses that email, a reset link is on its way.' }],
    appName: res.locals.appName,
  });
}));

router.get('/reset-password', (req, res) => {
  const valid = passwordRecovery.inspect(req.db, req.query.token || '');
  return res.status(valid ? 200 : 400).render('auth/reset-password', {
    title: 'Choose a new password', csrfToken: res.locals.csrfToken,
    flash: res.locals.flash, token: req.query.token || '', valid: Boolean(valid),
    appName: res.locals.appName,
  });
});

router.post('/reset-password', asyncRoute(async (req, res) => {
  try {
    passwordRecovery.consume(req.db, req.body.token || '', req.body.password || '');
  } catch (error) {
    return res.status(error.status || 400).render('auth/reset-password', {
      title: 'Choose a new password', csrfToken: res.locals.csrfToken,
      flash: [{ type: 'error', message: error.message }], token: req.body.token || '', valid: true,
      appName: res.locals.appName,
    });
  }
  req.flash('success', 'Your password has been changed. Sign in with the new password.');
  return res.redirect(303, '/login');
}));

module.exports = router;
