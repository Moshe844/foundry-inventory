'use strict';

const assert = require('node:assert/strict');

async function submit(page, button) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    button.click({ noWaitAfter: true }),
  ]);
}

/**
 * Drives the ordinary streamlined custody path a warehouse operator sees.
 * "It left" records the separate immutable pick and dispatch facts together;
 * it never changes the stock twice.
 */
async function completeTransfer(page) {
  assert.match(new URL(page.url()).pathname, /^\/transfers\/tr_/);
  let text = await page.locator('main').innerText();
  assert.match(text, /Approve this move|Ready to move/i);

  const approve = page.getByRole('button', { name: /Approve (?:and reserve|this move)/i });
  if (await approve.count()) await submit(page, approve);
  assert.match(await page.locator('main').innerText(), /Ready to move/i);
  await submit(page, page.getByRole('button', { name: /^(?:It left|Confirm .* units left|Confirm units left)/i }));
  assert.match(await page.locator('main').innerText(), /On the way|in transit/i);

  const serial = page.getByRole('button', { name: 'Record serial outcomes' });
  const quantity = page.getByRole('button', { name: /^(?:All|Confirm all) \d+ arrived$/i });
  await submit(page, (await serial.count()) ? serial : quantity);
  assert.match(await page.locator('main').innerText(), /This transfer is complete|Complete/i);
}

module.exports = { completeTransfer };
