'use strict';

/**
 * The operating layer: what a person should do first, and what they should do
 * next. There is no tour state here. Every completed step and recommendation
 * is derived from the same records Foundry operates on.
 */

const needsYouInbox = require('./needs-you-inbox');

const openingWords = /\b(opening|starting|initial|beginning|migrat)/i;

function json(value, fallback = {}) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function facts(db, workspaceId) {
  const configuration = db
    .prepare('SELECT configured_at, inventory_model FROM workspace_configuration WHERE workspace_id = ?')
    .get(workspaceId) || null;
  const items = db.prepare(
    `SELECT i.id, i.name, i.tracking_mode, s.id AS sku_id, s.variant_label
       FROM items i LEFT JOIN skus s ON s.item_id = i.id AND s.is_active = 1
      WHERE i.workspace_id = ? AND i.is_active = 1
      ORDER BY i.created_at, s.position LIMIT 500`
  ).all(workspaceId);
  const first = items.find((row) => row.sku_id) || items[0] || null;
  const locations = db.prepare(
    'SELECT id, name FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name'
  ).all(workspaceId);
  const movements = db.prepare(
    `SELECT operation, notes, reason_code FROM movements WHERE workspace_id = ? ORDER BY seq`
  ).all(workspaceId);
  const issueCount = movements.filter((row) => row.operation === 'issue').length;
  const transferCount = movements.filter((row) => row.operation === 'transfer').length;
  const normalReceipts = movements.filter((row) => row.operation === 'receive'
    && !openingWords.test(`${row.notes || ''} ${row.reason_code || ''}`)).length;
  const supplierCount = db.prepare(
    "SELECT COUNT(*) AS n FROM suppliers WHERE workspace_id = ? AND status = 'active'"
  ).get(workspaceId).n;
  const supplierItemCount = db.prepare(
    'SELECT COUNT(*) AS n FROM supplier_items WHERE workspace_id = ? AND is_active = 1'
  ).get(workspaceId).n;
  const reorderCount = db.prepare(
    'SELECT COUNT(*) AS n FROM reorder_policies WHERE workspace_id = ? AND reorder_point IS NOT NULL'
  ).get(workspaceId).n;
  const missingSupplier = db.prepare(
    `SELECT rp.sku_id, i.name, s.variant_label
       FROM reorder_policies rp
       JOIN skus s ON s.id = rp.sku_id
       JOIN items i ON i.id = s.item_id
      WHERE rp.workspace_id = ? AND rp.reorder_point IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM supplier_items si
           WHERE si.workspace_id = rp.workspace_id AND si.sku_id = rp.sku_id AND si.is_active = 1
        )
      ORDER BY i.name, s.position LIMIT 1`
  ).get(workspaceId) || null;
  const missingReorder = db.prepare(
    `SELECT s.id AS sku_id, i.name, s.variant_label
       FROM skus s JOIN items i ON i.id = s.item_id
      WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
        AND i.tracking_mode != 'serial'
        AND NOT EXISTS (
          SELECT 1 FROM reorder_policies rp
           WHERE rp.workspace_id = s.workspace_id AND rp.sku_id = s.id AND rp.reorder_point IS NOT NULL
        )
      ORDER BY i.name, s.position LIMIT 1`
  ).get(workspaceId) || null;
  const partialOrder = db.prepare(
    `SELECT po.id, po.po_number,
            COALESCE(SUM(pol.quantity_units - pol.quantity_received_units), 0) AS outstanding
       FROM purchase_orders po
       JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
      WHERE po.workspace_id = ? AND po.status = 'PARTIALLY_RECEIVED'
      GROUP BY po.id ORDER BY po.updated_at DESC LIMIT 1`
  ).get(workspaceId) || null;
  const openOrder = db.prepare(
    `SELECT id, po_number, status FROM purchase_orders
      WHERE workspace_id = ? AND status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')
      ORDER BY updated_at DESC LIMIT 1`
  ).get(workspaceId) || null;
  const onboarding = db.prepare(
    'SELECT path, status FROM workspace_onboarding WHERE workspace_id = ?'
  ).get(workspaceId) || null;
  const autopilot = db.prepare(
    'SELECT mode, created_at, updated_at FROM workspace_autopilot WHERE workspace_id = ?'
  ).get(workspaceId) || null;
  const activePolicies = db.prepare(
    `SELECT COUNT(*) AS n FROM automation_policies
      WHERE workspace_id = ? AND enabled = 1 AND approved_at IS NOT NULL AND disabled_at IS NULL`
  ).get(workspaceId).n;

  const uniqueItems = new Set(items.map((row) => row.id));
  const inventoryModel = json(configuration && configuration.inventory_model, {});
  const purchasingRelevant = items.some((row) => row.tracking_mode && row.tracking_mode !== 'serial')
    || supplierCount > 0 || reorderCount > 0;
  const authorityReviewed = activePolicies > 0
    || Boolean(autopilot && (autopilot.mode !== 'SUPERVISED' || autopilot.updated_at !== autopilot.created_at));

  return {
    configured: Boolean(configuration && configuration.configured_at),
    inventoryModel,
    itemCount: uniqueItems.size,
    skuCount: items.filter((row) => row.sku_id).length,
    first,
    locations,
    movementCount: movements.length,
    issueCount,
    normalActivityCount: issueCount + transferCount + normalReceipts,
    supplierCount,
    supplierItemCount,
    reorderCount,
    missingSupplier,
    missingReorder,
    partialOrder,
    openOrder,
    onboarding,
    purchasingRelevant,
    authorityReviewed,
    activePolicies,
  };
}

