'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname,'../..');
const SHOTS = path.join(ROOT,'artifacts/screenshots/operational-safety');

function messageFrom(child, type) {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => finish(new Error(`Fixture did not send ${type}.`)),30000);
    const received = (message) => { if (message.type === type) finish(null,message); };
    const exited = (code) => finish(new Error(`Fixture exited ${code}.`));
    function finish(error,value) {
      clearTimeout(timer); child.off('message',received); child.off('exit',exited);
      error ? reject(error) : resolve(value);
    }
    child.on('message',received); child.once('exit',exited);
  });
}

async function mailboxStats(child) {
  const response = messageFrom(child,'stockchief.test.mail-stats');
  child.send({ type:'stockchief.test.mail-stats' });
  return (await response).stats;
}

async function submit(page, button) {
  await Promise.all([page.waitForNavigation(),button.click()]);
}

test('operational safety and mailbox pagination are verified through screens', { timeout:120000 }, async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-operational-ui-'));
  const databasePath = path.join(directory,'safety.db');
  const child = fork(path.join(ROOT,'tests/helpers/operational-safety-server.js'),[], {
    cwd:ROOT, env:{ ...process.env,NODE_ENV:'test',DATABASE_PATH:databasePath }, silent:true });
  child.stderr.on('data',(chunk) => process.stderr.write(`[safety fixture] ${chunk}`));
  let browser;
  let page;
  context.after(async () => {
    if (page) await page.screenshot({ path:path.join(SHOTS,'last-screen.png'),fullPage:true }).catch(() => {});
    if (browser) await browser.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((resolve) => child.once('exit',resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'),3000);
      await stopped; clearTimeout(timer);
    }
    fs.rmSync(directory,{ recursive:true,force:true,maxRetries:3,retryDelay:100 });
  });
  fs.mkdirSync(SHOTS,{ recursive:true });
  const state = await messageFrom(child,'stockchief.test.ready');
  const base = `http://127.0.0.1:${state.port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport:{ width:1400,height:1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  let explicitMessageUrl;
  page.on('pageerror',(error) => errors.push(error.message));
  await page.goto(`${base}/login`);
  await page.getByLabel('Email',{ exact:true }).fill(state.email);
  await page.getByLabel('Password',{ exact:true }).fill(state.password);
  await submit(page,page.getByRole('button',{ name:'Sign in',exact:true }));

  await context.test('paused timers neither replay a repair nor apply an already granted learning change',async () => {
    for (let check = 0; check < 4; check += 1) {
      await page.goto(`${base}/repairs/${state.repairCaseId}`);
      assert.match(await page.locator('main').innerText(),/EXECUTING/);
      await page.goto(`${base}/planning#learning`);
      const change = page.locator(`#learning-${state.learningProposalId}`);
      assert.match(await change.innerText(),/proposed/);
      await page.goto(`${base}/suppliers`);
      assert.match(await page.getByRole('row').filter({ hasText:'Measured Supplier' }).innerText(),/10 days/);
      await page.waitForTimeout(550);
    }
    await page.screenshot({ path:path.join(SHOTS,'paused-settings-unchanged.png'),fullPage:true });
  });

  await context.test('resume allows the existing authorized work to execute and independently verify',async () => {
    await page.goto(`${base}/`);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith('/autopilot/resume') && response.request().method() === 'POST'),
      page.locator('form[action="/autopilot/resume"] button[type="submit"]').click(),
    ]);
    await page.goto(`${base}/planning#learning`);
    for (let check = 0; check < 20; check += 1) {
      if (await page.locator(`#learning-${state.learningProposalId}`).getByText('rolled out',{ exact:true }).count()) break;
      await page.waitForTimeout(500);
      await page.reload();
    }
    assert.match(await page.locator(`#learning-${state.learningProposalId}`).innerText(),/rolled out/);
    await page.goto(`${base}/suppliers`);
    assert.match(await page.getByRole('row').filter({ hasText:'Measured Supplier' }).innerText(),/12 days/);
    await page.goto(`${base}/repairs/${state.repairCaseId}`);
    assert.match(await page.locator('main').innerText(),/RESOLVED/);
    await page.screenshot({ path:path.join(SHOTS,'resumed-repair-verified.png'),fullPage:true });
  });

  await context.test('authorization failures are visible and cannot masquerade as an operational mailbox',async () => {
    await page.goto(`${base}/settings/connections/${state.failedMailboxId}`);
    const body = await page.locator('main').innerText();
    assert.match(body,/Mailbox is not ready/);
    assert.match(body,/Not completed — no mailbox authorized/);
    assert.match(body,/Fixture authorization failure/);
    assert.doesNotMatch(body,/Your supplier inbox is ready|One more step: choose a supplier/);
    await page.getByRole('button',{ name:'Try mailbox authorization again' }).waitFor();
    await page.getByText('Mailbox settings',{ exact:true }).click();
    assert.equal(await page.getByRole('button',{ name:'Check Gmail now',exact:true }).isEnabled(),false);
  });

  await context.test('Ask preserves explicit subject, body and Gmail sender instead of substituting another mailbox',async () => {
    await page.goto(`${base}/ask`);
    await page.getByLabel('Tell StockChief what happened, or ask it something',{ exact:true }).fill(
      'Draft an email from the connected Gmail mailbox to recipient@fixture.test.\nSubject: Controlled UI verification\nBody: No operational action is requested.');
    await submit(page,page.getByRole('button',{ name:'Send',exact:true }));
    assert.match(page.url(),/\/messages\/ccom_/);
    explicitMessageUrl = page.url();
    assert.equal(await page.getByLabel('Subject',{ exact:true }).inputValue(),'Controlled UI verification');
    assert.equal(await page.locator('textarea[name="body"]').inputValue(),'No operational action is requested.');
    assert.equal(await page.getByLabel('To',{ exact:true }).inputValue(),'recipient@fixture.test');
    assert.equal(await page.locator('select[name="connectorId"]').inputValue(),state.mailboxes.gmail);
    assert.match(await page.locator('main').innerText(),/Written, not sent/);
    await page.screenshot({ path:path.join(SHOTS,'ask-explicit-message-requirements.png'),fullPage:true });
  });

  await context.test('pausing the chosen sender never silently substitutes the other connected mailbox',async () => {
    await page.goto(`${base}/settings/connections/${state.mailboxes.gmail}`);
    await page.getByText('Mailbox settings',{ exact:true }).click();
    await submit(page,page.getByRole('button',{ name:'Pause mailbox',exact:true }));
    await page.goto(explicitMessageUrl);
    assert.equal(await page.locator('select[name="connectorId"]').inputValue(),'');
    assert.match(await page.locator('main').innerText(),/originally chosen mailbox is unavailable/);
    await submit(page,page.getByRole('button',{ name:'Do not send',exact:true }));
    assert.match(await page.locator('main').innerText(),/Not sent/);
    await page.goto(`${base}/settings/connections/${state.mailboxes.gmail}`);
    await page.getByText('Mailbox settings',{ exact:true }).click();
    await submit(page,page.getByRole('button',{ name:'Resume mailbox',exact:true }));
  });

  await context.test('a stalled catalogue review shows its actual deadline and preserves the original description',async () => {
    const description = 'An unusual assortment whose exact products need model review.';
    await page.goto(`${base}/inventory/describe`);
    await page.getByLabel('Products to add',{ exact:true }).fill(description);
    await submit(page,page.getByRole('button',{ name:'Review products',exact:true }));
    await page.getByRole('alert').filter({ hasText:'could not finish reviewing those products within 30 seconds' }).waitFor();
    assert.equal(await page.getByLabel('Products to add',{ exact:true }).inputValue(),description);
    assert.match(await page.locator('main').innerText(),/Nothing was created/);
    await page.screenshot({ path:path.join(SHOTS,'catalogue-deadline-original-preserved.png'),fullPage:true });
  });

  for (const [providerType,connectorId] of Object.entries(state.mailboxes)) {
    const name = providerType === 'gmail' ? 'Gmail' : 'Microsoft';
    await context.test(`${name}: checking all provider pages preserves 75 messages and replay adds no duplicates`,async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.goto(`${base}/settings/connections/${connectorId}`);
        await page.getByText('Mailbox settings',{ exact:true }).click();
        await submit(page,page.getByRole('button',{ name:`Check ${name} now`,exact:true }));
        await page.goto(`${base}/mail?show=not-foundry`);
        const body = await page.locator('main').innerText();
        assert.doesNotMatch(body,/Not for StockChief|paginated message/,
          'unrelated mailbox traffic must never appear in the business mail UI');
        const evidence = new Database(databasePath,{ readonly:true });
        const stored = evidence.prepare('SELECT COUNT(*) AS n FROM connection_email_messages WHERE connector_id=?')
          .get(connectorId).n;
        evidence.close();
        assert.equal(stored,0,'unrelated mail is discarded rather than becoming retained business data');
        const stats = (await mailboxStats(child))[providerType];
        assert.equal(stats.listCalls,(attempt + 1) * 2,'the adapter traverses both provider pages on every check');
        assert.equal(stats.uniqueMessages,75,'all unique provider messages are examined before relevance filtering');
      }
      await page.goto(`${base}/settings/connections/${connectorId}`);
      await page.getByText('Mailbox settings',{ exact:true }).click();
      await submit(page,page.getByRole('button',{ name:'Pause mailbox',exact:true }));
      assert.match(await page.locator('main').innerText(),/Mailbox checks are paused/);
      await page.getByText('Mailbox settings',{ exact:true }).click();
      assert.equal(await page.getByRole('button',{ name:`Check ${name} now`,exact:true }).isEnabled(),false);
      await submit(page,page.getByRole('button',{ name:'Resume mailbox',exact:true }));
    });
  }
  await context.test('both mailboxes can refresh existing authorization and prove the same identity without reading the inbox',async () => {
    for (const connectorId of Object.values(state.mailboxes)) {
      await page.goto(`${base}/settings/connections/${connectorId}`);
      await page.getByText('Mailbox settings',{exact:true}).click();
      await page.getByText('Advanced diagnostics',{exact:true}).click();
      await submit(page,page.getByRole('button',{name:'Refresh mailbox authorization',exact:true}));
      assert.match(await page.locator('main').innerText(),/Mailbox authorization refreshed and verified/);
      assert.match(await page.locator('main').innerText(),/No inbox messages were read and nothing was sent/);
    }
    await page.goto(`${base}/mail?show=not-foundry`);
    assert.doesNotMatch(await page.locator('main').innerText(),/Not for StockChief|paginated message/);
    const evidence = new Database(databasePath,{ readonly:true });
    assert.equal(evidence.prepare('SELECT COUNT(*) AS n FROM connection_email_messages').get().n,0,
      'refreshing authorization reads no mail and unrelated provider traffic remains unretained');
    evidence.close();
    const stats = await mailboxStats(child);
    assert.deepEqual({ gmail:stats.gmail.listCalls,microsoft365:stats.microsoft365.listCalls },
      { gmail:4,microsoft365:4 },'authorization refresh performs no additional inbox page reads');
  });
  await context.test('a temporary refresh outage preserves consent and a retry works without reconnecting',async () => {
    let ack = messageFrom(child,'stockchief.test.fault-set');
    child.send({type:'stockchief.test.mail-fault',fault:'transient-refresh'});await ack;
    await page.goto(`${base}/settings/connections/${state.mailboxes.gmail}`);
    await page.getByText('Mailbox settings',{exact:true}).click();
    await page.getByText('Advanced diagnostics',{exact:true}).click();
    await submit(page,page.getByRole('button',{name:'Refresh mailbox authorization',exact:true}));
    assert.match(await page.locator('main').innerText(),/could not be refreshed and verified/);
    assert.doesNotMatch(await page.locator('main').innerText(),/Mailbox is not ready/);
    ack = messageFrom(child,'stockchief.test.fault-set');
    child.send({type:'stockchief.test.mail-fault',fault:null});await ack;
    await page.getByText('Mailbox settings',{exact:true}).click();
    await page.getByText('Advanced diagnostics',{exact:true}).click();
    await submit(page,page.getByRole('button',{name:'Refresh mailbox authorization',exact:true}));
    assert.match(await page.locator('main').innerText(),/Mailbox authorization refreshed and verified/);
  });
  await context.test('a repeated provider page is visibly incomplete, not reported as a successful check',async () => {
    const ack = messageFrom(child,'stockchief.test.fault-set');
    child.send({ type:'stockchief.test.mail-fault',fault:'repeat' });
    await ack;
    await page.goto(`${base}/settings/connections/${state.mailboxes.gmail}`);
    await page.getByText('Mailbox settings',{ exact:true }).click();
    await submit(page,page.getByRole('button',{ name:'Check Gmail now',exact:true }));
    assert.match(await page.locator('main').innerText(),/check remains incomplete/);
    assert.doesNotMatch(await page.locator('main').innerText(),/Mailbox checked/);
  });
  await context.test('a different identity after refresh quarantines the mailbox rather than reading or sending as another account',async () => {
    const ack = messageFrom(child,'stockchief.test.fault-set');
    child.send({type:'stockchief.test.mail-fault',fault:'identity-mismatch'});await ack;
    await page.goto(`${base}/settings/connections/${state.mailboxes.gmail}`);
    await page.getByText('Mailbox settings',{exact:true}).click();
    await page.getByText('Advanced diagnostics',{exact:true}).click();
    await submit(page,page.getByRole('button',{name:'Refresh mailbox authorization',exact:true}));
    assert.match(await page.locator('main').innerText(),/Mailbox is not ready/);
    assert.match(await page.locator('main').innerText(),/different mailbox identity/);
    await page.getByText('Mailbox settings',{exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Check Gmail now',exact:true}).isEnabled(),false);
    await page.getByText('Advanced diagnostics',{exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Refresh mailbox authorization',exact:true}).isEnabled(),false);
  });
  assert.deepEqual(errors,[]);
});
