'use strict';

/**
 * Building and re-checking what Foundry proposes to do.
 *
 * A proposal is a *request* to run one Mission 1 operation. It records what the
 * inventory looked like when it was written, what it expects afterwards, and a
 * hash over its own bytes — so what a person approved is provably what runs.
 *
 * Nothing here mutates stock. The only writes are to the action tables.
 */

const crypto = require('node:crypto');

const { inTransaction } = require('../db');
const repo = require('../domain/repository');
const operatingGuards = require('../domain/operating-guards');
const resolver = require('./resolver');
const catalog = require('../imports/catalog-service');
const policy = require('./policy');
const permissions = require('./permissions');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');
const { ADJUSTMENT_REASON_IDS, ISSUE_REASON_IDS } = require('../domain/constants');

const HASHED_FIELDS = [
  'workspaceId', 'actionType', 'skuId', 'lotId', 'serialUnitIds',
  'sourceLocationId', 'destinationLocationId', 'quantity', 'adjustmentTarget',
  'reasonCode', 'settings', 'expectedBeforeState', 'expectedAfterState', 'proposalVersion',
];

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** A hash over exactly what will be executed, and nothing presentational. */
function computeIntegrityHash(proposal) {
  const subject = {};
  for (const field of HASHED_FIELDS) subject[field] = proposal[field] ?? null;
  return crypto.createHash('sha256').update(stableStringify(subject)).digest('hex');
}

function verifyIntegrity(proposal) {
  return computeIntegrityHash(proposal) === proposal.integrityHash;
}

// --- building ----------------------------------------------------------------

/**
 * Resolves an intent into a fully specified, validated proposal.
 *
 * Returns either `{ ok: true, proposal }` or `{ ok: false, question }` — a
 * question is a legitimate outcome, not a failure: refusing to guess between
 * two products is the behaviour that keeps this safe.
 */
function build(db, ctx, intent, options = {}) {
  const workspaceId = ctx.workspaceId;
  const actionType = intent.actionType;

  if (!policy.MUTATION_ACTIONS.includes(actionType) && !policy.CONFIGURATION_ACTIONS.includes(actionType)) {
    return { ok: false, question: null, unsupported: intent.unsupportedReason || 'Foundry cannot do that yet.' };
  }

  const draft = {
    workspaceId,
    actionType,
    serialUnitIds: [],
    assumptions: Array.isArray(intent.assumptions) ? intent.assumptions.slice(0, 6) : [],
    settings: {},
    proposalVersion: 1,
  };

  if (policy.CONFIGURATION_ACTIONS.includes(actionType)) {
    const configured = buildConfiguration(db, ctx, intent, draft, options);
    if (!configured.ok) return configured;
  } else {
    const resolved = resolveSubject(db, workspaceId, intent, draft, options);
    if (!resolved.ok) return resolved;
    const shaped = shapeOperation(db, workspaceId, intent, draft);
    if (!shaped.ok) return shaped;
  }

  const classification = policy.classify({
    actionType,
    quantity: draft.quantity,
    adjustmentDelta: draft.adjustmentDelta,
    availableAtSource: draft.availableAtSource,
  });

  draft.safetyLevel = classification.safetyLevel;
  draft.approvalRequirement = classification.approvalRequirement;
  draft.warnings = classification.warnings;
  draft.requiredPermission = permissions.permissionForAction(actionType);
  draft.integrityHash = computeIntegrityHash(draft);

  return { ok: true, proposal: draft };
}