const displayName = (record) => record
  ? `${record.name}${record.variant_label ? ` — ${record.variant_label}` : ''}`
  : 'a product';

function setupAction(state) {
  if (!state.configured) return { href: '/onboarding', action: 'Set up this inventory' };
  if (!state.locations.length) return { href: '/locations', action: 'Add a location' };
  if (!state.itemCount) return { href: '/inventory/new', action: 'Add a product' };
  return { href: '/inventory', action: 'View inventory setup' };
}

function replenishmentAction(state) {
  if (state.missingSupplier) {
    return {
      href: `/purchasing/supplier-for/${state.missingSupplier.sku_id}`,
      action: 'Add its supplier',
      detail: `${displayName(state.missingSupplier)} has a reorder rule but no supplier to order from.`,
    };
  }
  const record = state.missingReorder || state.first;
  if (record && record.sku_id) {
    return {
      href: `/purchasing/why/${record.sku_id}?guide=1#reorder-settings`,
      action: 'Set replenishment rules',
      detail: `Set when ${displayName(record)} is low and what stock level Foundry should restore.`,
    };
  }
  return { href: '/purchasing/setup', action: 'Set up purchasing', detail: 'Add suppliers and the products you buy from them.' };
}

function examples(state) {
  const item = displayName(state.first);
  const location = state.locations[0] && state.locations[0].name;
  if (!state.itemCount) {
    return [
      'I want to add my products',
      'Help me set up inventory from this file',
      'We are starting from scratch',
    ];
  }
  if (!state.movementCount) {
    return [
      `I want to enter opening inventory for ${item}`,
      'Help me import my opening inventory from a file',
      `We received 10 ${item}${location ? ` at ${location}` : ''}`,
    ];
  }
  if (!state.issueCount) {
    return [
      `We sold 1 ${item}${location ? ` at ${location}` : ''}`,
      `We received 10 ${item}${location ? ` at ${location}` : ''}`,
      `I counted ${item}${location ? ` at ${location}` : ''}`,
    ];
  }
  if (state.partialOrder) {
    return [
      `We received stock for ${state.partialOrder.po_number}`,
      `What is still outstanding on ${state.partialOrder.po_number}?`,
      `I counted ${item}${location ? ` at ${location}` : ''}`,
    ];
  }
  if (state.missingSupplier) {
    return [
      `Help me add a supplier for ${displayName(state.missingSupplier)}`,
      `Set replenishment rules for ${item}`,
      `We sold 1 ${item}${location ? ` at ${location}` : ''}`,
    ];
  }
  return [
    `We sold 1 ${item}${location ? ` at ${location}` : ''}`,
    `We received 10 ${item}${location ? ` at ${location}` : ''}`,
    state.locations.length > 1
      ? `Move 5 ${item} from ${state.locations[0].name} to ${state.locations[1].name}`
      : `I counted ${item}${location ? ` at ${location}` : ''}`,
  ];
}

