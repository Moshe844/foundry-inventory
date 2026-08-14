'use strict';

/**
 * Applies an approved InventoryConfigurationPlan to the real Mission 1 engine.
 *
 * This module is deliberately small and deliberately boring. It:
 *   - re-verifies the plan's integrity hash before doing anything, so a plan
 *     edited in storage after approval is refused;
 *   - creates only STRUCTURE — locations, terminology, operational defaults;
 *   - never creates items, SKUs, serial numbers, lots, or a single unit of
 *     stock, because real inventory records come from the customer;
 *   - is idempotent, so a double-submitted approval configures nothing twice.
 *
 * It imports the location service and nothing else from the domain. It has no
 * access to the inventory engine's mutating operations at all, which is what
 * makes "AI cannot move stock" a structural fact rather than a promise.
 */

const { inTransaction } = require('../db');
const locationService = require('../domain/location-service');
const { verifyPlanIntegrity } = require('./plan-schema');
const { NotFoundError, InvariantError } = require('../domain/errors');
const { nowIso } = require('../lib/util');

function applyPlan(db, ctx, planId) {
  return inTransaction(db, () => {
    const row = db
      .prepare('SELECT * FROM foundry_plans WHERE id = ? AND workspace_id = ?')
      .get(planId, ctx.workspaceId);
    if (!row) throw new NotFoundError('That configuration plan could not be found.');

    if (row.status === 'applied') {
      // Idempotent: a resubmitted approval reports what already happened.
      return { alreadyApplied: true, ...JSON.parse(row.applied_summary || '{}') };
    }
    if (row.status !== 'proposed') {
      throw new InvariantError('That configuration plan is no longer available to apply.', 'plan_not_proposed');
    }

    const plan = JSON.parse(row.payload);
    if (!verifyPlanIntegrity(plan)) {
      throw new InvariantError(
        'This configuration plan has been altered since it was proposed. Foundry will not apply it.',
        'plan_integrity_failed'
      );
    }
    if (plan.workspaceId !== ctx.workspaceId) {
      throw new NotFoundError('That configuration plan could not be found.');
    }

    const now = nowIso();
    const created = [];
    const skipped = [];

    const existing = db
      .prepare('SELECT name FROM locations WHERE workspace_id = ?')
      .all(ctx.workspaceId)
      .map((loc) => loc.name.toLowerCase());

    for (const location of plan.locations) {
      if (existing.includes(location.name.trim().toLowerCase())) {
        skipped.push(location.name);
        continue;
      }
      const made = locationService.createLocation(db, ctx, {
        name: location.name,
        kind: location.kind,
      });
      existing.push(made.name.toLowerCase());
      created.push({ id: made.id, name: made.name, kind: made.kind });
    }

    db.prepare(
      `INSERT INTO workspace_configuration (
         workspace_id, configured_at, configuration_version, applied_plan_id,
         terminology, operational_defaults, inventory_model, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         configured_at = COALESCE(workspace_configuration.configured_at, excluded.configured_at),
         configuration_version = excluded.configuration_version,
         applied_plan_id = excluded.applied_plan_id,
         terminology = excluded.terminology,
         operational_defaults = excluded.operational_defaults,
         inventory_model = excluded.inventory_model,
         updated_at = excluded.updated_at`
    ).run(
      ctx.workspaceId,
      now,
      plan.configurationVersion,
      planId,
      JSON.stringify(plan.terminology),
      JSON.stringify(plan.operationalDefaults),
      JSON.stringify({
        ...plan.inventoryModel,
        variantDimensions: plan.variantDimensions,
        serialRules: plan.serialRules,
        lotRules: plan.lotRules,
        expirationRules: plan.expirationRules,
      }),
      now
    );

    const summary = {
      planId,
      configurationVersion: plan.configurationVersion,
      locationsCreated: created,
      locationsAlreadyPresent: skipped,
      trackingMode: plan.inventoryModel.primaryArchetype,
      usesVariants: plan.inventoryModel.usesVariants,
      variantDimensions: plan.variantDimensions.map((dim) => dim.name),
      terminology: plan.terminology,
      operationalDefaults: plan.operationalDefaults,
      expirationTracking: plan.expirationRules.enabled,
      appliedAt: now,
    };

    db.prepare(
      "UPDATE foundry_plans SET status = 'applied', applied_at = ?, applied_summary = ? WHERE id = ?"
    ).run(now, JSON.stringify(summary), planId);

    db.prepare(
      `UPDATE foundry_plans SET status = 'superseded'
        WHERE workspace_id = ? AND id <> ? AND status = 'proposed'`
    ).run(ctx.workspaceId, planId);

    return { alreadyApplied: false, ...summary };
  });
}

function getConfiguration(db, workspaceId) {
  const row = db.prepare('SELECT * FROM workspace_configuration WHERE workspace_id = ?').get(workspaceId);
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    configuredAt: row.configured_at,
    configurationVersion: row.configuration_version,
    appliedPlanId: row.applied_plan_id,
    terminology: safeParse(row.terminology, {}),
    operationalDefaults: safeParse(row.operational_defaults, {}),
    inventoryModel: safeParse(row.inventory_model, {}),
    updatedAt: row.updated_at,
  };
}

function isConfigured(db, workspaceId) {
  const config = getConfiguration(db, workspaceId);
  return Boolean(config && config.configuredAt);
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = { applyPlan, getConfiguration, isConfigured };
