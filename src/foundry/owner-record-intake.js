'use strict';

/**
 * Applies exact inventory records typed and approved by the owner. This is a
 * domain boundary separate from structural planning: it may create only the
 * sealed rows it receives, and the surrounding plan transaction supplies
 * idempotency.
 */

const locationService = require('../domain/location-service');
const itemService = require('../domain/item-service');
const inventory = require('../domain/inventory-engine');
const { ValidationError } = require('../domain/errors');

function apply(db, ctx, plan, existingLocationNames, createdLocations) {
  const rows = plan.ownerProvidedInventory.lines;
  const locationByName = new Map(db.prepare('SELECT id, name FROM locations WHERE workspace_id = ?')
    .all(ctx.workspaceId).map((location) => [location.name.trim().toLowerCase(), location]));
  for (const row of rows) {
    const key = row.locationName.trim().toLowerCase();
    if (!locationByName.has(key)) {
      const location = locationService.createLocation(db, ctx, { name: row.locationName, kind: 'warehouse' });
      locationByName.set(key, location);
      existingLocationNames.push(key);
      createdLocations.push({ id: location.id, name: location.name, kind: location.kind });
    }
  }

  const grouped = new Map();
  for (const row of rows) {
    const productKey = row.productName.trim().toLowerCase();
    if (!grouped.has(productKey)) grouped.set(productKey, { name: row.productName.trim(), rows: [] });
    grouped.get(productKey).rows.push(row);
  }

  let products = 0;
  let skus = 0;
  let units = 0;
  const variantAxis = plan.variantDimensions[0]?.name || 'Variant';
  for (const group of grouped.values()) {
    const collision = db.prepare('SELECT id FROM items WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
      .get(ctx.workspaceId, group.name);
    if (collision) {
      throw new ValidationError(`${group.name} already exists. Foundry stopped rather than adding the opening quantity twice.`);
    }
    const seenVariants = new Set();
    const variants = group.rows.map((row) => {
      const variantKey = row.variantLabel.trim().toLowerCase();
      if (seenVariants.has(variantKey)) {
        throw new ValidationError(`Two ${group.name} rows have the same variant. Combine their quantity or give each variant a distinct value.`);
      }
      seenVariants.add(variantKey);
      return {
        label: row.variantLabel || null,
        options: row.variantLabel ? { [variantAxis]: row.variantLabel } : {},
      };
    });
    const made = itemService.createExactItem(db, ctx, {
      name: group.name,
      trackingMode: 'quantity',
      variants,
    });
    group.rows.forEach((row, index) => {
      const location = locationByName.get(row.locationName.trim().toLowerCase());
      inventory.receive(db, ctx, {
        skuId: made.skus[index].skuId,
        locationId: location.id,
        quantity: row.quantity,
        reference: `OWNER-OPENING-${plan.configurationVersion}-${products + 1}-${index + 1}`,
        notes: 'Opening stock entered directly by the owner during Foundry setup.',
      });
      units += row.quantity;
    });
    products += 1;
    skus += made.skus.length;
  }
  return { products, skus, units, locations: locationByName.size };
}

module.exports = { apply };