function buildChecklist(state) {
  // Existing inventory is the truth for this step. A workspace populated by a
  // migration or manual setup must not be sent back through the descriptive
  // configuration flow merely because it has no workspace_configuration row.
  const setup = state.itemCount > 0 && state.locations.length > 0;
  const opening = setup && state.movementCount > 0;
  const firstActivity = opening && state.normalActivityCount > 0;
  const purchasing = !state.purchasingRelevant
    || (state.reorderCount > 0 && state.supplierItemCount > 0);
  const authority = state.authorityReviewed;
  const setupCta = setupAction(state);
  const replenishment = replenishmentAction(state);
  const saleExample = state.first
    ? `We sold 1 ${displayName(state.first)}${state.locations[0] ? ` at ${state.locations[0].name}` : ''}`
    : 'We sold an item';

  const steps = [
    {
      id: 'structure', title: state.locations.length ? 'Set up products and locations' : 'Start with a location', complete: setup,
      detail: setup
        ? `${state.itemCount} product${state.itemCount === 1 ? '' : 's'} across ${state.locations.length} location${state.locations.length === 1 ? '' : 's'}.`
        : 'Foundry needs to know what you track and where stock can be held.',
      ...setupCta,
    },
    {
      id: 'opening', title: 'Enter opening inventory', complete: opening,
      detail: opening
        ? 'Opening stock is recorded in the ledger.'
        : 'Tell Foundry what is on hand now, or attach the file that already contains it.',
      href: `/actions?q=${encodeURIComponent('I want to enter opening inventory')}`,
      action: 'Confirm current stock',
    },
    {
      id: 'activity', title: 'Record your first sale or receipt', complete: firstActivity,
      detail: firstActivity
        ? 'Foundry has started observing normal stock movement.'
        : 'Record real activity as it happens so Foundry can learn demand and keep the ledger current.',
      href: `/actions?q=${encodeURIComponent(saleExample)}`,
      action: 'Record an activity',
    },
  ];
  if (state.purchasingRelevant) {
    steps.push({
      id: 'replenishment', title: 'Configure replenishment and suppliers', complete: purchasing,
      detail: purchasing ? 'Foundry has a reorder rule and a supplier relationship it can use.' : replenishment.detail,
      href: replenishment.href, action: replenishment.action, optional: true,
    });
  }
  steps.push({
    id: 'authority', title: 'Choose how much routine work Foundry may handle', complete: authority,
    detail: authority
      ? activeAuthorityCopy(state)
      : 'Keep Ask me first, or explicitly approve narrow limits for routine transfers and purchasing.',
    href: '/autopilot', action: 'Choose automatic-work limits', optional: true,
  });

  let foundCurrent = false;
  for (const step of steps) {
    if (!step.complete && !foundCurrent) {
      step.current = true;
      foundCurrent = true;
    }
  }
  return { steps, active: !setup || !opening || !firstActivity };
}

function activeAuthorityCopy(state) {
  if (state.activePolicies) {
    return `${state.activePolicies} approved routine-work ${state.activePolicies === 1 ? 'policy is' : 'policies are'} available.`;
  }
  return 'You reviewed the automatic-work mode; Foundry will follow that choice.';
}

function nextBestAction(db, workspaceId, state) {
  const inbox = needsYouInbox.inbox(db, workspaceId);
  if (inbox.length) {
    const item = inbox[0];
    return {
      kind: 'needs-you', eyebrow: 'What should I do next?', title: item.title,
      what: item.happened, why: item.why, recommendation: item.recommendation,
      action: item.actionLabel, href: item.href,
    };
  }
  if (state.partialOrder) {
    return {
      kind: 'purchase-order', eyebrow: 'What should I do next?',
      title: `${state.partialOrder.outstanding} units are still outstanding on ${state.partialOrder.po_number}.`,
      what: 'Part of this purchase order has arrived and part is still expected.',
      why: 'Foundry keeps the remainder on order until it is physically received or the order is closed.',
      recommendation: 'Open the order when the next delivery arrives and record only what is in the box.',
      action: 'Open the purchase order', href: `/purchasing/orders/${state.partialOrder.id}`,
    };
  }
  if (state.missingSupplier) {
    return {
      kind: 'supplier', eyebrow: 'What should I do next?',
      title: `Add a supplier for ${displayName(state.missingSupplier)}.`,
      what: 'A reorder rule exists, but this variant is not linked to an active supplier.',
      why: 'Without a supplier, Foundry cannot know the pack size, price or lead time and cannot prepare a truthful order.',
      recommendation: 'Add the supplier and purchasing terms for this exact variant.',
      action: 'Add its supplier', href: `/purchasing/supplier-for/${state.missingSupplier.sku_id}`,
    };
  }
  if (state.missingReorder) {
    return {
      kind: 'replenishment', eyebrow: 'What should I do next?',
      title: `Set low-stock and replenishment rules for ${displayName(state.missingReorder)}.`,
      what: 'Foundry is recording this variant, but no reorder point is set.',
      why: 'Without the rule, Foundry will not invent when you consider it low or how far to replenish it.',
      recommendation: 'Set the reorder point, order-up-to level and supplier for this variant.',
      action: 'Set replenishment rules',
      href: `/purchasing/why/${state.missingReorder.sku_id}?guide=1#reorder-settings`,
    };
  }
  if (!state.authorityReviewed) {
    return {
      kind: 'authority', eyebrow: 'What should I do next?', title: 'Choose how Foundry should handle routine work.',
      what: 'Foundry is currently using the safe default and asks before consequential changes.',
      why: 'Automatic authority is never inferred from your activity.',
      recommendation: 'Keep Ask me first, or explicitly approve narrow transfer and purchasing limits.',
      action: 'Choose automatic-work limits', href: '/autopilot',
    };
  }
  return {
    kind: 'clear', eyebrow: 'What should I do next?', title: 'Everything is in order. Nothing needs you right now.',
    what: 'Foundry has no unresolved decision or physical fact waiting.',
    why: 'Recorded inventory, purchasing and exception state are currently consistent.',
    recommendation: 'Keep telling Foundry about normal sales, receipts, transfers and counts.',
    action: null, href: null,
  };
}

