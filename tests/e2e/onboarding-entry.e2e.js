'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { chromium } = require('playwright');

test('first-run onboarding removes choices without mixing samples and real records', { timeout: 180000 }, async (context) => {
  const root = path.resolve(__dirname, '../..');
  const child = fork(path.join(root, 'tests/helpers/onboarding-entry-server.js'), [],
    { cwd: root, env: { ...process.env, NODE_ENV: 'test', FOUNDRY_SESSION_DATABASE_URL: '' }, silent: true });
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
    child.once('exit', () => reject(new Error('Frontend fixture startup failed.')));
  });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(15000);
  const base = `http://127.0.0.1:${state.port}`;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.test('signup opens three source choices and an editable prefilled first inventory', async () => {
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name', { exact: true }).fill('First Run Business');
    await page.getByLabel('Your name').fill('First Run Owner');
    await page.getByLabel('Email').fill('first-run@example.test');
    await page.getByLabel('Password', { exact: true }).fill('disposable-entry-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`), page.locator('form[action="/register"] button[type=submit]').click()]);
    assert.equal(await page.getByLabel('Inventory name').inputValue(), 'First Run Business');
    assert.equal(await page.locator('.rm-source-grid > *').count(), 3);
    const body = await page.locator('main').innerText();
    assert.doesNotMatch(body, /Use several sources|Use email attachments|My real business|Test environment|Back to previous page/);
    assert.equal(await page.getByRole('link', { name: 'Add a source', exact: true }).count(), 0);
    fs.mkdirSync(path.join(root, 'artifacts/screenshots/onboarding-entry'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/onboarding-entry/source-layout-check.png'), fullPage: true });
    const cards = await page.locator('.rm-source-grid > *').first().boundingBox();
    assert.ok(cards && cards.y < 800);
    for (const card of await page.locator('.rm-source-files,.rm-source-grid button.rm-choice').all()) {
      const bounds = await card.boundingBox();
      assert.ok(bounds && bounds.y + bounds.height <= 800, `every desktop source card must be visible: ${JSON.stringify(bounds)}`);
    }
    await page.getByLabel('Inventory name').fill('Actual Business Inventory');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save name', exact: true }).click()]);
    assert.equal(await page.getByLabel('Inventory name').inputValue(), 'Actual Business Inventory');
    const shots = path.join(root, 'artifacts/screenshots/onboarding-entry');
    fs.mkdirSync(shots, { recursive: true });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter((animation) => animation.effect.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
    });
    await page.screenshot({ path: path.join(shots, 'three-source-choices-desktop.png'), fullPage: true });
  });
  await context.test('skip opens a usable empty app with a durable source prompt and no fake back link', async () => {
    await Promise.all([page.waitForURL(`${base}/`), page.getByRole('button', { name: 'Skip for now', exact: true }).click()]);
    assert.match(await page.locator('main').innerText(), /first records/);
    assert.equal(await page.locator('.rm-empty-welcome').count(), 1);
    assert.equal(await page.locator('.rm-hero').count(), 0);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().filter((animation) => animation.effect.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})));
    });
    const welcomeColors = await page.locator('.rm-empty-welcome').evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      heading: getComputedStyle(element.querySelector('h1')).color,
    }));
    assert.equal(welcomeColors.background, 'rgb(255, 255, 255)');
    const channels = welcomeColors.heading.match(/\d+/g).slice(0, 3).map((channel) => Number(channel) / 255);
    const luminance = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    assert.ok(1.05 / (0.2126 * luminance[0] + 0.7152 * luminance[1] + 0.0722 * luminance[2] + 0.05) >= 4.5);
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/onboarding-entry/empty-welcome.png'), fullPage: true });
    assert.equal(await page.getByRole('link', { name: 'Back to previous page', exact: true }).count(), 0);
    await page.getByRole('link', { name: 'Inventory', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Add inventory data', exact: true }).count(), 1);
    await page.reload();
    assert.equal(await page.getByRole('link', { name: 'Add a source', exact: true }).count(), 1);
  });
  await context.test('sample exploration is populated, labelled, repeat-safe and clearable with one click', async () => {
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Load sample data to explore', exact: true }).click()]);
    await page.getByRole('link', { name: 'Open the stock table', exact: true }).click();
    assert.match(await page.locator('main').innerText(), /Sample coffee beans|Sample travel mug/);
    assert.match(await page.getByRole('region', { name: 'Sample exploration' }).innerText(), /cannot be converted to real/);
    await page.goto(`${base}/settings`);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Load sample data to explore', exact: true }).click()]);
    await Promise.all([page.waitForURL(`${base}/`), page.getByRole('button', { name: 'Clear sample data', exact: true }).click()]);
    assert.match(await page.locator('main').innerText(), /Your real inventory is unchanged/);
    await page.goto(`${base}/inventories`);
    assert.equal(await page.locator('.wsp-card').count(), 1);
    assert.match(await page.locator('.wsp-card').innerText(), /Actual Business Inventory/);
    assert.match(await page.locator('.wsp-facts').innerText(), /0 items/);
  });
  await context.test('dismiss survives navigation while source prompt and settings exploration remain', async () => {
    await page.goto(`${base}/onboarding`);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Dismiss sample suggestion', exact: true }).click()]);
    assert.equal(page.url(), `${base}/onboarding`);
    assert.equal(await page.locator('.rm-source-grid > *').count(), 3);
    await page.goto(`${base}/inventory`);
    assert.equal(await page.getByRole('button', { name: 'Load sample data to explore', exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Add a source', exact: true }).count(), 1);
    await page.goto(`${base}/settings`);
    assert.equal(await page.getByRole('button', { name: 'Load sample data to explore', exact: true }).count(), 1);
    await page.getByRole('link', { name: 'Set up ongoing email-attachment ingestion', exact: true }).click();
    assert.match(await page.locator('main').innerText(), /Ongoing ingestion/);
  });
  await context.test('manual entry goes to the actual product form; additional inventories remain explicit', async () => {
    await page.goto(`${base}/onboarding`);
    await Promise.all([page.waitForURL(`${base}/inventory/new`), page.getByRole('button', { name: /Enter it manually/ }).click()]);
    assert.equal(await page.locator('form[action="/inventory"]').count(), 1);
    await page.goto(`${base}/inventories/new`);
    assert.equal(await page.locator('input[name=dataMode]').count(), 0);
    assert.equal(await page.locator('#name').inputValue(), '');
    assert.match(await page.locator('#name').getAttribute('placeholder'), /^e\.g\./);
    assert.ok(await page.locator('a.page-back,a.back-link').count() <= 1);
    await page.locator('#name').fill('Second Inventory');
    await Promise.all([page.waitForURL(`${base}/onboarding`), page.locator('form[action="/inventories"] button[type=submit]').click()]);
    await page.goto(`${base}/inventories`);
    assert.equal(await page.locator('.wsp-card').count(), 2);
    assert.match(await page.locator('main').innerText(), /Each one is completely separate/);
  });
  await context.test('direct spreadsheet drop uploads real bytes from source selection without opening another card', async () => {
    await page.goto(`${base}/onboarding`);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.match(await page.locator('main').innerText(), /Three ways to start/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.setViewportSize({ width: 1280, height: 800 });
    const transfer = await page.evaluateHandle(() => {
      const payload = new DataTransfer();
      payload.items.add(new File(['SKU,Name,Location,Quantity\nREAL-001,Real coffee,Main warehouse,17\n'], 'real-stock.csv', { type: 'text/csv' }));
      return payload;
    });
    await Promise.all([page.waitForURL(/\/onboarding\/migrations\/(?!new)[^/]+(?:\/sources)?$/),
      page.locator('[data-file-drop]').dispatchEvent('drop', { dataTransfer: transfer })]);
    assert.match(await page.locator('main').innerText(), /real-stock\.csv/);
    assert.doesNotMatch(await page.locator('main').innerText(), /Sample coffee/);
    await page.getByRole('button', { name: 'Approve and go live', exact: true }).waitFor({ timeout: 60000 });
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Approve and go live', exact: true }).click()]);
    await page.goto(`${base}/inventory`);
    await page.getByRole('link', { name: 'Open the stock table', exact: true }).click();
    assert.match(await page.locator('main').innerText(), /Real coffee/);
    assert.match(await page.locator('main').innerText(), /17/);
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/onboarding-entry/file-import-populated.png'), fullPage: true });
  });
  await context.test('an existing account that never had an inventory bypasses the empty inventories list', async () => {
    await Promise.all([page.waitForURL(`${base}/login`), page.getByRole('button', { name: 'Sign out', exact: true }).click()]);
    await page.getByLabel('Email', { exact: true }).fill('legacy-empty@example.test');
    await page.getByLabel('Password', { exact: true }).fill('disposable-legacy-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
    assert.equal(await page.getByLabel('Inventory name').inputValue(), 'My inventory');
    assert.equal(await page.locator('.rm-source-grid > *').count(), 3);
    assert.doesNotMatch(await page.locator('main').innerText(), /Give StockChief an inventory to manage|New inventory|Use several sources|Use email attachments/);
    await page.getByLabel('Inventory name').fill('Legacy Business');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Save name', exact: true }).click()]);
    await page.goto(`${base}/inventories`);
    assert.equal(await page.locator('.wsp-card').count(), 1);
    assert.match(await page.locator('.wsp-card').innerText(), /Legacy Business/);
    await page.reload();
    assert.equal(await page.locator('.wsp-card').count(), 1);
  });
  assert.deepEqual(errors, []);
});
