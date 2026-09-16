'use strict';

/**
 * Running an approved action.
 *
 * The order here is the whole safety argument, and it never varies:
 *
 *   authorize → claim an idempotency key → revalidate against current truth
 *   → execute through the Mission 1 engine → re-read the balances → record
 *
 * The engine is still the only code that changes a balance. Nothing in this
 * file writes to `balances`, `movements`, `lot_balances` or `serial_units`; it
 * calls `receive` / `issue` / `transfer` / `adjust` exactly as a person would.
 *
 * "It ran" and "it is correct" are deliberately separate claims. A successful
 * engine call that fails verification is reported as unverified, never as done.
 */

const { inTransaction } = require('../db');
const engine = require('../domain/inventory-engine');
const transferService = require('../transfers/transfer-service');
const locationService = require('../domain/location-service');
const itemService = require('../domain/item-service');
const kits = require('../domain/kit-service');
const supplierService = require('../purchasing/supplier-service');
const purchasingPolicy = require('../purchasing/policy-service');
const priceService = require('../pricing/price-service');
const catalog = require('../imports/catalog-service');
const repo = require('../domain/repository');
const proposals = require('./proposal-service');
const permissions = require('./permissions');
const removals = require('./removals');
const policy = require('./policy');
const verification = require('./verification');
const reevaluate = require('../attention/reevaluate');
const { ValidationError, NotFoundError, DomainError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

function locationKind(name) {
  if (/\b(?:store|shop|counter|showroom)\b/i.test(name)) return 'store';
  if (/\bstockroom\b/i.test(name)) return 'stockroom';
  return 'warehouse';
}

function ensureCatalogueLocation(db, engineCtx, name) {
  const existing = db.prepare(`SELECT * FROM locations
    WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1`).get(engineCtx.workspaceId, name);
  return existing || locationService.createLocation(db, engineCtx, { name, kind: locationKind(name) });
}

function ensureCatalogueSupplier(db, ctx, membership, name) {
  const existing = db.prepare(`SELECT id FROM suppliers
    WHERE workspace_id = ? AND name = ? COLLATE NOCASE`).get(ctx.workspaceId, name);
  return existing
    ? supplierService.getSupplier(db, ctx.workspaceId, existing.id)
    : supplierService.createSupplier(db, ctx, membership, { name });
}

function saveCatalogueFacts(db, ctx, itemId, skuId, record) {
  const now = nowIso();
  const sourceText = [`${record.ordinal}. ${record.name}`,
    ...(record.fields || []).map((field) => `${field.label}: ${field.value}`)].join('\n');
  db.prepare(`INSERT INTO catalogue_item_facts
    (workspace_id,item_id,category,facts,source_text,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,item_id) DO UPDATE SET
      category=excluded.category,facts=excluded.facts,source_text=excluded.source_text,updated_at=excluded.updated_at`)
    .run(ctx.workspaceId, itemId, record.category || null,
      JSON.stringify({ category: record.category || null }), sourceText, now, now);
  db.prepare(`INSERT INTO catalogue_sku_facts
    (workspace_id,sku_id,source_key,facts,source_text,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,sku_id) DO UPDATE SET
      source_key=excluded.source_key,facts=excluded.facts,source_text=excluded.source_text,updated_at=excluded.updated_at`)
    .run(ctx.workspaceId, skuId, record.code || null, JSON.stringify(record), sourceText, now, now);
}

function applyCatalogueRecord(db, ctx, membership, engineCtx, reference, itemId, skuId, record) {
  const movementIds = [];
  const groupIds = [];
  saveCatalogueFacts(db, ctx, itemId, skuId, record);
  if (record.sellingPriceMinor !== null) {
    priceService.setPrice(db, ctx, { skuId, amountMinor: record.sellingPriceMinor, currency: 'USD',
      source: 'owner', sourceDetail: { catalogueRecord: record.ordinal } });
  }
  if (record.unitCostMinor !== null) {
    priceService.setPurchaseCost(db, ctx, { skuId, amountMinor: record.unitCostMinor, currency: 'USD',
      source: 'owner', sourceDetail: { catalogueRecord: record.ordinal } });
  }
  let supplier = null;
  if (record.supplier) {
    supplier = ensureCatalogueSupplier(db, ctx, membership, record.supplier);
    supplierService.linkItem(db, ctx, membership, {
      supplierId: supplier.id, skuId, supplierSku: record.supplierPart || null,
      purchaseUnit: record.unitLabel || 'unit', unitsPerPurchaseUnit: 1,
      lastUnitCost: record.unitCostMinor === null ? null : record.unitCostMinor / 100,
      isPreferred: true,
    });
  }
  if (record.reorderPoint !== null) {
    purchasingPolicy.setPolicy(db, ctx, membership, skuId, {
      reorderPoint: record.reorderPoint,
      preferredSupplierId: supplier ? supplier.id : undefined,
      source: 'manual',
    });
  }

  for (const stated of record.locations || []) {
    if (!stated.quantity) continue;
    const location = ensureCatalogueLocation(db, engineCtx, stated.name);
    const input = { skuId, locationId: location.id, reference,
      notes: `Opening stock copied from structured catalogue record ${record.ordinal}.` };
    if (record.trackingMode === 'serial') {
      if ((record.locations || []).length === 1 && record.serials.length === stated.quantity) {
        input.serials = record.serials;
      } else {
        const found = Object.entries(record.serialsByLocation || {})
          .find(([name]) => String(name).localeCompare(stated.name, undefined, { sensitivity: 'accent' }) === 0);
        input.serials = found ? found[1] : [];
      }
    } else {
      input.quantity = stated.quantity;
    }
    if (record.trackingMode === 'lot') {
      input.lotCode = record.lotCode;
      input.expiresAt = record.expirationDate || undefined;
    }
    const received = engine.receive(db, engineCtx, input);
    movementIds.push(...(received.movementIds || []));
    if (received.groupId) groupIds.push(received.groupId);
  }
  return { movementIds, groupIds };
}

function executableCatalogueVariants(variants) {
  const source = Array.isArray(variants) ? variants : [];
  if (source.length < 2) return source.map((variant) => ({ ...variant, options: {} }));

  const names = [];
  for (const variant of source) {
    for (const name of Object.keys(variant.options || {})) {
      if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  const axes = names.filter((name) => {
    const values = source.map((variant) => {
      const key = Object.keys(variant.options || {})
        .find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return key ? String(variant.options[key] || '').trim().toLowerCase() : '';
    });
    return values.every(Boolean) && new Set(values).size > 1;
  }).slice(0, 3);

  return source.map((variant) => ({
    ...variant,
    options: Object.fromEntries(axes.map((name) => {
      const key = Object.keys(variant.options || {})
        .find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return [name, variant.options[key]];
    })),
  }));
}

class StaleProposalError extends DomainError {
  constructor(message, details) {
    super(message, { code: 'proposal_stale', status: 409 });
    this.details = details || null;
  }
}

/**
 * The approval step. Separate from execution so approval is auditable alone.
 *
 * The staleness check runs and is *recorded* before anything can throw. Marking
 * a proposal invalid has to outlive the rejection — writing it inside the same
 * transaction as the throw would roll the record back with it, leaving a stale
 * proposal that still looks approvable.
 */
function approve(db, ctx, membership, proposalId) {
  const proposal = proposals.get(db, ctx.workspaceId, proposalId);
  if (!proposal) throw new NotFoundError('That action could not be found.');
  permissions.assertCanPerform(membership, proposal.actionType, proposal);

  if (proposal.status === 'APPROVED') return proposal;
  if (proposal.status !== 'AWAITING_APPROVAL') {
    throw new ValidationError('That action is no longer waiting for approval.');
  }

  const check = proposals.revalidate(db, ctx, proposal);
  if (!check.ok) {
    const problems = describe(check);
    inTransaction(db, () => {
      proposals.setStatus(db, ctx, proposalId, 'INVALIDATED', { problems });
      proposals.record(db, ctx, proposalId, 'INVALIDATED', { at: 'approval', problems });
    });
    throw new StaleProposalError(problems[0] || 'The inventory changed since this was proposed.', {
      current: check.current,
    });
  }

  return inTransaction(db, () => {
    proposals.setStatus(db, ctx, proposalId, 'APPROVED', { approvedBy: ctx.actorId });
    proposals.record(db, ctx, proposalId, 'APPROVED', {});
    return proposals.get(db, ctx.workspaceId, proposalId);
  });
}

function describe(check) {
  const problems = [...(check.problems || [])];
  if (check.changed && problems.length === 0) {
    problems.push('The stock changed since this was worked out. StockChief has recalculated it.');
  }
  return problems;
}

/**
 * Executes an approved proposal, exactly once.
 *
 * `idempotencyKey` is claimed inside the same transaction as the mutation, so a
 * double-click, a retried POST or a replayed request finds the claim already
 * taken and gets the first result back instead of moving stock twice.
 */
function execute(db, ctx, membership, proposalId, options = {}) {
  const idempotencyKey = options.idempotencyKey || `proposal:${proposalId}`;

  const existing = findExecution(db, ctx.workspaceId, idempotencyKey);
  if (existing) return replay(db, ctx.workspaceId, existing);

  const proposal = proposals.get(db, ctx.workspaceId, proposalId);
  if (!proposal) throw new NotFoundError('That action could not be found.');
  permissions.assertCanPerform(membership, proposal.actionType, proposal);
  if (proposal.status !== 'APPROVED') {
    throw new ValidationError('That action has not been approved.');
  }

  let claimed;
  try {
    claimed = runOnce(db, ctx, membership, proposal, idempotencyKey);
  } catch (error) {
    if (isDuplicateKey(error)) {
      // Another request beat this one to it by microseconds.
      const winner = findExecution(db, ctx.workspaceId, idempotencyKey);
      if (winner) return replay(db, ctx.workspaceId, winner);
    }
    throw error;
  }

  // Attention re-evaluation happens after the movement has committed, never
  // inside it: interpretation must not be able to roll back inventory work.
  const affectedSkuIds = proposal.skuId ? [proposal.skuId] : (claimed.affectedSkuIds || []);
  if (claimed.status === 'SUCCEEDED' && affectedSkuIds.length && claimed.movementIds.length) {
    reevaluate.afterMovement(db, ctx.workspaceId, affectedSkuIds, `action:${proposal.actionType}`);
  }
  return claimed;
}

function isDuplicateKey(error) {
  return Boolean(error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT'));
}

function runOnce(db, ctx, membership, proposal, idempotencyKey) {
  return inTransaction(db, () => {
    const executionId = newId('axe');
    // Claimed first: if anything below fails, the row is rolled back with it,
    // so a failed attempt never blocks a legitimate retry.
    db.prepare(
      `INSERT INTO action_executions
         (id, workspace_id, idempotency_key, proposal_id, plan_id, executed_by_user_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'EXECUTING', ?)`
    ).run(executionId, ctx.workspaceId, idempotencyKey, proposal.proposalId, proposal.planId, ctx.actorId, nowIso());

    proposals.setStatus(db, ctx, proposal.proposalId, 'EXECUTING');
    proposals.record(db, ctx, proposal.proposalId, 'EXECUTING', { executionId });

    // Last check, with the write lock held: nothing can change underneath now.
    const check = proposals.revalidate(db, ctx, proposal, { ignoreExpiry: true });
    if (!check.ok) {
      throw new StaleProposalError(describe(check)[0] || 'The inventory changed before this could run.', {
        current: check.current,
      });
    }

    const before = proposals.currentState(db, ctx.workspaceId, proposal);
    const result = perform(db, ctx, membership, proposal);
    const after = proposals.currentState(db, ctx.workspaceId, proposal);

    const verdict = verification.verify(db, ctx.workspaceId, proposal, { before, after, result });

    db.prepare(
      `INSERT INTO action_verifications
         (id, workspace_id, execution_id, proposal_id, verified, checks, observed_state, problems, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId('avf'),
      ctx.workspaceId,
      executionId,
      proposal.proposalId,
      verdict.verified ? 1 : 0,
      JSON.stringify(verdict.checks),
      JSON.stringify(after),
      JSON.stringify(verdict.problems),
      nowIso()
    );

    db.prepare(
      `UPDATE action_executions
          SET status = 'SUCCEEDED', movement_group_ids = ?, movement_ids = ?, result = ?, finished_at = ?
        WHERE id = ?`
    ).run(
      JSON.stringify(result.groupIds || []),
      JSON.stringify(result.movementIds || []),
      JSON.stringify({ before, after, verified: verdict.verified,
        transferId: result.transferId || null, transferNumber: result.transferNumber || null,
        transferStatus: result.transferStatus || null }),
      nowIso(),
      executionId
    );

    proposals.setStatus(db, ctx, proposal.proposalId, 'SUCCEEDED', { completed: true });
    proposals.record(db, ctx, proposal.proposalId, verdict.verified ? 'SUCCEEDED' : 'SUCCEEDED_UNVERIFIED', {
      executionId,
      before,
      after,
      problems: verdict.problems,
    });

    return {
      executionId,
      status: 'SUCCEEDED',
      replayed: false,
      before,
      after,
      verified: verdict.verified,
      verification: verdict,
      movementIds: result.movementIds || [],
      transferId: result.transferId || null,
      transferNumber: result.transferNumber || null,
      transferStatus: result.transferStatus || null,
      affectedSkuIds: result.skuIds || [],
      proposal: proposals.get(db, ctx.workspaceId, proposal.proposalId),
    };
  });
}

/**
 * The only place an action reaches inventory, and it does so exclusively
 * through Mission 1's public operations.
 */
function perform(db, ctx, membership, proposal) {
  const engineCtx = { workspaceId: ctx.workspaceId, actorId: ctx.actorId };
  const reference = `StockChief ${proposal.proposalId}`;

  if (proposal.actionType === 'receive') {
    return engine.receive(db, engineCtx, {
      skuId: proposal.skuId,
      locationId: proposal.destinationLocationId,
      quantity: proposal.quantity,
      lotId: proposal.lotId || undefined,
      // A batch named on the proposal that does not exist yet. The engine finds
      // or creates it exactly as the receiving form does; nothing new is
      // reachable from here that a person could not already do by hand.
      lotCode: proposal.lotId ? undefined : (proposal.settings && proposal.settings.newLotCode) || undefined,
      reference,
      notes: proposal.notes || undefined,
    });
  }

  if (proposal.actionType === 'issue') {
    return engine.issue(db, engineCtx, {
      skuId: proposal.skuId,
      locationId: proposal.sourceLocationId,
      quantity: proposal.serialUnitIds.length ? undefined : proposal.quantity,
      serialUnitIds: proposal.serialUnitIds.length ? proposal.serialUnitIds : undefined,
      lotId: proposal.lotId || undefined,
      reasonCode: proposal.reasonCode,
      reference,
      notes: proposal.notes || undefined,
    });
  }

  if (proposal.actionType === 'transfer') {
    let transfer = transferService.request(db, engineCtx, membership, {
      fromLocationId: proposal.sourceLocationId, toLocationId: proposal.destinationLocationId,
      reference, notes: proposal.notes || undefined,
      idempotencyKey: `action-transfer-request:${proposal.proposalId}`,
      lines: [{ skuId: proposal.skuId, quantity: proposal.quantity,
        serialUnitIds: proposal.serialUnitIds.length ? proposal.serialUnitIds : undefined,
        lotId: proposal.lotId || undefined }],
    });
    if (permissions.can(membership, permissions.APPROVE_TRANSFER)) {
      transfer = transferService.approve(db, engineCtx, membership, transfer.id,
        { idempotencyKey: `action-transfer-approve:${proposal.proposalId}` });
    }
    return { movementIds: [], groupIds: [], skuIds: [], transferId: transfer.id,
      transferNumber: transfer.transfer_number, transferStatus: transfer.status };
  }

  if (proposal.actionType === 'adjust') {
    return engine.adjust(db, engineCtx, {
      skuId: proposal.skuId,
      locationId: proposal.sourceLocationId,
      countedQty: proposal.adjustmentTarget,
      lotId: proposal.lotId || undefined,
      reasonCode: proposal.reasonCode,
      reference,
      notes: proposal.notes || undefined,
    });
  }

  if (proposal.actionType === 'create_item') {
    const catalogueRecords = (proposal.settings && proposal.settings.catalogueRecords) || [];
    const exactVariants = proposal.settings.exactVariants
      ? (catalogueRecords.length
          ? executableCatalogueVariants(proposal.settings.exactVariants)
          : proposal.settings.exactVariants)
      : null;
    const created = proposal.settings.exactVariants
      ? itemService.createExactItem(db, engineCtx, {
        name: proposal.settings.name,
        baseCode: proposal.settings.code,
        description: proposal.settings.description,
        unitLabel: proposal.settings.unitLabel,
        trackingMode: proposal.settings.trackingMode,
        variants: exactVariants,
      })
      : itemService.createItem(db, engineCtx, catalog.toCreateInput(proposal.settings));
    if (catalogueRecords.length) {
      const bySource = new Map((created.skus || [])
        .map((sku) => [String(sku.sourceKey || sku.code).toLowerCase(), sku]));
      const movementIds = [];
      const groupIds = [];
      for (const record of catalogueRecords) {
        const createdSku = bySource.get(String(record.code || '').toLowerCase());
        if (!createdSku) {
          throw new ValidationError(`The created SKU ${record.code} could not be matched to its supplied record.`);
        }
        const applied = applyCatalogueRecord(
          db, ctx, membership, engineCtx, reference, created.itemId, createdSku.skuId, record
        );
        movementIds.push(...applied.movementIds);
        groupIds.push(...applied.groupIds);
      }
      const kitRecord = catalogueRecords.find((record) => Array.isArray(record.components) && record.components.length);
      if (kitRecord) {
        const kitSku = bySource.get(String(kitRecord.code || '').toLowerCase());
        const components = kitRecord.components.map((component) => {
          const row = db.prepare(`SELECT id FROM skus
            WHERE workspace_id = ? AND code = ? COLLATE NOCASE AND is_active = 1`)
            .get(ctx.workspaceId, component.exactSku);
          if (!row) throw new ValidationError(`Kit component SKU ${component.exactSku} is not in this inventory.`);
          return { skuId: row.id, quantity: component.quantity };
        });
        kits.define(db, engineCtx, {
          kitSkuId: kitSku.skuId,
          components,
          stockBasis: kitRecord.kitStockBasis || 'components',
        });
      }
      return { movementIds, groupIds, itemId: created.itemId, skuIds: created.skuIds };
    }
    const initial = proposal.settings && proposal.settings.initialStock;
    if (!initial) {
      return { movementIds: [], groupIds: [], itemId: created.itemId, skuIds: created.skuIds };
    }
    if (created.skuIds.length !== 1) {
      throw new ValidationError('Initial stock can only be received when the new product resolves to one exact variant.');
    }
    const received = engine.receive(db, engineCtx, {
      skuId: created.skuIds[0],
      locationId: initial.locationId,
      quantity: proposal.settings.trackingMode === 'serial' ? undefined : initial.quantity,
      serials: proposal.settings.trackingMode === 'serial' ? initial.serials : undefined,
      lotCode: proposal.settings.trackingMode === 'lot' ? initial.lotCode : undefined,
      reference,
      notes: `Initial stock recorded while adding ${proposal.settings.name}.`,
    });
    return {
      movementIds: received.movementIds || [],
      groupIds: received.groupId ? [received.groupId] : [],
      itemId: created.itemId,
      skuIds: created.skuIds,
    };
  }

  if (proposal.actionType === 'configure_kit') {
    const configured = kits.define(db, engineCtx, {
      kitSkuId: proposal.skuId,
      components: proposal.settings.components,
    });
    return {
      movementIds: [],
      groupIds: [],
      skuIds: [proposal.skuId, ...configured.components.map((component) => component.component_sku_id)],
      kitSkuId: proposal.skuId,
    };
  }

  if (proposal.actionType === removals.ACTION_TYPE) {
    const kind = removals.kindOf(proposal);
    if (!kind) throw new ValidationError('StockChief cannot remove that sort of record.');
    // The registry decides deletion versus archiving from what currently refers
    // to the record — the same call the preview and the re-check made. Nothing
    // here overrides it, so an approved preview and the outcome cannot diverge.
    const outcome = kind.remove(db, engineCtx, proposal.settings.recordId);
    return {
      movementIds: [],
      groupIds: [],
      recordKind: kind.kind,
      recordId: proposal.settings.recordId,
      recordDeleted: Boolean(outcome && outcome.deleted),
    };
  }

  if (proposal.actionType === 'archive_item') {
    if (proposal.settings.archiveScope === 'item') {
      itemService.setItemActive(db, engineCtx, proposal.itemId, false);
    } else {
      itemService.setSkuActive(db, engineCtx, proposal.skuId, false);
    }
    return { movementIds: [], groupIds: [], skuIds: [proposal.skuId] };
  }

  if (proposal.actionType === 'add_location') {
    const location = locationService.createLocation(db, engineCtx, {
      name: proposal.settings.name,
      kind: proposal.settings.kind,
    });
    return { movementIds: [], groupIds: [], locationId: location.id };
  }

  if (proposal.actionType === 'rename_terminology') {
    applyTerminology(db, ctx.workspaceId, proposal.settings.key, proposal.settings.value);
    return { movementIds: [], groupIds: [] };
  }

  throw new ValidationError(`StockChief cannot carry out “${proposal.actionType}”.`);
}

/** Presentation vocabulary only; the domain never sees these words. */
function applyTerminology(db, workspaceId, key, value) {
  const row = db
    .prepare('SELECT terminology FROM workspace_configuration WHERE workspace_id = ?')
    .get(workspaceId);
  const terminology = row ? JSON.parse(row.terminology || '{}') : {};
  terminology[key] = value;
  if (row) {
    db.prepare('UPDATE workspace_configuration SET terminology = ?, updated_at = ? WHERE workspace_id = ?')
      .run(JSON.stringify(terminology), nowIso(), workspaceId);
  } else {
    db.prepare(
      `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
         operational_defaults, inventory_model, updated_at)
       VALUES (?, ?, 0, ?, '{}', '{}', ?)`
    ).run(workspaceId, nowIso(), JSON.stringify(terminology), nowIso());
  }
}

function findExecution(db, workspaceId, idempotencyKey) {
  return db
    .prepare('SELECT * FROM action_executions WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, idempotencyKey);
}

/** A repeat of an already-executed action returns the original outcome. */
function replay(db, workspaceId, row) {
  const stored = JSON.parse(row.result || '{}');
  const verdict = db
    .prepare('SELECT * FROM action_verifications WHERE execution_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(row.id);
  return {
    executionId: row.id,
    status: row.status,
    replayed: true,
    before: stored.before || {},
    after: stored.after || {},
    verified: Boolean(stored.verified),
    verification: verdict
      ? {
          verified: Boolean(verdict.verified),
          checks: JSON.parse(verdict.checks || '[]'),
          problems: JSON.parse(verdict.problems || '[]'),
        }
      : null,
    movementIds: JSON.parse(row.movement_ids || '[]'),
    transferId: stored.transferId || null,
    transferNumber: stored.transferNumber || null,
    transferStatus: stored.transferStatus || null,
    proposal: row.proposal_id ? proposals.get(db, workspaceId, row.proposal_id) : null,
  };
}

function getExecution(db, workspaceId, executionId) {
  const row = db
    .prepare('SELECT * FROM action_executions WHERE id = ? AND workspace_id = ?')
    .get(executionId, workspaceId);
  return row ? replay(db, workspaceId, row) : null;
}

module.exports = {
  StaleProposalError,
  approve,
  execute,
  perform,
  findExecution,
  getExecution,
  replay,
};

// --- multi-line plans --------------------------------------------------------

const actionService = require('./action-service');

function approvePlan(db, ctx, membership, planId) {
  return inTransaction(db, () => {
    const plan = actionService.getPlan(db, ctx.workspaceId, planId);
    if (!plan) throw new NotFoundError('That plan could not be found.');
    for (const line of plan.lines) permissions.assertCanPerform(membership, line.actionType, line);
    if (plan.status === 'APPROVED') return actionService.getPlan(db, ctx.workspaceId, planId);
    if (plan.status !== 'AWAITING_APPROVAL') throw new ValidationError('That plan is no longer waiting for approval.');

    for (const line of plan.lines) {
      const check = proposals.revalidate(db, ctx, line);
      if (!check.ok) {
        actionService.setPlanStatus(db, ctx.workspaceId, planId, 'INVALIDATED');
        proposals.setStatus(db, ctx, line.proposalId, 'INVALIDATED', { problems: describe(check) });
        throw new StaleProposalError(describe(check)[0] || 'The inventory changed since this was proposed.', {
          current: check.current,
        });
      }
      proposals.setStatus(db, ctx, line.proposalId, 'APPROVED', { approvedBy: ctx.actorId });
      proposals.record(db, ctx, line.proposalId, 'APPROVED', { planId }, planId);
    }
    actionService.setPlanStatus(db, ctx.workspaceId, planId, 'APPROVED', { approvedBy: ctx.actorId });
    return actionService.getPlan(db, ctx.workspaceId, planId);
  });
}

/**
 * Runs every line of a plan inside one transaction.
 *
 * All-or-nothing is the default because a half-applied batch is the worst
 * outcome available: the inventory is left in a state nobody asked for and
 * nobody can name. If any line fails, the whole thing rolls back and the
 * inventory is exactly as it was.
 */
function executePlan(db, ctx, membership, planId, options = {}) {
  const idempotencyKey = options.idempotencyKey || `plan:${planId}`;
  const existing = findExecution(db, ctx.workspaceId, idempotencyKey);
  if (existing) return { ...replay(db, ctx.workspaceId, existing), planId };

  const plan = actionService.getPlan(db, ctx.workspaceId, planId);
  if (!plan) throw new NotFoundError('That plan could not be found.');
  if (plan.status !== 'APPROVED') throw new ValidationError('That plan has not been approved.');
  for (const line of plan.lines) permissions.assertCanPerform(membership, line.actionType, line);

  let outcome;
  try {
    outcome = inTransaction(db, () => {
      const executionId = newId('axe');
      db.prepare(
        `INSERT INTO action_executions
           (id, workspace_id, idempotency_key, proposal_id, plan_id, executed_by_user_id, status, started_at)
         VALUES (?, ?, ?, NULL, ?, ?, 'EXECUTING', ?)`
      ).run(executionId, ctx.workspaceId, idempotencyKey, planId, ctx.actorId, nowIso());

      actionService.setPlanStatus(db, ctx.workspaceId, planId, 'EXECUTING');

      const results = [];
      let allVerified = true;

      // What this plan has moved so far, so a later line is judged against the
      // position its own siblings left behind rather than against a snapshot
      // they have already made out of date.
      const appliedByPlan = { totals: new Map(), positions: new Map() };
      const addEffect = (map, key, delta) => {
        if (!key || !delta) return;
        map.set(key, (map.get(key) || 0) + delta);
      };

      for (const line of orderPlanLinesForExecution(plan.lines)) {
        const check = proposals.revalidate(db, ctx, line, { ignoreExpiry: true, appliedByPlan });
        if (!check.ok) {
          throw new StaleProposalError(
            describe(check)[0] || 'The inventory changed before this could run.',
            { current: check.current, line: line.lineNumber }
          );
        }
        const before = proposals.currentState(db, ctx.workspaceId, line);
        const result = perform(db, ctx, membership, line);
        const after = proposals.currentState(db, ctx.workspaceId, line);
        const verdict = verification.verify(db, ctx.workspaceId, line, { before, after, result });
        if (!verdict.verified) allVerified = false;

        db.prepare(
          `INSERT INTO action_verifications
             (id, workspace_id, execution_id, proposal_id, verified, checks, observed_state, problems, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId('avf'), ctx.workspaceId, executionId, line.proposalId, verdict.verified ? 1 : 0,
          JSON.stringify(verdict.checks), JSON.stringify(after), JSON.stringify(verdict.problems), nowIso()
        );

        // Measured, not predicted: the effect recorded is the difference the
        // engine actually made.
        const keys = proposals.planKeys(line);
        addEffect(appliedByPlan.totals, keys.total, (after.total ?? 0) - (before.total ?? 0));
        addEffect(appliedByPlan.positions, keys.source, (after.sourceOnHand ?? 0) - (before.sourceOnHand ?? 0));
        addEffect(
          appliedByPlan.positions,
          keys.destination,
          (after.destinationOnHand ?? 0) - (before.destinationOnHand ?? 0)
        );

        proposals.setStatus(db, ctx, line.proposalId, 'SUCCEEDED', { completed: true });
        proposals.record(db, ctx, line.proposalId, 'SUCCEEDED', { executionId, before, after }, planId);
        results.push({ proposalId: line.proposalId, before, after,
          transferId: result.transferId || null, transferNumber: result.transferNumber || null,
          transferStatus: result.transferStatus || null,
          verified: verdict.verified, verification: verdict });
      }

      db.prepare(
        `UPDATE action_executions SET status = 'SUCCEEDED', result = ?, finished_at = ? WHERE id = ?`
      ).run(JSON.stringify({ lines: results, verified: allVerified }), nowIso(), executionId);
      actionService.setPlanStatus(db, ctx.workspaceId, planId, 'SUCCEEDED', { completed: true });

      return { executionId, planId, status: 'SUCCEEDED', replayed: false, verified: allVerified, lines: results };
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      const winner = findExecution(db, ctx.workspaceId, idempotencyKey);
      if (winner) return { ...replay(db, ctx.workspaceId, winner), planId };
    }
    // The transaction rolled back, so the plan never half-ran.
    actionService.setPlanStatus(db, ctx.workspaceId, planId, 'FAILED');
    throw error;
  }

  const skuIds = plan.lines.map((l) => l.skuId).filter(Boolean);
  if (skuIds.length) reevaluate.afterMovement(db, ctx.workspaceId, skuIds, 'action:plan');
  return outcome;
}

function retryPlan(db, ctx, membership, planId) {
  return inTransaction(db, () => {
    const plan = actionService.getPlan(db, ctx.workspaceId, planId);
    if (!plan) throw new NotFoundError('That plan could not be found.');
    if (plan.status !== 'FAILED') throw new ValidationError('Only a failed plan can be tried again.');
    for (const line of plan.lines) {
      permissions.assertCanPerform(membership, line.actionType, line);
      if (line.status !== 'APPROVED') {
        throw new ValidationError('This plan is no longer approved and must be reviewed again.');
      }
      const check = proposals.revalidate(db, ctx, line);
      if (!check.ok) throw new StaleProposalError(
        describe(check)[0] || 'The inventory changed since this plan was approved.',
        { current: check.current, line: line.lineNumber }
      );
    }
    actionService.setPlanStatus(db, ctx.workspaceId, planId, 'APPROVED');
    return actionService.getPlan(db, ctx.workspaceId, planId);
  });
}

function orderPlanLinesForExecution(lines) {
  const source = Array.isArray(lines) ? lines : [];
  const producedBy = new Map();
  source.forEach((line, index) => {
    for (const variant of (line.settings && line.settings.exactVariants) || []) {
      const code = String(variant.code || '').trim().toLowerCase();
      if (code && !producedBy.has(code)) producedBy.set(code, index);
    }
  });

  const dependencies = source.map((line) => new Set(
    ((line.settings && line.settings.catalogueRecords) || [])
      .flatMap((record) => record.components || [])
      .map((component) => producedBy.get(String(component.exactSku || '').trim().toLowerCase()))
      .filter((index) => Number.isInteger(index))
  ));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (index) => {
    if (visited.has(index)) return;
    if (visiting.has(index)) throw new ValidationError('Kit components form a circular dependency.');
    visiting.add(index);
    for (const dependency of dependencies[index]) visit(dependency);
    visiting.delete(index);
    visited.add(index);
    ordered.push(source[index]);
  };
  source.forEach((_, index) => visit(index));
  return ordered;
}

module.exports.approvePlan = approvePlan;
module.exports.executePlan = executePlan;
module.exports.retryPlan = retryPlan;
module.exports.executableCatalogueVariants = executableCatalogueVariants;
module.exports.orderPlanLinesForExecution = orderPlanLinesForExecution;
