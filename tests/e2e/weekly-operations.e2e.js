'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname,'../..');
const screenshots = path.join(root,'artifacts/screenshots/weekly-operations');

test('weekly purchasing decisions and 150-order allocation use complete real business records in the UI',{timeout:360000},async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-weekly-ui-'));
  const child = fork(path.join(root,'tests/helpers/weekly-operations-server.js'),[],{
    cwd:root,env:{...process.env,NODE_ENV:'test',DATABASE_PATH:path.join(directory,'weekly.sqlite')},silent:true});
  child.stderr.on('data',(chunk) => process.stderr.write(`[weekly fixture] ${chunk}`));
  let browser;
  context.after(async () => {
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit',resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'),3000);
      await exited;clearTimeout(timer);
    }
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  const state = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Weekly fixture startup timeout')),90000);
    child.once('message',(message) => {clearTimeout(timer);resolve(message);});
    child.once('exit',(code) => {clearTimeout(timer);reject(new Error(`Weekly fixture exited ${code}`));});
  });
  fs.mkdirSync(screenshots,{recursive:true});
  browser = await chromium.launch({headless:process.env.UI_VISIBLE!=='1'});
  const page = await browser.newPage({viewport:{width:1400,height:1000}});
  const base = `http://127.0.0.1:${state.port}`;
  const errors = [];
  page.on('pageerror',(error) => errors.push(error.message));
  await page.goto(`${base}/login`);
  await page.getByLabel('Email',{exact:true}).fill(state.email);
  await page.getByLabel('Password',{exact:true}).fill(state.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);

  await context.test('the supplier screen includes more than twelve orders, overdue non-delivery and late full completion',async () => {
    await page.goto(`${base}/suppliers/${state.supplierId}`);
    const panel = page.locator('.card').filter({has:page.getByRole('heading',{name:'Do they turn up?',exact:true})});
    const body = await panel.innerText();
    assert.match(body,/Committed orders in last 365 days\s*16/);
    assert.match(body,/Overdue unfinished orders\s*1/);
    assert.match(body,/Completed when promised\s*86\.7%/);
    assert.match(body,/All of it arrived\s*87\.5%/);
    await page.screenshot({path:path.join(screenshots,'supplier-complete-history.png'),fullPage:true});
  });

  await context.test('Ask honors six actual calendar months and distinguishes completion from first delivery',async () => {
    await page.goto(`${base}/ask`);
    await page.getByLabel('Tell StockChief what happened, or ask it something',{exact:true}).fill('Which supplier is most reliable in the last six months?');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send',exact:true}).click()]);
    const body = await page.locator('main').innerText();
    assert.match(body,/2026-03-18 through 2026-09-18/);
    assert.match(body,/15 committed orders, 13 complete and 1 overdue unfinished/);
    assert.match(body,/85\.7% completed on time across 14 rated orders/);
    await page.screenshot({path:path.join(screenshots,'ask-six-month-supplier-performance.png'),fullPage:true});
  });

  await context.test('replenishment chooses a 24-dollar packed order over a thousand-dollar low-unit-price minimum',async () => {
    await page.goto(`${base}/purchasing/why/${state.economicSkuId}`);
    const body = await page.locator('main').innerText();
    assert.match(body,/Practical Cases has the lowest known order total for 12 needed: 12 units cost 24 USD/);
    assert.match(body,/unpriced alternatives were not assumed cheaper/);
    assert.match(body,/Freight, tax and supplier-wide minimum spend are not included/);
    await page.screenshot({path:path.join(screenshots,'supplier-minimum-order-economics.png'),fullPage:true});
  });
  await context.test('overdue, unknown and too-late incoming orders are exceptions, not proven coverage', async () => {
    for (const item of state.timingSkus) {
      await page.goto(`${base}/purchasing/why/${item.skuId}`);
      const body = await page.locator('main').innerText();
      assert.match(body, /Incoming stock needs a timing decision/);
      assert.match(body, /No duplicate order was prepared/);
      assert.doesNotMatch(body, /Incoming stock currently covers the expected requirement/);
      if (item.name.startsWith('Too Late')) assert.match(body, /projected short before 2026-10-20/);
      else assert.match(body, /overdue or unverified arrival dates/);
    }
    await page.goto(`${base}/purchasing`);
    const alerts = page.getByRole('alert').filter({ hasText: 'Incoming stock is not proven coverage' });
    for (const item of state.timingSkus) assert.match(await alerts.innerText(), new RegExp(item.name));
    await page.goto(`${base}/needs-you/all`);
    for (const item of state.timingSkus) assert.match(await page.locator('main').innerText(), new RegExp(`${item.name} needs an arrival decision`));
    await page.screenshot({ path: path.join(screenshots, 'incoming-timing-real-exceptions.png'), fullPage: true });
  });
  for (const [report,expected] of [
    ['profit and loss',[/2026-04-01 to 2026-06-30/,/\$100\.00 revenue/,/\$60\.00 cost of goods sold/,/\$40\.00 net profit/]],
    ['customer payments',[/2026-04-01 through 2026-06-30/,/paid \$120\.00 in 12 recorded payments/]],
    ['supplier spend',[/2026-04-01 through 2026-06-30/,/purchases from suppliers are \$91\.00/,/cash payments are \$55\.00/]],
  ]) await context.test(`Ask ${report} honors the calendar quarter and includes records beyond the display limit`,async () => {
    await page.goto(`${base}/ask`);
    await page.getByLabel('Tell StockChief what happened, or ask it something',{exact:true}).fill(`Show ${report} for last calendar quarter.`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send',exact:true}).click()]);
    const body = await page.locator('main').innerText();
    for (const pattern of expected) assert.match(body,pattern);
    if (report==='profit and loss') {
      assert.match(body,/Unrecorded costs, if any, are excluded/);
      assert.doesNotMatch(body,/the real net figure is lower/);
    }
    await page.screenshot({path:path.join(screenshots,`quarter-${report.replace(/ /g,'-')}.png`),fullPage:true});
  });
  await context.test('a preparation request keeps an order draft even when existing policy permits approval',async () => {
    await page.goto(`${base}/ask`);
    await page.getByLabel('Tell StockChief what happened, or ask it something',{exact:true}).fill('Order what we need. Prepare only.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Send',exact:true}).click()]);
    assert.match(await page.locator('main').innerText(),/did not approve orders, send messages or move stock/);
    await page.goto(`${base}/purchasing/orders`);
    const draft = page.locator('.rm-told__row').filter({hasText:'Practical Cases'});
    assert.equal(await draft.count(),1);
    assert.match(await draft.innerText(),/DRAFT/i);
    await draft.getByRole('link',{name:'Practical Cases',exact:true}).click();
    await page.getByRole('button',{name:'Approve order',exact:true}).waitFor();
    assert.match(await page.locator('main').innerText(),/Economical Replenishment/);
    await page.screenshot({path:path.join(screenshots,'prepare-only-existing-policy.png'),fullPage:true});
  });
  const allocationTotals = async (orderId) => {
    await page.goto(`${base}/orders/${orderId}/detail`);
    const held = page.locator('.stat').filter({hasText:'committed to this customer'});
    const waiting = page.locator('.stat').filter({hasText:'waiting for stock'});
    return {held:await held.count() ? Number(await held.locator('strong').innerText()) : 0,
      waiting:await waiting.count() ? Number(await waiting.locator('strong').innerText()) : 0};
  };
  const settings = async (orderId,priority,date) => {
    await page.goto(`${base}/orders/${orderId}`);
    const section = page.locator('#allocation-settings');
    await section.getByText('Change customer allocation',{exact:true}).click();
    await section.getByLabel('Allocation priority',{exact:true}).fill(String(priority));
    await section.getByLabel('Customer needed date',{exact:true}).fill(date);
    await Promise.all([page.waitForNavigation(),section.getByRole('button',{name:'Save allocation settings',exact:true}).click()]);
    assert.match(await page.locator('main').innerText(),/Allocation settings saved/);
  };
  await context.test('150 open orders reserve only 100 physical units, not the 50 incoming units',async () => {
    await page.goto(`${base}/orders`);
    const rows = page.locator('.rm-told__row').filter({has:page.locator('a.rm-u[href^="/orders/"]')}).filter({hasText:'Allocation Customer'});
    assert.equal(await rows.count(),150);
    let held = 0;
    let waiting = 0;
    for (const orderId of state.allocationOrders) {
      const totals = await allocationTotals(orderId);
      held += totals.held;waiting += totals.waiting;
    }
    assert.equal(held,100);assert.equal(waiting,50);
    assert.deepEqual(await allocationTotals(state.earlyOrderId),{held:1,waiting:0});
    await page.screenshot({path:path.join(screenshots,'allocation-150-orders-physical-only.png'),fullPage:true});
  });
  await context.test('a warehouse pick retains its reservation when another customer becomes urgent',async () => {
    await page.goto(`${base}/orders/${state.pickedOrderId}/detail`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:/Start picking 1 unit/}).click()]);
    assert.match(page.url(),/fulfilment/);
    await settings(state.pickedOrderId,200,'2026-09-25');
    await settings(state.waitingOrderId,0,'2026-10-01');
    assert.deepEqual(await allocationTotals(state.pickedOrderId),{held:1,waiting:0});
    assert.deepEqual(await allocationTotals(state.waitingOrderId),{held:1,waiting:0});
    assert.deepEqual(await allocationTotals(state.earlyOrderId),{held:1,waiting:0});
    await page.screenshot({path:path.join(screenshots,'allocation-active-pick-protected.png'),fullPage:true});
  });
  await context.test('repeated allocation settings create no duplicate activity',async () => {
    await page.goto(`${base}/orders/${state.waitingOrderId}/detail`);
    const activityBefore = await page.locator('.order-activity .fold-note').innerText();
    await settings(state.waitingOrderId,0,'2026-10-01');
    await page.goto(`${base}/orders/${state.waitingOrderId}/detail`);
    assert.equal(await page.locator('.order-activity .fold-note').innerText(),activityBefore);
  });
  await context.test('a real UI purchase receipt automatically fills the remaining customer shortages',async () => {
    await page.goto(`${base}/purchasing/orders/${state.allocationPurchaseId}/receive`);
    await page.locator(`input[name="qty_${state.allocationPurchaseLineId}"]`).fill('50');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Book it in',exact:true}).click()]);
    await page.goto(`${base}/orders`);
    const rows = page.locator('.rm-told__row').filter({has:page.locator('a.rm-u[href^="/orders/"]')}).filter({hasText:'Allocation Customer'});
    assert.equal(await rows.count(),150);
    assert.doesNotMatch(await rows.allTextContents().then((values) => values.join('\n')),/Waiting for stock|waiting for stock/);
    await page.screenshot({path:path.join(screenshots,'allocation-receipt-fills-shortages.png'),fullPage:true});
  });
  await context.test('the actual supplier invoice can differ from its PO without posting or paying a disputed bill',async () => {
    await page.goto(`${base}/accounting/payables/new?purchaseOrderId=${state.allocationPurchaseId}`);
    await page.getByLabel('Supplier invoice or receipt number (optional)',{exact:true}).fill('UI-VARIANCE-120');
    await page.getByLabel('Billed quantity — Allocation Acceptance Stock',{exact:true}).fill('60');
    await page.getByLabel('Billed unit cost — Allocation Acceptance Stock',{exact:true}).fill('2.00');
    await page.locator('select[name="paymentStatus"]').selectOption('paid');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record supplier bill',exact:true}).click()]);
    const body = await page.locator('main').innerText();
    assert.match(body,/saved for review/);
    assert.match(body,/not posted as a payable and no payment was recorded/);
    assert.match(body,/UI-VARIANCE-120/);
    assert.match(body,/does not agree with what was ordered or arrived/);
    assert.doesNotMatch(body,/Every bill is paid/);
    await page.goto(`${base}/needs-you/all`);
    assert.match(await page.locator('main').innerText(),/UI-VARIANCE-120|BILL-1001/);
    assert.deepEqual(await allocationTotals(state.earlyOrderId),{held:1,waiting:0});
    await page.screenshot({path:path.join(screenshots,'supplier-invoice-variance-safe.png'),fullPage:true});
  });
  await context.test('all 25 draft supplier decisions appear beyond the former five-order preview',async () => {
    await page.goto(`${base}/needs-you/all`);
    assert.equal(await page.locator('.rm-told__row').filter({hasText:'Queue Verification Supplier'}).count(),25);
    await page.screenshot({path:path.join(screenshots,'complete-purchase-exception-queue.png'),fullPage:true});
  });
  let reviewHref;
  await context.test('rechecking a mismatched invoice preserves evidence and does not approve edited fields',async () => {
    await page.goto(`${base}/accounting/payables`);
    const bill = page.locator('.bill-row').filter({hasText:'UI-VARIANCE-120'});
    reviewHref = await bill.getByRole('link',{name:'Resolve invoice',exact:true}).getAttribute('href');
    await bill.getByRole('link',{name:'Resolve invoice',exact:true}).click();
    await page.getByLabel('Corrected quantity — Allocation Acceptance Stock',{exact:true}).fill('50');
    await page.getByLabel('Corrected unit cost — Allocation Acceptance Stock',{exact:true}).fill('1.00');
    await page.getByLabel('Evidence and reason for this review',{exact:true}).fill('Reviewed the original invoice; the mismatch is not yet corrected.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Recheck existing invoice evidence',exact:true}).click()]);
    const body = await page.locator('main').innerText();
    assert.match(body,/still does not match; no payable or payment was posted/);
    assert.match(body,/60 × \$2\.00 → 60 × \$2\.00/);
    assert.equal(await page.getByLabel('Corrected quantity — Allocation Acceptance Stock',{exact:true}).inputValue(),'60');
  });
  await context.test('corrections cannot override matching rules or approve stale evidence',async () => {
    const stale = await browser.newPage();
    await stale.goto(`${base}/login`);
    await stale.getByLabel('Email',{exact:true}).fill(state.email);
    await stale.getByLabel('Password',{exact:true}).fill(state.password);
    await Promise.all([stale.waitForNavigation(),stale.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await stale.goto(`${base}${reviewHref}`);
    await page.getByLabel('Corrected quantity — Allocation Acceptance Stock',{exact:true}).fill('59');
    await page.getByLabel('Evidence and reason for this review',{exact:true}).fill('Supplier correction still bills nine units above the approved order.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save corrected invoice and approve if matched',exact:true}).click()]);
    assert.match(await page.locator('main').innerText(),/still does not match/);
    await stale.getByLabel('Corrected quantity — Allocation Acceptance Stock',{exact:true}).fill('50');
    await stale.getByLabel('Corrected unit cost — Allocation Acceptance Stock',{exact:true}).fill('1.00');
    await stale.getByLabel('Evidence and reason for this review',{exact:true}).fill('A stale browser must not approve a newer correction.');
    await Promise.all([stale.waitForNavigation(),stale.getByRole('button',{name:'Save corrected invoice and approve if matched',exact:true}).click()]);
    assert.match(await stale.locator('main').innerText(),/changed since you opened it/);
    assert.equal(await stale.getByLabel('Corrected quantity — Allocation Acceptance Stock',{exact:true}).inputValue(),'59');
    await stale.close();
  });
  await context.test('verified invoice correction posts one payable, preserves original history and clears its exception',async () => {
    await page.getByLabel('Corrected quantity — Allocation Acceptance Stock',{exact:true}).fill('50');
    await page.getByLabel('Corrected unit cost — Allocation Acceptance Stock',{exact:true}).fill('1.00');
    await page.getByLabel('Evidence and reason for this review',{exact:true}).fill('Corrected supplier invoice confirms fifty units at one dollar each.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save corrected invoice and approve if matched',exact:true}).click()]);
    const body = await page.locator('main').innerText();
    assert.match(body,/matched and approved once/);
    assert.match(body,/no payment was recorded and inventory did not change/);
    assert.match(body,/60 × \$2\.00 → 59 × \$2\.00/);
    assert.match(body,/59 × \$2\.00 → 50 × \$1\.00/);
    assert.equal(await page.getByRole('button',{name:'Save corrected invoice and approve if matched',exact:true}).count(),0);
    await page.getByRole('link',{name:'Open the posted accounting entry',exact:true}).click();
    assert.match(await page.locator('main').innerText(),/Supplier bill UI-VARIANCE-120/);
    const postedUrl = page.url();
    await page.goto(`${base}${reviewHref}`);
    await page.reload();
    await page.getByRole('link',{name:'Open the posted accounting entry',exact:true}).click();
    assert.equal(page.url(),postedUrl);
    await page.goto(`${base}/accounting/payables`);
    const bill = page.locator('.bill-row').filter({hasText:'UI-VARIANCE-120'});
    assert.match(await bill.innerText(),/\$50\.00/);
    assert.match(await bill.innerText(),/Record payment/);
    await page.goto(`${base}/needs-you/all`);
    assert.doesNotMatch(await page.locator('main').innerText(),/UI-VARIANCE-120/);
    assert.deepEqual(await allocationTotals(state.earlyOrderId),{held:1,waiting:0});
    await page.screenshot({path:path.join(screenshots,'supplier-invoice-resolution-complete.png'),fullPage:true});
  });
  await context.test('duplicate quantities remain disputed and dismissal preserves evidence without paying or crediting',async () => {
    await page.goto(`${base}/accounting/payables/new?purchaseOrderId=${state.allocationPurchaseId}`);
    await page.getByLabel('Supplier invoice or receipt number (optional)',{exact:true}).fill('UI-DUPLICATE-100');
    await page.getByLabel('Billed unit cost — Allocation Acceptance Stock',{exact:true}).fill('2.00');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record supplier bill',exact:true}).click()]);
    const duplicate = page.locator('.bill-row').filter({hasText:'UI-DUPLICATE-100'});
    await duplicate.getByRole('link',{name:'Resolve invoice',exact:true}).click();
    assert.match(await page.locator('main').innerText(),/bills 100 units against 50 ordered/);
    await page.getByLabel('Evidence and reason for this review',{exact:true}).fill('Confirmed duplicate supplier invoice. Retain the evidence but do not post debt.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Dismiss unposted invoice',exact:true}).click()]);
    assert.match(await page.locator('main').innerText(),/dismissed with its evidence and review history preserved/);
    assert.match(await page.locator('main').innerText(),/DISPUTED → VOID/);
    assert.equal(await page.getByRole('link',{name:'Open the posted accounting entry',exact:true}).count(),0);
    await page.goto(`${base}/accounting/payables`);
    assert.match(await page.locator('.bill-row').filter({hasText:'UI-VARIANCE-120'}).innerText(),/\$50\.00/);
    assert.match(await page.locator('main').innerText(),/\$50\.00 open/);
    await page.getByRole('heading',{name:'Settled · 1',exact:true}).click();
    assert.match(await page.locator('.bill-row').filter({hasText:'UI-DUPLICATE-100'}).innerText(),/void/);
    await page.screenshot({path:path.join(screenshots,'duplicate-invoice-dismissal-preserved.png'),fullPage:true});
  });
  await context.test('a failed exception source produces an incomplete-review warning instead of an all-clear',async () => {
    const changed = new Promise((resolve) => child.once('message',resolve));
    child.send({type:'projection-failure',enabled:true});
    await changed;
    await page.goto(`${base}/needs-you`);
    assert.match(await page.getByRole('alert').innerText(),/Operations review is incomplete/);
    await page.goto(`${base}/`);
    assert.match(await page.getByRole('heading',{level:1}).innerText(),/Operations review is incomplete/);
    await page.screenshot({path:path.join(screenshots,'incomplete-review-not-all-clear.png'),fullPage:true});
    const restored = new Promise((resolve) => child.once('message',resolve));
    child.send({type:'projection-failure',enabled:false});await restored;
  });
  assert.deepEqual(errors,[]);
});
