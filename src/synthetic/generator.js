'use strict';

const itemService = require('../domain/item-service');
const inventory = require('../domain/inventory-engine');
const locationService = require('../domain/location-service');
const supplierService = require('../purchasing/supplier-service');
const priceService = require('../pricing/price-service');
const dataMode = require('./data-mode');

const ADJECTIVES = ['Harbor', 'Summit', 'Willow', 'Atlas', 'Cedar', 'Northstar', 'Riverside', 'Heritage', 'Metro', 'Evergreen'];
const PRODUCTS = ['Crew Tee', 'Work Jacket', 'Travel Mug', 'Canvas Tote', 'Running Shoe', 'Desk Lamp', 'Storage Bin', 'Trail Pack', 'Safety Glove', 'Utility Pant'];
const COLORS = ['Black', 'Navy', 'Stone', 'Forest', 'Burgundy', 'White', 'Slate', 'Sand'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size'];
const SUPPLIER_WORDS = ['Apparel', 'Supply', 'Wholesale', 'Trading', 'Distribution', 'Goods', 'Manufacturing'];

function productName(index) {
  const cycle = Math.floor(index / (ADJECTIVES.length * PRODUCTS.length)) + 1;
  return `${ADJECTIVES[index % ADJECTIVES.length]} ${PRODUCTS[Math.floor(index / ADJECTIVES.length) % PRODUCTS.length]}${cycle > 1 ? ` Series ${cycle}` : ''}`;
}

function supplierName(index) {
  return `${ADJECTIVES[index % ADJECTIVES.length]} ${SUPPLIER_WORDS[Math.floor(index / ADJECTIVES.length) % SUPPLIER_WORDS.length]} ${index + 1}`;
}

function dateMonthsAgo(months, offset) {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - Math.max(0, months - 1 - (offset % months)));
  date.setUTCDate(2 + (offset % 24));
  date.setUTCHours(12, 0, 0, 0);
  if (date.getTime() > Date.now() - 24 * 60 * 60 * 1000) {
    date.setTime(Date.now() - 24 * 60 * 60 * 1000);
  }
  return date.toISOString();
}

function generate(db, ctx, spec) {
  if (dataMode.workspaceMode(db, ctx.workspaceId) !== dataMode.MODES.SYNTHETIC) {
    throw new Error('Synthetic records can only be generated inside a persisted Test environment.');
  }
  const existing = db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(ctx.workspaceId).n;
  if (existing) throw new Error('This Test environment already contains products. Start with an empty Test environment to generate a complete synthetic company.');

  const membership = db.prepare('SELECT * FROM users WHERE id = ? AND workspace_id = ?').get(ctx.actorId, ctx.workspaceId);
  const locations = [];
  for (const [name, kind] of [['Main Warehouse', 'warehouse'], ['Downtown Store', 'store'], ['North Store', 'store'], ['Overflow Warehouse', 'warehouse']]) {
    const found = db.prepare('SELECT * FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE').get(ctx.workspaceId, name);
    locations.push(found || locationService.createLocation(db, ctx, { name, kind }));
  }

  const suppliers = [];
  for (let i = 0; i < spec.suppliers; i += 1) {
    suppliers.push(supplierService.createSupplier(db, ctx, membership, {
      name: supplierName(i), code: `V-${String(i + 1).padStart(3, '0')}`,
      email: `orders${i + 1}@supplier.example`, defaultLeadTimeDays: 3 + (i % 18),
      paymentTerms: i % 3 === 0 ? 'Net 15' : 'Net 30', currency: 'USD',
    }));
  }

  let madeSkus = 0;
  let movements = 0;
  const base = Math.floor(spec.skus / spec.products);
  const extra = spec.skus % spec.products;
  for (let p = 0; p < spec.products; p += 1) {
    const variantCount = base + (p < extra ? 1 : 0);
    const variants = Array.from({ length: variantCount }, (_, v) => {
      const color = COLORS[v % COLORS.length];
      const size = SIZES[Math.floor(v / COLORS.length) % SIZES.length];
      return { code: `SKU-${String(p + 1).padStart(4, '0')}-${String(v + 1).padStart(2, '0')}`,
        label: variantCount === 1 ? null : `${color} / ${size}`,
        options: variantCount === 1 ? {} : { Color: color, Size: size } };
    });
    const made = itemService.createExactItem(db, ctx, {
      name: productName(p), baseCode: `PRD-${String(p + 1).padStart(4, '0')}`,
      description: 'Synthetic test product generated for realistic operating rehearsal.', variants,
    });
    for (let v = 0; v < made.skus.length; v += 1) {
      const sku = made.skus[v];
      const supplier = suppliers[(p + v) % suppliers.length];
      const cost = 4.5 + ((p * 7 + v * 3) % 90) + ((p + v) % 4) * 0.25;
      supplierService.linkItem(db, ctx, membership, {
        supplierId: supplier.id, skuId: sku.skuId, supplierSku: `SUP-${p + 1}-${v + 1}`,
        purchaseUnit: 'case', unitsPerPurchaseUnit: 12, lastUnitCost: cost,
        leadTimeDays: 3 + ((p + v) % 20), minimumOrderQuantity: 1, orderMultiple: 1,
        isPreferred: true,
      });
      priceService.setPrice(db, ctx, { skuId: sku.skuId, amountMinor: Math.round(cost * (150 + ((p + v) % 45))),
        currency: 'USD', source: 'synthetic_generation', sourceDetail: { synthetic: true } });
      const location = locations[(p + v) % locations.length];
      const received = 25 + ((p * 11 + v * 5) % 80);
      const receivedAt = dateMonthsAgo(spec.historyMonths, p + v);
      inventory.receive(db, ctx, { skuId: sku.skuId, locationId: location.id, quantity: received,
        occurredAt: receivedAt, reference: `SYN-OPEN-${p + 1}-${v + 1}`,
        notes: 'Synthetic receipt generated in Test environment.' });
      movements += 1;
      const sold = (p + v) % Math.min(18, received);
      if (sold > 0) {
        const soldAt = new Date(Math.min(Date.now() - 60_000, Date.parse(receivedAt) + 5 * 24 * 60 * 60 * 1000)).toISOString();
        inventory.issue(db, ctx, { skuId: sku.skuId, locationId: location.id, quantity: sold,
          occurredAt: soldAt, reasonCode: 'sold',
          reference: `SYN-SALE-${p + 1}-${v + 1}`, notes: 'Synthetic sale history generated in Test environment.' });
        movements += 1;
      }
      madeSkus += 1;
    }
  }
  return { products: spec.products, skus: madeSkus, suppliers: suppliers.length,
    locations: locations.length, historyMonths: spec.historyMonths, movements };
}

module.exports = { generate, productName, supplierName };
