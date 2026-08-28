'use strict';

/**
 * Detection thresholds, and which categories a workspace can produce at all.
 *
 * Relevance is decided by the Mission 2 configuration, not by guesswork: a
 * business with no lot tracking can never raise an expiring-inventory item, and
 * a single-location business can never raise a location imbalance. That is what
 * keeps the briefing free of categories that could not apply.
 */

const DETECTION_RULE_VERSION = 'm6.1';

const THRESHOLDS = {
  stockout: {
    criticalDays: 7,
    importantDays: 14,
    watchDays: 21,
  },
  lowStock: {
    // Out of stock entirely, for something that has been moving.
    recentlyActiveDays: 60,
  },
  imbalance: {
    // Both sides need enough stock and enough movement to be worth a claim.
    minTotalOnHand: 20,
    minBusyLocationOutbound: 5,
    minQuietLocationOnHand: 10,
    // The busy location must be materially shorter of stock than the quiet one.
    minStockRatio: 3,
    // …and the quiet location must be materially slower.
    minOutboundRatio: 2,
  },
  adjustment: {
    lookbackDays: 45,
    minBaselineCount: 3,
    // How many times the usual correction before it is worth a look.
    magnitudeMultiple: 4,
    absoluteFloor: 5,
    // With no baseline, judge against the balance it was correcting.
    noBaselineShareOfExpected: 0.25,
    noBaselineFloor: 10,
  },
  // Purchasing thresholds. A day late is not news; a week with stock still
  // outstanding is. Price movements are only worth raising when they are large
  // enough to change a decision.
  latePurchaseOrder: {
    watchDays: 1,
    importantDays: 4,
    criticalDays: 10,
  },
  priceChange: {
    minPercent: 10,
    importantPercent: 20,
    minPreviousCost: 0.01,
  },
  expiration: {
    criticalDays: 7,
    importantDays: 21,
    watchDays: 45,
    minQuantity: 1,
    // A batch code is per product in the records, but it is one physical batch
    // in the world: a single roast bagged in three sizes is one decision, not
    // three. From this many products sharing a code and a date, report it once.
    rollUpAcrossProductsAt: 2,
  },
  stale: {
    defaultDays: 90,
    watchDays: 90,
    importantDays: 150,
    minQuantity: 5,
  },
  serialInactivity: {
    watchDays: 120,
    importantDays: 240,
    // Past this many idle units of one product, report them as one situation
    // rather than one card each.
    rollUpAt: 3,
  },
};

const ALL_CATEGORIES = [
  'replenishment_needed',
  'stock_protection_boundary',
  'low_stock',
  'stockout_risk',
  'location_imbalance',
  'unusual_adjustment',
  'expiring_inventory',
  'stale_inventory',
  'serialized_inactivity',
  'data_integrity',
  'late_purchase_order',
  'supplier_price_change',
];

/**
 * Which categories this workspace's inventory model can actually produce.
 * @param {object} context { configuration, locationCount, trackingModes }
 */
function relevantCategories(context) {
  const model = (context.configuration && context.configuration.inventoryModel) || {};
  const modes = new Set(context.trackingModes || []);
  // Replenishment is always relevant: it gates itself on a reorder point being
  // configured, which is a stronger and more honest test than any guess here.
  const relevant = new Set([
    'replenishment_needed', 'stock_protection_boundary', 'low_stock', 'stockout_risk', 'unusual_adjustment',
    'stale_inventory', 'data_integrity',
  ]);

  if ((context.locationCount || 0) >= 2) relevant.add('location_imbalance');

  // Expiration needs lot tracking AND expiry capture to be configured.
  const lotConfigured = Boolean(model.lotRules && model.lotRules.enabled) || modes.has('lot');
  const expirationConfigured = model.expirationRules ? Boolean(model.expirationRules.enabled) : true;
  if (lotConfigured && expirationConfigured) relevant.add('expiring_inventory');

  const serialConfigured = Boolean(model.serialRules && model.serialRules.enabled) || modes.has('serial');
  if (serialConfigured) relevant.add('serialized_inactivity');

  // Purchasing findings need purchasing to exist. A business that has not added
  // a supplier cannot have a late order or a price change, and running those
  // detectors over an empty table just to find nothing is noise in the code.
  if (context.hasPurchasing) {
    relevant.add('late_purchase_order');
    relevant.add('supplier_price_change');
  }

  return relevant;
}

/**
 * Categories that describe the same underlying situation for one SKU and should
 * be told as a single story rather than three separate alarms.
 */
const GROUPABLE = ['replenishment_needed', 'stock_protection_boundary', 'stockout_risk', 'low_stock', 'location_imbalance', 'stale_inventory'];

/** When several groupable signals collide, this is the one that leads. */
// A worked replenishment plan leads over every symptom of the same shortage:
// it already accounts for what they each noticed, and with better arithmetic.
const GROUP_PRECEDENCE = ['replenishment_needed', 'stock_protection_boundary', 'low_stock', 'stockout_risk', 'location_imbalance', 'stale_inventory'];

const SEVERITY_WEIGHT = { critical: 100, important: 60, watch: 25 };
const CONFIDENCE_WEIGHT = { high: 1, medium: 0.85, low: 0.6 };

/** Snooze length when a customer says "not now". */
const SNOOZE_DAYS = 14;

module.exports = {
  DETECTION_RULE_VERSION,
  THRESHOLDS,
  ALL_CATEGORIES,
  GROUPABLE,
  GROUP_PRECEDENCE,
  SEVERITY_WEIGHT,
  CONFIDENCE_WEIGHT,
  SNOOZE_DAYS,
  relevantCategories,
};
