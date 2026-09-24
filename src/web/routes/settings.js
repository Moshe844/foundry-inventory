'use strict';

const express = require('express');
const authService = require('../../domain/auth-service');
const engine = require('../../domain/inventory-engine');
const entitlements = require('../../entitlements/service');
const eventFeed = require('../../connectors/event-feed');
const operatingInstructions = require('../../manager/operating-instructions');
const operatingGuards = require('../../domain/operating-guards');
const workspaceExport = require('../../domain/workspace-export');
const config = require('../../config');
const workspaceService = require('../../domain/workspace-service');
const emailAlerts = require('../../notifications/email-alerts');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/settings', requireAuth);

router.get('/support', requireAuth, asyncRoute(async (req, res) => res.page('support', {
  title: 'Help and support', nav: null, supportEmail: config.supportEmail,
})));

/*
 * Settings is a transcript.
 *
 * StockChief is taught by talking to it, so what an owner needs is a readable
 * record of what they already said, with the ability to change, pause or
 * revoke any line of it — not a tree of forms. The forms still exist, at
 * /settings and behind it; this is the page somebody actually arrives at
 * asking "what have I told it, and has it used any of that?".
 */
router.get('/what-you-told-me', requireAuth, asyncRoute(async (req, res) => {
  const safely = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  const rules = safely(() => operatingInstructions.list(req.db, req.ctx.workspaceId), []);
  const policies = safely(
    () => require('../../autopilot/policy-service').list(req.db, req.ctx.workspaceId), []
  );

  const connections = safely(() => require('../../connections/service')
    .list(req.db, req.ctx.workspaceId), [])
    .map((row) => ({
      id: row.id,
      name: row.display_name || row.provider_type,
      // What it is doing for the business, not what it is configured as.
      doing: row.provides && row.provides.length
        ? row.provides.join(', ').replaceAll('_', ' ')
        : 'connected, and not carrying anything yet',
      state: row.publicStatus === 'Connected' ? 'healthy'
        : row.publicStatus === 'Needs attention' ? 'needs you' : 'disconnected',
      healthy: row.publicStatus === 'Connected',
    }));

  /*
   * Preferences that are held as settings rather than as sentences, said back
   * as sentences anyway. Where somebody set it in a form, this is still the
   * page that has to be able to tell them what it means.
   */
  const preferences = [];
  const notices = safely(
    () => require('../../sales/customer-communications').policy(req.db, req.ctx.workspaceId), null
  );
  if (notices) {
    preferences.push({
      text: notices.shippingNotice === 'send'
        ? 'Tell customers their order shipped without checking with me first.'
        : notices.shippingNotice === 'off'
          ? 'Do not write to customers when their order ships.'
          : 'Write to customers when their order ships, but let me read it before it goes.',
      href: '/fulfilment',
    });
  }

  return res.page('settings/told', {
    title: "What you've told me",
    nav: 'settings',
    room: true,
    rules,
    policies,
    connections,
    preferences,
  });
}));

/*
 * The promise that makes the consolidation honest.
 *
 * Every screen this redesign took off the main path still has its address, and
 * they are all listed here, grouped by the question they answer. A navigation
 * that hides things is worse than the sidebar it replaced.
 */
