'use strict';

/*
 * The other side of EasyPost: the platform, not the parcel.
 *
 * Every other file under src/shipping speaks about one shop's parcels using
 * one shop's key. This one speaks as Keeper — the partner account that owns
 * the referral customers — and it is the only file in StockChief that ever holds
 * the partner key. It is kept apart from providers/easypost.js on purpose:
 * that file must never be able to reach an endpoint that acts on somebody
 * else's account, and the cheapest way to guarantee that is for it not to know
 * the address.
 *
 * None of this is on the shipping seam. `provider.REQUIRED` is quote, buy,
 * track, verifyEvent and readEvent — what a carrier does — and creating a
 * merchant's account is not one of them. A partner is a way of getting a key,
 * not a way of shipping, so it sits beside the seam rather than inside it.
 *
 *
 * A note on what is certain here and what is not.
 *
 * The referral customer endpoints are stable and documented. Attaching a
 * payment method is the part that has moved: it has been a Stripe token, a
 * customer id and payment-method reference pair, and a client secret handed to
 * Stripe Elements, at different times. So it is confined to `PAYMENT` below,
 * in one small place with one shape to correct, rather than spread through the
 * lifecycle. Everything above it works from `hasPaymentMethod` and does not
 * care how the card got there.
 *
 * What is not negotiable, whichever shape it settles on: the card number never
 * passes through StockChief. The merchant types it into Stripe's own field and
 * StockChief learns only that a payment method exists.
 */

const { ValidationError, AuthenticationError } = require('../../domain/errors');

const BASE = 'https://api.easypost.com/v2';
const BETA = 'https://api.easypost.com/beta';

/** The partner key, which belongs to the platform and to no workspace. */
function partnerKey(explicit) {
  const key = explicit || process.env.EASYPOST_PARTNER_KEY;
  if (!key) {
    throw new ValidationError('StockChief is not enrolled as an EasyPost partner, so it cannot open a '
      + 'shipping account on a merchant\'s behalf. Connect an existing EasyPost account instead.');
  }
  return String(key);
}

/** Whether opening accounts from inside StockChief is available at all. */
function isPartnerConfigured() { return Boolean(process.env.EASYPOST_PARTNER_KEY); }

