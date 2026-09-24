'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname,'../..');
const SHOTS = path.join(ROOT,'artifacts/screenshots/seasoned-business');

function messageFrom(child,type,timeoutMs=90000) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error(`No ${type} message from the business fixture.`)),timeoutMs);
    const received=(message)=>{if(message.type===type)finish(null,message);};
    const exited=(code)=>finish(new Error(`Business fixture exited with code ${code}.`));
    function finish(error,value){clearTimeout(timer);child.off('message',received);child.off('exit',exited);error?reject(error):resolve(value);}
    child.on('message',received);child.once('exit',exited);
  });
}

async function advance(child,at) {
  const ack=messageFrom(child,'stockchief.test.advanced');
  child.send({type:'stockchief.test.advance',at});
  await ack;
}

async function submit(page,button) {
  await Promise.all([page.waitForNavigation(),button.click()]);
}

async function eventually(page,predicate,timeoutMs=30000) {
  const deadline=Date.now()+timeoutMs;
  do {
    await page.reload();
    if(await predicate())return;
    await page.waitForTimeout(700);
  } while(Date.now()<deadline);
  throw new Error(`UI did not reach the expected state:\n${await page.locator('main').innerText()}`);
}

test('a six-month business is managed through real screens as the calendar moves', {timeout:240000},async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-calendar-ui-'));
  const child=fork(path.join(ROOT,'tests/helpers/seasoned-business-server.js'),[],{
    cwd:ROOT,env:{...process.env,NODE_ENV:'test',PORT:'0',DATABASE_PATH:path.join(directory,'business.db')},
    execArgv:['-r',path.join(ROOT,'tests/helpers/test-models.js')],silent:true,
  });
  child.stderr.on('data',(chunk)=>process.stderr.write(`[calendar fixture] ${chunk}`));
  let browser;
  let page;
  t.after(async()=>{
    if(page)await page.screenshot({path:path.join(SHOTS,'last-screen.png'),fullPage:true}).catch(()=>{});
    if(browser)await browser.close();
    if(child.exitCode===null&&child.signalCode===null){
      const closed=new Promise((resolve)=>child.once('exit',resolve));
      child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
      await closed;clearTimeout(timer);
    }
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  fs.mkdirSync(SHOTS,{recursive:true});
  const state=await messageFrom(child,'stockchief.test.ready');
  const base=`http://127.0.0.1:${state.port}`;
  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:1400,height:1000}});
  page=await context.newPage();
  page.setDefaultTimeout(15000);
  const errors=[];
  page.on('pageerror',(error)=>errors.push(error.message));
  await page.goto(`${base}/login`);
  await page.getByLabel('Email',{exact:true}).fill(state.email);
  await page.getByLabel('Password',{exact:true}).fill(state.password);
  await submit(page,page.getByRole('button',{name:'Sign in',exact:true}));

  let orderUrl;
  let orderedBestseller;
  await t.test('Friday: StockChief autonomously prepares one supplier draft, not just a work record',async()=>{
    await page.goto(`${base}/purchasing/orders`);
    await eventually(page,async()=>await page.locator('a.rm-u[href^="/purchasing/orders/po_"]').count()>0);
    const links=page.locator('a.rm-u[href^="/purchasing/orders/po_"]');
    assert.equal(await links.count(),1,'Requirements for two products share one supplier order.');
    await links.click();
    orderUrl=page.url();
    const body=await page.locator('main').innerText();
    assert.match(body,/Weekend Bestseller/);
    assert.match(body,/Weekday Staple/);
    assert.doesNotMatch(body,/Slow Shelf Item|Unobserved New Product/);
    const row=page.getByRole('row').filter({hasText:'Weekend Bestseller'});
    orderedBestseller=Number(await row.getByRole('cell').nth(1).innerText());
    assert.ok(orderedBestseller>0);
    assert.equal(orderedBestseller%12,0,'Cases of six, ordered in multiples of two, were preserved.');
    await page.getByRole('button',{name:'Approve order',exact:true}).waitFor();
    assert.doesNotMatch(body,/carried out automatically/);
    await page.screenshot({path:path.join(SHOTS,'friday-consolidated-draft.png'),fullPage:true});
  });

  await t.test('Measured history supports the forecast; new stock is not invented demand',async()=>{
    await page.goto(`${base}/inventory/${state.fastItemId}`);
    const body=await page.locator('main').innerText();
    assert.match(body,/Selling about/);
    assert.match(body,/StockChief.s read on where this is heading/);
    await page.getByText('See how I worked this out',{exact:true}).click();
    assert.match(await page.locator('main').innerText(),/Day-of-week pattern|day.of.week|weekday/i);
    await page.screenshot({path:path.join(SHOTS,'weekday-evidence.png'),fullPage:true});
    await page.goto(`${base}/`);
    assert.match(await page.locator('main').innerText(),/2 products have insufficient outbound history/);
    await page.screenshot({path:path.join(SHOTS,'measured-history-and-gaps.png'),fullPage:true});
  });

  await t.test('Ask keeps the product and calendar quarter when calculating posted gross margin',async()=>{
    await page.goto(`${base}/ask`);
    await page.locator('#ask-question').fill('What was the gross margin on Weekend Bestseller last quarter?');
    await submit(page,page.locator('[data-ask-form] button[type="submit"]'));
    const answer = await page.locator('main').innerText();
    assert.match(answer,/2026-04-01 through 2026-06-30/);
    assert.match(answer,/posted revenue is \$100\.00/);
    assert.match(answer,/posted product cost is \$60\.00/);
    assert.match(answer,/Recorded gross margin is 40\.00%/);
    assert.doesNotMatch(answer,/98\.89%|10\.00%/);
    await page.screenshot({path:path.join(SHOTS,'grounded-calendar-quarter-margin.png'),fullPage:true});
  });

  await t.test('A scheduled count becomes a visible exception only when its date arrives',async()=>{
    await page.goto(`${base}/warehouse/operations`);
    await page.getByText('Schedule a recurring count',{exact:true}).click();
    const form=page.locator('form[action="/warehouse/count-plans"]');
    await form.getByLabel('Name',{exact:true}).fill('Monday Bestseller Count');
    await form.getByLabel('First due').fill('2026-09-14');
    await form.locator('select[name="locationId"]').selectOption(state.locationId);
    await form.locator('select[name="skuId"]').selectOption(state.fastSkuId);
    await submit(page,form.getByRole('button',{name:'Save count plan'}));
    await page.goto(`${base}/needs-you/all`);
    assert.doesNotMatch(await page.locator('main').innerText(),/Monday Bestseller Count is due/);
    await advance(child,'2026-09-12T12:00:00.000Z');
    await page.reload();
    assert.doesNotMatch(await page.locator('main').innerText(),/Monday Bestseller Count is due/);
    await advance(child,'2026-09-14T12:00:00.000Z');
    await eventually(page,async()=>/Monday Bestseller Count is due for a physical count/.test(await page.locator('main').innerText()));
    await page.screenshot({path:path.join(SHOTS,'monday-due-count.png'),fullPage:true});
  });

  await t.test('UI count evidence completes the scheduled job without changing matching stock',async()=>{
    await page.goto(`${base}/warehouse/operations`);
    await submit(page,page.locator('form[action$="/start"]').getByRole('button',{name:'Start now'}));
    const countUrl=page.url();
    const input=page.getByLabel('Counted quantity for Weekend Bestseller at Main Warehouse');
    await input.fill('8');
    await submit(page,page.getByRole('button',{name:'Record',exact:true}));
    await submit(page,page.getByRole('button',{name:'Submit this count',exact:true}));
    assert.match(await page.locator('main').innerText(),/COMPLETED|Count matched the records/);
    await page.goto(`${base}/needs-you/all`);
    assert.doesNotMatch(await page.locator('main').innerText(),/Monday Bestseller Count is due|Monday Bestseller Count.*needs physical quantities/);
    await page.goto(countUrl);
    await page.screenshot({path:path.join(SHOTS,'verified-count.png'),fullPage:true});
  });

  await t.test('Calendar ticks and page refreshes do not duplicate supplier orders',async()=>{
    await advance(child,'2026-09-15T12:00:00.000Z');
    await page.goto(`${base}/purchasing/orders`);
    await eventually(page,async()=>await page.locator('a.rm-u[href^="/purchasing/orders/po_"]').count()===1);
    assert.equal(await page.locator('a.rm-u[href^="/purchasing/orders/po_"]').getAttribute('href'),new URL(orderUrl).pathname);
    assert.deepEqual(errors,[]);
  });

  await t.test('Ask reads actual current quantities without using a model to invent figures',async()=>{
    await page.goto(`${base}/ask`);
    await page.locator('#ask-question').fill('How many Weekend Bestseller do we have?');
    await submit(page,page.getByRole('button',{name:'Send',exact:true}));
    await page.getByText('Weekend Bestseller: 8 units on hand.',{exact:true}).waitFor();
    await page.screenshot({path:path.join(SHOTS,'ask-grounded-stock.png'),fullPage:true});
  });

  await t.test('Approving commits an order but does not prematurely receive stock',async()=>{
    await page.goto(orderUrl);
    await submit(page,page.getByRole('button',{name:'Approve order',exact:true}));
    assert.match(await page.locator('main').innerText(),/Ordered/);
    await page.goto(`${base}/inventory/${state.fastItemId}`);
    assert.equal(await page.locator('.rm-stat__n').first().innerText(),'8');
    await page.screenshot({path:path.join(SHOTS,'ordered-not-received.png'),fullPage:true});
  });

  await t.test('A real receipt updates visible stock, verifies the delivery and resolves the need',async()=>{
    await advance(child,'2026-09-23T12:00:00.000Z');
    await page.goto(orderUrl);
    await submit(page,page.getByRole('button',{name:'It all arrived — book it in',exact:true}));
    assert.match(await page.locator('main').innerText(),/Received/);
    await page.goto(`${base}/inventory/${state.fastItemId}`);
    assert.equal(Number((await page.locator('.rm-stat__n').first().innerText()).replace(/,/g,'')),8+orderedBestseller);
    await page.screenshot({path:path.join(SHOTS,'received-real-stock.png'),fullPage:true});
    await page.goto(`${base}/purchasing/orders`);
    assert.equal(await page.locator('a.rm-u[href^="/purchasing/orders/po_"]').count(),1);
    assert.match(await page.locator('main').innerText(),/all of it arrived/);
    assert.deepEqual(errors,[]);
  });

  await t.test('Backdated daily sales are entered through the UI and trigger replenishment of the consumed product',async()=>{
    for(let day=16;day<=22;day+=1) {
      await page.goto(`${base}/inventory/${state.fastItemId}`);
      await page.getByRole('button',{name:'Sold or used',exact:true}).click();
      const form=page.locator('#modal-issue form');
      await form.locator('#issue-location').selectOption(state.locationId);
      await form.locator('#issue-quantity').fill('20');
      await form.locator('#issue-reason').selectOption('sold');
      await form.locator('#issue-occurred').fill(`2026-09-${day}`);
      await submit(page,form.locator('button[type="submit"]'));
    }
    assert.equal(Number((await page.locator('.rm-stat__n').first().innerText()).replace(/,/g,'')),8+orderedBestseller-140);
    await advance(child,'2026-09-24T12:00:00.000Z');
    await page.goto(`${base}/purchasing/orders`);
    await eventually(page,async()=>await page.locator('a.rm-u[href^="/purchasing/orders/po_"]').count()===2);
    const second=page.locator(`a.rm-u[href^="/purchasing/orders/po_"]:not([href="${new URL(orderUrl).pathname}"])`);
    await second.click();
    const body=await page.locator('main').innerText();
    assert.match(body,/Weekend Bestseller/);
    assert.doesNotMatch(body,/Slow Shelf Item|Unobserved New Product|Weekday Staple/);
    const quantity=Number(await page.getByRole('row').filter({hasText:'Weekend Bestseller'}).getByRole('cell').nth(1).innerText());
    assert.ok(quantity>0);
    assert.equal(quantity%12,0);
    await page.screenshot({path:path.join(SHOTS,'sales-driven-next-order.png'),fullPage:true});
  });

  await t.test('Month rollover preserves outstanding supply and exposes the next physical count',async()=>{
    await advance(child,'2026-10-01T12:00:00.000Z');
    await page.goto(`${base}/purchasing/orders`);
    await eventually(page,async()=>await page.locator('a.rm-u[href^="/purchasing/orders/po_"]').count()===2);
    await page.goto(`${base}/needs-you/all`);
    assert.match(await page.locator('main').innerText(),/Monday Bestseller Count is due for a physical count/);
    await page.screenshot({path:path.join(SHOTS,'october-exceptions.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  });

  await t.test('A disputed physical count stays visible through recount and changes stock only after approval',async()=>{
    const quantity=8+orderedBestseller-141;
    await page.goto(`${base}/warehouse/operations`);
    const form=page.locator('form[action="/warehouse/counts"]');
    await form.locator('input[name="name"]').fill('October Investigation');
    await form.locator('select[name="locationId"]').selectOption(state.locationId);
    await form.locator('select[name="skuId"]').selectOption(state.fastSkuId);
    await submit(page,form.getByRole('button',{name:'Start count',exact:true}));
    let countUrl=page.url();
    await page.getByLabel('Counted quantity for Weekend Bestseller at Main Warehouse').fill(String(quantity));
    await submit(page,page.getByRole('button',{name:'Record',exact:true}));
    await submit(page,page.getByRole('button',{name:'Submit this count',exact:true}));
    await page.goto(`${base}/needs-you/all`);
    assert.match(await page.locator('main').innerText(),/October Investigation needs a blind recount/);
    await page.goto(countUrl);
    await submit(page,page.getByRole('button',{name:'Start blind recount',exact:true}));
    countUrl=page.url();
    await page.goto(`${base}/needs-you/all`);
    const body=await page.locator('main').innerText();
    assert.match(body,/October Investigation needs physical quantities/);
    assert.doesNotMatch(body,/October Investigation needs a blind recount/);
    await page.goto(countUrl);
    await page.getByLabel('Counted quantity for Weekend Bestseller at Main Warehouse').fill(String(quantity));
    await submit(page,page.getByRole('button',{name:'Record',exact:true}));
    await submit(page,page.getByRole('button',{name:'Submit this count',exact:true}));
    await page.goto(`${base}/inventory/${state.fastItemId}`);
    assert.equal(Number(await page.locator('.rm-stat__n').first().innerText()),quantity+1);
    await page.goto(countUrl);
    await submit(page,page.getByRole('button',{name:'Approve and post variance',exact:true}));
    assert.match(await page.locator('main').innerText(),/Variance approved, posted through the inventory engine, and verified/);
    await page.goto(`${base}/inventory/${state.fastItemId}`);
    assert.equal(Number(await page.locator('.rm-stat__n').first().innerText()),quantity);
    await page.screenshot({path:path.join(SHOTS,'october-approved-count.png'),fullPage:true});
    assert.deepEqual(errors,[]);
  });
});

test('a stalled instruction reader fails visibly without guessing stock or losing the request',{timeout:120000},async(t)=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-reader-ui-'));
  const child=fork(path.join(ROOT,'tests/helpers/seasoned-business-server.js'),[],{
    cwd:ROOT,env:{...process.env,NODE_ENV:'test',PORT:'0',DATABASE_PATH:path.join(directory,'business.db'),
      STOCKCHIEF_TEST_STALLED_READER:'1',FOUNDRY_AI_READ_TIMEOUT_MS:'150'},
    execArgv:['-r',path.join(ROOT,'tests/helpers/test-models.js')],silent:true,
  });
  child.stderr.on('data',(chunk)=>process.stderr.write(`[reader fixture] ${chunk}`));
  let browser;
  t.after(async()=>{
    if(browser)await browser.close();
    if(child.exitCode===null&&child.signalCode===null){
      const closed=new Promise((resolve)=>child.once('exit',resolve));child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await closed;clearTimeout(timer);
    }
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  const state=await messageFrom(child,'stockchief.test.ready');
  const base=`http://127.0.0.1:${state.port}`;
  browser=await chromium.launch();
  const page=await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${base}/login`);
  await page.getByLabel('Email',{exact:true}).fill(state.email);
  await page.getByLabel('Password',{exact:true}).fill(state.password);
  await submit(page,page.getByRole('button',{name:'Sign in',exact:true}));
  await page.goto(`${base}/actions`);
  const instruction='Receive some Weekend Bestseller stock into Main Warehouse';
  await page.locator('#action-instruction').fill(instruction);
  await submit(page,page.getByRole('button',{name:'Continue',exact:true}));
  assert.match(await page.locator('main').innerText(),/nothing changed|no figures were guessed/i);
  assert.equal(await page.locator('#ask-question').inputValue(),instruction);
  await page.screenshot({path:path.join(SHOTS,'stalled-reader-no-guessed-action.png'),fullPage:true});
  await page.goto(`${base}/inventory/${state.fastItemId}`);
  assert.equal(await page.locator('.rm-stat__n').first().innerText(),'8');
});
