'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');

test('the cross-domain briefing and shared sessions work in the UI against actual PostgreSQL', { timeout: 180000 }, async (context) => {
  const child = fork(path.join(root, 'tests/helpers/operations-review-server.js'), [], { cwd: root,
    env: { ...process.env, NODE_ENV: 'test', TZ: 'UTC' }, silent: true });
  child.stderr.on('data', (chunk) => process.stderr.write(`[operations fixture] ${chunk}`));
  let browser;
  context.after(async () => {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
      await stopped;
      clearTimeout(timer);
    }
  });
  const state = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PostgreSQL frontend fixture startup timed out.')), 120000);
    child.once('message', (message) => { clearTimeout(timer); resolve(message); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`PostgreSQL frontend fixture exited ${code}.`)); });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${state.ports[0]}`;
  const second = `http://127.0.0.1:${state.ports[1]}`;
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact: true }).fill(state.email);
  await page.getByLabel('Password', { exact: true }).fill(state.password);
  await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  await context.test('a second app instance reads the real shared PostgreSQL login session', async () => {
    await page.goto(`${second}/foundry/briefing`);
    assert.match(await page.locator('main').innerText(), /Operations briefing/);
    assert.doesNotMatch(page.url(), /login/);
  });
  await context.test('Monday includes all Friday, Saturday and Sunday records but excludes Thursday and Tuesday', async () => {
    const body = await page.locator('main').innerText();
    assert.match(body, /2026-09-18 through 2026-09-21/);
    assert.match(body, /Physical inventory ledger: 31 records/);
    assert.match(body, /Recorded payments: 4 records/);
    assert.equal(await page.locator('article[data-domain="Physical inventory ledger"]').count(), 31);
    assert.doesNotMatch(body, /receive: 987 units|2026-09-17T12|2026-09-22T12/);
    assert.match(body, /not a completed business-storage migration/);
    assert.match(body, /not independent bank-settlement confirmation/);
    const payments = page.locator('article[data-domain="Recorded payments"]');
    assert.equal(await payments.count(), 4);
    assert.doesNotMatch((await payments.allTextContents()).join('\n'), /T12:00/);
  });
  await context.test('UI dates narrow real PostgreSQL history without truncating the 25 Friday receipts', async () => {
    await page.getByLabel('Briefing from', { exact: true }).fill('2026-09-18');
    await page.getByLabel('Briefing through', { exact: true }).fill('2026-09-18');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Update briefing', exact: true }).click()]);
    assert.equal(await page.locator('article[data-domain="Physical inventory ledger"]').count(), 25);
    assert.match(await page.locator('main').innerText(), /Recorded payments: 1 records/);
  });
  await context.test('Ask offers the real briefing without pretending requested execution happened', async () => {
    await page.goto(`${base}/ask`);
    await page.getByLabel('Tell StockChief what happened, or ask it something', { exact: true })
      .fill('Monday morning operations briefing since Friday. Handle everything and send supplier messages.');
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Send', exact: true }).click()]);
    assert.match(await page.locator('main').innerText(), /requested actions have not been completed/);
    assert.match(await page.locator('main').innerText(), /Physical inventory ledger: 31 records/);
    assert.match(await page.locator('main').innerText(), /Recorded payments: 4 records/);
    await page.getByRole('link', { name: 'Open since-Friday operations briefing', exact: true }).click();
    assert.match(page.url(), /briefing/);
  });
  await context.test('a failed history source is disclosed while the later payment source still succeeds', async () => {
    const ready = new Promise((resolve) => child.once('message', resolve));
    child.send({ type: 'history-source-failure' });
    await ready;
    await page.reload();
    assert.match(await page.getByRole('heading', { level: 1 }).innerText(), /review is incomplete/);
    assert.match(await page.getByRole('alert').innerText(), /Customer email outcomes/);
    assert.match(await page.locator('main').innerText(), /Recorded payments: 4 records/);
    fs.mkdirSync(path.join(root, 'artifacts/screenshots/operations-review'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'artifacts/screenshots/operations-review/partial-source-no-all-clear.png'), fullPage: true });
  });
  await context.test('the frontend retries a workspace-scoped native PostgreSQL dead letter', async () => {
    await page.goto(`${base}/settings/operations`);
    const panel = page.locator('#postgres-jobs');
    assert.match(await panel.innerText(), /migration.acceptance-probe/);
    assert.doesNotMatch(await panel.innerText(), /private-workspace-probe/);
    await Promise.all([page.waitForNavigation(), panel.getByRole('button', { name: 'Retry PostgreSQL job', exact: true }).click()]);
    assert.match(await page.locator('main').innerText(), /PostgreSQL job is queued for a controlled retry/);
    assert.match(await page.locator('#postgres-jobs').innerText(), /not proof that a worker completed/);
    const ready = new Promise((resolve) => child.once('message', resolve));
    child.send({ type: 'queue-state' });
    const result = await ready;
    assert.equal(result.job.status, 'RETRY');
    await page.goto(`${second}/settings/operations`);
    assert.equal(await page.locator('#postgres-jobs button').count(), 0);
  });
  await context.test('sign out invalidates the shared session across both app instances', async () => {
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Sign out', exact: true }).click()]);
    await page.goto(`${second}/foundry/briefing`);
    assert.match(page.url(), /login/);
  });
});