async function call(key, path, options = {}) {
  const base = options.beta ? BETA : BASE;
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const said = body?.error?.message || body?.error;
    const message = typeof said === 'string' ? said
      : said ? JSON.stringify(said) : `EasyPost returned ${response.status}.`;
    /*
     * 401 from the partner key is not the merchant's problem and must not be
     * shown to them as one. It means Keeper's own enrolment is wrong.
     */
    const error = response.status === 401
      ? new AuthenticationError('EasyPost refused StockChief\'s partner credentials. '
        + 'This is a problem with StockChief\'s enrolment, not with this inventory.')
      : new ValidationError(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

/* ------------------------------------------------------------------- keys */

/*
 * A referral customer comes back with both of its keys.
 *
 * Which one StockChief then uses is decided elsewhere, by whether the merchant
 * has a way to be billed — a live key with no card behind it buys nothing and
 * fails at the counter.
 */
function keysFrom(user = {}) {
  const listed = user.api_keys || user.keys || [];
  const pick = (mode) => {
    const found = listed.find((row) => String(row.mode || '').toLowerCase() === mode);
    return found ? String(found.key) : null;
  };
  return { testKey: pick('test'), liveKey: pick('production') || pick('live') };
}

function readCustomer(user = {}) {
  const keys = keysFrom(user);
  return {
    referralCustomerId: user.id || null,
    name: user.name || null,
    email: user.email || null,
    phone: user.phone_number || user.phone || null,
    createdAt: user.created_at || null,
    testKey: keys.testKey,
    liveKey: keys.liveKey,
  };
}

/* -------------------------------------------------------------- lifecycle */

/**
 * Open an EasyPost account belonging to this merchant.
 *
 * The account is theirs from the moment it exists: their labels, their rates,
 * their billing. StockChief is how it was created and is not who it belongs to,
 * which is why nothing here takes or keeps a card.
 */
async function createReferralCustomer(input = {}, options = {}) {
  const key = partnerKey(options.partnerKey);
  const created = await call(key, '/referral_customers', {
    method: 'POST',
    body: { user: {
      name: input.name || undefined,
      email: input.email || undefined,
      phone: input.phone || undefined,
    } },
  });
  const read = readCustomer(created);
  if (!read.referralCustomerId) {
    throw new ValidationError('EasyPost created something StockChief could not read as an account.');
  }
  return read;
}

/** Every merchant account StockChief has opened. Used to reconcile, not to browse. */
async function listReferralCustomers(options = {}) {
  const key = partnerKey(options.partnerKey);
  const query = options.pageSize ? `?page_size=${Number(options.pageSize)}` : '';
  const body = await call(key, `/referral_customers${query}`);
  return (body?.referral_customers || body?.children || []).map(readCustomer);
}

/** Correct a name or address on an account StockChief opened. */
async function updateReferralCustomer(referralCustomerId, input = {}, options = {}) {
  const key = partnerKey(options.partnerKey);
  const updated = await call(key, `/referral_customers/${encodeURIComponent(referralCustomerId)}`, {
    method: 'PUT',
    body: { user: {
      name: input.name || undefined,
      email: input.email || undefined,
      phone: input.phone || undefined,
    } },
  });
  return readCustomer(updated);
}

/* ----------------------------------------------------------------- paying */

/*
 * How a merchant's card gets onto their account, without touching StockChief.
 *
 * EasyPost bills a referral customer through Stripe, and hands out a client
 * secret so the card can be collected by Stripe's own field in the merchant's
 * browser. StockChief passes that secret to the page and learns nothing else. The
 * number never reaches this process, this database, or a log.
 *
 * These three calls are made with the *merchant's* key, not the partner's:
 * the account being paid for is theirs.
 */
const PAYMENT = {
  /** A secret for Stripe's own card field, in the merchant's browser. */
  async beginCardSetup(referralKey) {
    const body = await call(referralKey, '/setup_intents',
      { method: 'POST', beta: true });
    const secret = body?.client_secret || null;
    if (!secret) throw new ValidationError('EasyPost did not return a way to collect a card.');
    return {
      clientSecret: secret,
      publishableKey: body?.publishable_key || process.env.EASYPOST_STRIPE_PUBLISHABLE_KEY || null,
    };
  },

  /** A secret for a bank account instead, for merchants who prefer one. */
  async beginBankSetup(referralKey) {
    const body = await call(referralKey, '/referral_customers/bank_accounts/clientsecret',
      { method: 'POST', beta: true });
    const secret = body?.client_secret || null;
    if (!secret) throw new ValidationError('EasyPost did not return a way to collect a bank account.');
    return { clientSecret: secret };
  },

  /*
   * Tell EasyPost about the method Stripe has just stored.
   *
   * The pm_ reference comes from Stripe through the browser. StockChief forwards
   * it to EasyPost's current credit-card endpoint and keeps no card data.
   */
  async attach(referralKey, input = {}) {
    if (!input.paymentMethodReference) {
      throw new ValidationError('Stripe did not return a stored payment method to record.');
    }
    if (/^(?:\d[ -]?){12,19}$/.test(String(input.paymentMethodReference))) {
      /*
       * A guard, not a validation. If a card number ever reaches this
       * argument something upstream has gone badly wrong, and the right
       * response is to stop rather than to forward it and log the failure.
       */
      throw new ValidationError('That looks like a card number rather than a Stripe reference. '
        + 'StockChief does not handle card numbers.');
    }
    const body = await call(referralKey, '/credit_cards', {
      method: 'POST',
      body: {
        credit_card: {
          payment_method_id: input.paymentMethodReference,
          priority: input.priority || 'primary',
        },
      },
    });
    return { attached: true, id: body?.id || null };
  },
};

/**
 * Whether this merchant can actually be billed yet.
 *
 * The question that decides whether a live label may be bought. An account
 * with no payment method is not broken — it is unfinished, and quoting live
 * rates against it would be quoting a price nobody can pay.
 */
async function hasPaymentMethod(referralKey) {
  try {
    const body = await call(referralKey, '/payment_methods');
    const primary = body?.primary_payment_method || null;
    const secondary = body?.secondary_payment_method || null;
    return Boolean(primary || secondary);
  } catch (error) {
    /*
     * EasyPost answers 404 or 422 for an account that has never had one. That
     * is an answer — "no" — and not a failure worth raising to a merchant.
     */
    if (error.status === 404 || error.status === 422) return false;
    throw error;
  }
}

/** What the merchant's own wallet holds, for the screen that says so. */
async function balance(referralKey) {
  const body = await call(referralKey, '/users/me');
  const figure = body?.balance;
  if (figure === undefined || figure === null) return null;
  return Math.round(Number(figure) * 100);
}

module.exports = {
  isPartnerConfigured,
  createReferralCustomer,
  listReferralCustomers,
  updateReferralCustomer,
  hasPaymentMethod,
  balance,
  PAYMENT,
  // Exported for the tests, which stand in for EasyPost rather than calling it.
  readCustomer,
  keysFrom,
};
