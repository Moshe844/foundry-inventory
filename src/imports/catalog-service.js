'use strict';

/**
 * Working out what a product *is*, before anything creates one.
 *
 * Two callers: someone describing a product in a sentence, and a file being
 * imported. Both end up here, so a product created by conversation and one
 * created by import are the same kind of record, made the same way.
 *
 * The tracking mode comes from the workspace's Mission 2 configuration rather
 * than from a question. A business already told Foundry how it counts things;
 * asking again on every product would be forgetting.
 */

const repo = require('../domain/repository');
const planApplier = require('../foundry/plan-applier');
const resolver = require('../actions/resolver');

const MAX_AXES = 3;
const MAX_VALUES_PER_AXIS = 60;
const MAX_VARIANTS = 400;

/**
 * "6 through 12", "6-12", "S,M,L" → a list of values.
 *
 * Ranges are expanded here rather than by the model: enumerating a range is
 * arithmetic, and arithmetic belongs in code where it is exactly right every
 * time and cannot quietly skip 9.
 */
function expandValues(text) {
  const raw = String(text || '')
    .split(/[,;/]|\band\b/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const values = [];
  for (const part of raw) {
    const range = /^(-?\d+)\s*(?:-|–|—|to|through|thru)\s*(-?\d+)$/i.exec(part);
    if (range) {
      let from = Number(range[1]);
      let to = Number(range[2]);
      const step = from <= to ? 1 : -1;
      const span = Math.abs(to - from) + 1;
      if (span <= MAX_VALUES_PER_AXIS) {
        for (let v = from; step > 0 ? v <= to : v >= to; v += step) values.push(String(v));
        continue;
      }
    }
    values.push(part);
  }

  // Case-insensitive de-duplication, keeping the wording the person used.
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_VALUES_PER_AXIS);
}

/**
 * "Colour: Navy, Black | Size: 6 through 12" → axes with expanded values.
 *
 * A flat string rather than nested objects, because the model's output grammar
 * stays small and the structure is parsed here where it can be checked.
 */
function parseAxes(text) {
  const axes = [];
  for (const chunk of String(text || '').split('|')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const split = trimmed.indexOf(':');
    if (split === -1) continue;
    const name = trimmed.slice(0, split).trim();
    const values = expandValues(trimmed.slice(split + 1));
    if (name && values.length) axes.push({ name, values });
    if (axes.length >= MAX_AXES) break;
  }
  return axes;
}

function variantCount(axes) {
  return axes.reduce((total, axis) => total * axis.values.length, 1);
}

/** What this workspace normally does, so a product need not be interrogated. */
function workspaceDefaults(db, workspaceId) {
  const configuration = planApplier.getConfiguration(db, workspaceId);
  const model = (configuration && configuration.inventoryModel) || {};
  const archetype = ['quantity', 'serial', 'lot'].includes(model.primaryArchetype)
    ? model.primaryArchetype
    : 'quantity';

  return {
    configured: Boolean(configuration && configuration.configuredAt),
    trackingMode: archetype,
    usesVariants: model.usesVariants === true,
    variantDimensions: Array.isArray(model.variantDimensions) ? model.variantDimensions : [],
    terminology: (configuration && configuration.terminology) || {},
  };
}

/**
 * Turns a described product into a fully specified plan, or a question.
 *
 * @param {object} spec { name, code, trackingMode, unitLabel, axes | variantAxes, description }
 */
