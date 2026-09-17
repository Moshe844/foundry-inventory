'use strict';

/**
 * "How do I …?" answered as steps, from the product brain.
 *
 * The brain knows each capability's description, the page it lives on, the
 * permission it needs and its prerequisites. What it did not have was the
 * steps a person takes, so "How do I create a purchase order?" got "You can
 * manage this in Purchasing." The topics below carry those steps in plain
 * words — what StockChief does when told, what you do by hand, and what
 * happens after — and the rest (permission, availability, the page) comes
 * from the registry. No model; nothing invented.
 */

const permissions = require('../actions/permissions');

const HOW_TO = /\b(?:how\s+(?:do|can|could|should|would|to)\b|how\s+does\s+(?:this|stockchief|foundry|it)\b|what(?:'s|\s+is)\s+the\s+(?:way|process|steps?)\b|what\s+do\s+i\s+(?:do|need)\s+to\b|walk\s+me\s+through|show\s+me\s+how|explain\s+how|steps\s+to)/i;

/*
 * A topic: which words name it, which destination it lives on, and the
 * steps. `quick` is what to type into the box; `byHand` is the page and
 * form; `after` is what follows. Keep each a sentence a person would say.
 */
const TOPICS = [
  { id: 'purchase-order', title: 'create a purchase order', destination: 'purchasing',
    match: /\b(?:purchase\s+order|po\b|order\s+(?:stock|more|from\s+a\s+supplier|from\s+\w+)|reorder\b(?!\s+point)|restock|buy\s+(?:stock|more))/i,
    quick: 'Type “order 12 Copper Elbow from Acme” or “order what we need”. StockChief drafts the purchase order, with every line, for you to approve.',
    byHand: 'Purchasing → Write a purchase order: choose the supplier, add lines, save the draft.',
    after: 'Nothing is ordered until you approve the draft. If a mailbox is connected, the order is emailed to the supplier when you send it; otherwise you copy it. When it arrives, say “the Acme delivery arrived” to book it in.' },
  { id: 'receive', title: 'receive a delivery', destination: 'actions',
    match: /\b(?:receive|receiving|received|book(?:ing)?\s+in|delivery\s+(?:arrived|came)|arrived|goods\s+in|check\s+in\s+(?:a\s+)?delivery)\b/i,
    quick: 'Type “the Acme delivery for PO-1001 arrived, all 240” or “we received 20 solder wire into the warehouse”. StockChief matches it to the open order when there is one and prepares the receipt.',
    byHand: 'Purchasing → the order → Book in, or Record inventory activity → Received.',
    after: 'Stock goes up only when you approve the receipt. A delivery with no order behind it is received as a plain receipt and says so.' },
  { id: 'add-product', title: 'add a new product', destination: 'inventory',
    match: /\b(?:add|create|new|set\s+up)\s+(?:a\s+)?(?:new\s+)?(?:product|item|sku|variant)s?\b|\bproduct\s+(?:setup|creation)\b/i,
    quick: 'Type “add a new product: Brass Tee 3/4 in, we buy it at $1.10 and sell at $3.50, put 40 in the warehouse”. StockChief prepares the product, its prices and the opening stock in one proposal.',
    byHand: 'Inventory → Add a product: name, code, whether it has variants, how it is tracked.',
    after: 'The product exists only when you approve the proposal. Stock, prices and a supplier can be added in the same sentence or later.' },
  { id: 'count', title: 'count stock and correct the records', destination: 'actions',
    match: /\b(?:count(?:ed|ing)?|stock\s*take|stocktake|correct(?:ion)?\s+(?:a\s+|the\s+)?count|fix\s+(?:a\s+|the\s+)?count|cycle\s+count)\b/i,
    quick: 'Type “we counted the van: 8 copper elbow, 12 trail ration pack, 0 solder wire”. StockChief reads every line and prepares one correction per product that differs from the records.',
    byHand: 'Record inventory activity → Fix the count, one product and place at a time.',
    after: 'A correction changes the records without stock moving, and only when you approve it. Lines that already match are said, not dropped.' },
  { id: 'move', title: 'move stock between places', destination: 'actions',
    match: /\b(?:move|transfer|shift|send)\s+(?:stock|products?|items?|units|\d+|some|them|it)\b|\btransfers?\b/i,
    quick: 'Type “move 10 trail ration pack from the warehouse to the store”. StockChief prepares the transfer and asks only what it cannot work out, such as which place it leaves from.',
    byHand: 'Record inventory activity → Move it, or Transfers for a tracked in-transit transfer.',
    after: 'Stock moves when you approve. A batch-tracked product takes its earliest-to-expire batch and says so; you can name another.' },
  { id: 'sell', title: 'record a sale or a customer order', destination: 'sales',
    match: /\b(?:sales?\s+order|customer\s+order|sell|sold|invoice\s+a\s+customer|take\s+an?\s+order)\b/i,
    quick: 'Type “we sold 3 sweaters navy 4 from the store” to record a sale, or “Marlow wants 10 gloves black L, make the order” to draft a customer order.',
    byHand: 'Sales orders → New order: customer, lines, needed-by date; then confirm, pick and ship from the order page.',
    after: 'A sale drafted from a sentence is confirmed only when you approve it. Shipping notices go out only when a mailbox is connected and you allow them.' },
  { id: 'price', title: 'change selling prices', destination: 'inventory',
    match: /\b(?:selling\s+price|price|prices|pricing|mark\s+(?:up|down)|discount)\b/i,
    quick: 'Type “change the price of trail ration pack to 12.99”, “lower the price of all the gloves by 10%”, or a list of products and prices, one per line. StockChief prepares each change for review.',
    byHand: 'Inventory → the product → Selling price.',
    after: 'Prices change only when you approve them. A product with no price yet says so rather than being skipped.' },
  { id: 'pay-bill', title: 'record a payment or a bill', destination: 'accounting',
    match: /\b(?:pay|paid|payment|bill|invoice|owe|owed|receivable|payable)s?\b/i,
    quick: 'Type “I paid Acme $500 today against their invoice”. StockChief matches it to the open bill and prepares the payment record for you to confirm.',
    byHand: 'Accounting → Bills (what you owe) or Invoices (what you are owed) → record a payment on the bill or invoice.',
    after: 'The books change only when you confirm. Unapplied remainders are shown, never hidden.' },
  { id: 'supplier', title: 'add or change a supplier', destination: 'suppliers',
    match: /\b(?:supplier|vendor)s?\b/i,
    quick: 'Type “add a new supplier called Bright Tools, email sales@brighttools.com”. StockChief opens the supplier form filled in; you press Add.',
    byHand: 'Suppliers → Add a supplier: name, email, lead time; then link the products you buy from them with their pack sizes and costs.',
    after: 'Once a supplier is linked to a product, StockChief can draft orders to them and tell you which supplier is cheapest.' },
  { id: 'email', title: 'connect your email', destination: 'mail',
    match: /\b(?:connect|link|set\s+up|add)\s+(?:my\s+|an?\s+|the\s+)?(?:email|mailbox|gmail|outlook)\b|\bmailbox\b/i,
    quick: 'Say “connect my email” and StockChief opens the connections page at the email section.',
    byHand: 'Settings → Connections → Email: connect Gmail or Microsoft 365 and choose which mailbox StockChief sends from.',
    after: 'With a mailbox connected, drafts to suppliers and customers can be sent from the message page — never from the chat. Without one, drafts are still written for you to copy.' },
  { id: 'import', title: 'import a spreadsheet', destination: 'imports',
    match: /\b(?:import|upload|spreadsheet|csv|excel|xlsx|bring\s+in\s+(?:my\s+)?(?:data|records|products))\b/i,
    quick: 'Attach a spreadsheet to the box (or drop it on Imports). StockChief reads it, shows what it would create or change, and creates nothing until you approve.',
    byHand: 'Imports → Upload a file → review the columns and the preview → Apply.',
    after: 'Everything an import created can be rolled back from the import page; provenance is kept.' },
  { id: 'rule', title: 'set a standing rule', destination: 'autopilot',
    match: /\b(?:rule|rules|automatic(?:ally)?|autopilot|reorder\s+point|standing\s+instruction|from\s+now\s+on)\b/i,
    quick: 'Type “from now on reorder gloves whenever we drop below 20”. StockChief reads it as a rule and shows it for approval before it is in force.',
    byHand: 'Automatic work → choose how much StockChief may do on its own; Inventory → the product → reorder settings.',
    after: 'A rule is not in force until approved, and StockChief says which rule it applied whenever it acts on one.' },
  { id: 'people', title: 'invite people and set permissions', destination: 'settings',
    match: /\b(?:invite|add|remove)\s+(?:a\s+|an\s+|my\s+|the\s+|our\s+)?(?:new\s+)?(?:person|people|user|team\s*member|staff|colleague|accountant)\b|\bpermissions?\b/i,
    quick: 'This one is done on the page, not from the box.',
    byHand: 'Settings → People: invite by email, choose owner, staff or accountant, and adjust what each may do.',
    after: 'Every action StockChief prepares checks the permission of the person asking, and says plainly when a role does not allow it.' },
];

function isHowTo(text) {
  return HOW_TO.test(String(text || ''));
}

/** The topic a how-to question is about, or null. */
function topic(text) {
  const clean = String(text || '');
  return TOPICS.find((t) => t.match.test(clean)) || null;
}

function permissionLabel(id) {
  return (permissions.LABELS && permissions.LABELS[id]) || String(id || '').toLowerCase().replace(/_/g, ' ');
}

/**
 * Steps for a destination (and, when the question names one, a topic).
 * @returns {{answer:string, steps:string[], href:string, label:string}|null}
 */
function compose(brain, destination, membership, text = '') {
  if (!brain || !destination) return null;
  const capability = brain.capability(destination.capability);
  if (!capability) return null;
  const access = brain.accessForHref(destination.href, membership);
  const found = topic(text);
  const steps = [];
  if (found) {
    steps.push(`Tell StockChief: ${found.quick}`);
    steps.push(`Or by hand: ${found.byHand}`);
  } else {
    steps.push(`What it is: ${capability.description}`);
    const says = capability.manager && Array.isArray(capability.manager.examples) ? capability.manager.examples.slice(0, 3) : [];
    if (says.length) steps.push(`Tell StockChief in the box, for example “${says.join('”, “')}”; it shows the exact change before anything happens.`);
    steps.push(`Or by hand: open ${destination.label} (${destination.href}).`);
  }
  const needs = [];
  if (capability.actionPermission) needs.push(`“${permissionLabel(capability.actionPermission)}” to make changes`);
  if (capability.permission) needs.push(`“${permissionLabel(capability.permission)}” to see it`);
  if (needs.length) steps.push(`You need: ${needs.join(', and ')}.${access.allowed ? ' You have that.' : ` ${access.reason || 'Your role does not include it yet — ask an inventory owner.'}`}`);
  if (Array.isArray(capability.prerequisites) && capability.prerequisites.length) steps.push(`Before it works: ${capability.prerequisites.join(' ')}`);
  if (found) steps.push(`What happens after: ${found.after}`);
  else if (Array.isArray(capability.sideEffects) && capability.sideEffects.length) steps.push(`What happens after: ${capability.sideEffects.join(' ')}`);

  const title = found ? found.title : `use ${destination.label}`;
  return {
    answer: `How to ${title}:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
    steps, href: destination.href, label: `Open ${destination.label}`, topic: found ? found.id : null,
  };
}

module.exports = { isHowTo, topic, compose, HOW_TO, TOPICS };
