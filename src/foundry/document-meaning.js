'use strict';

/**
 * What a document proves, before anything is changed because of it.
 *
 * Foundry used to treat every uploaded file the same way: read the lines,
 * create the products, receive the stock. A proforma invoice for shoes still
 * being made in a factory became 800 pairs on the shelf and $21,390 of
 * inventory asset, on somebody's first day using the product.
 *
 * The fix is not a better reader. It is refusing to let one document change
 * several different truths at once, because they are separate facts that
 * happen to arrive on the same piece of paper:
 *
 *   ORDERED    we have committed to buy it
 *   INVOICED   the supplier says we owe money
 *   INCOMING   the supplier says it is on the way
 *   RECEIVED   it physically arrived
 *   PAID       money left our account
 *
 * A supplier invoice proves the second. It says nothing whatever about the
 * fourth. Conflating them is how a business ends up counting stock it does
 * not have and paying for goods twice.
 *
 * Nothing here reads a document or decides what it is. A model does that, and
 * a model may be wrong. This takes the classification as a claim and maps it
 * to consequences deterministically, so the worst a misread can do is propose
 * the wrong thing to a person — never quietly perform it.
 */

/*
 * What each kind of document is evidence of.
 *
 * `onHand` is the dangerous one and it is false almost everywhere. Physical
 * stock is a claim about the real world, and paper about a purchase is not
 * usually evidence that the world changed.
 */
const KINDS = {
  opening_inventory: {
    label: 'a snapshot of what you have right now',
    establishes: { onHand: true, incoming: false, owed: false, paid: false },
    because: 'a stock list is a count of goods that already exist',
  },
  purchase_order: {
    label: 'an order placed with a supplier',
    establishes: { onHand: false, incoming: true, owed: false, paid: false },
    because: 'ordering commits you to buy, and moves nothing',
  },
  proforma_invoice: {
    label: 'a quote to be confirmed before anything is made',
    establishes: { onHand: false, incoming: false, owed: false, paid: false },
    because: 'a proforma is an offer — nothing is ordered, owed or shipped until you accept it',
  },
  quote: {
    label: 'a price quotation',
    establishes: { onHand: false, incoming: false, owed: false, paid: false },
    because: 'a quotation is a price, not a commitment by anybody',
  },
  order_acknowledgement: {
    label: "the supplier confirming your order",
    establishes: { onHand: false, incoming: true, owed: false, paid: false },
    because: 'the supplier has accepted the order; the goods have still not moved',
  },
  supplier_invoice: {
    label: 'a bill from a supplier',
    establishes: { onHand: false, incoming: false, owed: true, paid: false },
    because: 'an invoice is a demand for money and proves nothing about delivery',
  },
  shipment_notice: {
    label: 'notice that goods have been despatched',
    establishes: { onHand: false, incoming: true, owed: false, paid: false },
    because: 'goods in transit are not goods on your shelf',
  },
  packing_slip: {
    label: 'a packing slip from a delivery',
    establishes: { onHand: false, incoming: true, owed: false, paid: false },
    because: 'it lists what was packed; whether it all arrived is what receiving checks',
  },
  receipt_evidence: {
    label: 'evidence that goods were received',
    establishes: { onHand: true, incoming: false, owed: false, paid: false },
    because: 'this records goods physically arriving',
  },
  payment_remittance: {
    label: 'evidence that money was paid',
    establishes: { onHand: false, incoming: false, owed: false, paid: true },
    because: 'paying a supplier moves money, never stock',
  },
  catalogue: {
    label: 'a product list with no quantities',
    establishes: { onHand: false, incoming: false, owed: false, paid: false },
    because: 'a catalogue describes what can be bought, not what you have',
  },
  other: {
    label: 'a document Foundry could not place',
    establishes: { onHand: false, incoming: false, owed: false, paid: false },
    because: 'Foundry will not change anything on the strength of a document it cannot identify',
  },
};

const money = (minor, currency = 'USD') => `${currency} ${(Number(minor || 0) / 100).toFixed(2)}`;

/*
 * The reader's older, narrower vocabulary, mapped forward. A document read as
 * "invoice" before this existed is a supplier invoice, and must not be allowed
 * to keep meaning "receive everything".
 */
const ALIASES = {
  invoice: 'supplier_invoice',
  stock_report: 'opening_inventory',
};

function kindOf(interpretation) {
  const claimed = String(interpretation?.documentType || 'other');
  const name = ALIASES[claimed] || claimed;
  return KINDS[name] ? name : 'other';
}

/**
 * Everything Foundry believes about this document, in the order a person asks:
 * what did you find, what does it mean, what will you change, what will you
 * deliberately not change, and what do you need from me.
 *
 * `context` carries what Foundry already knows — whether this is a brand new
 * inventory being set up, and any purchase order the document appears to be
 * about — because the same invoice means something different when there is
 * already an order for it.
 */
