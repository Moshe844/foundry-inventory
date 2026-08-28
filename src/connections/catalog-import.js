'use strict';

const itemService = require('../domain/item-service');
const inventory = require('../domain/inventory-engine');
const prices = require('../pricing/price-service');
const { inTransaction } = require('../db');
const connections = require('./service');

const MAX_BULK_PRODUCTS = 500;

function requestedIds(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, MAX_BULK_PRODUCTS);
}

function unmappedRecords(db, workspaceId, connectorId, externalIds) {
  if (!externalIds.length) return [];
  const placeholders = externalIds.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'sku'
      AND mapping_status = 'UNMAPPED' AND external_id IN (${placeholders})
    ORDER BY display_name COLLATE NOCASE, external_id`)
    .all(workspaceId, connectorId, ...externalIds);
}

function siblingRecords(db, workspaceId, connectorId, record) {
  return db.prepare(`SELECT * FROM connection_external_records
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'sku' AND mapping_status = 'UNMAPPED'
      AND (parent_external_id = ? OR (? IS NULL AND external_id = ?))
    ORDER BY display_name COLLATE NOCASE, external_id`)
    .all(workspaceId, connectorId, record.parent_external_id, record.parent_external_id, record.external_id);
}

function importProducts(db, ctx, connection, rawExternalIds) {
  const externalIds = requestedIds(rawExternalIds);
  const requested = unmappedRecords(db, ctx.workspaceId, connection.id, externalIds);
  const groups = new Map();
  for (const record of requested) {
    const groupKey = record.parent_external_id || record.external_id;
    if (!groups.has(groupKey)) groups.set(groupKey,
      siblingRecords(db, ctx.workspaceId, connection.id, record));
  }
  if (!groups.size) return { items: 0, mapped: 0, priceCount: 0, openingUnits: 0 };

  const capturedAt = new Date().toISOString();
  return inTransaction(db, () => {
    const total = { items: 0, mapped: 0, priceCount: 0, openingUnits: 0 };
    for (const siblings of groups.values()) {
      const external = siblings[0];
      const details = siblings.map((record) => ({ record, data: connections.parseJson(record.provider_data, {}) }));
      const created = itemService.createExactItem(db, ctx, {
        name: details[0].data.itemName || external.display_name,
        trackingMode: 'quantity',
        description: `Created from ${connection.display_name} product ${external.parent_external_id || external.external_id}`,
        variants: details.map(({ record, data }) => ({ sourceKey: record.external_id,
          code: record.code || undefined,
          label: siblings.length > 1 ? data.variationName || record.display_name : null })),
      });
      const skuByExternalId = new Map(created.skus.map((sku) => [String(sku.sourceKey), sku]));
      for (const { record, data } of details) {
        const sku = skuByExternalId.get(String(record.external_id));
        connections.mapExternal(db, ctx, connection.id, {
          entityType: 'sku', externalId: record.external_id, foundryRecordId: sku.skuId,
        });
        const amount = Number(data.priceMoney?.amount);
        if (Number.isSafeInteger(amount) && amount >= 0) {
          prices.setPrice(db, ctx, { skuId: sku.skuId, amountMinor: amount,
            currency: data.priceMoney?.currency || 'USD', source: `${connection.provider_type}_opening_catalog`,
            sourceDetail: { connectorId: connection.id, externalVariantId: record.external_id, capturedAt } });
          total.priceCount += 1;
        }
        for (const count of data.inventoryCounts || []) {
          if (count.state && count.state !== 'IN_STOCK') continue;
          const quantity = Number(count.quantity);
          if (!Number.isInteger(quantity) || quantity <= 0) continue;
          const location = connections.mapping(db, ctx.workspaceId, connection.id,
            'location', String(count.externalLocationId));
          if (!location) continue;
          inventory.receive(db, ctx, { skuId: sku.skuId, locationId: location.foundry_record_id,
            quantity, reference: `${connection.provider_type}-opening:${connection.id}:${record.external_id}:${count.externalLocationId}`,
            notes: `Opening balance captured from ${connection.display_name} at ${capturedAt}; historical sales were not replayed.` });
          total.openingUnits += quantity;
        }
      }
      total.items += 1;
      total.mapped += siblings.length;
    }
    return total;
  });
}

module.exports = { MAX_BULK_PRODUCTS, requestedIds, importProducts };
