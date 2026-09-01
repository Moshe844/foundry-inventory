'use strict';

/**
 * The tracking mode decides how a SKU's stock is represented.
 * `has_variants` is orthogonal, which is what lets a variant item also be
 * lot tracked or serialized without a second engine.
 */
const TRACKING_MODES = {
  quantity: {
    id: 'quantity',
    label: 'Quantity',
    staffLabel: 'Counted by quantity',
    blurb: 'I mainly need to know how many I have.',
  },
  serial: {
    id: 'serial',
    label: 'Individual units',
    staffLabel: 'Individually tracked units',
    blurb: 'Every physical unit has its own serial number or identity.',
  },
  lot: {
    id: 'lot',
    label: 'Lots / batches',
    staffLabel: 'Lots and batches',
    blurb: 'Groups of this item need their own lot, batch, or expiration information.',
  },
};

const TRACKING_MODE_IDS = Object.keys(TRACKING_MODES);

const LOCATION_KINDS = [
  { id: 'warehouse', label: 'Warehouse' },
  { id: 'store', label: 'Store' },
  { id: 'stockroom', label: 'Stockroom' },
  { id: 'truck', label: 'Truck' },
  { id: 'office', label: 'Office' },
  { id: 'other', label: 'Other' },
];

const LOCATION_KIND_IDS = LOCATION_KINDS.map((k) => k.id);

const OPERATIONS = [
  { id: 'receive', label: 'Received' },
  { id: 'issue', label: 'Issued' },
  { id: 'transfer', label: 'Transferred' },
  { id: 'adjust', label: 'Adjusted' },
];

const OPERATION_IDS = OPERATIONS.map((o) => o.id);

const ADJUSTMENT_REASONS = [
  { id: 'physical_count', label: 'Physical count' },
  { id: 'damage', label: 'Damaged' },
  { id: 'loss', label: 'Lost or missing' },
  { id: 'found', label: 'Found stock' },
  { id: 'correction', label: 'Data correction' },
  { id: 'other', label: 'Other' },
];

const ADJUSTMENT_REASON_IDS = ADJUSTMENT_REASONS.map((r) => r.id);

const ISSUE_REASONS = [
  { id: 'used', label: 'Used in work' },
  { id: 'sold', label: 'Sold or delivered' },
  { id: 'damaged', label: 'Damaged or scrapped' },
  { id: 'returned', label: 'Returned to supplier' },
  { id: 'other', label: 'Other' },
];

const ISSUE_REASON_IDS = ISSUE_REASONS.map((r) => r.id);

const CONDITIONS = [
  { id: 'good', label: 'Good' },
  { id: 'damaged', label: 'Damaged' },
  { id: 'repair', label: 'In repair' },
  { id: 'unknown', label: 'Unknown' },
];

const CONDITION_IDS = CONDITIONS.map((c) => c.id);

const ROLES = [
  { id: 'owner', label: 'Owner', blurb: 'Full access, including locations, people and settings.' },
  { id: 'accountant', label: 'Accountant', blurb: 'Financial records, reconciliation, reports and period close; no physical stock operations.' },
  { id: 'staff', label: 'Staff', blurb: 'Day-to-day inventory work: receive, issue, transfer, adjust.' },
];

const ROLE_IDS = ROLES.map((r) => r.id);

function labelFor(list, id) {
  const found = list.find((entry) => entry.id === id);
  return found ? found.label : id;
}

module.exports = {
  TRACKING_MODES,
  TRACKING_MODE_IDS,
  LOCATION_KINDS,
  LOCATION_KIND_IDS,
  OPERATIONS,
  OPERATION_IDS,
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REASON_IDS,
  ISSUE_REASONS,
  ISSUE_REASON_IDS,
  CONDITIONS,
  CONDITION_IDS,
  ROLES,
  ROLE_IDS,
  labelFor,
};
