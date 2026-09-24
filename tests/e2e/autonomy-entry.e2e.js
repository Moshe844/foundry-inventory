'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { chromium } = require('playwright');

test('months-running business authority, dated digest, batch approvals and owner miss intake work through the UI', { timeout: 180000 }, async (context) => {
  const root = path.resolve(__dirname, '../..');
  const screenshots = path.join(root, 'artifacts/screenshots/autonomy-entry');
  fs.mkdirSync(screenshots, { recursive: true });
  const child = fork(path.join(root, 'tests/helpers/autonomy-entry-server.js'), [], {
    cwd: root, env: { ...process.env, NODE_ENV: 'test', FOUNDRY_SESSION_DATABASE_URL: '' }, silent: true });
  child.stderr.on('data', (chunk) => process.stderr.write(String(chunk)));
  let browser;
  context.after(async () => {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.send({ type: 'shutdown' });
      const timer = setTimeout(() => child.kill(), 10000);
      await exited;
      clearTimeout(timer);
    }
  });
  const state = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', () => reject(new Error('Autonomy frontend fixture startup failed.')));
  });
  const base = `http://127.0.0.1:${state.port}`;
  browser = await chromium.launch();
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await browserContext.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/login`);
  await page.getByLabel('Email').fill('autonomy-owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('disposable-autonomy-password');
  await Promise.all([page.waitForNavigation(), page.locator('form[action="/login"] button[type=submit]').click()]);
  await context.test('one confirmation displays evidence-backed supplier, product and actual weekly limits', async () => {
    await page.goto(`${base}/`);
    assert.match(await page.getByRole('region', { name: 'Suggested routine-work limits' }).innerText(), /\$200\.00 USD in any rolling seven days/);
    await page.goto(`${base}/autopilot`);
    const proposal = page.getByRole('region', { name: 'Limits from your own records' });
    assert.match(await proposal.innerText(), /3 priced USD orders|Usual Coffee Supplier/);
    assert.match(await proposal.innerText(), /\$200\.00 in any rolling seven days/);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Confirm these limits' }).click()]);
    assert.match(await page.locator('main').innerText(), /Approved only the displayed suppliers/);
    assert.equal(await page.locator('input[name="maximumValuePerWeek"]').inputValue(), '200');
    await page.reload();
    assert.equal(await page.getByRole('button', { name: 'Confirm these limits' }).count(), 0);
  });
  await context.test('daily digest uses real calendar dates, including weekends, without inventing completions', async () => {
    await page.goto(`${base}/autopilot/daily`);
    assert.match(await page.getByRole('region', { name: 'Automatic digest snapshots' }).innerText(), /6 waiting decisions/);
    await page.getByLabel('Report date').fill(state.saturday);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Show day' }).click()]);
    assert.match(await page.getByRole('region', { name: 'Completed and verified', exact: true }).innerText(), /Completed and verified · 1/);
    assert.match(await page.locator('main').innerText(), /draft prepared only; nothing sent/);
    await page.getByLabel('Report date').fill(state.sunday);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Show day' }).click()]);
    assert.match(await page.getByRole('region', { name: 'Completed and verified', exact: true }).innerText(), /No verified completions/);
  });
  await context.test('a stale batch is rejected before any still-pending decision is approved', async () => {
    const boxes = page.locator('input[name=selected]');
    await boxes.first().check();
    await boxes.last().check();
    const value = await boxes.last().getAttribute('value');
    const id = value.split(':')[0];
    const other = await browserContext.newPage();
    await other.goto(`${base}/autopilot/work/${id}`);
    await Promise.all([other.waitForNavigation(), other.locator(`form[action="/autopilot/work/${id}/cancel"] button`).click()]);
    await other.close();
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Approve selected decisions' }).click()]);
    assert.match(await page.locator('main').innerText(), /Nothing in this batch was approved/);
    assert.equal(await page.locator('input[name=selected]').count(), 5);
  });
  await context.test('five selected approvals produce verified PO results and one policy suggestion, not silent authority', async () => {
    await page.goto(`${base}/autopilot/daily`);
    for (const checkbox of await page.locator('input[name=selected]').all()) await checkbox.check();
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Approve selected decisions' }).click()]);
    assert.equal(await page.getByRole('region', { name: 'Batch results' }).getByRole('link', { name: 'Completed and verified', exact: true }).count(), 5);
    assert.equal(await page.locator('input[name=selected]').count(), 0);
    await page.goto(`${base}/needs-you/all`);
    assert.match(await page.locator('main').innerText(), /five times|Suggestion: handle similar/);
    await page.goto(`${base}/autopilot/daily`);
    await page.getByRole('region', { name: 'Approvals that can become policy' }).getByRole('link').click();
    assert.match(await page.locator('main').innerText(), /Nothing changes until you approve/);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Approve and remember' }).click()]);
    assert.match(await page.locator('main').innerText(), /Remembered and active/);
  });
  await context.test('an owner can keep the exact failed question and review its missing requirement without claiming it fixed', async () => {
    await page.goto(`${base}/autopilot/misses`);
    await page.getByLabel('Exact question you asked').fill('Which products sold most last month?');
    await page.getByLabel('What actually happened').fill('The answer ignored the date range.');
    await page.getByLabel('What should have happened').fill('Ground sales in the requested month; do not invent missing history.');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save miss report' }).click()]);
    assert.match(await page.getByRole('region', { name: 'Miss report' }).innerText(), /OPEN|No matching recorded Ask request/);
    await page.getByLabel('Review and next fix').fill('Implement a dated sales regression, then retest the actual Ask answer.');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save review' }).click()]);
    await page.reload();
    assert.match(await page.getByRole('region', { name: 'Miss report' }).innerText(), /REVIEWED|passing regression test/);
    fs.mkdirSync(path.join(root, 'artifacts/screenshots/autonomy-entry'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/autonomy-entry/owner-miss-review.png'), fullPage: true });
  });
  await context.test('one confirmation covers a saved mailbox and history-backed USD carrier limits without treating seeded history as live proof', async () => {
    const isolatedContext = await browser.newContext();
    const connectedPage = await isolatedContext.newPage();
    connectedPage.on('pageerror', (error) => errors.push(error.message));
    await connectedPage.goto(`${base}/login`);
    await connectedPage.getByLabel('Email').fill('connected-authority-owner@example.test');
    await connectedPage.getByLabel('Password', { exact: true }).fill('disposable-autonomy-password');
    await Promise.all([connectedPage.waitForNavigation(), connectedPage.locator('form[action="/login"] button[type=submit]').click()]);
    await connectedPage.goto(`${base}/autopilot`);
    const proposal = connectedPage.getByRole('region', { name: 'Limits from your own records' });
    assert.match(await proposal.innerText(), /supplier@example\.test|fixture@example\.test/);
    assert.match(await proposal.innerText(), /\$7\.00 USD per label/);
    assert.match(await proposal.innerText(), /not live-provider certification/);
    await connectedPage.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect.getComputedTiming().iterations))
        .map((animation) => animation.finished.catch(() => {})));
    });
    await connectedPage.screenshot({ path: path.join(screenshots, 'connected-authority-proposal.png'), fullPage: true });
    await Promise.all([connectedPage.waitForNavigation(), connectedPage.getByRole('button', { name: 'Confirm these limits' }).click()]);
    assert.match(await connectedPage.locator('main').innerText(), /payments are not authorised/);
    for (const capability of ['replenishment', 'supplier_emails', 'shipping_labels']) {
      const job = connectedPage.locator('li.job').filter({ has: connectedPage.locator(`input[name=capability][value="${capability}"]`) });
      assert.match(await job.locator('.job-state').innerText(), /Authorised/);
    }
    await connectedPage.goto(`${base}/autopilot/daily`);
    assert.doesNotMatch(await connectedPage.getByRole('region', { name: 'Supplier email status' }).innerText(), / · SENT/);
    await isolatedContext.close();
  });
  await context.test('authorising customer payment requests never authorises supplier purchasing', async () => {
    await page.goto(`${base}/autopilot#jobs`);
    let purchasing = page.locator('li.job').filter({ has:page.locator('input[name="capability"][value="replenishment"]') });
    if (/Authorised/.test(await purchasing.locator('.job-state').innerText())) {
      await Promise.all([
        page.waitForNavigation(),
        purchasing.getByRole('button', { name:'Take this back', exact:true }).click(),
      ]);
    }
    let paymentRequests = page.locator('li.job').filter({ has:page.locator('input[name="capability"][value="payment_requests"]') });
    if (/Asks first/.test(await paymentRequests.locator('.job-state').innerText())) {
      await Promise.all([
        page.waitForNavigation(),
        paymentRequests.getByRole('button', { name:'Let StockChief do this', exact:true }).click(),
      ]);
    }
    purchasing = page.locator('li.job').filter({ has:page.locator('input[name="capability"][value="replenishment"]') });
    paymentRequests = page.locator('li.job').filter({ has:page.locator('input[name="capability"][value="payment_requests"]') });
    assert.match(await paymentRequests.locator('.job-state').innerText(), /Authorised/);
    assert.match(await purchasing.locator('.job-state').innerText(), /Asks first/);
    assert.match(await page.locator('main').innerText(), /Nothing else changed/);
  });
  assert.deepEqual(errors, []);
});
