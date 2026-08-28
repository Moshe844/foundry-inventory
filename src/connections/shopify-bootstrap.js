'use strict';

const { inTransaction } = require('../db');
const { ValidationError } = require('../domain/errors');
const itemService = require('../domain/item-service');
const locationService = require('../domain/location-service');
const inventory = require('../domain/inventory-engine');
const prices = require('../pricing/price-service');
const { newId, nowIso } = require('../lib/util');
const connections = require('./service');
const credentialsStore = require('./credentials');
const providers = require('./providers/registry');

function codeFromGid(prefix, gid) {
  return `${prefix}-${String(gid || '').split('/').pop() || 'ITEM'}`.toUpperCase();
}

function optionsFor(variant) {
  const entries = (variant.selectedOptions || [])
    .filter((option) => !(option.name === 'Title' && option.value === 'Default Title'));
  return Object.fromEntries(entries.map((option) => [option.name, option.value]));
}

function labelFor(variant) {
  const values = Object.values(optionsFor(variant));
  if (values.length) return values.join(' / ');
  return variant.title && variant.title !== 'Default Title' ? variant.title : null;
}

function workspaceCounts(db, workspaceId) {
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM items WHERE workspace_id = ?) AS items,
    (SELECT COUNT(*) FROM locations WHERE workspace_id = ?) AS locations,
    (SELECT COUNT(*) FROM movements WHERE workspace_id = ?) AS movements`)
    .get(workspaceId, workspaceId, workspaceId);
}

async function bootstrap(db, ctx, connectorId, options = {}) {
  const connection = connections.get(db, ctx.workspaceId, connectorId);
  if (connection.provider_type !== 'shopify') throw new ValidationError('This setup is only for Shopify connections.');
  if (connection.status !== 'connected') throw new ValidationError('Reconnect Shopify before importing its catalogue.');
  if (connection.config.catalogBootstrap?.completedAt) {
    return { ...connection.config.catalogBootstrap, replayed: true };
  }
  const existing = workspaceCounts(db, ctx.workspaceId);
  if (existing.items || existing.locations || existing.movements) {
    throw new ValidationError('This inventory is not empty. Review mappings instead of importing an opening Shopify snapshot over existing records.');
  }

  const adapter = options.adapter || providers.get('shopify');
  let providerCredentials = credentialsStore.get(db, ctx.workspaceId, connectorId, 'provider');
  if (!providerCredentials) throw new ValidationError('Reconnect Shopify before importing its catalogue.');
  if (adapter.refreshCredentials) {
    const refreshed = await adapter.refreshCredentials(providerCredentials);
    providerCredentials = refreshed.credentials;
    if (refreshed.refreshed) credentialsStore.put(db, ctx.workspaceId, connectorId, 'provider', providerCredentials,
      refreshed.expiresAt || null);
  }
  const snapshot = options.snapshot || await adapter.bootstrapSnapshot({ credentials: providerCredentials, connection });
  const capturedAt = nowIso();

  return inTransaction(db, () => {
    const locationByExternalId = new Map();
    let ignored = 0; let openingUnits = 0; let priceCount = 0; let skuCount = 0; let itemCount = 0;
    const activeLocations = (snapshot.locations || []).filter((location) => location.active);
    for (const external of activeLocations) {
      const location = locationService.createLocation(db, ctx, {
        name: external.name, kind: 'store', note: `Imported from Shopify ${connection.provider_account_name || ''}`.trim(),
      });
      locationByExternalId.set(String(external.externalId), location);
      connections.mapExternal(db, ctx, connectorId, {
        entityType: 'location', externalId: external.externalId, foundryRecordId: location.id,
      });
    }
    for (const external of (snapshot.locations || []).filter((location) => !location.active)) {
      require('./provider-service').ignoreExternal(db, ctx.workspaceId, connectorId, 'location', external.externalId);
      ignored += 1;
    }

    for (const product of snapshot.products || []) {
      const eligible = (product.variants || []).filter((variant) =>
        product.status === 'ACTIVE' && !product.isGiftCard && variant.tracked);
      const excluded = (product.variants || []).filter((variant) => !eligible.includes(variant));
      for (const variant of excluded) {
        require('./provider-service').ignoreExternal(db, ctx.workspaceId, connectorId, 'sku', variant.externalId);
        ignored += 1;
      }
      if (!eligible.length) continue;

      const created = itemService.createExactItem(db, ctx, {
        name: product.title,
        trackingMode: 'quantity',
        variants: eligible.map((variant) => ({
          sourceKey: variant.externalId,
          code: variant.sku || codeFromGid('SHP-V', variant.externalId),
          label: labelFor(variant),
          options: optionsFor(variant),
        })),
        description: `Imported from Shopify product ${product.externalId}`,
      });
      itemCount += 1; skuCount += created.skus.length;
      const createdByExternalId = new Map(created.skus.map((sku) => [String(sku.sourceKey), sku]));
      for (const variant of eligible) {
        const sku = createdByExternalId.get(String(variant.externalId));
        connections.mapExternal(db, ctx, connectorId, {
          entityType: 'sku', externalId: variant.externalId, foundryRecordId: sku.skuId,
        });
        const price = Number(variant.price);
        if (Number.isFinite(price) && price >= 0) {
          prices.setPrice(db, ctx, { skuId: sku.skuId, amountMinor: prices.fromMajorNumber(price),
            currency: snapshot.currency || 'USD', source: 'shopify_opening_catalog',
            sourceDetail: { connectorId, externalVariantId: variant.externalId, capturedAt } });
          priceCount += 1;
        }
        for (const level of variant.inventoryLevels || []) {
          const location = locationByExternalId.get(String(level.externalLocationId));
          if (!location || !level.active) continue;
          if (!Number.isInteger(level.onHand) || level.onHand < 0) {
            throw new ValidationError(`Shopify supplied an unsupported opening quantity for ${product.title} at ${level.name}.`);
          }
          if (level.onHand > 0) {
            inventory.receive(db, ctx, { skuId: sku.skuId, locationId: location.id, quantity: level.onHand,
              reference: `shopify-opening:${connectorId}:${variant.externalId}:${level.externalLocationId}`,
              notes: `Opening balance captured from Shopify at ${capturedAt}; historical sales were not replayed.` });
            openingUnits += level.onHand;
          }
        }
      }
    }

    require('./provider-service').setSelectedLocations(db, ctx.workspaceId, connectorId,
      activeLocations.map((location) => location.externalId));
    const summary = { completedAt: capturedAt, items: itemCount, skus: skuCount,
      locations: activeLocations.length, prices: priceCount, openingUnits, ignored };
    const updatedConfig = { ...connection.config, catalogBootstrap: summary, catalogAuthority: 'shopify' };
    db.prepare(`UPDATE workspace_connectors SET config = ?, setup_status = 'CONNECTED', status = 'connected',
      last_synced_at = ?, last_error = NULL, updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(JSON.stringify(updatedConfig), capturedAt, capturedAt, ctx.workspaceId, connectorId);
    db.prepare(`INSERT INTO connection_sync_runs
      (id, workspace_id, connector_id, sync_kind, status, discovered_products, discovered_locations,
       auto_mapped, needs_mapping, started_at, completed_at)
      VALUES (?, ?, ?, 'INITIAL_CATALOG_AND_STOCK', 'COMPLETED', ?, ?, ?, 0, ?, ?)`)
      .run(newId('csync'), ctx.workspaceId, connectorId, skuCount, activeLocations.length,
        skuCount + activeLocations.length, capturedAt, capturedAt);
    return { ...summary, replayed: false };
  });
}

module.exports = { bootstrap };