router.get('/everything', requireAuth, asyncRoute(async (req, res) => res.page('settings/everything', {
  title: 'Everything else',
  nav: 'settings',
  room: true,
  sections: [
    {
      title: 'Customer orders',
      why: 'An order is one story, and it is the page. These are the working surfaces underneath it.',
      links: [
        { href: '/orders', label: 'All customer orders' },
        { href: '/orders/new', label: 'Write an order' },
        { href: '/fulfilment', label: 'Picking and packing queue' },
        { href: '/sales/customers/new', label: 'Add a customer' },
      ],
    },
    {
      title: 'Buying and suppliers',
      why: 'A purchase is one story too. StockChief prepares these; the queue is here for when you want to work through them yourself.',
      links: [
        { href: '/purchasing', label: 'What needs buying' },
        { href: '/purchasing/orders', label: 'All purchase orders' },
        { href: '/purchasing/orders/new', label: 'Write a purchase order' },
        { href: '/purchasing/receive', label: 'Book in a delivery' },
        { href: '/suppliers', label: 'Suppliers and their terms' },
        { href: '/purchasing/setup', label: 'Reorder points and targets' },
      ],
    },
    {
      title: 'Stock, in detail',
      why: 'What you hold answers the question in six lines. This is the database underneath it, for when six lines is not enough.',
      links: [
        { href: '/inventory/table', label: 'Full stock table' },
        { href: '/inventory/new', label: 'Add a product' },
        { href: '/locations', label: 'Locations' },
        { href: '/warehouse', label: 'Warehouse tasks and scanning' },
        { href: '/transfers', label: 'Transfers and in-transit stock' },
        { href: '/planning', label: 'What StockChief expects to go wrong' },
        { href: '/pricing/new', label: 'Change selling prices' },
        { href: '/imports/start', label: 'Bring data in from a file' },
      ],
    },
    {
      title: 'Books and accounting',
      why: 'Money says how the business is doing. This is the ledger, for your accountant — you should not be operating it during ordinary work.',
      links: [
        { href: '/accounting/books', label: 'Books dashboard' },
        { href: '/accounting/transactions', label: 'Every transaction' },
        { href: '/accounting/chart', label: 'Chart of accounts' },
        { href: '/accounting/receivables', label: 'What customers owe' },
        { href: '/accounting/payables', label: 'What you owe' },
        { href: '/accounting/banking', label: 'Banking and reconciliation' },
        { href: '/accounting/periods', label: 'Closing a period' },
        { href: '/accounting/tax', label: 'Tax rates' },
        { href: '/accounting/reports/profit-and-loss', label: 'Profit and loss' },
        { href: '/accounting/reports/balance-sheet', label: 'Balance sheet' },
      ],
    },
    {
      title: 'Messages',
      why: 'StockChief is not an email client. Supplier mail lives on the purchase, customer mail on the order, and anything waiting on a reply is on the desk. This is the whole mailbox, for when you want to look through it.',
      links: [
        { href: '/mail', label: 'All conversations' },
        { href: '/activity', label: 'Everything that happened, in order' },
      ],
    },
    {
      title: 'What StockChief may do on its own',
      why: 'Authority is two choices: ask me first, or handle routine work inside limits you approve. The exact limits are here.',
      links: [
        { href: '/autopilot', label: 'Standing authority' },
        { href: '/autopilot', label: 'Limits and preferences' },
        { href: '/autopilot/history', label: 'Everything it did on its own' },
        { href: '/actions', label: 'Changes prepared for approval' },
      ],
    },
    {
      title: 'Connections',
      why: 'Mailbox, shop, payments and carrier. Mapping and credentials are technical, so they sit inside each connection rather than on the main path.',
      links: [
        { href: '/settings/connections', label: 'All connections' },
        { href: '/settings/shipping', label: 'Shipping and carriers' },
      ],
    },
    {
      title: 'This inventory',
      why: 'Set once, changed rarely.',
      links: [
        { href: '/search', label: 'Search every record' },
        { href: '/settings', label: 'Settings, people and plan' },
        { href: '/foundry', label: 'How this inventory is configured' },
        { href: '/inventories', label: 'Your other inventories' },
        { href: '/settings/export', label: 'Export everything' },
        { href: '/guide', label: 'How to use StockChief' },
        { href: '/support', label: 'Support' },
      ],
    },
  ],
})));

router.get(
  '/settings',
  asyncRoute(async (req, res) => {
    const users = authService.listUsers(req.db, req.ctx.workspaceId);
    const integrity = engine.verifyIntegrity(req.db, req.ctx.workspaceId);
    const learnedInstructions = operatingInstructions.list(req.db, req.ctx.workspaceId)
      .filter((instruction) => ['APPROVED', 'REMOVED', 'SUPERSEDED'].includes(instruction.status));
    const activeInstructionByRecordId = new Map();
    for (const instruction of learnedInstructions) {
      if (instruction.status !== 'APPROVED') continue;
      for (const record of instruction.appliedRecords) {
        if (record.id) activeInstructionByRecordId.set(record.id, instruction.id);
      }
    }
    const newFeedToken = req.session.newFeedToken || null;
    delete req.session.newFeedToken;
    res.page('settings', {
      title: 'Settings',
      nav: 'settings',
      room: true,
      users,
      integrity,
      eventFeed: eventFeed.state(req.db, req.ctx.workspaceId),
      newFeedToken,
      workspace: res.locals.workspace,
      // Where this account stands against its plan. Billing will change what
      // the numbers are; nothing on this page needs to know that happened.
      entitlements: entitlements.summarise(req.db, {
        accountId: req.ctx.accountId,
        workspaceId: req.ctx.workspaceId,
      }),
      // What the assistant's model reads have cost this inventory, from the
      // call record; a page that failed to count would be worse than none.
      aiUsage: (() => { try { return require('../../assistant/calls').usageSummary(req.db, req.ctx.workspaceId); } catch { return null; } })(),
      learnedInstructions,
      stockGuards: operatingGuards.list(req.db, req.ctx.workspaceId, { activeOnly: true })
        .map((guard) => ({
          ...guard,
          boundary: operatingGuards.describeBoundary(guard),
          instructionId: activeInstructionByRecordId.get(guard.id) || null,
        })),
      emailAlerts: emailAlerts.get(req.db, req.ctx.workspaceId),
    });
  })
);

