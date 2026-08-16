'use strict';

/**
 * Turning purchasing on for an inventory that already has one.
 *
 * Mission 6 gave Foundry suppliers, reorder policies and purchase orders, but
 * left every existing workspace to configure them line by line. On a shoe
 * wholesaler with 40 styles across 8 sizes that is 320 decisions, which is a
 * polite way of saying nobody will ever do it — and the replenishment engine
 * stays silent because no line has a supplier or a policy.
 *
 * So Foundry proposes the whole thing at once, from what it already knows:
 *
 *   - reorder points derived from real outbound history, per SKU, with the
 *     arithmetic shown;
 *   - the lines it cannot derive anything for, named, with the reason;
 *   - a way to attach a supplier to many products in one go, because a vendor
 *     usually sells a whole range on the same terms.
 *
 * Nothing here invents a number. A line with no usage history gets no policy
 * and says so, because a reorder point guessed from an opening balance would
 * quietly become a purchase order for stock nobody needs.
 */

const { inTransaction } = require('../db');
const { ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const signalEngine = require('../signals/signal-engine');
const policyService = require('./policy-service');
const supplierService = require('./supplier-service');
const replenishment = require('./replenishment');
const position = require('./position');

/** Why a line cannot have a policy derived for it. */
const BLOCKED = {
  NO_HISTORY: 'no_history',
  ALREADY_SET: 'already_set',
};

/**
 * Looks at every line and works out what purchasing setup it could have.
 *
 * @returns {{ proposals, blocked, configured, summary }}
 */
function assess(db, workspaceId, options = {}) {
  const now = options.now || Date.now();
  const skus = signalEngine.skuSignals(db, workspaceId, { now }).filter((sku) => sku.isActive);
  const policies = policyService.policiesBySku(db, workspaceId);
  const incoming = position.onOrderBySku(db, workspaceId, { now });

  const proposals = [];
  const blocked = [];
  const configured = [];

  for (const sku of skus) {
    const existing = policies.get(sku.skuId);
    const suppliers = supplierService.suppliersForSku(db, workspaceId, sku.skuId);
    const base = {
      skuId: sku.skuId,
      itemId: sku.itemId,
      displayName: sku.displayName,
      unitLabel: sku.unitLabel,
      onHand: sku.measured.onHand,
      onOrder: (incoming.get(sku.skuId) || { onOrder: 0 }).onOrder,
      issuedInWindow: sku.measured.issuedInWindow,
      windowDays: sku.measured.windowDays,
      suppliers: suppliers.map((entry) => ({
        supplierItemId: entry.id,
        supplierId: entry.supplierId,
        supplierName: entry.supplierName,
        purchaseUnit: entry.purchaseUnit,
        unitsPerPurchaseUnit: entry.unitsPerPurchaseUnit,
      })),
      hasSupplier: suppliers.length > 0,
    };

    if (existing && existing.isSet) {
      configured.push({ ...base, policy: existing });
      continue;
    }

    const proposal = policyService.proposePolicy(db, workspaceId, sku.skuId, { now });
    if (!proposal || !proposal.canPropose) {
      blocked.push({
        ...base,
        reason: BLOCKED.NO_HISTORY,
        because:
          (proposal && proposal.because) ||
          `Only ${sku.measured.issuedInWindow} issued in the last ${sku.measured.windowDays} days — not enough to work a reorder point out from.`,
      });
      continue;
    }

    proposals.push({ ...base, proposal: proposal.proposal, derivedFrom: proposal.derivedFrom });
  }

  return {
    proposals,
    blocked,
    configured,
    summary: {
      lines: skus.length,
      canPropose: proposals.length,
      needHistory: blocked.length,
      alreadySet: configured.length,
      withoutSupplier: [...proposals, ...blocked].filter((entry) => !entry.hasSupplier).length,
      suppliers: supplierService.listSuppliers(db, workspaceId).length,
    },
  };
}

/**
 * Writes the proposed policies a person accepted.
 *
 * Recorded as `source: 'foundry'` so it is always visible that these were
 * derived rather than decided by somebody, and any of them can be overridden.
 */
function applyPolicies(db, ctx, membership, skuIds, options = {}) {
  permissions.assertCan(membership, permissions.MANAGE_REPLENISHMENT, 'set reorder policies');
  const wanted = new Set(Array.isArray(skuIds) ? skuIds : []);
  if (!wanted.size) throw new ValidationError('Choose at least one line to set up.');

  const assessment = assess(db, ctx.workspaceId, options);
  const applied = [];

  for (const entry of assessment.proposals) {
    if (!wanted.has(entry.skuId)) continue;
    policyService.setPolicy(db, ctx, membership, entry.skuId, {
      ...entry.proposal,
      source: 'foundry',
      notes: `Derived from ${entry.issuedInWindow} issued in ${entry.windowDays} days.`,
    });
    applied.push({ skuId: entry.skuId, displayName: entry.displayName, policy: entry.proposal });
  }

  return { applied, count: applied.length };
}

/**
 * Attaches one supplier to many products on the same terms.
 *
 * A vendor usually sells a whole range the same way — cases of twelve, a
 * three-week lead time — so setting that once for forty styles is the
 * difference between purchasing being usable and being theoretical.
 */
function linkSupplierToMany(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'manage suppliers');
  const supplier = supplierService.getSupplier(db, ctx.workspaceId, input.supplierId);
  const skuIds = Array.isArray(input.skuIds) ? input.skuIds : [];
  if (!skuIds.length) throw new ValidationError('Choose at least one product.');

  const linked = [];
  inTransaction(db, () => {
    for (const skuId of skuIds) {
      linked.push(
        supplierService.linkItem(db, ctx, membership, {
          supplierId: supplier.id,
          skuId,
          purchaseUnit: input.purchaseUnit,
          unitsPerPurchaseUnit: input.unitsPerPurchaseUnit,
          minimumOrderQuantity: input.minimumOrderQuantity,
          orderMultiple: input.orderMultiple,
          leadTimeDays: input.leadTimeDays,
          lastUnitCost: input.lastUnitCost,
          isPreferred: input.isPreferred,
        })
      );
    }
  });

  return { supplier, linked: linked.length };
}

/**
 * What purchasing would do for this inventory once it is set up.
 *
 * Shown before anything is written, so "set this up" is a decision with a
 * visible consequence rather than an act of faith.
 */
function preview(db, workspaceId, options = {}) {
  const assessment = assess(db, workspaceId, options);
  const wouldRecommend = replenishment.evaluateWorkspace(db, workspaceId, options);
  return {
    ...assessment,
    replenishment: {
      recommendations: wouldRecommend.recommendations.length,
      covered: wouldRecommend.covered.length,
      blocked: wouldRecommend.blocked.length,
    },
  };
}

module.exports = {
  BLOCKED,
  assess,
  applyPolicies,
  linkSupplierToMany,
  preview,
};
