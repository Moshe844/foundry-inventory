'use strict';

/*
 * "Use UPS Ground automatically if it arrives by the promised date and costs
 * under $25. Ask me otherwise." — read into a rule.
 *
 * Deterministic, for the same reason authority is: a sentence read slightly
 * wrong is money spent somebody did not agree to. A model may say *that* this
 * sentence is about shipping; it may never be the thing that decides the
 * figure is 25 rather than 250, or that "UPS" meant FedEx. Every value here
 * comes out of the owner's own characters by pattern, and anything that does
 * not match cleanly comes back as a question.
 *
 * The refusal that matters most is the last one. A sentence naming a carrier
 * and no limits — "just use UPS" — is unlimited permission to spend on
 * postage, and Foundry does not create that from a sentence any more than it
 * creates unlimited authority from "handle everything". It says what it would
 * need and waits.
 */

const carriers = require('../sales/carriers');

/* Somebody talking about shipping at all. */
const ABOUT_SHIPPING = /\b(ship|shipping|shipment|postage|label|labels|courier|carrier|parcel|deliver|delivery|freight|mail it|send it)\b/i;

/*
 * A standing rule, rather than a one-off.
 *
 * Two shapes: a word that means "every time" — always, automatically, by
 * default — or a condition, which is what "when it costs under $25" is. A
 * sentence with neither is somebody talking about one parcel: "ship this order
 * today" is an instruction, not a policy, and writing it down as one would
 * quietly change how every future parcel is handled.
 */
const A_RULE = /\b(always|automatically|by default|from now on|whenever|prefer|default to|stick to|when|if)\b/i;

/*
 * A limit on money, and not on anything else.
 *
 * The first version of this read "within 3 days" as a three-dollar spending
 * limit, because "within" introduces both and a bare number looks the same
 * either way. It would have quietly refused every rate over $3 and looked, to
 * the owner, like carriers had stopped quoting.
 *
 * So a figure only counts as money when it says so — a currency symbol, or the
 * word — and never when a unit of time follows it. Scanned rather than matched
 * once, because "under $25 within 3 days" contains both and the money is not
 * necessarily first.
 */
const MONEY_NEAR = /(?:under|below|less than|no more than|up to|cheaper than|max(?:imum)?(?: of)?|within|costs?)\s*(\$)?\s*([0-9]+(?:[.,][0-9]{1,2})?)\s*(dollars?|usd|bucks|days?|business days?|weeks?|hours?)?/gi;
const DAYS = /\bwithin\s+(\d{1,2})\s*(?:business\s+)?days?\b/i;

/** The spending limit the sentence states, in minor units, or null. */
function moneyIn(text) {
  for (const match of String(text).matchAll(MONEY_NEAR)) {
    const [, symbol, figure, unit] = match;
    if (unit && /day|week|hour/i.test(unit)) continue;
    if (!symbol && !unit) continue;
    return Math.round(Number(String(figure).replace(',', '.')) * 100);
  }
  return null;
}
const BY_PROMISED = /\b(?:by|before|meets?|makes?|hits?)\s+(?:the\s+)?(?:date\s+)?(?:the\s+)?(?:customer(?:'s|s')?\s+)?(?:was\s+)?promised(?:\s+date)?\b|\bpromised\s+date\b|\bon\s+time\b|\bby\s+the\s+(?:customer'?s?\s+)?date\b/i;

/* "The cheapest", said in the ways people say it. */
const CHEAPEST = /\b(cheapest|lowest|least expensive|whatever is cheapest|best price)\b/i;

/** The carrier named, if one is. */
function carrierIn(text) {
  const lower = ` ${text.toLowerCase()} `;
  for (const carrier of carriers.list()) {
    const name = carrier.name.toLowerCase();
    if (lower.includes(` ${name} `) || lower.includes(` ${carrier.code} `)) return carrier;
  }
  return null;
}

/** The service named, out of the ones that carrier actually offers. */
function serviceIn(text, carrier) {
  const lower = text.toLowerCase();
  const pool = carrier ? carrier.services : carriers.list().flatMap((row) => row.services);
  // Longest first, so "Priority Mail Express" is not read as "Priority Mail".
  const found = [...new Set(pool)]
    .sort((a, b) => b.length - a.length)
    .find((service) => lower.includes(service.toLowerCase()));
  return found || null;
}

/**
 * What the sentence means, or what is missing from it.
 *
 * Returns `{ understood, rule, because, needs }`. `needs` is what Foundry
 * would have to be told before this could become a rule, phrased as the thing
 * to say rather than the field that is empty.
 */
function read(sentence) {
  const text = String(sentence || '').trim();
  if (!text) return { understood: false, because: 'Nothing was said.' };

  /*
   * Naming a carrier is talking about shipping. "Use UPS Ground under $25"
   * contains not one of the words in ABOUT_SHIPPING and is unmistakably a
   * shipping rule, so who would carry it counts as the subject.
   */
  const named = carrierIn(text) || serviceIn(text, null);
  if (!ABOUT_SHIPPING.test(text) && !named) {
    return { understood: false, because: 'That is not about shipping.' };
  }
  if (!A_RULE.test(text)) {
    return { understood: false,
      because: 'That reads as a one-off rather than a standing rule. A rule says "always", '
        + '"automatically", or "by default".' };
  }

  const carrier = carrierIn(text);
  const service = serviceIn(text, carrier);
  const days = text.match(DAYS);
  const byPromised = BY_PROMISED.test(text);
  const cheapest = CHEAPEST.test(text);
  const maxCostMinor = moneyIn(text);

  /*
   * A rule with no ceiling and no deadline is not a rule.
   *
   * "Always use UPS" sounds like an instruction and is in fact permission to
   * spend any amount on postage for ever. Foundry will not write that down
   * from a sentence, for the same reason it will not turn "handle everything"
   * into unlimited authority. What it needs is one number.
   */
  if (maxCostMinor === null && !byPromised && !days) {
    return {
      understood: false,
      needs: 'a limit',
      because: carrier
        ? `Foundry can use ${carrier.name}${service ? ` ${service}` : ''} on its own, but not without a `
          + 'limit — that would be permission to spend anything on postage. Say what it may cost, or '
          + 'that it has to arrive by the date the customer was promised.'
        : 'A rule needs a limit: what postage may cost, or that it has to arrive by the date the '
          + 'customer was promised.',
    };
  }

  if (maxCostMinor !== null && !(maxCostMinor > 0)) {
    return { understood: false, because: 'A spending limit has to be more than nothing.' };
  }

  const rule = {
    carrier: carrier ? carrier.code : null,
    service: carrier || !cheapest ? service : null,
    maxCostMinor,
    requireByPromised: byPromised,
    maxDeliveryDays: days ? Number(days[1]) : null,
    statedText: text,
  };

  return { understood: true, rule, because: require('./rules').describe(rule) };
}

/**
 * Read it and keep it, in one step.
 *
 * Saves nothing it did not fully understand — a half-read rule about spending
 * is worse than no rule, because the owner would believe it was there.
 */
function applySentence(db, ctx, sentence) {
  const said = read(sentence);
  if (!said.understood) return said;
  const rules = require('./rules');
  const saved = rules.save(db, ctx, { ...said.rule, name: rules.describe(said.rule) });
  return { ...said, saved };
}

module.exports = { read, applySentence, carrierIn, serviceIn, moneyIn, ABOUT_SHIPPING, A_RULE };
