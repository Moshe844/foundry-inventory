'use strict';

/**
 * What this owner has said they want, in a shape the planners can use.
 *
 * The goals themselves live in the ordinary preference store, because that is
 * where every deliberate instruction already lives and a second place for
 * settings is a second place to forget to look. This module is the translation
 * layer: it turns "avoid stockouts" into a service level, "no more than sixty
 * days" into a cap, and hands both to arithmetic that has no opinions of its
 * own.
 *
 * A goal chooses between answers StockChief was already permitted to give. It
 * cannot widen authority, raise a spending limit, or make an action automatic
 * that was not automatic before — those come from a capability and an approved
 * policy, and nothing here touches either. Wanting fewer stockouts very much is
 * not permission to spend more money without asking.
 */

const preferences = require('../autopilot/preferences');

/** The planning defaults, when the owner has said nothing at all. */
const DEFAULTS = {
  serviceLevel: 'balanced',
  maxDaysOfSupply: null,
  inventoryCapMinor: null,
  cashReserveMinor: null,
  coverDays: 30,
  reviewDays: 7,
  sourceKeepDays: 21,
  prioritiseCoreProducts: false,
  conservativeSeasonal: false,
  preferTransferBeforePurchasing: false,
};

/**
 * Reads the stated goals.
 *
 * Every value is bounds-checked on the way out as well as on the way in: a
 * preference written before a limit changed must not become a way around it.
 */
function forWorkspace(db, workspaceId) {
  const stored = preferences.all(db, workspaceId);
  const KEYS = preferences.KEYS;

  const goals = { ...DEFAULTS };

  const service = stored[KEYS.SERVICE_LEVEL.key];
  if (service && ['lean', 'balanced', 'protective'].includes(service)) goals.serviceLevel = service;

  const maxDays = Number(stored[KEYS.MAX_DAYS_OF_SUPPLY.key]);
  if (Number.isFinite(maxDays) && maxDays >= 7 && maxDays <= 730) goals.maxDaysOfSupply = maxDays;

  const cap = Number(stored[KEYS.INVENTORY_CAP.key]);
  if (Number.isFinite(cap) && cap > 0) goals.inventoryCapMinor = cap;

  const reserve = Number(stored[KEYS.CASH_RESERVE.key]);
  if (Number.isFinite(reserve) && reserve >= 0) goals.cashReserveMinor = reserve;

  const cover = Number(stored[KEYS.TARGET_DAYS_OF_STOCK.key]);
  if (Number.isFinite(cover) && cover > 0) goals.coverDays = cover;

  const keep = Number(stored[KEYS.SOURCE_SAFETY_DAYS.key]);
  if (Number.isFinite(keep) && keep > 0) goals.sourceKeepDays = keep;

  goals.prioritiseCoreProducts = stored[KEYS.PRIORITISE_CORE_PRODUCTS.key] === true;
  goals.conservativeSeasonal = stored[KEYS.CONSERVATIVE_SEASONAL.key] === true;
  goals.preferTransferBeforePurchasing = stored[KEYS.PREFER_TRANSFER_BEFORE_PURCHASING.key] === true;

  /*
   * A ceiling on days of supply also caps the cover StockChief buys. Without this
   * the two settings quietly contradict each other and the more generous one
   * wins, which is the opposite of what somebody setting a limit intended.
   */
  if (goals.maxDaysOfSupply !== null && goals.coverDays > goals.maxDaysOfSupply) {
    goals.coverDays = goals.maxDaysOfSupply;
  }

  return goals;
}

/**
 * The goals as sentences, for the page that shows an owner what StockChief thinks
 * it has been told. Only what was actually set — silence is not a goal.
 */
function describe(db, workspaceId) {
  return preferences.list(db, workspaceId)
    .filter((row) => GOAL_KEYS.has(row.key))
    .map((row) => ({
      key: row.key,
      label: row.label,
      // Their words if they used any, StockChief's paraphrase if they did not.
      text: row.statedAs || row.description,
      description: row.description,
      statedAs: row.statedAs,
      source: row.source,
      updatedAt: row.updatedAt,
    }));
}

const GOAL_KEYS = new Set([
  preferences.KEYS.SERVICE_LEVEL.key,
  preferences.KEYS.MAX_DAYS_OF_SUPPLY.key,
  preferences.KEYS.INVENTORY_CAP.key,
  preferences.KEYS.CASH_RESERVE.key,
  preferences.KEYS.PRIORITISE_CORE_PRODUCTS.key,
  preferences.KEYS.CONSERVATIVE_SEASONAL.key,
  preferences.KEYS.TARGET_DAYS_OF_STOCK.key,
  preferences.KEYS.SOURCE_SAFETY_DAYS.key,
]);

/**
 * How much money is currently in stock, against the cap if one was set.
 *
 * Reported rather than enforced. A cap is a preference between reasonable
 * plans, not a wall — refusing to reorder a product a customer has already paid
 * for because a total is high would be following the rule off a cliff.
 */
function inventoryPosition(db, workspaceId, goals) {
  const row = db.prepare(`SELECT COALESCE(SUM(total_cost_minor), 0) AS value_minor
    FROM accounting_inventory_cost_balances WHERE workspace_id = ?`).get(workspaceId);
  const heldMinor = Number(row.value_minor || 0);
  if (!goals.inventoryCapMinor) return { heldMinor, capMinor: null, overBy: null, within: true };
  const overBy = heldMinor - goals.inventoryCapMinor;
  return {
    heldMinor,
    capMinor: goals.inventoryCapMinor,
    overBy: overBy > 0 ? overBy : 0,
    within: overBy <= 0,
  };
}

module.exports = { forWorkspace, describe, inventoryPosition, DEFAULTS, GOAL_KEYS };
