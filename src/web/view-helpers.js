'use strict';

const {
  TRACKING_MODES,
  LOCATION_KINDS,
  ADJUSTMENT_REASONS,
  ISSUE_REASONS,
  CONDITIONS,
  OPERATIONS,
  ROLES,
  labelFor,
} = require('../domain/constants');

const { icon } = require('./icons');

const numberFormat = new Intl.NumberFormat('en-US');

function qty(value) {
  const n = Number(value || 0);
  return numberFormat.format(n);
}

const { unitCount, unitLabel } = require('../lib/units');

function plural(count, one, many) {
  return Number(count) === 1 ? one : many || `${one}s`;
}

/**
 * Calendar dates (lot expiry, received-on) are stored as UTC midnight and mean
 * a day, not an instant, so they are formatted in UTC. Formatting them locally
 * would show "Oct 29" for an October 30th expiry west of Greenwich.
 */
function shortDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function dateInputValue(iso) {
  return iso ? String(iso).slice(0, 10) : '';
}

function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return shortDate(iso);
}

function dateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function trackingLabel(mode, hasVariants) {
  const base = TRACKING_MODES[mode] ? TRACKING_MODES[mode].label : mode;
  return hasVariants ? `${base} · Variants` : base;
}

function trackingBadgeClass(mode) {
  return `badge badge--${mode}`;
}

function operationLabel(op) {
  return labelFor(OPERATIONS, op);
}

function locationKindLabel(kind) {
  return labelFor(LOCATION_KINDS, kind);
}

function reasonText(operation, code) {
  if (!code) return '';
  return operation === 'adjust' ? labelFor(ADJUSTMENT_REASONS, code) : labelFor(ISSUE_REASONS, code);
}

function conditionLabel(id) {
  return labelFor(CONDITIONS, id);
}

function roleLabel(id) {
  return labelFor(ROLES, id);
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/** Rebuilds the current query string with some values replaced. */
function queryString(current, changes) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...current, ...changes })) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

function expiryState(iso) {
  if (!iso) return null;
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (Number.isNaN(days)) return null;
  if (days < 0) return { tone: 'danger', text: 'Expired' };
  if (days <= 30) return { tone: 'warn', text: `${days}d left` };
  return { tone: 'muted', text: shortDate(iso) };
}

/** Column headings for Ask Foundry results, which come back as plain keys. */
const COLUMN_LABELS = {
  label: 'Item',
  code: 'Code',
  onHand: 'On hand',
  location: 'Location',
  occurredAt: 'When',
  operation: 'What',
  delta: 'Change',
  actor: 'Who',
  reason: 'Reason',
  expected: 'Before',
  counted: 'After',
  lot: 'Lot',
  quantity: 'Quantity',
  expiresAt: 'Expires',
  lastOutbound: 'Last issued',
  issued: 'Issued',
  movements: 'Movements',
  severity: 'Priority',
  summary: 'Detail',
};

function columnLabel(key) {
  if (COLUMN_LABELS[key]) return COLUMN_LABELS[key];
  return String(key)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

module.exports = {
  unitCount,
  unitLabel,
  icon,
  qty,
  plural,
  columnLabel,
  shortDate,
  dateInputValue,
  dateTime,
  timeAgo,
  trackingLabel,
  trackingBadgeClass,
  operationLabel,
  locationKindLabel,
  reasonText,
  conditionLabel,
  roleLabel,
  initials,
  queryString,
  expiryState,
  TRACKING_MODES,
  LOCATION_KINDS,
  ADJUSTMENT_REASONS,
  ISSUE_REASONS,
  CONDITIONS,
  OPERATIONS,
  ROLES,
};
