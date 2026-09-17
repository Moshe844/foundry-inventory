'use strict';

const searchService = require('../domain/search-service');
const { canonical } = require('./registry');

const NAVIGATION_WORDS = /\b(?:take me|open|go to|navigate|bring me|show me where|where (?:do|can|should|is|are)|how (?:do|can|should))\b/i;
const ACTION_WORDS = /\b(?:take me|open|go to|navigate|bring me)\b/i;
const RECEIVE_WORDS = /\b(?:receive|receiving|book(?:ing)? in|delivery)\b/i;
const RECORD_VIEW_WORDS = /\b(?:see|show|view|already|recorded|history|what|which|were|was|where are|booked)\b/i;
const WEBSITE_LOCATION_WORDS = /\b(?:section|page|screen|menu|tab|website|place|area|part|find|located)\b/i;
const NAVIGATION_REQUEST_WORDS = /\b(?:where|how.*(?:get|find|open)|take me|bring me|point me|navigate|go to|open|find|section|page|screen|menu|tab|place|area)\b/i;
const NAVIGATION_TIMEOUT_MS = 8_000;

function isBusinessDataQuestion(text) {
  const value = String(text || '');
  if (WEBSITE_LOCATION_WORDS.test(value)) return false;
  // "Do we have enough gloves for the winter?" is about gloves, not about
  // whether StockChief has a feature; it was answered with the status of
  // the selling-prices capability because "sell" appeared in the sentence.
  if (/\b(?:do|does|did)\s+we\s+have\b|\benough\b|\bhow\s+(?:many|much)\b|\bin\s+stock\b|\bon\s+hand\b|\bleft\b/i.test(value)) return true;
  // "List the open purchase orders with their totals": "open" is what the
  // orders are, not a request to open a page; a list of records is a lookup.
  if (/\bopen\s+(?:purchase\s+|sales\s+|customer\s+)?(?:orders?|bills?|invoices?|proposals?|returns?)\b/i.test(value)) return true;
  // "Has SO-1006 shipped?" asks about the order's state, not for its page.
  if (/\b(?:has|have|is|was|did|when)\b[^.?!]{0,40}\b(?:shipped|delivered|arrived|paid|received|invoiced|dispatched|sent out|due|late|overdue)\b/i.test(value)) return true;
  if (/\b(?:list|show|give me|get me|pull up)\b[^.?!]{0,40}\b(?:orders?|customers?|suppliers?|products?|variants?|bills?|invoices?|movements?|payments?|sales|purchases)\b[^.?!]{0,40}\b(?:with|and|their|totals?|amounts?|values?|due|overdue|late|outstanding)\b/i.test(value)) return true;
  return /\b(?:how many|how much|which|what)\b.*\b(?:stock|inventory|product|sku|order|customer|supplier|sale|payment)\b/i.test(value)
    || /\bwhere\s+(?:is|are)\s+(?:my|our|the)\b/i.test(value)
    || /\bwhere\b.*\b(?:stock|inventory|units?|products?|skus?)\b.*\b(?:held|stored|located|left)\b/i.test(value);
}

/** Whether the sentence names one of this inventory's own products. */
function mentionsProduct(db, workspaceId, text) {
  if (!db || !workspaceId) return false;
  const said = String(text || '').toLowerCase();
  try {
    const names = db.prepare('SELECT name FROM items WHERE workspace_id = ? AND is_active = 1 LIMIT 500').all(workspaceId).map((r) => String(r.name || '').toLowerCase());
    return names.some((name) => {
      if (!name) return false;
      if (said.includes(name)) return true;
      // "PTFE tape" names PTFE Tape 12m: every word of the name that is a word
      // rather than a size or a number.
      const words = name.split(/\s+/).filter((w) => w.length > 2 && !/^\d/.test(w) && !/^[\d/.]+(?:in|mm|cm|m|kg|g|ml|l)?\.?$/.test(w));
      if (words.length && words.every((w) => said.includes(w))) return true;
      // "gloves" names Harbour Work Glove: the product's last word, plural or not.
      const last = name.split(/\s+/).pop().replace(/s$/, '');
      return last.length > 3 && new RegExp(`\\b${last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`).test(said);
    });
  } catch { return false; }
}