function meaningOf(interpretation, context = {}) {
  const kind = kindOf(interpretation);
  const meaning = KINDS[kind];
  const currency = interpretation.currency || 'USD';
  const lines = interpretation.lines || [];
  const units = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  const products = new Set(lines.map((line) => line.styleName)).size;
  const goodsMinor = lines.reduce((sum, line) =>
    sum + Math.round(Number(line.unitCost || 0) * 100) * Number(line.quantity || 0), 0);
  const charges = interpretation.charges || [];
  const chargesMinor = charges.reduce((sum, charge) => sum + Number(charge.amountMinor || 0), 0);

  /*
   * Setting up a business is the one time a document may state what is on the
   * shelf, because there is no prior truth for it to contradict. The same
   * stock list arriving at a running business is a count to reconcile against,
   * not a fact to overwrite with.
   */
  const openingTheBooks = Boolean(context.isNewWorkspace) && meaning.establishes.onHand;

  const found = [
    products ? `${products} product${products === 1 ? '' : 's'}` : null,
    lines.length > products ? `${lines.length} variants` : null,
    units ? `${units} ${interpretation.unitLabel || 'unit'}${units === 1 ? '' : 's'}` : null,
    interpretation.supplierName ? `supplier ${interpretation.supplierName}` : null,
    goodsMinor ? `${money(goodsMinor, currency)} of goods` : null,
    ...charges.map((charge) => `${charge.label} ${money(charge.amountMinor, currency)}`),
    interpretation.documentTotalMinor
      ? `a stated total of ${money(interpretation.documentTotalMinor, currency)}` : null,
  ].filter(Boolean);

  const willDo = [];
  const wontDo = [];
  const needsYou = [];

  // Always safe: the catalogue and who sells it. Neither is a claim about
  // quantity, money owed, or where anything physically is.
  if (lines.length) willDo.push('create the products and their variants');
  if (interpretation.supplierName) willDo.push(`record ${interpretation.supplierName} as a supplier`);

  if (meaning.establishes.onHand) {
    willDo.push(openingTheBooks
      ? `set your opening stock to the ${units} ${interpretation.unitLabel || 'unit'}s listed`
      : `record ${units} ${interpretation.unitLabel || 'unit'}s as received`);
  } else {
    wontDo.push({
      what: 'add anything to your on-hand stock',
      why: meaning.because,
    });
  }

  if (meaning.establishes.incoming) {
    willDo.push(`show ${units} ${interpretation.unitLabel || 'unit'}s as incoming`);
  }

  if (meaning.establishes.owed) {
    const owed = interpretation.documentTotalMinor || (goodsMinor + chargesMinor);
    willDo.push(`record ${money(owed, currency)} owed to ${interpretation.supplierName || 'the supplier'}`);
  } else if (goodsMinor) {
    wontDo.push({
      what: 'record any money as owed',
      why: kind === 'proforma_invoice' || kind === 'quote'
        ? 'nothing is owed until you accept this and place the order'
        : 'this document is not a bill',
    });
  }

  if (meaning.establishes.paid) willDo.push('record the payment against the supplier invoice');

  /*
   * A quote is the one kind that leads nowhere on its own. Saying so is more
   * use than importing it and leaving somebody to wonder why nothing happened.
   */
  if (kind === 'proforma_invoice' || kind === 'quote') {
    needsYou.push({
      question: 'Do you want to place this order?',
      because: 'Accepting it is what makes the goods incoming and the money owed.',
      options: [
        { label: 'Place the order',
          does: `Raises a purchase order for the ${units} ${interpretation.unitLabel || 'unit'}s and `
            + `shows them as incoming. ${money(interpretation.documentTotalMinor || (goodsMinor + chargesMinor), currency)} `
            + `becomes owed to ${interpretation.supplierName || 'the supplier'} when they arrive. Nothing goes on the shelf yet.` },
        { label: 'Just keep the prices',
          does: 'Creates the products and the supplier with these prices, and stops there. '
            + 'No order, nothing owed, nothing added to stock.' },
        { label: 'This is what I already have in stock',
          does: `Treats the ${units} ${interpretation.unitLabel || 'unit'}s as stock you already own and `
            + 'puts them on the shelf as your opening balance. No order and no money owed — '
            + 'they are already yours.' },
      ],
    });
  }

  if (kind === 'supplier_invoice') {
    if (context.matchedPurchaseOrder) {
      willDo.push(`match it to ${context.matchedPurchaseOrder.poNumber}`);
    } else {
      needsYou.push({
        question: `Are these ${units} ${interpretation.unitLabel || 'unit'}s expected to arrive?`,
        because: 'There is no purchase order for this, so Foundry does not know whether goods are coming.',
        options: [
        { label: 'Yes, they are coming',
          does: `Records what is owed and raises the order for the ${units} `
            + `${interpretation.unitLabel || 'unit'}s, so the delivery is expected.` },
        { label: 'Something is wrong',
          does: 'Records what the supplier says is owed and raises no order, so nothing is '
            + 'expected to arrive.' },
      ],
      });
    }
  }

  if (kind === 'other') {
    needsYou.push({
      question: 'What is this document?',
      because: 'Foundry will not change anything on the strength of a document it cannot identify.',
      options: Object.keys(KINDS).filter((name) => name !== 'other'),
    });
  }

  /*
   * Anything the reader admitted it could not read. These matter more than a
   * clean summary does: a size run with three unreadable columns is exactly
   * the case where quietly dropping the difference looks like a working import
   * until somebody tries to sell those sizes.
   */
  for (const warning of interpretation.warnings || []) {
    needsYou.push({ question: warning, because: null, options: [] });
  }

  return {
    kind,
    label: meaning.label,
    establishes: meaning.establishes,
    headline: `This is ${meaning.label}.`,
    found,
    means: meaning.because,
    willDo,
    wontDo,
    needsYou,
    openingTheBooks,
    totals: { units, products, goodsMinor, chargesMinor, currency,
      statedTotalMinor: interpretation.documentTotalMinor ?? null },
  };
}

module.exports = { KINDS, kindOf, meaningOf };