function planItem(db, workspaceId, spec) {
  const defaults = workspaceDefaults(db, workspaceId);
  const name = String(spec.name || '').trim();
  if (!name) return { ok: false, question: 'What should the product be called?' };

  const axes = Array.isArray(spec.axes) && spec.axes.length
    ? spec.axes.map((axis) => ({ name: String(axis.name).trim(), values: expandValues(axis.values) }))
        .filter((axis) => axis.name && axis.values.length)
    : parseAxes(spec.variantAxes);

  const hasVariants = axes.length > 0;
  const count = hasVariants ? variantCount(axes) : 1;
  if (count > MAX_VARIANTS) {
    return {
      ok: false,
      unsupported: `That would create ${count} variants. Foundry creates up to ${MAX_VARIANTS} at once — split it into a few products.`,
    };
  }

  // The mode the business already uses, unless this product was described
  // differently. Not a question: Mission 2 answered it once, for everything.
  const trackingMode = ['quantity', 'serial', 'lot'].includes(spec.trackingMode)
    ? spec.trackingMode
    : defaults.trackingMode;

  const code = String(spec.code || '').trim() || null;
  const assumptions = [];
  if (!spec.trackingMode && defaults.configured) {
    assumptions.push(
      trackingMode === 'quantity'
        ? 'Counted by quantity, the way this inventory is set up.'
        : trackingMode === 'serial'
          ? 'Tracked by individual unit, the way this inventory is set up.'
          : 'Tracked by lot, the way this inventory is set up.'
    );
  }
  if (hasVariants) {
    assumptions.push(
      `${axes.map((a) => `${a.name} (${a.values.length})`).join(' × ')} — ${count} variants.`
    );
  }

  return {
    ok: true,
    plan: {
      name,
      code,
      description: String(spec.description || '').trim() || null,
      unitLabel: String(spec.unitLabel || '').trim() || 'unit',
      trackingMode,
      hasVariants,
      axes,
      variantCount: count,
      assumptions,
      conflicts: findConflicts(db, workspaceId, { name, code }),
    },
  };
}

/**
 * Whether this product already exists.
 *
 * A matching code is decisive — that is what a code is for. A similar *name* is
 * only ever a suggestion: "Copper Elbow 1/2" and "1/2in Copper Elbow" may well
 * be the same thing, and they may well not, and merging them on a resemblance
 * would silently fuse two products' stock.
 */
function findConflicts(db, workspaceId, { name, code }) {
  const conflicts = [];

  if (code) {
    const byCode = db
      .prepare(
        `SELECT id, name, base_code FROM items
          WHERE workspace_id = ? AND base_code = ? COLLATE NOCASE AND is_active = 1`
      )
      .get(workspaceId, code);
    if (byCode) {
      conflicts.push({
        kind: 'duplicate_code',
        decisive: true,
        itemId: byCode.id,
        message: `${byCode.name} already uses the code ${byCode.base_code}.`,
      });
    }
  }

  const exact = db
    .prepare('SELECT id, name FROM items WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
    .get(workspaceId, name);
  if (exact) {
    conflicts.push({
      kind: 'duplicate_name',
      decisive: true,
      itemId: exact.id,
      message: `A product called ${exact.name} already exists.`,
    });
    return conflicts;
  }

  // A resemblance, offered for a person to judge. Never acted on.
  const candidates = db
    .prepare('SELECT id, name FROM items WHERE workspace_id = ? AND is_active = 1')
    .all(workspaceId);
  for (const candidate of candidates) {
    if (looksLikeSameProduct(name, candidate.name)) {
      conflicts.push({
        kind: 'possible_duplicate',
        decisive: false,
        itemId: candidate.id,
        message: `This may be the same as ${candidate.name}.`,
      });
    }
  }
  return conflicts.slice(0, 5);
}

/** Same words in a different order, or one small typo apart. */
function looksLikeSameProduct(a, b) {
  const normalise = (text) =>
    String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const left = normalise(a);
  const right = normalise(b);
  if (left.length === 0 || right.length === 0) return false;

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const shared = [...leftSet].filter((word) => rightSet.has(word)).length;
  if (shared === 0) return false;

  // Overlap rather than union: "Copper Elbow 1/2 in." and "1/2in Copper Elbow"
  // are the same product written two ways, and comparing against the union
  // penalises them for the extra token one of them happens to split. Two shared
  // words are required so a single common word is never enough.
  const overlap = shared / Math.min(leftSet.size, rightSet.size);
  if (shared >= 2 && overlap >= 0.7) return true;

  const gap = resolver.distance(a, b);
  return gap > 0 && gap <= resolver.tolerance(a);
}

/** The option list `itemService.createItem` expects. */
function toCreateInput(plan) {
  return {
    name: plan.name,
    baseCode: plan.code,
    description: plan.description,
    unitLabel: plan.unitLabel,
    trackingMode: plan.trackingMode,
    hasVariants: plan.hasVariants,
    options: plan.axes.map((axis) => ({ name: axis.name, values: axis.values.join(', ') })),
  };
}

module.exports = {
  MAX_AXES,
  MAX_VALUES_PER_AXIS,
  MAX_VARIANTS,
  expandValues,
  parseAxes,
  variantCount,
  workspaceDefaults,
  planItem,
  findConflicts,
  looksLikeSameProduct,
  toCreateInput,
};