function navigationTokens(value) {
  const ignored = new Set(['a', 'an', 'the', 'to', 'in', 'on', 'of', 'for', 'do', 'can', 'should',
    'where', 'how', 'is', 'are', 'find', 'located', 'section', 'page', 'screen', 'menu', 'tab', 'website',
    'place', 'area', 'part', 'i', 'me', 'my', 'we', 'our', 'us', 'you', 'your', 'could', 'would',
    'please', 'show', 'take', 'bring', 'open', 'go', 'navigate', 'point', 'toward', 'direct', 'lead',
    'send', 'put', 'get', 'handle', 'manage', 'deal', 'care', 'from']);
  return String(value || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(Boolean).map((word) => word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)
    .filter((word) => !ignored.has(word));
}

function textMatch(text, candidate) {
  const clean = String(candidate || '').toLowerCase();
  return clean && String(text).toLowerCase().includes(clean);
}

function destinationMatch(text, brain) {
  const inputTokens = new Set(navigationTokens(text));
  const candidates = brain.listDestinations().flatMap((destination) => {
    const names = [destination.label, ...(destination.aliases || [])];
    const vocabulary = new Set(names.flatMap(navigationTokens));
    return names.map((alias) => {
      const aliasTokens = navigationTokens(alias);
      const exactAlias = aliasTokens.length && aliasTokens.every((token) => inputTokens.has(token));
      const vocabularyHits = [...inputTokens].filter((token) => vocabulary.has(token)).length;
      const coverage = inputTokens.size ? vocabularyHits / inputTokens.size : 0;
      // Combining registered aliases helps "scan warehouse bins" without a
      // sentence-specific rule. A single shared word such as "order" is not
      // enough to choose Sales over Purchasing; that stays with the bounded
      // semantic classifier and its closed destination enum.
      return { destination, alias, tokenMatch: exactAlias || (vocabularyHits >= 2 && coverage > 0.5), coverage };
    });
  }
  // A local shortcut is safe only when the registered page name accounts for
  // most of the request's meaningful words. A stray word such as “people” in
  // “people buying things from us” must not override the sentence and open the
  // People/Settings area. Contextual language belongs to semantic interpretation.
  ).filter((entry) => entry.tokenMatch && entry.coverage > 0.5);
  candidates.sort((a, b) => b.coverage - a.coverage
    || navigationTokens(b.alias).length - navigationTokens(a.alias).length
    || b.alias.length - a.alias.length);
  return candidates[0] && candidates[0].destination;
}

function semanticSchema(brain) {
  return {
    type: 'object', additionalProperties: false, required: ['destinationId', 'reason'],
    properties: {
      destinationId: { type: 'string', enum: ['not_navigation', ...brain.listDestinations().map((entry) => entry.id)] },
      reason: { type: 'string' },
    },
  };
}

function semanticPrompt(text, brain) {
  const choices = brain.listDestinations().map((destination) => {
    const capability = brain.capability(destination.capability);
    return `- ${destination.id}: ${destination.label}. ${capability ? capability.description : ''}`;
  }).join('\n');
  return `Interpret whether the user is asking where a part of StockChief is or asking StockChief to open it.
Choose exactly one destinationId from the registered destinations below. Use not_navigation if this is a business-data question or an operation rather than website navigation.
Do not invent a route, capability, destination, permission, or product fact. Your selection is only a proposal; deterministic application code validates it.

Registered destinations:
${choices}

User request: ${text}`;
}

function timed(promise, timeoutMs, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => {
      if (onTimeout) onTimeout();
      resolve(null);
    }, timeoutMs); }),
  ]);
}

function navigationResultForDestination(text, destination, brain, membership) {
  const access = brain.accessForHref(destination.href, membership);
  if (!access.available || !access.allowed) return { kind: 'navigation', supported: true,
    available: access.available, canNavigate: false, capabilityId: destination.capability,
    answer: !access.available
      ? `${access.capability.label} is not available yet. ${access.reason}`
      : `${destination.label} exists, but I cannot expose it for this user. ${access.reason}` };
  // "How do I …?" gets the steps, composed from the brain, not a door.
  const howTo = require('./how-to');
  if (howTo.isHowTo(text)) {
    const composed = howTo.compose(brain, destination, membership, text);
    if (composed) return { kind: 'navigation', supported: true, available: true, canNavigate: true, howTo: true,
      href: destination.href, label: composed.label, capabilityId: destination.capability, navigateNow: false, answer: composed.answer };
  }
  return { kind: 'navigation', supported: true, available: true, canNavigate: true,
    href: destination.href, label: `Open ${destination.label}`, capabilityId: destination.capability,
    navigateNow: ACTION_WORDS.test(text), answer: `You can manage this in ${destination.label}. I can open it directly.` };
}