router.post(
  '/settings/email-alerts',
  requireOwner,
  asyncRoute(async (req, res) => {
    const saved = emailAlerts.save(req.db, req.ctx.workspaceId, {
      enabled: req.body.enabled === '1',
      minimumSeverity: req.body.minimumSeverity,
      recipients: req.body.recipients,
    });
    if (saved.enabled && !saved.deliveryConfigured) {
      req.flash('warn', 'Email alert rules are saved, but delivery still needs a verified StockChief sender and email API key.');
    } else {
      req.flash('success', saved.enabled
        ? 'Automatic email alerts are on. Each newly opened item is emailed once.'
        : 'Automatic email alerts are off. Needs You still works in StockChief.');
    }
    res.redirect(303, '/settings#email-alerts');
  })
);

router.post(
  '/settings/email-alerts/test',
  requireOwner,
  asyncRoute(async (req, res) => {
    const setting = emailAlerts.get(req.db, req.ctx.workspaceId);
    if (!setting.enabled) {
      req.flash('warn', 'Turn on automatic email alerts and save them before sending a test.');
    } else if (!setting.deliveryConfigured) {
      req.flash('warn', 'The alert is configured, but this StockChief server does not yet have a verified email sender and API key.');
    } else {
      const result = emailAlerts.queueTest(req.db, req.ctx.workspaceId);
      req.flash('success', result.queued
        ? `Test email queued for ${result.queued} recipient${result.queued === 1 ? '' : 's'}.`
        : 'That identical test is already queued.');
    }
    res.redirect(303, '/settings#email-alerts');
  })
);

router.post(
  '/settings/event-feed/enable',
  requireOwner,
  asyncRoute(async (req, res) => {
    const enabled = eventFeed.enable(req.db, req.ctx, req.user);
    req.session.newFeedToken = enabled.token;
    req.flash('success', 'The live operating feed is connected. Copy the token now; StockChief will not show it again.');
    res.redirect(303, '/settings#live-event-feed');
  })
);

router.get('/settings/export', requireOwner, asyncRoute(async (req, res) => {
  const payload = workspaceExport.build(req.db, req.ctx.workspaceId);
  const safeName = String(req.workspace.name || 'keeper-workspace')
    .replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'keeper-workspace';
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${safeName}-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.send(`${JSON.stringify(payload, null, 2)}\n`);
}));

router.post(
  '/settings/event-feed/disconnect',
  requireOwner,
  asyncRoute(async (req, res) => {
    eventFeed.disconnect(req.db, req.ctx);
    req.flash('success', 'The live operating feed is disconnected and every active feed token was revoked.');
    res.redirect(303, '/settings#live-event-feed');
  })
);

router.post(
  '/settings/workspace',
  requireOwner,
  asyncRoute(async (req, res) => {
    authService.renameWorkspace(req.db, req.ctx, req.user, req.body.name);
    req.flash('success', 'Workspace name updated.');
    res.redirect(303, '/settings');
  })
);

router.post('/settings/test-inventory', requireOwner, asyncRoute(async (req, res) => {
  const created = workspaceService.createWorkspace(req.db, req.account.id,
    String(req.body.name || 'Test inventory').trim(), { dataMode: 'synthetic' });
  req.session.workspaceId = created.workspaceId;
  return req.session.save(() => res.redirect(303, '/foundry/describe'));
}));

router.post(
  '/settings/people',
  requireOwner,
  asyncRoute(async (req, res) => {
    const member = authService.createTeamMember(req.db, req.ctx, req.user, {
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      role: req.body.role,
    });
    req.flash('success', `${member.name} can now sign in.`);
    res.redirect(303, '/settings');
  })
);

module.exports = router;
