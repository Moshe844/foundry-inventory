'use strict';

/*
 * The address of the payment page, as it reaches the browser.
 *
 * A merchant asked a customer for money with the customer standing there, and
 * the window that opened was a Foundry page saying "We could not find that".
 * Nothing was wrong with the payment: Stripe had the invoice, the link was
 * valid, and the order was correct. What was wrong was one attribute.
 *
 * The template supplied the attribute's quotes with JSON.stringify, and EJS's
 * `<%=` then escaped them into `&#34;` — so the attribute arrived unquoted
 * with literal quote characters inside its value. The browser read the value
 * as `"https://…stripe.com/…"`, which is not an absolute URL, so it resolved
 * it against Foundry's own origin and opened
 *
 *   /orders/%22https://invoice.stripe.com/i/acct_1?s=ap%22
 *
 * This reads the real view rather than a copy of the line, because a test that
 * restates the markup would have gone on passing while the page was broken.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const VIEW = path.join(__dirname, '..', '..', 'src', 'web', 'views', 'sales', 'order.ejs');
const STRIPE = 'https://invoice.stripe.com/i/acct_1UBFTuRIKnVSv4Xh/test_YWNjdF8x?s=ap';

/** The opening tag of the payment panel, out of the view as it actually is. */
function payWindowTag() {
  const source = fs.readFileSync(VIEW, 'utf8');
  const line = source.split('\n').find((row) => row.includes('id="pay-window"'));
  assert.ok(line, 'the payment panel is still in the order view');
  return line;
}

/** What an attribute's value is once a browser has decoded the entities in it. */
function attributeValue(html, name) {
  const quoted = new RegExp(`${name}="([^"]*)"`).exec(html);
  if (quoted) return decode(quoted[1]);
  const bare = new RegExp(`${name}=([^\\s>]+)`).exec(html);
  return bare ? decode(bare[1]) : null;
}

const decode = (text) => String(text)
  .replaceAll('&#34;', '"').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

test('the order page is a template a browser can be given', () => {
  /*
   * Blunt, and it earned its place. The fix above came with a comment
   * explaining it, the comment quoted an EJS tag, and the parser read the
   * quotation as a tag — so every order page became "Something went wrong".
   * Rendering one line out of the view, as the tests below do, cannot see
   * that. This compiles the whole thing.
   */
  ejs.compile(fs.readFileSync(VIEW, 'utf8'), { filename: VIEW });
});

test('the payment window opens the carrier of the money, not a Foundry page', () => {
  const rendered = ejs.render(payWindowTag(), { openPaymentUrl: STRIPE }, { filename: VIEW });

  const value = attributeValue(rendered, 'data-open-now');
  assert.equal(value, STRIPE, 'the browser reads back exactly the address Stripe gave');

  /*
   * The failure this is really about: a value the browser cannot read as an
   * absolute address is resolved against Foundry, and the merchant is sent to
   * a page that does not exist while a customer waits.
   */
  const resolved = new URL(value, 'http://localhost:4000/orders/so_1').href;
  assert.equal(resolved, STRIPE);
  assert.ok(!resolved.startsWith('http://localhost:4000'),
    'and never somewhere on Foundry itself');
});

test('no payment asked for means no window to open', () => {
  const rendered = ejs.render(payWindowTag(), {}, { filename: VIEW });
  assert.ok(!rendered.includes('data-open-now'),
    'the panel is there for the buttons, and opens nothing by itself');
});

test('an address is escaped rather than allowed to end the attribute', () => {
  /*
   * The provider's URL is not ours to trust the shape of. One quote character
   * in it would close the attribute early and put the rest of the address into
   * the markup as though it were more attributes.
   */
  const awkward = 'https://pay.test/x?a="b"&c=<d>';
  const rendered = ejs.render(payWindowTag(), { openPaymentUrl: awkward }, { filename: VIEW });
  assert.ok(!/data-open-now="[^"]*"[^>]*"/.test(rendered), 'the attribute is not ended early');
  assert.equal(attributeValue(rendered, 'data-open-now'), awkward);
});