function contextualId(db, text, options = {}) {
  let pathname = '';
  try { pathname = new URL(String(options.currentHref || ''), 'http://foundry.local').pathname; } catch { pathname = ''; }
  if (/\b(?:PO|purchase order)\b/i.test(text)) {
    const match = pathname.match(/^\/purchasing\/orders\/([^/]+)/);
    if (match) return { type: 'purchase_order', id: match[1] };
  }
  if (/\b(?:SO|sales order|customer order)\b/i.test(text)) {
    const match = pathname.match(/^\/(?:sales\/)?orders\/([^/]+)/);
    if (match) return { type: 'sales_order', id: match[1] };
  }
  if (options.actorId && /\b(?:this|that|the)\s+(?:PO|purchase order)\b/i.test(text)) {
    const context = require('../manager/context').get(db, options.workspaceId, options.actorId);
    const id = context.lastPurchaseOrderId || context.lastEntities.purchaseOrderId;
    if (id) return { type: 'purchase_order', id };
  }
  return null;
}

function recordMatch(db, workspaceId, text, options = {}) {
  const tokens = String(text).match(/\b(?:PO|SO)[- ]?[A-Z0-9]+\b/ig) || [];
  for (const token of tokens) {
    const query = token.replace(/\s+/g, '-');
    const result = searchService.search(db, workspaceId, query, { limit: 10 });
    const wanted = /^PO/i.test(query) ? 'purchase_order' : 'sales_order';
    const record = result.results.find((entry) => entry.type === wanted);
    if (record) return record;
  }
  const contextual = contextualId(db, text, { ...options, workspaceId });
  if (contextual && contextual.type === 'purchase_order') {
    const row = db.prepare('SELECT id, po_number FROM purchase_orders WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, contextual.id);
    if (row) return { type: 'purchase_order', id: row.id, title: row.po_number,
      href: `/purchasing/orders/${row.id}` };
  }
  if (contextual && contextual.type === 'sales_order') {
    const row = db.prepare('SELECT id, order_number FROM sales_orders WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, contextual.id);
    if (row) return { type: 'sales_order', id: row.id, title: row.order_number,
      href: `/sales/orders/${row.id}` };
  }
  return null;
}

/** Resolve a named record to the exact part of its registered record journey. */
function recordContextMatch(db, workspaceId, record, text, brain) {
  const entity = brain.entity(record.type);
  if (!entity || !Array.isArray(entity.contexts)) return null;
  const inputTokens = new Set(navigationTokens(text));
  const intended = RECORD_VIEW_WORDS.test(text) ? 'view' : 'action';
  const choices = entity.contexts.flatMap((context) => (context.aliases || []).map((alias) => {
    const aliasTokens = navigationTokens(alias);
    const matches = aliasTokens.length && aliasTokens.every((token) => inputTokens.has(token));
    const intentScore = context.intent === intended ? 2 : 0;
    return { context, alias, matches, score: intentScore + aliasTokens.length };
  })).filter((choice) => choice.matches)
    .sort((a, b) => b.score - a.score || b.alias.length - a.alias.length);
  const chosen = choices[0] && choices[0].context;
  if (!chosen) return null;
  let relatedId = '';
  if (chosen.relatedEntity === 'supplier_bill' && record.type === 'purchase_order') {
    const related = db.prepare(`SELECT id FROM accounting_supplier_bills
      WHERE workspace_id = ? AND purchase_order_id = ?
      ORDER BY issue_date DESC, created_at DESC LIMIT 1`).get(workspaceId, record.id);
    if (!related) return null;
    relatedId = related.id;
  }
  return {
    ...chosen,
    href: chosen.route.replace(/:id/g, record.id).replace(/:relatedId/g, relatedId)
      .replace(/:title/g, encodeURIComponent(record.title)),
    label: chosen.label.replace(/:title/g, record.title),
  };
}

function unavailableMatch(text, brain) {
  return brain.listCapabilities().filter((entry) => entry.status !== 'available')
    .find((entry) => textMatch(text, entry.label) || textMatch(text, entry.id.replace(/[.-]/g, ' '))) || null;
}

function capabilityMatch(text, brain) {
  const input = String(text).toLowerCase();
  const ignored = new Set(['foundry', 'stockchief', 'manage', 'management', 'business', 'record', 'records']);
  const scored = brain.listCapabilities().map((entry) => {
    const words = `${entry.label} ${entry.id.replace(/[.-]/g, ' ')}`.toLowerCase()
      .split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !ignored.has(word));
    const hits = words.filter((word) => input.includes(word.replace(/(?:ing|ment|s)$/i, ''))).length;
    return { entry, hits };
  }).filter((row) => row.hits > 0).sort((a, b) => b.hits - a.hits);
  return scored[0] && scored[0].entry;
}

/** Resolve product existence, access and destination without model judgment. */
function resolve(db, workspaceId, membership, input, options = {}) {
  const brain = options.brain || canonical;
  const text = String(input || '').trim();
  if (!text) return null;

  // A question about the business's own stock, orders or money is never a
  // question about StockChief's features, whatever words it shares with one.
  const aboutTheBusiness = isBusinessDataQuestion(text) || mentionsProduct(db, workspaceId, text);
  const unavailable = aboutTheBusiness ? null : unavailableMatch(text, brain);
  if (unavailable && /\b(?:can|where|how|support|available|have|do)\b/i.test(text)) {
    const access = brain.accessForCapability(unavailable.id, membership);
    return { kind: 'capability', supported: true, available: false, canNavigate: false, capabilityId: unavailable.id,
      answer: `${unavailable.label} is not available yet. ${access.reason}`
        + (access.prerequisites && access.prerequisites.length ? ` Required first: ${access.prerequisites.join(' ')}` : '') };
  }


  if (!aboutTheBusiness && /\b(?:can (?:i|we|foundry|stockchief)|do (?:you|we) (?:have|support)|is .*available)\b/i.test(text)) {
    const capability = capabilityMatch(text, brain);
    if (capability) {
      const evaluation = brain.evaluateCapability(db, workspaceId, capability.id, membership);
      const destination = evaluation.destination;
      if (!evaluation.available) return { kind: 'capability', supported: true, available: false, canNavigate: false,
        capabilityId: capability.id, answer: `${capability.label} is not available yet. ${evaluation.reason}`
          + (evaluation.prerequisites.length ? ` Required first: ${evaluation.prerequisites.join(' ')}` : '') };
      if (!evaluation.allowed) return { kind: 'capability', supported: true, available: evaluation.available, canNavigate: false,
        capabilityId: capability.id, answer: `${capability.label} is available in StockChief, but ${evaluation.reason}` };
      const autonomy = capability.authorityCapability
        ? evaluation.foundryCanExecuteAutomatically
          ? 'StockChief is currently authorised to handle it automatically.'
          : `StockChief cannot do it automatically right now. ${evaluation.autonomyReason}`
        : 'It is not an autonomous operation; StockChief can still guide or perform the supported workflow with you.';
      return { kind: 'capability', supported: true, available: evaluation.available, canNavigate: Boolean(destination),
        href: destination && destination.href, label: destination && `Open ${destination.label}`,
        capabilityId: capability.id,
        answer: `${capability.label} is available. You can use it with your current role. ${autonomy}`
          + (destination ? ` It is in ${destination.label}.` : '')
          + (evaluation.prerequisites.length ? ` Required first: ${evaluation.prerequisites.join(' ')}` : '') };
    }
  }

  /*
   * "Show me everything about copper elbow" wants the product's page: stock
   * by place, on order, price, supplier, recent movement — all of it. It
   * used to be met with "what would you like to know?", which is the one
   * answer that page never needs. One product named in full goes straight
   * there; a name that fits several products is left to the planner, which
   * asks which.
   */
  const about = /^\s*(?:can\s+you\s+)?(?:show\s+me\s+|tell\s+me\s+|give\s+me\s+)?(?:everything|all|all\s+the\s+details|the\s+full\s+picture|a\s+summary|an\s+overview)\s+(?:about|on|of|for)\s+(.+?)\s*[?.!]*\s*$/i.exec(text)
    || /^\s*(?:tell\s+me\s+about|what\s+do\s+we\s+know\s+about|open\s+the\s+product|show\s+me\s+the\s+product)\s+(.+?)\s*[?.!]*\s*$/i.exec(text);
  if (about) {
    const named = about[1].replace(/^(?:the|our|my)\s+/i, '').replace(/\s+(?:product|item|sku)$/i, '').trim();
    let items = [];
    try {
      const skus = require('../attention/query-service').resolveSkus(db, workspaceId, named, 50);
      items = [...new Map(skus.map((s) => [s.item_id, { id: s.item_id, name: s.item_name || s.name }])).values()];
    } catch { items = []; }
    if (items.length === 1) {
      const href = `/inventory/${items[0].id}`;
      const access = brain.accessForHref(href, membership);
      if (access.allowed) {
        return { kind: 'navigation', supported: true, canNavigate: true, href, label: `Open ${items[0].name}`,
          capabilityId: access.capability.id, navigateNow: true,
          answer: `Everything about ${items[0].name} is on its page: stock by place, what is on order, price, supplier and recent movement.` };
      }
    }
    // Several products fit the name: the answer is which, as one click each,
    // not an open question about what the person would like to know.
    if (items.length > 1 && items.length <= 6) {
      return { kind: 'clarify', supported: false, canNavigate: false, needsClarification: true,
        choices: items.map((item) => `everything about ${item.name}`),
        answer: `Which product do you mean? ${items.map((item) => item.name).join(' or ')}.` };
    }
  }

  const record = recordMatch(db, workspaceId, text, options);
  // "Has SO-1006 shipped and where is it?" asks about the order, not for
  // its page; only "open" / "take me to" wording overrides that.
  if (record && NAVIGATION_WORDS.test(text) && (ACTION_WORDS.test(text) || !isBusinessDataQuestion(text))) {
    let href = record.href;
    let label = `Open ${record.title}`;
    const context = recordContextMatch(db, workspaceId, record, text, brain);
    if (context) {
      href = context.href;
      label = context.label;
    } else if (record.type === 'purchase_order' && RECEIVE_WORDS.test(text)) {
      href = `/purchasing/orders/${record.id}/receive`;
      label = `Receive ${record.title}`;
    }
    const access = brain.accessForHref(href, membership);
    if (!access.allowed) return { kind: 'navigation', supported: true, canNavigate: false,
      answer: `I found ${record.title}, but I cannot take you there. ${access.reason}` };
    return { kind: 'navigation', supported: true, canNavigate: true, href, label,
      capabilityId: access.capability.id, navigateNow: ACTION_WORDS.test(text),
      answer: `I found ${record.title}. ${label} opens the exact ${record.type.replace('_', ' ')} context.` };
  }

  // "How do I receive a delivery?" names a topic before it names a page;
  // the topic knows its page and its steps.
  const howTo = require('./how-to');
  if (howTo.isHowTo(text) && !mentionsProduct(db, workspaceId, text)) {
    const found = howTo.topic(text);
    const home = found ? brain.listDestinations().find((d) => d.id === found.destination) : null;
    if (home) return navigationResultForDestination(text, home, brain, membership);
  }
  const destination = destinationMatch(text, brain);
  if (destination && NAVIGATION_WORDS.test(text)) {
    return navigationResultForDestination(text, destination, brain, membership);
  }

  return null;
}

/**
 * Natural language may interpret a website request, but it never becomes the
 * authority. The model can return only a canonical destination id; the live
 * product brain then verifies existence, route registration and the current
 * user's permission before a link can be returned. A bounded timeout prevents
 * navigation from ever waiting behind a slow general-purpose AI request.
 */
async function resolveNatural(db, workspaceId, membership, input, options = {}) {
  const direct = resolve(db, workspaceId, membership, input, options);
  if (direct) return direct;
  const text = String(input || '').trim();
  if (!text || !NAVIGATION_REQUEST_WORDS.test(text)) return null;
  // "Where is Accounting?" is navigation. "Where is our Navy 4?" asks for
  // business data. The model may propose a destination, but it is never
  // allowed to turn an inventory-location question into website navigation.
  if (isBusinessDataQuestion(text)) return null;
  const brain = options.brain || canonical;
  let provider = options.provider || null;
  if (!provider) {
    try {
      const config = require('../config');
      if (config.ai.configured) provider = require('../ai/provider').createProviderForTier('fast', { maxTokens: 128 });
    } catch { provider = null; }
  }
  if (provider && typeof provider.complete === 'function') {
    try {
      const controller = new AbortController();
      const response = await timed(provider.complete({
        system: 'You classify navigation requests into a closed, application-provided destination enum.',
        prompt: semanticPrompt(text, brain), schema: semanticSchema(brain),
        schemaName: 'foundry_product_destination', signal: controller.signal,
      }), Number(options.navigationTimeoutMs || NAVIGATION_TIMEOUT_MS), () => controller.abort());
      const proposedId = response && response.data && response.data.destinationId;
      if (proposedId === 'not_navigation') return null;
      const destination = brain.destination(proposedId);
      if (destination) return navigationResultForDestination(text, destination, brain, membership);
    } catch {
      // The fallback below is intentionally immediate and contains no guessed
      // route. A provider failure cannot make a destination authoritative.
    }
  }
  if (NAVIGATION_WORDS.test(text) || WEBSITE_LOCATION_WORDS.test(text)) {
    return { kind: 'navigation', supported: true, available: false, canNavigate: false,
      answer: 'I understood that you are looking for something in StockChief, but I could not safely match it to a registered destination. Describe the business task or name the record you want to open.' };
  }
  return null;
}

function handoffHref(href, label, returnTo = '/ask') {
  return `/foundry/navigate?to=${encodeURIComponent(href)}&label=${encodeURIComponent(label || 'requested page')}`
    + `&return=${encodeURIComponent(returnTo)}`;
}

function asQueryResult(question, resolution) {
  return {
    question: String(question).trim(), answer: resolution.answer, spoken: null,
    rows: [], columns: [], rowCount: 0, supported: resolution.supported !== false,
    handoff: resolution.canNavigate ? {
      href: handoffHref(resolution.href, resolution.label, `/ask?q=${encodeURIComponent(String(question).trim())}`),
      label: resolution.label,
    } : null,
    plan: { intent: resolution.kind === 'navigation' ? 'website_navigation' : resolution.kind === 'clarify' ? 'unsupported' : 'capability_status',
      entityQuery: '', locationQuery: '', windowDays: 30, limit: 1 },
    needsClarification: resolution.needsClarification === true,
    choices: resolution.choices || null,
    navigation: resolution,
  };
}

function remember(req, resolution, returnTo) {
  if (!req.session || !resolution || !resolution.href) return;
  const pathname = new URL(resolution.href, 'http://foundry.local').pathname;
  req.session.productNavigation = { expectedPath: pathname, href: resolution.href,
    label: resolution.label, returnTo: returnTo || req.get('referer') || '/', createdAt: Date.now() };
}

function verifyArrival(req) {
  const pending = req.session && req.session.productNavigation;
  if (!pending) return null;
  if (Date.now() - Number(pending.createdAt || 0) > 10 * 60_000) {
    delete req.session.productNavigation;
    return null;
  }
  if (req.path !== pending.expectedPath) return null;
  delete req.session.productNavigation;
  const returnPath = (() => {
    try {
      const value = new URL(String(pending.returnTo || '/'), `http://${req.get('host')}`);
      return value.host === req.get('host') ? `${value.pathname}${value.search}${value.hash}` : '/ask';
    } catch { return '/ask'; }
  })();
  return { message: `StockChief opened the requested place: ${pending.label.replace(/^Open /, '')}.`,
    backTo: { href: returnPath, label: 'your question' } };
}

module.exports = { resolve, resolveNatural, asQueryResult, remember, verifyArrival, handoffHref,
  destinationMatch, recordMatch, recordContextMatch, navigationTokens, semanticSchema, isBusinessDataQuestion, mentionsProduct };
