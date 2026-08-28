'use strict';

const express = require('express');
const changes = require('../../pricing/price-changes');
const prices = require('../../pricing/price-service');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');

const router = express.Router();
router.use('/pricing', requireAuth);

router.get('/pricing/new', asyncRoute(async (req, res) => {
  const sku = prices.requireSku(req.db, req.ctx.workspaceId, req.query.skuId);
  res.page('pricing/new', { title: 'Set selling price', nav: 'inventory', sku,
    current: prices.currentForSku(req.db, req.ctx.workspaceId, sku.id),
    purchaseCost: prices.purchaseCostForSku(req.db, req.ctx.workspaceId, sku.id) });
}));

router.post('/pricing/proposals', requireOwner, asyncRoute(async (req, res) => {
  const proposal = changes.createProposal(req.db, req.ctx, { skuId: req.body.skuId,
    amount: req.body.amount, currency: req.body.currency, sourceText: `Set from inventory screen: ${req.body.amount} ${req.body.currency}` });
  res.redirect(303, `/pricing/proposals/${proposal.id}`);
}));

function pendingBatch(req) {
  const ids = Array.isArray(req.session.pendingPriceBatch) ? req.session.pendingPriceBatch : [];
  return ids.map((id) => changes.get(req.db, req.ctx.workspaceId, id))
    .filter((proposal) => proposal.status === 'PENDING');
}

router.get('/pricing/proposals/batch', asyncRoute(async (req, res) => {
  const proposals = pendingBatch(req);
  if (!proposals.length) {
    delete req.session.pendingPriceBatch;
    req.flash('info', 'There is no price list waiting for review.');
    return res.redirect(303, '/inventory');
  }
  return res.page('pricing/batch', { title: 'Review selling prices', nav: 'inventory', proposals });
}));

router.post('/pricing/proposals/batch/approve', requireOwner, asyncRoute(async (req, res) => {
  const proposals = pendingBatch(req);
  const approvals = req.body.approval || {};
  const completed = changes.approveBatch(req.db, req.ctx, proposals.map((proposal) => ({
    id: proposal.id,
    integrityHash: approvals[proposal.id],
  })));
  delete req.session.pendingPriceBatch;
  req.flash('success', `${completed.length} selling price${completed.length === 1 ? '' : 's'} updated.`);
  return res.redirect(303, '/inventory');
}));

router.post('/pricing/proposals/batch/cancel', requireOwner, asyncRoute(async (req, res) => {
  const proposals = pendingBatch(req);
  changes.cancelBatch(req.db, req.ctx.workspaceId, proposals.map((proposal) => proposal.id));
  delete req.session.pendingPriceBatch;
  req.flash('success', 'The selling prices were not changed.');
  return res.redirect(303, '/inventory');
}));

router.get('/pricing/proposals/:id', asyncRoute(async (req, res) => {
  res.page('pricing/proposal', { title: 'Review selling price', nav: 'inventory',
    proposal: changes.get(req.db, req.ctx.workspaceId, req.params.id) });
}));

router.post('/pricing/proposals/:id/approve', requireOwner, asyncRoute(async (req, res) => {
  const proposal = changes.approve(req.db, req.ctx, req.params.id, req.body.integrityHash);
  req.flash('success', proposal.amount_minor === null
    ? `${proposal.displayName} no longer has a selling price.`
    : `${proposal.displayName} now sells for ${proposal.proposedFormatted}.`);
  res.redirect(303, `/inventory/${proposal.item_id}`);
}));

router.post('/pricing/proposals/:id/cancel', requireOwner, asyncRoute(async (req, res) => {
  const proposal = changes.cancel(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'The selling price was not changed.');
  res.redirect(303, `/inventory/${proposal.item_id}`);
}));

module.exports = router;