function buildConfiguration(db, ctx, intent, draft, options = {}) {
  if (draft.actionType === 'create_item') {
    const planned = catalog.planItem(db, ctx.workspaceId, {
      name: intent.productName || intent.item,
      code: intent.productCode,
      variantAxes: intent.variantAxes,
      unitLabel: intent.unitLabel,
      trackingMode: ['quantity', 'serial', 'lot'].includes(intent.trackingMode) ? intent.trackingMode : null,
    });
    if (!planned.ok) return planned;

    // A code or name that already exists is decisive: creating a second one
    // would split a product's stock across two records nobody meant to have.
    const decisive = planned.plan.conflicts.filter((c) => c.decisive);
    if (decisive.length) {
      return { ok: false, question: null, unsupported: decisive[0].message };
    }

    draft.settings = {
      name: planned.plan.name,
      code: planned.plan.code,
      description: planned.plan.description,
      unitLabel: planned.plan.unitLabel,
      trackingMode: planned.plan.trackingMode,
      hasVariants: planned.plan.hasVariants,
      axes: planned.plan.axes,
    };
    draft.assumptions.push(...planned.plan.assumptions);
    // A resemblance is shown, never acted on.
    for (const conflict of planned.plan.conflicts) draft.assumptions.push(conflict.message);
    draft.expectedBeforeState = { variants: 0, total: 0 };
    draft.expectedAfterState = { variants: planned.plan.variantCount, total: 0 };

    // Creating a catalogue record and recording stock that has just arrived is
    // one business event when the person states both in the same instruction.
    // Keeping the receipt on this proposal is important: the SKU does not exist
    // yet, so a separate receive proposal could neither resolve nor preview it
    // truthfully. Execution still goes through the inventory engine and the
    // surrounding transaction makes the two controlled operations atomic.
    const quantity = Number(intent.quantity);
    const hasInitialStock = Number.isInteger(quantity) && quantity > 0;
    if (!hasInitialStock) return { ok: true };

    if (planned.plan.variantCount !== 1) {
      return {
        ok: false,
        question:
          `You are adding ${planned.plan.name} with ${planned.plan.variantCount} variants. `
          + `Which variant should receive the ${quantity} ${planned.plan.unitLabel}(s)?`,
        clarification: { dimension: 'variant', choices: [] },
      };
    }

    const serials = Array.isArray(intent.serials) ? intent.serials.filter(Boolean) : [];
    const lotCode = String(intent.lotCode || '').trim();
    if (planned.plan.trackingMode === 'serial' && serials.length !== quantity) {
      return {
        ok: false,
        question:
          `${planned.plan.name} is tracked by serial number. `
          + `Provide the ${quantity} serial number${quantity === 1 ? '' : 's'} for the units received.`,
        clarification: { dimension: 'serials', choices: [] },
      };
    }
    if (planned.plan.trackingMode === 'lot' && !lotCode) {
      return {
        ok: false,
        question: `What lot or batch code should be recorded for the ${quantity} ${planned.plan.name} received?`,
        clarification: { dimension: 'lot', choices: [] },
      };
    }

    const namedLocation = String(intent.destinationLocation || intent.sourceLocation || '').trim();
    const resolvedLocation = resolver.resolveLocation(db, ctx.workspaceId, namedLocation, { role: 'receiving location' });
    if (!resolvedLocation.ok) {
      const choices = resolvedLocation.clarification && resolvedLocation.clarification.choices;
      return {
        ok: false,
        question:
          `Where should the ${quantity} ${planned.plan.name}${planned.plan.variantCount === 1 && planned.plan.axes.length
            ? ` / ${planned.plan.axes.map((axis) => axis.values[0]).join(' / ')}` : ''} be received?`,
        clarification: {
          dimension: 'destination_location',
          choices: Array.isArray(choices) ? choices : [],
        },
        choices: Array.isArray(choices) ? choices : [],
      };
    }
    if (resolvedLocation.note) draft.assumptions.push(resolvedLocation.note);

    const location = resolvedLocation.value;
    draft.quantity = quantity;
    draft.destinationLocationId = location.id;
    draft.settings.initialStock = {
      quantity,
      locationId: location.id,
      locationName: location.name,
      lotCode: lotCode || null,
      serials,
    };
    draft.expectedBeforeState = {
      variants: 0,
      total: 0,
      destinationLocationId: location.id,
      destinationLocationName: location.name,
      destinationOnHand: 0,
    };
    draft.expectedAfterState = {
      variants: planned.plan.variantCount,
      total: quantity,
      destinationLocationId: location.id,
      destinationLocationName: location.name,
      destinationOnHand: quantity,
    };
    return { ok: true };
  }

  if (draft.actionType === 'archive_item') {
    const named = String(intent.item || intent.productName || '').trim();
    const variant = String(intent.variant || '').trim();
    const exactItem = !variant && named
      ? db.prepare(
          `SELECT * FROM items WHERE workspace_id = ? AND is_active = 1
            AND (name = ? COLLATE NOCASE OR base_code = ? COLLATE NOCASE)`
        ).get(ctx.workspaceId, named, named)
      : null;

    let sku;
    let scope = 'item';
    if (exactItem) {
      sku = db.prepare(
        `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
           FROM skus s JOIN items i ON i.id = s.item_id
          WHERE s.workspace_id = ? AND s.item_id = ? AND s.is_active = 1
          ORDER BY s.position LIMIT 1`
      ).get(ctx.workspaceId, exactItem.id);
    } else {
      const resolved = resolver.resolveSku(db, ctx.workspaceId, named, variant, {
        instruction: options.instruction,
        groundIdentity: options.groundIdentity,
      });
      if (!resolved.ok) return unresolved(resolved);
      sku = resolved.value;
      const siblings = db.prepare(
        'SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND item_id = ? AND is_active = 1'
      ).get(ctx.workspaceId, sku.item_id).n;
      scope = siblings > 1 ? 'sku' : 'item';
    }
    if (!sku) return { ok: false, question: null, unsupported: 'That product is not active in this inventory.' };

    const itemId = exactItem ? exactItem.id : sku.item_id;
    const total = scope === 'item'
      ? repo.getItemTotal(db, ctx.workspaceId, itemId)
      : db.prepare(
          'SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?'
        ).get(ctx.workspaceId, sku.id).n;
    if (total !== 0) {
      const display = [sku.item_name, scope === 'sku' ? sku.variant_label : null].filter(Boolean).join(' / ');
      return {
        ok: false,
        question: null,
        unsupported: `${display} still has ${total} on hand. Move or issue that stock before removing it from the catalogue.`,
      };
    }

    draft.itemId = itemId;
    draft.skuId = sku.id;
    draft.subject = { kind: 'sku', sku };
    draft.settings = { archiveScope: scope };
    draft.expectedBeforeState = { total: 0, active: true };
    draft.expectedAfterState = { total: 0, active: false };
    return { ok: true };
  }

  if (draft.actionType === 'add_location') {
    const name = String(intent.locationName || intent.destinationLocation || '').trim();
    if (!name) return { ok: false, question: 'What should the new location be called?' };
    const clash = db
      .prepare('SELECT 1 FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
      .get(ctx.workspaceId, name);
    if (clash) return { ok: false, question: null, unsupported: `There is already a location called “${name}”.` };
    draft.settings = { name, kind: intent.locationKind || 'other' };
    draft.expectedBeforeState = { locationCount: repo.listLocations(db, ctx.workspaceId).length };
    draft.expectedAfterState = { locationCount: draft.expectedBeforeState.locationCount + 1 };
    return { ok: true };
  }

  // rename_terminology
  const term = String(intent.terminologyKey || '').trim();
  const value = String(intent.terminologyValue || '').trim();
  if (!term || !value) return { ok: false, question: 'What word would you like Foundry to use, and for what?' };
  if (!['item', 'location', 'variant', 'lot', 'serialUnit'].includes(term)) {
    return { ok: false, question: null, unsupported: 'Foundry can only rename items, locations, variants, lots and units.' };
  }
  draft.settings = { key: term, value };
  draft.expectedBeforeState = { term };
  draft.expectedAfterState = { term, value };
  return { ok: true };
}

/** Which product, lot or units the action is about. */
function noteFrom(draft, result) {
  if (result && result.note) draft.assumptions.push(result.note);
  return result;
}

function unresolved(result, fallback = null) {
  const clarification = result && result.clarification ? result.clarification : fallback;
  return {
    ok: false,
    question: result && result.message ? result.message : null,
    clarification: clarification || null,
    choices: clarification && Array.isArray(clarification.choices) ? clarification.choices : null,
  };
}

/**
 * Which batch the stock leaves from, when the person did not name one.
 *
 * A lot-tracked move has to identify a lot — the engine will not move generic
 * stock of a lot-tracked product, and it is right not to. But "which batch" is
 * usually not a real question: if only one batch of this product is at that
 * location, there is nothing to choose, and asking would be Foundry making its
 * own record-keeping into the person's problem. Several batches is a genuine
 * question, and it is asked with the codes and quantities rather than as a bare
 * instruction to go and find out.
 *
 * Oldest first, because that is the order stock should leave in.
 */
function resolveLotAtSource(db, workspaceId, draft, location, verb) {
  if (draft.lotId || !draft.skuId) return { ok: true };
  const sku = db
    .prepare('SELECT tracking_mode FROM skus s JOIN items i ON i.id = s.item_id WHERE s.id = ? AND s.workspace_id = ?')
    .get(draft.skuId, workspaceId);
  if (!sku || sku.tracking_mode !== 'lot') return { ok: true };

  const lots = db
    .prepare(
      `SELECT l.id, l.code, l.expires_at, lb.quantity
         FROM lot_balances lb JOIN lots l ON l.id = lb.lot_id
        WHERE lb.workspace_id = ? AND lb.location_id = ? AND l.sku_id = ? AND lb.quantity > 0
        ORDER BY COALESCE(l.expires_at, l.received_at), l.code`
    )
    .all(workspaceId, location.id, draft.skuId);

  // None here at all is not a lot problem — the shortfall check says so better.
  if (lots.length === 0) return { ok: true };
  if (lots.length === 1) {
    draft.lotId = lots[0].id;
    draft.assumptions.push(
      `${lots[0].code} is the only batch at ${location.name}, so that is the one that ${verb}.`
    );
    return { ok: true };
  }
  // Batches are not interchangeable, and a list that says only "B-GONE (6)"
  // presents an expired one as an equal choice — offered first, because the
  // ordering is by expiry and expired sorts earliest. Someone reaching for the
  // oldest batch, which is ordinarily the right instinct, issues expired stock.
  //
  // So each batch says when it expires, expired ones say so, and the one
  // Foundry would take — the earliest-expiring batch that is still good — is
  // named. It is still a question: which batch leaves is not Foundry's to
  // assume, and using up an expired batch deliberately is a real decision
  // somebody is allowed to make.
  const today = new Date().toISOString().slice(0, 10);
  const expiryNote = (lot) => {
    if (!lot.expires_at) return '';
    const on = String(lot.expires_at).slice(0, 10);
    return on < today ? `, EXPIRED ${on}` : `, expires ${on}`;
  };
  const usable = lots.filter((lot) => !lot.expires_at || String(lot.expires_at).slice(0, 10) >= today);
  const expired = lots.filter((lot) => !usable.includes(lot));
  const suggestion = usable.length
    ? ` Foundry would take ${usable[0].code}, the earliest to expire of the ones still good.`
    : ' Every batch here has expired.';

  return {
    ok: false,
    question:
      `Which batch should it come from? ${location.name} has ${lots
        .map((lot) => `${lot.code} (${lot.quantity}${expiryNote(lot)})`)
        .join(', ')}.` +
      (expired.length
        ? ` ${expired.map((lot) => lot.code).join(', ')} ${expired.length === 1 ? 'has' : 'have'} already expired.`
        : '') +
      suggestion,
    clarification: {
      dimension: 'lot',
      choices: lots.map((lot) => ({ label: `${lot.code} — ${lot.quantity} available`, value: lot.code })),
    },
    choices: lots.map((lot) => ({ label: `${lot.code} — ${lot.quantity} available`, value: lot.code })),
  };
}

/**
 * A batch number that does not exist yet.
 *
 * Receiving is how a lot comes into being — the receiving form has always taken
 * a new code and created it — so refusing an unknown code on a receive made it
 * impossible to book in a new batch by describing it, which for a business that
 * roasts, bakes or mixes in batches is every single delivery. The code is
 * carried on the proposal and created by the engine at execution, so the person
 * still sees "creates batch R-2602" before anything is written.
 *
 * Anything other than a receive keeps the old refusal: issuing or moving stock
 * out of a batch nobody has ever received is a real error.
 */
function openNewLot(draft, lotCode, failure) {
  if (draft.actionType !== 'receive') return { ok: false, question: failure.message };
  const code = String(lotCode || '').trim();
  if (!code) return { ok: false, question: failure.message };
  draft.settings = { ...(draft.settings || {}), newLotCode: code };
  draft.assumptions = [...(draft.assumptions || []), `${code} is a new batch and will be created by this receipt.`];
  return { ok: true };
}

/**
 * Recover an exact SKU identifier when the language reader mistakes the code
 * for a lot or serial number. A real physical identity still wins: an existing
 * lot/serial is never reinterpreted, and explicit "lot", "batch" or "serial"
 * wording remains specialised identity evidence (including a new lot receipt).
 */
function recoverMisclassifiedSkuIdentifier(db, workspaceId, intent, instruction) {
  const wording = `${intent.sourceText || ''} ${instruction || ''}`;
  if (intent.lotCode) {
    const sku = resolver.resolveExactSkuCode(db, workspaceId, intent.lotCode);
    const itemCode = resolver.hasExactItemCode(db, workspaceId, intent.lotCode);
    const actualLot = resolver.resolveLot(db, workspaceId, intent.lotCode);
    const explicitlyLot = /\b(?:lot|batch)\b/i.test(wording);
    if ((sku || itemCode) && !actualLot.ok && !explicitlyLot) {
      return sku
        ? { ...intent, resolvedSkuId: sku.id, lotCode: '' }
        : { ...intent, item: intent.lotCode, variant: intent.variant || '', lotCode: '' };
    }
  }

  if (Array.isArray(intent.serials) && intent.serials.length === 1) {
    const code = intent.serials[0];
    const sku = resolver.resolveExactSkuCode(db, workspaceId, code);
    const itemCode = resolver.hasExactItemCode(db, workspaceId, code);
    const actualSerial = resolver.resolveSerialUnit(db, workspaceId, code);
    const explicitlySerial = /\b(?:serial|serial number)\b/i.test(wording);
    if ((sku || itemCode) && !actualSerial.ok && !explicitlySerial) {
      return sku
        ? { ...intent, resolvedSkuId: sku.id, serials: [] }
        : { ...intent, item: code, variant: intent.variant || '', serials: [] };
    }
  }
  return intent;
}

function resolveSubject(db, workspaceId, intent, draft, options = {}) {
  intent = recoverMisclassifiedSkuIdentifier(db, workspaceId, intent, options.instruction);
  // An internal caller — a Mission 3 finding, or recalculating an existing
  // proposal — already knows the exact SKU. It is still re-checked against this
  // workspace, so an id from anywhere else simply is not found.
  if (intent.resolvedSkuId) {
    const sku = db
      .prepare(
        `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
           FROM skus s JOIN items i ON i.id = s.item_id
          WHERE s.id = ? AND s.workspace_id = ?`
      )
      .get(intent.resolvedSkuId, workspaceId);
    if (!sku) return { ok: false, question: 'That product is not in this inventory.' };
    draft.skuId = sku.id;
    draft.itemId = sku.item_id;
    draft.subject = { kind: 'sku', sku };
    if (intent.lotCode) {
      const lot = resolver.resolveLot(db, workspaceId, intent.lotCode, sku.id);
      if (!lot.ok) {
        const opened = openNewLot(draft, intent.lotCode, lot);
        if (!opened.ok) return opened;
      } else {
        draft.lotId = lot.value.id;
        draft.subject = { kind: 'lot', lot: lot.value, sku };
      }
    }
    if (Array.isArray(intent.serials) && intent.serials.length) {
      const units = resolver.resolveSerialUnits(db, workspaceId, intent.serials);
      if (!units.ok) return unresolved(units);
      draft.serialUnitIds = units.value.map((u) => u.id);
      draft.subject = { kind: 'serial', units: units.value };
    }
    return { ok: true };
  }

  if (Array.isArray(intent.serials) && intent.serials.length > 0) {
    const units = resolver.resolveSerialUnits(db, workspaceId, intent.serials);
    if (!units.ok) return unresolved(units);
    draft.serialUnitIds = units.value.map((u) => u.id);
    draft.skuId = units.value[0].sku_id;
    draft.itemId = units.value[0].item_id;
    draft.subject = { kind: 'serial', units: units.value };
    return { ok: true };
  }

  if (intent.lotCode) {
    // A named lot is never satisfied by generic stock of the same product.
    const skuHint = intent.item
      ? resolver.resolveSku(db, workspaceId, intent.item, intent.variant, {
          instruction: options.instruction,
          groundIdentity: options.groundIdentity,
        })
      : null;
    const lot = resolver.resolveLot(db, workspaceId, intent.lotCode, skuHint && skuHint.ok ? skuHint.value.id : null);
    if (!lot.ok) {
      // A receive names the batch it is creating, so an unknown code is the
      // normal case rather than a failure — but only once the product is known,
      // because a lot code alone cannot say what it is a batch of.
      if (draft.actionType === 'receive' && skuHint && skuHint.ok) {
        const sku = skuHint.value;
        draft.skuId = sku.id;
        draft.itemId = sku.item_id;
        draft.subject = { kind: 'sku', sku };
        const opened = openNewLot(draft, intent.lotCode, lot);
        if (!opened.ok) return opened;
        return { ok: true };
      }
      return unresolved(lot);
    }
    draft.lotId = lot.value.id;
    draft.skuId = lot.value.sku_id;
    const sku = repo.requireSku(db, workspaceId, lot.value.sku_id);
    draft.itemId = sku.item_id;
    draft.subject = { kind: 'lot', lot: lot.value, sku };
    return { ok: true };
  }

  const sku = noteFrom(draft, resolver.resolveSku(
    db, workspaceId, intent.item, intent.variant, {
      instruction: options.instruction,
      groundIdentity: options.groundIdentity,
    }
  ));
  if (!sku.ok) return unresolved(sku);
  draft.skuId = sku.value.id;
  draft.itemId = sku.value.item_id;
  draft.subject = { kind: 'sku', sku: sku.value };

  // A serialized product cannot be moved by quantity alone. Asking which units
  // without naming any is the same bad question the location resolver refuses
  // to ask below: one unit in stock is not a choice at all, and several is only
  // answerable if Foundry says what they are.
  if (sku.value.tracking_mode === 'serial' && ['issue', 'transfer', 'adjust'].includes(draft.actionType)) {
    const units = db
      .prepare(
        `SELECT su.id, su.serial, l.name AS location_name
           FROM serial_units su LEFT JOIN locations l ON l.id = su.location_id
          WHERE su.workspace_id = ? AND su.sku_id = ? AND su.status = 'in_stock'
          ORDER BY su.serial LIMIT 9`
      )
      .all(workspaceId, draft.skuId);

    if (units.length === 0) {
      return {
        ok: false,
        question: null,
        unsupported: `${sku.value.item_name} has no units in stock, so there is nothing to ${draft.actionType}.`,
      };
    }
    if (units.length === 1) {
      draft.serialUnitIds = [units[0].id];
      draft.assumptions.push(
        `${units[0].serial} is the only ${sku.value.item_name} in stock, so that is the one.`
      );
    } else {
      const listed = units.slice(0, 8).map((u) => u.serial).join(', ');
      return {
        ok: false,
        question:
          `${sku.value.item_name} is tracked by individual unit. Which one? ` +
          `${listed}${units.length > 8 ? ', and others' : ''}.`,
        clarification: {
          dimension: 'serial_unit',
          choices: units.slice(0, 8).map((unit) => ({
            label: `${unit.serial}${unit.location_name ? ` — ${unit.location_name}` : ''}`,
            value: unit.serial,
          })),
        },
        choices: units.slice(0, 8).map((unit) => ({
          label: `${unit.serial}${unit.location_name ? ` — ${unit.location_name}` : ''}`,
          value: unit.serial,
        })),
      };
    }
  }
  return { ok: true };
}

/**
 * Where stock currently is.
 *
 * Asking someone to tell Foundry where their own stock is, when the records
 * already say, is a bad question. Three answers are possible and they are not
 * the same: exactly one place (use it), several (ask, and *list* them with what
 * is in each), or none at all (say that, rather than asking which of the
 * nowheres it should come from).
 */
function inferSource(db, workspaceId, draft) {
  if (draft.serialUnitIds.length && draft.subject && draft.subject.units) {
    const places = [...new Set(draft.subject.units.map((u) => u.location_id).filter(Boolean))];
    if (places.length === 1) {
      const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(places[0]);
      return { ok: true, location };
    }
    return { ok: false, reason: places.length ? 'several' : 'none', rows: [] };
  }

  const rows = draft.lotId
    ? db
        .prepare(
          `SELECT lb.location_id AS id, l.name, lb.quantity AS onHand
             FROM lot_balances lb JOIN locations l ON l.id = lb.location_id
            WHERE lb.workspace_id = ? AND lb.lot_id = ? AND lb.quantity > 0
            ORDER BY lb.quantity DESC`
        )
        .all(workspaceId, draft.lotId)
    : db
        .prepare(
          `SELECT b.location_id AS id, l.name, b.on_hand AS onHand
             FROM balances b JOIN locations l ON l.id = b.location_id
            WHERE b.workspace_id = ? AND b.sku_id = ? AND b.on_hand > 0
            ORDER BY b.on_hand DESC`
        )
        .all(workspaceId, draft.skuId);

  if (rows.length === 1) {
    const location = db.prepare('SELECT * FROM locations WHERE id = ?').get(rows[0].id);
    return { ok: true, location, onHand: rows[0].onHand };
  }
  return { ok: false, reason: rows.length ? 'several' : 'none', rows };
}

/** What this action is about, in the words a person would use. */
function subjectName(draft) {
  if (draft.subject && draft.subject.lot) return `lot ${draft.subject.lot.code}`;
  if (draft.subject && draft.subject.sku) {
    const sku = draft.subject.sku;
    return sku.variant_label ? `${sku.item_name} (${sku.variant_label})` : sku.item_name;
  }
  if (draft.subject && draft.subject.units) {
    return draft.subject.units.map((u) => u.serial).join(', ');
  }
  return 'that';
}

/** Locations, quantities, reasons — and the before/after this action expects. */
function shapeOperation(db, workspaceId, intent, draft) {
  const { actionType } = draft;
  const quantity = Number.isFinite(Number(intent.quantity)) ? Math.trunc(Number(intent.quantity)) : null;

  /**
   * How many, when they did not say.
   *
   * An instruction with no number plainly means all of whatever is there, and
   * asking someone how much they have when the records already say is a poor
   * question. The amount is proposed, shown in the preview, and adjustable
   * there — and if it is most of the stock, the ordinary warning covers it.
   */
  /**
   * Asking for more than exists is answered now, not by a failure later. The
   * engine would refuse it anyway; hearing that at the moment you ask is worth
   * far more than hearing it after you approve.
   */
  /**
   * Refusing is a fact about the inventory, not a gap in the sentence.
   *
   * Everything needed to answer is already known here — the product, the
   * place, what is there and what was asked for — so the refusal carries all
   * of it rather than a sentence someone downstream has to re-derive. What
   * cannot be re-derived from prose is where else the stock is, which is the
   * one thing that makes the refusal actionable.
   *
   * The rule itself is the item's, not this function's: an item allowed to go
   * negative has already said this is permitted, and blocking it here would
   * refuse something the engine would accept.
   */
  const checkAvailable = (wanted, available, where) => {
    if (wanted <= available) return null;
    const sku = resolver.skuById(db, workspaceId, draft.skuId);
    if (sku && sku.tracking_mode === 'quantity' && sku.allow_negative) return null;
    return {
      ok: false,
      question: null,
      unsupported:
        available === 0
          ? `There is none at ${where}.`
          : `There ${available === 1 ? 'is' : 'are'} only ${available} at ${where}, and you asked for ${wanted}.`,
      blocked: {
        reason: 'insufficient_stock',
        wanted,
        available,
        subject: subjectName(draft),
        skuId: draft.skuId,
        locationId: draft.sourceLocationId || null,
        locationName: where,
        elsewhere: resolver.stockElsewhere(db, workspaceId, draft.skuId, draft.sourceLocationId),
      },
    };
  };

  const inferQuantity = (available) => {
    if (available <= 0) return null;
    draft.assumptions.push(
      available === 1
        ? 'You did not say how many, and there is only one.'
        : `You did not say how many, so Foundry is proposing all ${available}.`
    );
    return available;
  };

  /** Resolves the named source, or works it out when it can only be one place. */
  const resolveSource = (text, role) => {
    if (String(text || '').trim()) {
      return noteFrom(draft, resolver.resolveLocation(db, workspaceId, text, { role }));
    }

    const inferred = inferSource(db, workspaceId, draft);
    if (inferred.ok) {
      draft.assumptions.push(
        draft.serialUnitIds.length
          ? `It is currently at ${inferred.location.name}.`
          : `All of it is at ${inferred.location.name}, so that is where it comes from.`
      );
      return { ok: true, value: inferred.location, candidates: [inferred.location] };
    }

    if (inferred.reason === 'none') {
      // Not a question: they cannot answer it, because there is nothing to move.
      return {
        ok: false,
        empty: true,
        message: `There is no ${subjectName(draft)} in stock anywhere in this inventory.`,
      };
    }

    const where = inferred.rows.map((r) => `${r.name} (${r.onHand})`).join(', ');
    return {
      ok: false,
      message: `${subjectName(draft)} is at ${where}. Which should it come out of?`,
      clarification: {
        dimension: 'source_location',
        choices: inferred.rows.map((row) => ({ label: `${row.name} — ${row.onHand} on hand`, value: row.name })),
      },
    };
  };

  if (actionType === 'receive') {
    const into = noteFrom(draft, resolver.resolveLocation(db, workspaceId, intent.destinationLocation, { role: 'location' }));
    if (!into.ok) return unresolved(into);
    draft.destinationLocationId = into.value.id;

    if (draft.serialUnitIds.length) {
      return { ok: false, question: null, unsupported: 'Receiving new serial numbers is done from the item page.' };
    }
    if (!quantity || quantity <= 0) {
      return { ok: false, question: 'How many are you receiving?', clarification: { dimension: 'quantity', choices: [] } };
    }
    draft.quantity = quantity;
    draft.reasonCode = null;
    draft.availableAtSource = resolver.balanceAt(db, workspaceId, draft.skuId, into.value.id);
    draft.expectedBeforeState = beforeState(db, workspaceId, draft, { destination: into.value });
    draft.expectedAfterState = {
      ...draft.expectedBeforeState,
      destinationOnHand: draft.expectedBeforeState.destinationOnHand + quantity,
      total: draft.expectedBeforeState.total + quantity,
    };
    return { ok: true };
  }

  if (actionType === 'issue') {
    const from = resolveSource(intent.sourceLocation, 'location');
    if (!from.ok) {
      return from.empty
        ? { ok: false, question: null, unsupported: `${from.message} Receive some before issuing any.` }
        : unresolved(from);
    }
    draft.sourceLocationId = from.value.id;

    const issueLot = resolveLotAtSource(db, workspaceId, draft, from.value, 'goes');
    if (!issueLot.ok) return { ...issueLot, ok: false };

    draft.availableAtSource = draft.lotId
      ? resolver.lotBalanceAt(db, workspaceId, draft.lotId, from.value.id)
      : resolver.balanceAt(db, workspaceId, draft.skuId, from.value.id);

    if (draft.serialUnitIds.length) {
      draft.quantity = draft.serialUnitIds.length;
    } else if (quantity && quantity > 0) {
      const shortfall = checkAvailable(quantity, draft.availableAtSource, from.value.name);
      if (shortfall) return shortfall;
      draft.quantity = quantity;
    } else {
      const inferred = inferQuantity(draft.availableAtSource);
      if (inferred === null) {
        return { ok: false, question: null, unsupported: `There is none at ${from.value.name} to issue.` };
      }
      draft.quantity = inferred;
    }
    const guarded = operatingGuards.evaluateIssue(db, workspaceId, {
      skuId: draft.skuId, locationId: from.value.id, quantity: draft.quantity,
    });
    if (guarded) {
      return {
        ok: false,
        question: null,
        unsupported: guarded.message,
        blocked: {
          reason: 'operating_guard',
          ruleId: guarded.rule.id,
          threshold: guarded.rule.threshold,
          comparator: guarded.rule.comparator,
          releaseCondition: guarded.rule.releaseCondition,
          releaseThreshold: guarded.rule.releaseThreshold,
          before: guarded.before,
          after: guarded.after,
          onOrder: guarded.onOrder,
          subject: subjectName(draft),
          skuId: draft.skuId,
          locationId: from.value.id,
          locationName: from.value.name,
        },
      };
    }
    draft.reasonCode = ISSUE_REASON_IDS.includes(intent.reasonCode) ? intent.reasonCode : 'sold';
    draft.expectedBeforeState = beforeState(db, workspaceId, draft, { source: from.value });
    draft.expectedAfterState = {
      ...draft.expectedBeforeState,
      sourceOnHand: draft.expectedBeforeState.sourceOnHand - draft.quantity,
      total: draft.expectedBeforeState.total - draft.quantity,
    };
    return { ok: true };
  }

  if (actionType === 'transfer') {
    // A transfer needs somewhere to go. With a single location there is no
    // answer to "which location?", and asking anyway sends someone hunting the
    // screen for an option that does not exist. Foundry knows how many
    // locations it has, so it should say this rather than ask.
    const places = repo.listLocations(db, workspaceId);
    if (places.length < 2) {
      return {
        ok: false,
        question: null,
        unsupported: places.length === 1
          ? `${places[0].name} is the only location in this inventory, so there is nowhere to move stock to. ` +
            'Add a second location and Foundry can move stock between them.'
          : 'This inventory has no locations yet, so there is nowhere to move stock to.',
      };
    }

    const from = resolveSource(intent.sourceLocation, 'source location');
    if (!from.ok) {
      return from.empty
        ? { ok: false, question: null, unsupported: `${from.message} Receive some before moving any.` }
        : unresolved(from);
    }
    const to = noteFrom(draft, resolver.resolveLocation(db, workspaceId, intent.destinationLocation, { role: 'destination' }));
    if (!to.ok) {
      return {
        ...unresolved(to),
        // A destination may legitimately be new. Preserve that fact so the
        // interface can offer a safe location preview instead of reducing the
        // result to a brief flash message that is easy to miss.
        missingLocation: to.reason === 'not_found' && String(intent.destinationLocation || '').trim()
          ? { role: 'destination', name: String(intent.destinationLocation).trim() }
          : null,
      };
    }
    if (from.value.id === to.value.id) {
      return { ok: false, question: null, unsupported: 'That is the same location on both sides.' };
    }
    draft.sourceLocationId = from.value.id;
    draft.destinationLocationId = to.value.id;

    const moveLot = resolveLotAtSource(db, workspaceId, draft, from.value, 'moves');
    if (!moveLot.ok) return { ...moveLot, ok: false };

    draft.availableAtSource = draft.lotId
      ? resolver.lotBalanceAt(db, workspaceId, draft.lotId, from.value.id)
      : resolver.balanceAt(db, workspaceId, draft.skuId, from.value.id);

    if (draft.serialUnitIds.length) {
      draft.quantity = draft.serialUnitIds.length;
    } else if (quantity && quantity > 0) {
      const shortfall = checkAvailable(quantity, draft.availableAtSource, from.value.name);
      if (shortfall) return shortfall;
      draft.quantity = quantity;
    } else {
      const inferred = inferQuantity(draft.availableAtSource);
      if (inferred === null) {
        return { ok: false, question: null, unsupported: `There is none at ${from.value.name} to move.` };
      }
      draft.quantity = inferred;
    }
    draft.expectedBeforeState = beforeState(db, workspaceId, draft, { source: from.value, destination: to.value });
    draft.expectedAfterState = {
      ...draft.expectedBeforeState,
      sourceOnHand: draft.expectedBeforeState.sourceOnHand - draft.quantity,
      destinationOnHand: draft.expectedBeforeState.destinationOnHand + draft.quantity,
      // A transfer never creates or destroys stock.
      total: draft.expectedBeforeState.total,
    };
    return { ok: true };
  }

  // adjust
  let at = resolveSource(intent.sourceLocation || intent.destinationLocation, 'location');
  if (!at.ok && at.empty) {
    // Correcting up from nothing is a real thing to do ("we found five"), so a
    // zero balance is not a refusal here — it just needs a place.
    const locations = repo.listLocations(db, workspaceId).filter((l) => l.is_active);
    if (locations.length === 1) {
      draft.assumptions.push(`${locations[0].name} is the only location here.`);
      at = { ok: true, value: locations[0] };
    } else {
      at = {
        ok: false,
        message: `Which location's count should change? ${locations.map((l) => l.name).join(', ')}.`,
        clarification: {
          dimension: 'location',
          choices: locations.map((location) => ({ label: location.name, value: location.name })),
        },
      };
    }
  }
  if (!at.ok) return unresolved(at);
  draft.sourceLocationId = at.value.id;

  const countLot = resolveLotAtSource(db, workspaceId, draft, at.value, 'gets corrected');
  if (!countLot.ok) return { ...countLot, ok: false };

  const current = draft.lotId
    ? resolver.lotBalanceAt(db, workspaceId, draft.lotId, at.value.id)
    : resolver.balanceAt(db, workspaceId, draft.skuId, at.value.id);

  let target = Number.isFinite(Number(intent.adjustmentTarget)) ? Math.trunc(Number(intent.adjustmentTarget)) : null;
  if (target === null && quantity !== null && intent.adjustmentIsDelta) target = current + quantity;
  if (target === null) {
    return {
      ok: false,
      question: 'What should the count be after the correction?',
      clarification: { dimension: 'quantity', choices: [] },
    };
  }
  if (target < 0) return { ok: false, question: null, unsupported: 'A count cannot be negative.' };
  if (target === current) {
    return {
      ok: false,
      question: null,
      noChange: true,
      unsupported: `The count here is already ${current}. Nothing to correct.`,
    };
  }

  // A correction's reason carries audit meaning, so it is never invented.
  if (!ADJUSTMENT_REASON_IDS.includes(intent.reasonCode)) {
    return {
      ok: false,
      question: `Why is the count changing from ${current} to ${target}? Foundry needs the reason on record.`,
      needsReason: true,
      // The action service uses these resolved facts to describe a grouped
      // correction truthfully. They are not accepted from the browser and do
      // not mutate stock; they only prevent a twelve-line opening balance from
      // being presented as though Foundry understood its first line alone.
      reasonContext: { current, target },
      clarification: { dimension: 'reason', choices: [] },
    };
  }

  draft.adjustmentTarget = target;
  draft.adjustmentDelta = target - current;
  draft.quantity = Math.abs(target - current);
  draft.reasonCode = intent.reasonCode;
  draft.availableAtSource = current;
  draft.expectedBeforeState = beforeState(db, workspaceId, draft, { source: at.value });
  draft.expectedAfterState = {
    ...draft.expectedBeforeState,
    sourceOnHand: target,
    total: draft.expectedBeforeState.total + (target - current),
  };
  return { ok: true };
}

/** The numbers this proposal is standing on, read fresh. */
function beforeState(db, workspaceId, draft, { source = null, destination = null } = {}) {
  const state = {
    total: draft.lotId
      ? resolver.lotTotal(db, workspaceId, draft.lotId)
      : resolver.skuTotal(db, workspaceId, draft.skuId),
  };
  if (source) {
    state.sourceLocationId = source.id;
    state.sourceLocationName = source.name;
    state.sourceOnHand = draft.lotId
      ? resolver.lotBalanceAt(db, workspaceId, draft.lotId, source.id)
      : resolver.balanceAt(db, workspaceId, draft.skuId, source.id);
  }
  if (destination) {
    state.destinationLocationId = destination.id;
    state.destinationLocationName = destination.name;
    state.destinationOnHand = draft.lotId
      ? resolver.lotBalanceAt(db, workspaceId, draft.lotId, destination.id)
      : resolver.balanceAt(db, workspaceId, draft.skuId, destination.id);
  }
  if (draft.serialUnitIds.length && draft.subject && draft.subject.units) {
    state.units = draft.subject.units.map((u) => ({
      unitId: u.id,
      serial: u.serial,
      locationId: u.location_id,
      locationName: u.location_name,
    }));
  }
  return state;
}

// --- persistence -------------------------------------------------------------

function persist(db, ctx, proposal, meta = {}) {
  const id = newId('act');
  const now = nowIso();
  const expiresAt = new Date(Date.now() + policy.PROPOSAL_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO action_proposals (
       id, workspace_id, plan_id, line_number, requested_by_user_id, source_type,
       source_attention_id, source_proposal_id, original_instruction, action_type,
       item_id, sku_id, serial_unit_ids, lot_id, source_location_id, destination_location_id,
       quantity, adjustment_target, reason_code, notes, settings,
       expected_before_state, expected_after_state, assumptions, warnings,
       safety_level, approval_requirement, required_permission,
       validation_status, validation_problems, clarifying_question,
       status, proposal_version, integrity_hash, created_at, expires_at
     ) VALUES (
       @id, @workspaceId, @planId, @lineNumber, @requestedBy, @sourceType,
       @sourceAttentionId, @sourceProposalId, @instruction, @actionType,
       @itemId, @skuId, @serialUnitIds, @lotId, @sourceLocationId, @destinationLocationId,
       @quantity, @adjustmentTarget, @reasonCode, @notes, @settings,
       @before, @after, @assumptions, @warnings,
       @safetyLevel, @approvalRequirement, @requiredPermission,
       'VALID', '[]', NULL,
       'AWAITING_APPROVAL', @proposalVersion, @integrityHash, @now, @expiresAt
     )`
  ).run({
    id,
    workspaceId: ctx.workspaceId,
    planId: meta.planId || null,
    lineNumber: meta.lineNumber || 1,
    requestedBy: ctx.actorId,
    sourceType: meta.sourceType || 'USER_REQUEST',
    sourceAttentionId: meta.sourceAttentionId || null,
    sourceProposalId: meta.sourceProposalId || null,
    instruction: meta.instruction || null,
    actionType: proposal.actionType,
    itemId: proposal.itemId || null,
    skuId: proposal.skuId || null,
    serialUnitIds: JSON.stringify(proposal.serialUnitIds || []),
    lotId: proposal.lotId || null,
    sourceLocationId: proposal.sourceLocationId || null,
    destinationLocationId: proposal.destinationLocationId || null,
    quantity: proposal.quantity ?? null,
    adjustmentTarget: proposal.adjustmentTarget ?? null,
    reasonCode: proposal.reasonCode || null,
    notes: meta.notes || null,
    settings: JSON.stringify(proposal.settings || {}),
    before: JSON.stringify(proposal.expectedBeforeState || {}),
    after: JSON.stringify(proposal.expectedAfterState || {}),
    assumptions: JSON.stringify(proposal.assumptions || []),
    warnings: JSON.stringify(proposal.warnings || []),
    safetyLevel: proposal.safetyLevel,
    approvalRequirement: proposal.approvalRequirement,
    requiredPermission: proposal.requiredPermission,
    proposalVersion: proposal.proposalVersion || 1,
    integrityHash: proposal.integrityHash,
    now,
    expiresAt,
  });

  record(db, ctx, id, 'PROPOSED', { actionType: proposal.actionType, source: meta.sourceType || 'USER_REQUEST' });
  return get(db, ctx.workspaceId, id);
}

function record(db, ctx, proposalId, event, detail = {}, planId = null) {
  db.prepare(
    `INSERT INTO action_events (id, workspace_id, proposal_id, plan_id, event, detail, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId('aev'), ctx.workspaceId, proposalId, planId, event, JSON.stringify(detail), ctx.actorId || null, nowIso());
}

function hydrate(row) {
  if (!row) return null;
  return {
    proposalId: row.id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    lineNumber: row.line_number,
    requestedByUserId: row.requested_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    sourceType: row.source_type,
    sourceAttentionId: row.source_attention_id,
    sourceProposalId: row.source_proposal_id,
    originalInstruction: row.original_instruction,
    actionType: row.action_type,
    itemId: row.item_id,
    skuId: row.sku_id,
    serialUnitIds: JSON.parse(row.serial_unit_ids || '[]'),
    lotId: row.lot_id,
    sourceLocationId: row.source_location_id,
    destinationLocationId: row.destination_location_id,
    quantity: row.quantity,
    adjustmentTarget: row.adjustment_target,
    reasonCode: row.reason_code,
    notes: row.notes,
    settings: JSON.parse(row.settings || '{}'),
    expectedBeforeState: JSON.parse(row.expected_before_state || '{}'),
    expectedAfterState: JSON.parse(row.expected_after_state || '{}'),
    assumptions: JSON.parse(row.assumptions || '[]'),
    warnings: JSON.parse(row.warnings || '[]'),
    safetyLevel: row.safety_level,
    approvalRequirement: row.approval_requirement,
    requiredPermission: row.required_permission,
    validationStatus: row.validation_status,
    validationProblems: JSON.parse(row.validation_problems || '[]'),
    clarifyingQuestion: row.clarifying_question,
    status: row.status,
    proposalVersion: row.proposal_version,
    integrityHash: row.integrity_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
  };
}

function get(db, workspaceId, proposalId) {
  return hydrate(
    db.prepare('SELECT * FROM action_proposals WHERE id = ? AND workspace_id = ?').get(proposalId, workspaceId)
  );
}

function listOpen(db, workspaceId, { limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT * FROM action_proposals
        WHERE workspace_id = ? AND status IN ('AWAITING_APPROVAL', 'APPROVED')
        ORDER BY created_at DESC LIMIT ?`
    )
    .all(workspaceId, limit)
    .map(hydrate);
}

function listForAttention(db, workspaceId, attentionId) {
  return db
    .prepare(
      `SELECT * FROM action_proposals
        WHERE workspace_id = ? AND source_attention_id = ?
        ORDER BY created_at DESC`
    )
    .all(workspaceId, attentionId)
    .map(hydrate);
}

function events(db, workspaceId, proposalId) {
  return db
    .prepare(
      `SELECT e.*, u.name AS actor_name FROM action_events e
         LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.workspace_id = ? AND e.proposal_id = ?
        -- rowid, not id: ids are random, and two events written in the same
        -- millisecond must still come back in the order they happened.
        ORDER BY e.created_at, e.rowid`
    )
    .all(workspaceId, proposalId)
    .map((row) => ({
      event: row.event,
      detail: JSON.parse(row.detail || '{}'),
      actorName: row.actor_name,
      createdAt: row.created_at,
    }));
}

// --- revalidation ------------------------------------------------------------

function expired(proposal, now = Date.now()) {
  return new Date(proposal.expiresAt).getTime() <= now;
}

/**
 * Re-reads inventory truth and compares it with what the proposal expects.
 *
 * This is the check that matters most: a recommendation written twenty minutes
 * ago was written against numbers that may since have moved, and executing it
 * blind would apply yesterday's reasoning to today's stock.
 */
function revalidate(db, ctx, proposal, options = {}) {
  const problems = [];
  const workspaceId = ctx.workspaceId;

  if (proposal.workspaceId !== workspaceId) {
    return { ok: false, problems: ['That action belongs to a different inventory.'], fatal: true };
  }
  if (!verifyIntegrity(proposal)) {
    return { ok: false, problems: ['This proposal has been altered since it was created.'], fatal: true };
  }
  if (!options.ignoreExpiry && expired(proposal)) {
    return { ok: false, problems: ['This proposal has expired. Foundry will work it out again.'], expired: true };
  }

  if (policy.CONFIGURATION_ACTIONS.includes(proposal.actionType)) {
    if (proposal.actionType === 'add_location') {
      const clash = db
        .prepare('SELECT 1 FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
        .get(workspaceId, proposal.settings.name);
      if (clash) problems.push(`There is now already a location called “${proposal.settings.name}”.`);
    }
    if (proposal.actionType === 'create_item') {
      const conflict = catalog.findConflicts(db, workspaceId, {
        name: proposal.settings.name,
        code: proposal.settings.code,
      }).find((entry) => entry.decisive);
      if (conflict) problems.push(conflict.message);

      if (proposal.settings.initialStock) {
        const location = db
          .prepare('SELECT is_active FROM locations WHERE id = ? AND workspace_id = ?')
          .get(proposal.destinationLocationId, workspaceId);
        if (!location) problems.push('The receiving location is no longer in this inventory.');
        else if (!location.is_active) problems.push('The receiving location has been archived.');
      }
    }
    if (proposal.actionType === 'archive_item') {
      const scope = proposal.settings.archiveScope;
      const row = scope === 'item'
        ? db.prepare('SELECT is_active FROM items WHERE id = ? AND workspace_id = ?')
            .get(proposal.itemId, workspaceId)
        : db.prepare('SELECT is_active FROM skus WHERE id = ? AND workspace_id = ?')
            .get(proposal.skuId, workspaceId);
      if (!row) problems.push('That catalogue record is no longer in this inventory.');
      else if (!row.is_active) problems.push('That catalogue record has already been archived.');
      const total = scope === 'item'
        ? repo.getItemTotal(db, workspaceId, proposal.itemId)
        : resolver.skuTotal(db, workspaceId, proposal.skuId);
      if (total !== 0) problems.push(`That catalogue record now has ${total} on hand.`);
    }
    return { ok: problems.length === 0, problems, current: {} };
  }

  // Everything the action touches must still exist, and still be ours.
  const sku = proposal.skuId
    ? db.prepare('SELECT * FROM skus WHERE id = ? AND workspace_id = ?').get(proposal.skuId, workspaceId)
    : null;
  if (proposal.skuId && !sku) problems.push('That product is no longer in this inventory.');

  for (const [id, label] of [
    [proposal.sourceLocationId, 'source location'],
    [proposal.destinationLocationId, 'destination'],
  ]) {
    if (!id) continue;
    const location = db
      .prepare('SELECT * FROM locations WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId);
    if (!location) problems.push(`The ${label} is no longer in this inventory.`);
    else if (!location.is_active) problems.push(`The ${label} has been archived.`);
  }

  if (proposal.lotId) {
    const lot = db.prepare('SELECT * FROM lots WHERE id = ? AND workspace_id = ?').get(proposal.lotId, workspaceId);
    if (!lot) problems.push('That lot is no longer in this inventory.');
    else if (lot.sku_id !== proposal.skuId) problems.push('That lot belongs to a different product now.');
  }

  for (const unitId of proposal.serialUnitIds) {
    const unit = db
      .prepare('SELECT * FROM serial_units WHERE id = ? AND workspace_id = ?')
      .get(unitId, workspaceId);
    if (!unit) problems.push('One of those units is no longer in this inventory.');
    else if (unit.status !== 'in_stock') problems.push(`${unit.serial} has already been issued.`);
    else if (proposal.sourceLocationId && unit.location_id !== proposal.sourceLocationId) {
      problems.push(`${unit.serial} is no longer at the source location.`);
    }
  }

  // And the numbers it was standing on.
  const current = currentState(db, workspaceId, proposal);
  if (['issue', 'transfer'].includes(proposal.actionType)) {
    const available = current.sourceOnHand ?? 0;
    if (proposal.serialUnitIds.length === 0 && available < proposal.quantity) {
      problems.push(
        `There ${available === 1 ? 'is' : 'are'} only ${available} available at ` +
          `${current.sourceLocationName || 'the source'} now; the action needs ${proposal.quantity}.`
      );
    }
  }

  // A plan's own earlier lines are not somebody else moving the stock.
  //
  // expectedBeforeState carries `total`, which for a product without lots is
  // the total across every location. Twelve opening counts for one product at
  // two locations therefore invalidated themselves: line 1 set Main Warehouse
  // to 50, which moved the product's total, and line 7 — a different location
  // entirely — was then judged stale against the snapshot it was built from.
  // The whole plan rolled back with "the stock changed since this was worked
  // out", which was true only of the plan itself.
  //
  // Outside interference still counts: only the exact amounts this plan has
  // already applied are forgiven, so a real change underneath it is caught.
  const expectedBefore = rebaseForPlan(proposal, options.appliedByPlan);

  const drift = policy.materiallyChanged(
    { ...proposal, expectedBeforeState: expectedBefore },
    { ...proposal, expectedBeforeState: current }
  );

  return {
    ok: problems.length === 0 && !drift.changed,
    problems,
    changed: drift.changed,
    changedField: drift.field,
    current,
  };
}

/** Keys the running effect of a plan by what it actually moves. */
function planKeys(proposal) {
  const subject = proposal.lotId || proposal.skuId;
  return {
    total: subject,
    source: proposal.sourceLocationId ? `${subject}@${proposal.sourceLocationId}` : null,
    destination: proposal.destinationLocationId ? `${subject}@${proposal.destinationLocationId}` : null,
  };
}

/** The starting position this line should now expect, given what its plan already did. */
function rebaseForPlan(proposal, applied) {
  const before = proposal.expectedBeforeState || {};
  if (!applied) return before;
  const keys = planKeys(proposal);
  const shifted = { ...before };
  const move = (value, delta) => (typeof value === 'number' ? value + delta : value);

  shifted.total = move(shifted.total, applied.totals.get(keys.total) || 0);
  if (keys.source) shifted.sourceOnHand = move(shifted.sourceOnHand, applied.positions.get(keys.source) || 0);
  if (keys.destination) {
    shifted.destinationOnHand = move(shifted.destinationOnHand, applied.positions.get(keys.destination) || 0);
  }
  return shifted;
}

function currentState(db, workspaceId, proposal) {
  if (proposal.actionType === 'archive_item') {
    const scope = proposal.settings.archiveScope;
    const row = scope === 'item'
      ? db.prepare('SELECT is_active FROM items WHERE id = ? AND workspace_id = ?')
          .get(proposal.itemId, workspaceId)
      : db.prepare('SELECT is_active FROM skus WHERE id = ? AND workspace_id = ?')
          .get(proposal.skuId, workspaceId);
    return {
      total: scope === 'item'
        ? repo.getItemTotal(db, workspaceId, proposal.itemId)
        : resolver.skuTotal(db, workspaceId, proposal.skuId),
      active: Boolean(row && row.is_active),
    };
  }
  if (proposal.actionType === 'create_item') {
    const item = proposal.settings.code
      ? db.prepare(
          `SELECT id FROM items
            WHERE workspace_id = ? AND base_code = ? COLLATE NOCASE AND is_active = 1`
        ).get(workspaceId, proposal.settings.code)
      : db.prepare(
          `SELECT id FROM items
            WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1`
        ).get(workspaceId, proposal.settings.name);
    const state = {
      total: item
        ? db.prepare(
            `SELECT COALESCE(SUM(b.on_hand), 0) AS n
               FROM skus s LEFT JOIN balances b
                 ON b.sku_id = s.id AND b.workspace_id = s.workspace_id
              WHERE s.workspace_id = ? AND s.item_id = ? AND s.is_active = 1`
          ).get(workspaceId, item.id).n
        : 0,
    };
    if (proposal.destinationLocationId) {
      const location = db
        .prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?')
        .get(proposal.destinationLocationId, workspaceId);
      state.destinationLocationId = proposal.destinationLocationId;
      state.destinationLocationName = location ? location.name : null;
      state.destinationOnHand = item
        ? db.prepare(
            `SELECT COALESCE(SUM(b.on_hand), 0) AS n
               FROM skus s LEFT JOIN balances b
                 ON b.sku_id = s.id AND b.workspace_id = s.workspace_id
                AND b.location_id = ?
              WHERE s.workspace_id = ? AND s.item_id = ? AND s.is_active = 1`
          ).get(proposal.destinationLocationId, workspaceId, item.id).n
        : 0;
    }
    return state;
  }

  const state = {
    total: proposal.lotId
      ? resolver.lotTotal(db, workspaceId, proposal.lotId)
      : resolver.skuTotal(db, workspaceId, proposal.skuId),
  };
  if (proposal.sourceLocationId) {
    const location = db.prepare('SELECT name FROM locations WHERE id = ?').get(proposal.sourceLocationId);
    state.sourceLocationId = proposal.sourceLocationId;
    state.sourceLocationName = location ? location.name : null;
    state.sourceOnHand = proposal.lotId
      ? resolver.lotBalanceAt(db, workspaceId, proposal.lotId, proposal.sourceLocationId)
      : resolver.balanceAt(db, workspaceId, proposal.skuId, proposal.sourceLocationId);
  }
  if (proposal.destinationLocationId) {
    const location = db.prepare('SELECT name FROM locations WHERE id = ?').get(proposal.destinationLocationId);
    state.destinationLocationId = proposal.destinationLocationId;
    state.destinationLocationName = location ? location.name : null;
    state.destinationOnHand = proposal.lotId
      ? resolver.lotBalanceAt(db, workspaceId, proposal.lotId, proposal.destinationLocationId)
      : resolver.balanceAt(db, workspaceId, proposal.skuId, proposal.destinationLocationId);
  }
  if (proposal.serialUnitIds.length) {
    state.units = proposal.serialUnitIds.map((unitId) => {
      const unit = db
        .prepare(
          `SELECT su.id, su.serial, su.location_id, l.name AS location_name
             FROM serial_units su LEFT JOIN locations l ON l.id = su.location_id WHERE su.id = ?`
        )
        .get(unitId);
      return unit
        ? { unitId: unit.id, serial: unit.serial, locationId: unit.location_id, locationName: unit.location_name }
        : { unitId, serial: null, locationId: null, locationName: null };
    });
  }
  return state;
}

// --- state changes -----------------------------------------------------------

function setStatus(db, ctx, proposalId, status, extra = {}) {
  const sets = ['status = @status'];
  const params = { id: proposalId, workspaceId: ctx.workspaceId, status };
  if (extra.approvedBy) {
    sets.push('approved_by_user_id = @approvedBy', "approved_at = @now");
    params.approvedBy = extra.approvedBy;
    params.now = nowIso();
  }
  if (extra.completed) {
    sets.push('completed_at = @completedAt');
    params.completedAt = nowIso();
  }
  if (extra.problems) {
    sets.push('validation_problems = @problems', "validation_status = 'INVALID'");
    params.problems = JSON.stringify(extra.problems);
  }
  db.prepare(`UPDATE action_proposals SET ${sets.join(', ')} WHERE id = @id AND workspace_id = @workspaceId`).run(params);
}

function cancel(db, ctx, proposalId, reason = 'cancelled') {
  return inTransaction(db, () => {
    const proposal = get(db, ctx.workspaceId, proposalId);
    if (!proposal) throw new NotFoundError('That action could not be found.');
    if (['SUCCEEDED', 'EXECUTING'].includes(proposal.status)) {
      throw new ValidationError('That action has already run.');
    }
    setStatus(db, ctx, proposalId, 'CANCELLED');
    record(db, ctx, proposalId, 'CANCELLED', { reason });
    return get(db, ctx.workspaceId, proposalId);
  });
}

module.exports = {
  build,
  resolveLotAtSource,
  persist,
  get,
  listOpen,
  listForAttention,
  events,
  hydrate,
  record,
  revalidate,
  currentState,
  planKeys,
  setStatus,
  cancel,
  expired,
  computeIntegrityHash,
  verifyIntegrity,
  stableStringify,
};