function build(db, workspaceId) {
  const state = facts(db, workspaceId);
  const checklist = buildChecklist(state);
  return {
    state,
    checklistActive: checklist.active,
    steps: checklist.steps,
    next: checklist.active ? null : nextBestAction(db, workspaceId, state),
    examples: examples(state),
  };
}

function guideTopics(db, workspaceId) {
  const state = facts(db, workspaceId);
  const item = displayName(state.first);
  const here = state.locations[0] && state.locations[0].name;
  const there = state.locations[1] && state.locations[1].name;
  const replenish = replenishmentAction(state);
  const sale = `We sold 1 ${item}${here ? ` at ${here}` : ''}`;
  const receipt = `We received 10 ${item}${here ? ` at ${here}` : ''}`;
  const count = `I counted ${item}${here ? ` at ${here}` : ''}`;

  return [
    { title: 'Set up inventory', path: 'Choose the setup path that matches where your records live, then approve the products, variants and locations Foundry found.', tell: '“We are starting from scratch” or attach your existing file.', href: setupAction(state).href, action: setupAction(state).action },
    { title: 'Record a sale', path: 'Tell Foundry what sold, how many, and where. Check the preview, then approve it.', tell: `“${sale}.”`, href: `/actions?q=${encodeURIComponent(sale)}`, action: 'Record a sale' },
    { title: 'Receive stock', path: 'Tell Foundry what arrived and where. If it belongs to a PO, name the PO number.', tell: `“${receipt}.”`, href: `/actions?q=${encodeURIComponent(receipt)}`, action: 'Receive stock' },
    { title: 'Move stock', path: there ? 'Name the item, quantity, source and destination. Foundry verifies that totals stay unchanged.' : 'Add a second location first; a transfer needs a source and a destination.', tell: there ? `“Move 5 ${item} from ${here} to ${there}.”` : '“Add a second location.”', href: there ? `/actions?q=${encodeURIComponent(`Move 5 ${item} from ${here} to ${there}`)}` : '/locations', action: there ? 'Move stock' : 'Add a location' },
    { title: 'Fix a count', path: 'Report the physical count. If it disagrees with the ledger, Foundry opens one investigation and does not silently change stock.', tell: `“${count}.”`, href: `/actions?q=${encodeURIComponent(count)}`, action: 'Report a count' },
    { title: 'Set low-stock/reorder rules', path: 'Open the exact variant and set its reorder point, order-up-to level, safety stock and preferred supplier.', tell: `“Set a reorder point for ${item}.”`, href: replenish.href, action: replenish.action },
    { title: 'Set up suppliers and purchase orders', path: 'Add the supplier, connect the variants it sells, and record price, pack size, minimum and lead time. Foundry can then prepare a PO.', tell: `“Help me add a supplier for ${item}.”`, href: state.missingSupplier ? `/purchasing/supplier-for/${state.missingSupplier.sku_id}` : '/purchasing/setup', action: 'Set up purchasing' },
    { title: 'Receive a purchase order', path: state.openOrder ? `Open ${state.openOrder.po_number}, count what arrived, and record a partial or full receipt.` : 'Open the placed purchase order when the delivery arrives, count the box, and record only what actually arrived.', tell: state.openOrder ? `“We received stock for ${state.openOrder.po_number}.”` : '“The purchase order arrived.”', href: state.openOrder ? `/purchasing/orders/${state.openOrder.id}` : '/purchasing', action: state.openOrder ? `Open ${state.openOrder.po_number}` : 'View purchase orders' },
    { title: 'Control what Foundry may do automatically', path: 'Choose Ask me first or explicitly enable bounded routine transfers and purchasing. Custom contains the advanced policy engine.', tell: '“Automatically transfer up to 5 units at a time.”', href: '/autopilot', action: 'Choose automatic work' },
    { title: 'Find what needs my attention', path: 'Needs you is the inbox for real decisions and physical facts. Each item says what happened, why Foundry stopped, and the one action to take.', tell: '“What needs my attention?”', href: '/needs-you', action: 'Open Needs you' },
  ];
}

module.exports = { facts, build, guideTopics, examples, displayName };
