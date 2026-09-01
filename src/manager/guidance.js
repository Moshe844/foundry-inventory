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
  const onHand = db.prepare(
    'SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?'
  ).get(workspaceId).n;
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
    `SELECT s.id AS sku_id, i.name, s.variant_label
       FROM skus s
       JOIN items i ON i.id = s.item_id
      WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
        AND i.tracking_mode != 'serial'
        AND NOT EXISTS (
          SELECT 1 FROM supplier_items si
           WHERE si.workspace_id = s.workspace_id AND si.sku_id = s.id AND si.is_active = 1
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
    'SELECT mode FROM workspace_autopilot WHERE workspace_id = ?'
  ).get(workspaceId) || null;
  const activePolicies = db.prepare(
    `SELECT COUNT(*) AS n FROM automation_policies
      WHERE workspace_id = ? AND enabled = 1 AND approved_at IS NOT NULL AND disabled_at IS NULL`
  ).get(workspaceId).n;
  const authorityDecisionCount = db.prepare(
    "SELECT COUNT(*) AS n FROM domain_events WHERE workspace_id = ? AND event_type = 'authority.updated'"
  ).get(workspaceId).n;
  const connectionCount = db.prepare(
    "SELECT COUNT(*) AS n FROM workspace_connectors WHERE workspace_id = ? AND status = 'connected'"
  ).get(workspaceId).n;
  const sellingConnectionCount = db.prepare(
    "SELECT COUNT(*) AS n FROM workspace_connectors WHERE workspace_id = ? AND status = 'connected' AND provider_type IN ('shopify','square','clover','woocommerce','reference_webhook')"
  ).get(workspaceId).n;
  const salesOrderCount = db.prepare(
    'SELECT COUNT(*) AS n FROM sales_orders WHERE workspace_id = ?'
  ).get(workspaceId).n;
  const missingPrice = db.prepare(
    `SELECT i.id AS item_id, i.name, s.id AS sku_id, s.variant_label
       FROM skus s JOIN items i ON i.id = s.item_id
      WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
        AND (SELECT sp.amount_minor FROM sku_prices sp
              WHERE sp.workspace_id = s.workspace_id AND sp.sku_id = s.id
              ORDER BY sp.created_at DESC, sp.rowid DESC LIMIT 1) IS NULL
      ORDER BY i.name, s.position LIMIT 1`
  ).get(workspaceId) || null;

  const uniqueItems = new Set(items.map((row) => row.id));
  const inventoryModel = json(configuration && configuration.inventory_model, {});
  const purchasingRelevant = items.some((row) => row.tracking_mode && row.tracking_mode !== 'serial')
    || supplierCount > 0 || reorderCount > 0;
  const authorityReviewed = activePolicies > 0
    || authorityDecisionCount > 0
    || Boolean(autopilot && autopilot.mode !== 'SUPERVISED');

  return {
    configured: Boolean(configuration && configuration.configured_at),
    inventoryModel,
    itemCount: uniqueItems.size,
    skuCount: items.filter((row) => row.sku_id).length,
    first,
    locations,
    onHand,
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
    connectionCount,
    sellingConnectionCount,
    salesOrderCount,
    missingPrice,
  };
}

const displayName = (record) => record
  ? `${record.name}${record.variant_label ? ` — ${record.variant_label}` : ''}`
  : 'a product';

/*
 * The next step in getting set up, in the order things actually happen.
 *
 * "No items yet" was tested before anything else, so a workspace that had just
 * been through the whole descriptive setup — Foundry read the business, agreed
 * the tracking model, created the locations and said "Your inventory is ready,
 * everything below is live now" — was met on its own home page by "Do this
 * next: choose where Foundry should get your inventory", pointing back at the
 * screen it had just come from. The one thing missing was a product, and that
 * was the one thing it did not say.
 *
 * Choosing a source is only the next step for a workspace that has not made
 * that choice yet. Once it has, the next step is the first product.
 */
function setupAction(state) {
  // Having locations is not evidence the source question was answered — a
  // workspace can be seeded or migrated with locations and never have been
  // asked. An agreed configuration is that evidence.
  const started = state.configured;
  if (!started) return { href: '/onboarding', action: 'Choose an inventory source' };
  if (!state.locations.length) return { href: '/locations', action: 'Add a location' };
  if (!state.itemCount) return { href: '/inventory/new', action: 'Add your first product' };
  if (!state.configured) return { href: '/onboarding', action: 'Continue inventory setup' };
  return { href: '/inventory', action: 'View inventory setup' };
}

function replenishmentAction(state) {
  if (state.missingSupplier) {
    return {
      href: `/purchasing/supplier-for/${state.missingSupplier.sku_id}`,
      action: 'Add its supplier',
      detail: `Tell Foundry who supplies ${displayName(state.missingSupplier)} and how they sell it.`,
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
      'My product list is in a file',
      'My suppliers email inventory documents',
      'My products are in another selling or inventory system',
    ];
  }
  if (!state.movementCount) {
    return [
      `I want to enter opening inventory for ${item}`,
      'Help me import my opening inventory from a file',
      `We received 10 ${item}${location ? ` at ${location}` : ''}`,
    ];
  }
  if (state.missingSupplier) {
    /*
     * "ABC Apparel supplies Copper Elbow 15mm in cases of 12" was the first
     * suggestion here, and Foundry answers that sentence with "Foundry cannot
     * store supplier catalogue details like pricing, pack size or lead time".
     * It can — there is a form for exactly those fields — but not through this
     * box, which prepares stock movements. Offering a sentence the product then
     * refuses is worse than offering nothing: it teaches somebody that Tell
     * Foundry does not work.
     *
     * These are things this box does handle, and the supplier's own terms are
     * one click away in "Do this next" directly above.
     */
    return [
      `Help me add a supplier for ${item}`,
      `We received 10 ${item}${location ? ` at ${location}` : ''}`,
      `How many ${item} do we have?`,
    ];
  }
  if (state.missingReorder) {
    return [
      `Reorder ${item} at 20 and bring it back to 50`,
      `When is ${item} considered low?`,
      `We sold 1 ${item}${location ? ` at ${location}` : ''}`,
    ];
  }
  if (state.partialOrder) {
    return [
      `We received stock for ${state.partialOrder.po_number}`,
      `What is still outstanding on ${state.partialOrder.po_number}?`,
      `I counted ${item}${location ? ` at ${location}` : ''}`,
    ];
  }
  if (state.sellingConnectionCount) {
    return [
      "Did today's connected sales come through?",
      `We received 10 ${item}${location ? ` at ${location}` : ''}`,
      `I counted ${item}${location ? ` at ${location}` : ''}`,
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
  const supplier = opening && state.supplierItemCount > 0;
  const replenishmentReady = supplier && state.reorderCount > 0;
  const authority = state.authorityReviewed;
  const setupCta = setupAction(state);
  const replenishment = replenishmentAction(state);
  const steps = [
    {
      id: 'structure', title: 'Bring in products and stock locations', complete: setup,
      detail: setup
        ? `${state.itemCount} product${state.itemCount === 1 ? '' : 's'} across ${state.locations.length} location${state.locations.length === 1 ? '' : 's'}.`
        : state.locations.length
          // Half-done reads as not-started unless the step says which half.
          ? `${state.locations.length} location${state.locations.length === 1 ? '' : 's'} ready. No products yet.`
          : 'Choose the real source: enter it here, upload documents, use approved email attachments, connect another system, or combine sources.',
      ...setupCta,
    },
    {
      id: 'opening', title: 'Enter opening inventory', complete: opening,
      detail: opening
        ? 'Opening stock is recorded in the ledger.'
        : 'Confirm current stock by entering what is on hand now, or attach the file that already contains it.',
      href: state.first ? `/foundry/quantities/${state.first.id}` : '/foundry/quantities',
      action: 'Add opening inventory',
    },
    {
      id: 'supplier', title: 'Add who you buy from', complete: supplier,
      detail: supplier
        ? 'At least one product is linked to a supplier.'
        : 'Add a supplier so Foundry knows who can replenish your stock.',
      href: replenishment.href,
      action: state.missingSupplier ? 'Add supplier' : 'Set up purchasing',
    },
    {
      id: 'replenishment', title: 'Decide when Foundry should reorder', complete: replenishmentReady,
      detail: replenishmentReady
        ? 'A low-stock point and target stock level are saved.'
        : 'Set the simple low-stock point and the quantity you want restored.',
      href: replenishment.href, action: 'Set when to reorder',
    },
  ];
  steps.push({
    id: 'authority', title: 'Choose how much routine work Foundry may handle', complete: authority,
    detail: authority
      ? activeAuthorityCopy(state)
      : 'Keep Ask me first, or explicitly approve narrow limits for routine transfers and purchasing.',
    href: '/autopilot', action: 'Choose automatic work',
  });

  let foundCurrent = false;
  for (const step of steps) {
    if (!step.complete && !foundCurrent) {
      step.current = true;
      foundCurrent = true;
    }
  }
  return { steps, active: !setup || !opening || !supplier || !replenishmentReady || !authority };
}

function activeAuthorityCopy(state) {
  if (state.activePolicies) {
    return `${state.activePolicies} approved routine-work ${state.activePolicies === 1 ? 'policy is' : 'policies are'} available.`;
  }
  return 'You reviewed the automatic-work mode; Foundry will follow that choice.';
}

function nextBestAction(db, workspaceId, state) {
  const inbox = needsYouInbox.inbox(db, workspaceId);
  // A source the owner already chose outranks a generic manual-setup prompt.
  // This is especially important for unattended mailbox checks: Foundry can
  // finish reading a file while the browser is closed, and Home must expose
  // the resulting review instead of pretending that nothing happened.
  const sourceTask = inbox.find((entry) => entry.kind === 'import'
    || entry.kind === 'connection');
  if (sourceTask) {
    return {
      kind: sourceTask.kind, eyebrow: 'Do this next', title: sourceTask.title,
      what: sourceTask.happened, why: sourceTask.why, recommendation: sourceTask.recommendation,
      action: sourceTask.actionLabel, href: sourceTask.href,
    };
  }
  if (!state.itemCount || !state.locations.length) {
    const action = setupAction(state);
    const missingLocation = !state.locations.length;
    // A workspace that has already agreed a setup with Foundry is not choosing
    // a source any more; it is waiting for its first product. Saying otherwise
    // sent somebody back through a flow they had just finished.
    const chosen = state.configured;
    const stage = missingLocation ? 'location' : chosen ? 'product' : 'source';
    const COPY = {
      location: {
        title: 'Add the first place you keep stock.',
        what: 'This inventory does not have a warehouse, store or other stock location yet.',
        why: 'Every quantity must belong to a real place.',
        recommendation: 'Add the warehouse, store or other place where stock currently lives.',
      },
      product: {
        title: 'Add the first thing you sell.',
        what: `Foundry has agreed how this inventory works and set up ${state.locations.length === 1 ? 'its location' : 'its locations'}, but there are no products in it yet.`,
        why: 'Foundry can only count, watch and reorder things it has a record of.',
        recommendation: 'Add one by hand, tell Foundry what you stock, or attach the file that lists it.',
      },
      source: {
        title: 'Choose where Foundry should get your inventory.',
        what: 'Foundry knows something about the business, but it has not received real product records yet.',
        why: 'A general description such as “I sell clothing” does not contain product names, variants, or quantities.',
        recommendation: 'Choose manual entry, file upload, approved email attachments, a connected POS/ERP, or several sources.',
      },
    };
    return { kind: 'setup', eyebrow: 'Do this next', ...COPY[stage], ...action };
  }
  if (!state.movementCount) {
    return {
      kind: 'setup', eyebrow: 'Do this next', title: 'Tell Foundry how much you have now.',
      what: 'Your products are ready, but no opening quantities have been recorded.',
      why: 'Until the starting amount is known, later sales and receipts cannot produce a truthful balance.',
      recommendation: 'Enter current quantities or attach the inventory file that contains them.',
      action: 'Add opening inventory', href: state.first ? `/foundry/quantities/${state.first.id}` : '/foundry/quantities',
    };
  }
  if (state.missingSupplier) {
    return {
      kind: 'supplier', eyebrow: 'Do this next',
      title: `Add who supplies ${displayName(state.missingSupplier)}.`,
      what: 'Foundry knows the product and its current quantity, but not where replacement stock comes from.',
      why: 'A supplier relationship is needed before Foundry can prepare an honest replenishment order.',
      recommendation: 'Add the supplier, pack size, lead time and current cost if known.',
      action: 'Add supplier', href: `/purchasing/supplier-for/${state.missingSupplier.sku_id}`,
    };
  }
  if (state.missingReorder) {
    return {
      kind: 'replenishment', eyebrow: 'Do this next',
      title: `Decide when to reorder ${displayName(state.missingReorder)}.`,
      what: 'Foundry knows who supplies this product, but not when you consider it low.',
      why: 'Foundry will never invent your low-stock point or target quantity.',
      recommendation: 'Set the quantity that means “low” and the quantity you want restored.',
      action: 'Set when to reorder',
      href: `/purchasing/why/${state.missingReorder.sku_id}?guide=1#reorder-settings`,
    };
  }
  if (!state.authorityReviewed) {
    return {
      kind: 'authority', eyebrow: 'Do this next', title: 'Choose what Foundry may handle without asking you.',
      what: 'Inventory and replenishment are ready. Foundry is still using the safe “ask first” default.',
      why: 'Automatic authority is never inferred from your activity.',
      recommendation: 'Keep Ask me first, or approve narrow limits for routine purchasing and transfers.',
      action: 'Choose automatic work', href: '/autopilot',
    };
  }
  if (inbox.length) {
    const item = inbox[0];
    return {
      kind: 'needs-you', eyebrow: 'Do this next', title: item.title,
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
  return {
    kind: 'clear', eyebrow: 'Do this next', title: 'You’re set up. Foundry is managing inventory.',
    what: 'Foundry has no unresolved decision or physical fact waiting.',
    why: 'Recorded inventory, purchasing and exception state are currently consistent.',
    recommendation: 'Keep telling Foundry about normal sales, receipts, transfers and counts.',
    action: null, href: null,
  };
}

function build(db, workspaceId) {
  const state = facts(db, workspaceId);
  const checklist = buildChecklist(state);
  const inbox = needsYouInbox.inbox(db, workspaceId);
  return {
    state,
    checklistActive: checklist.active,
    steps: checklist.steps,
    next: nextBestAction(db, workspaceId, state),
    examples: examples(state),
    firstNeedsYou: inbox[0] || null,
    needsYouCount: inbox.length,
  };
}

const screenDescriptions = {
  inventory: 'See what you have, receive stock, record usage, move inventory, count it, and control replenishment.',
  locations: 'See every warehouse, store or other place where stock can be held.',
  sales: 'See completed sales, customer commitments, reserved stock, shortages and fulfillment.',
  purchasing: 'See what Foundry wants to buy, orders already placed, what is arriving, and what still needs receiving.',
  connections: 'Connect where sales and inventory activity happen so Foundry learns about them automatically.',
  attention: 'Make only the decisions Foundry cannot safely settle by itself.',
  activity: 'See the meaningful inventory changes Foundry and your team have recorded.',
  settings: 'Choose how this inventory works and what Foundry may handle automatically.',
};

function screenContext(guidance, nav) {
  if (!guidance || !screenDescriptions[nav]) return null;
  const state = guidance.state;
  let next = guidance.next;
  if (nav === 'sales') {
    next = state.missingPrice
      ? { title: `Set the selling price for ${displayName(state.missingPrice)}`, action: 'Set selling price',
          href: `/inventory/${state.missingPrice.item_id}#selling-price` }
      : state.sellingConnectionCount
      ? { title: 'Record a customer commitment', action: 'New sales order', href: '/sales/new' }
      : { title: 'Connect where sales happen', action: 'Choose a sales system', href: '/settings/connections#connection-group-selling' };
  } else if (nav === 'connections') {
    // "Connected systems run automatically" is a status, not a task. If
    // something genuinely needs the owner, show that exact next action;
    // otherwise do not manufacture a contradictory "Do now" instruction.
    next = guidance.next.kind === 'clear'
      ? null
      : guidance.next;
    if (!state.connectionCount && guidance.next.kind === 'setup') {
      next = { title: 'Connect the system where your records live', action: 'Choose a connection', href: '#connection-group-selling' };
    }
  } else if (nav === 'attention') {
    /*
     * Needs you is the list of decisions. A band above it saying "3 things need
     * you · Do now: Copper Elbow 1/2 in. needs a decision · Approve the plan"
     * repeats the page's own count and its first row, one centimetre higher,
     * with the same button. The page introduces itself and says how many are
     * waiting; there is nothing left for this to add.
     */
    return null;
  } else if (nav === 'activity') {
    next = state.movementCount
      ? { title: 'Keep recording what comes in, goes out, moves or gets counted', action: 'Tell Foundry', href: '/#tell-foundry' }
      : guidance.next;
  }
  /*
   * A page may describe itself.
   *
   * Descriptions are keyed by the sidebar section, and every page under
   * Purchasing shares that key — so Suppliers, a page listing who you buy from,
   * introduced itself as "See what Foundry wants to buy, orders already placed,
   * what is arriving, and what still needs receiving". Nothing on that screen
   * does any of those things.
   */
  return { description: screenDescriptions[nav], next };
}

/** The same context, with a description this particular page provides. */
function screenContextFor(guidance, nav, description) {
  const context = screenContext(guidance, nav);
  if (!context) return context;
  return description ? { ...context, description } : context;
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

module.exports = { facts, build, guideTopics, examples, displayName, screenContext, screenContextFor };
