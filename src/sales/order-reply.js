'use strict';

/*
 * The answer a customer is owed when their order does not simply go through.
 *
 * Two situations, and until now both ended the same way: silence. A customer
 * wrote "I want to order size 36, 2 pieces", Foundry could not tell which of
 * four shoes they meant, and the whole thing became a line in the owner's
 * Needs You saying read it yourself. The customer heard nothing. The same
 * happened when the order was perfectly clear and there was not enough stock
 * to fill it.
 *
 *   They named something ambiguous — ask which, and name the actual choices.
 *   The order is clear but short  — say what can go now and what is coming.
 *
 * Written here rather than by the model, deliberately. Every sentence is
 * determined by the records: which products carry that size, how many are on
 * the shelf, how many are on order and when they are expected. There is
 * nothing for a writer to add, and a great deal for one to invent — a date
 * nobody committed to is exactly the sort of promise that costs a customer
 * twice. So the wording is fixed and the figures come from the ledger.
 *
 * And nothing is sent. Each of these is put on the message as a draft, in the
 * same place the model's drafts go, with the same Send button that a person
 * has to press.
 */

const { nowIso } = require('../lib/util');

/** A product as a customer would recognise it. */
function nameOf(row) {
  const item = row.item_name || row.name || '';
  return row.variant_label ? `${item} ${row.variant_label}` : item;
}

/** A list in English: "a, b and c". */
function series(parts) {
  const list = parts.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Put a draft on the message, unless one is already there.
 *
 * A draft somebody has written, edited or sent is never replaced. Foundry
 * offering to help must not mean Foundry overwriting the owner's own words on
 * the next sweep of the mailbox.
 */
function put(db, workspaceId, messageId, subject, body) {
  const row = db.prepare(`SELECT draft_at, reply_sent_at FROM connection_email_messages
    WHERE workspace_id = ? AND id = ?`).get(workspaceId, messageId);
  if (!row || row.draft_at || row.reply_sent_at) return null;
  db.prepare(`UPDATE connection_email_messages SET draft_subject = ?, draft_body = ?,
    draft_source = 'records', draft_rejected_because = NULL, draft_at = ?
    WHERE workspace_id = ? AND id = ?`).run(subject, body, nowIso(), workspaceId, messageId);
  return { subject, body, source: 'records' };
}

const replyTo = (message) => {
  const subject = String(message.subject || '').trim();
  if (!subject) return 'Re: your order';
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
};

/**
 * "Which of these did you mean?" — with the choices named.
 *
 * `questions` are the lines Foundry could not pin down, each carrying the
 * customer's own wording and the candidates the catalogue offered.
 */
function askWhichProduct(db, workspaceId, messageId, message, questions) {
  if (!questions.length) return null;
  const paragraphs = questions.map((question) => {
    const choices = question.candidates.map(nameOf).filter(Boolean);
    const asked = question.asked;
    if (!choices.length) {
      return `You asked for ${asked}, and I could not find that in our range. `
        + 'Could you tell me the style name, or the code from the box?';
    }
    return `You asked for ${asked}. We make ${choices.length} of those — `
      + `${series(choices)} — so I want to be sure you get the right one.`;
  });

  const body = [
    'Hi,',
    '',
    'Thanks for your order.',
    '',
    ...paragraphs.flatMap((paragraph) => [paragraph, '']),
    'Which did you mean? I will put it through as soon as I hear back.',
    '',
    'Thanks,',
  ].join('\n');
  return put(db, workspaceId, messageId, replyTo(message), body);
}

/**
 * What can actually ship, and when the rest can.
 *
 * Only stated for lines that are genuinely short. A date is only given when a
 * purchase order carries one — "expected soon" is the kind of thing that turns
 * into a complaint, so if nothing is expected the reply says exactly that.
 */
function stockShortfall(db, workspaceId, lines) {
  const position = require('../purchasing/position');
  const short = [];
  for (const line of lines) {
    const stock = position.positionForSku(db, workspaceId, line.skuId);
    if (stock.available >= line.quantity) continue;
    const sku = db.prepare(`SELECT s.variant_label, i.name AS item_name FROM skus s
      JOIN items i ON i.id = s.item_id WHERE s.id = ?`).get(line.skuId);
    short.push({
      name: nameOf(sku || {}),
      wanted: line.quantity,
      ready: Math.max(0, stock.available),
      onOrder: stock.onOrder,
      expected: stock.nextExpectedDate,
    });
  }
  return short;
}

function tellThemAboutStock(db, workspaceId, messageId, message, lines, orderNumber) {
  const short = stockShortfall(db, workspaceId, lines);
  if (!short.length) return null;

  const paragraphs = short.map((row) => {
    const missing = row.wanted - row.ready;
    const have = row.ready > 0
      ? `We have ${row.ready} of the ${row.wanted} ${row.name} here now`
      : `We do not have the ${row.name} in stock at the moment`;
    if (row.onOrder > 0 && row.expected) {
      return `${have}. ${row.onOrder} more ${row.onOrder === 1 ? 'is' : 'are'} on order and due ${row.expected}.`;
    }
    if (row.onOrder > 0) {
      return `${have}. ${row.onOrder} more ${row.onOrder === 1 ? 'is' : 'are'} on order, `
        + 'though the supplier has not given a date yet.';
    }
    return `${have}, and ${missing} of them ${missing === 1 ? 'is' : 'are'} not on order yet. `
      + 'Let me know if you would like me to order them in.';
  });

  const body = [
    'Hi,',
    '',
    `Thanks for your order${orderNumber ? ` — I have it down as ${orderNumber}` : ''}.`,
    '',
    'One thing before it goes out:',
    '',
    ...paragraphs.flatMap((paragraph) => [paragraph, '']),
    'Would you like what we have now, or would you rather wait and have it all together?',
    '',
    'Thanks,',
  ].join('\n');
  return put(db, workspaceId, messageId, replyTo(message), body);
}

/** Ask the one operational question needed before this order can proceed. */
function askDeliveryDetails(db, workspaceId, messageId, message, orderNumber, lines = []) {
  const short = stockShortfall(db, workspaceId, lines);
  const stockNote = short.length ? [
    '',
    'I also checked what is ready:',
    ...short.map((row) => {
      const ready = row.ready
        ? `${row.ready} of ${row.wanted} ${row.name} ${row.ready === 1 ? 'is' : 'are'} ready now.`
        : `We do not have the ${row.name} in stock right now.`;
      if (row.onOrder && row.expected) return `${ready} ${row.onOrder} more are due ${row.expected}.`;
      if (row.onOrder) return `${ready} ${row.onOrder} more are on order, but the supplier has not given a date.`;
      return `${ready} The remaining ${row.wanted - row.ready} ${row.wanted - row.ready === 1 ? 'is' : 'are'} not on order yet.`;
    }),
  ] : [];
  const body = [
    'Hi,',
    '',
    `Thanks for your order${orderNumber ? ` — I have it down as ${orderNumber}` : ''}.`,
    '',
    'How would you like to receive it?',
    '',
    'Please reply with either:',
    '- the full address where we should ship it, or',
    '- pickup, if you will collect it.',
    ...stockNote,
    '',
    'We will continue the order as soon as we hear back.',
    '',
    'Thanks,',
  ].join('\n');
  const drafted = put(db, workspaceId, messageId, replyTo(message), body);
  return drafted ? { ...drafted, shortfall: short.length > 0 } : null;
}

module.exports = { askWhichProduct, askDeliveryDetails, tellThemAboutStock, stockShortfall, nameOf, series, put };
