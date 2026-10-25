'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{chromium}=require('playwright');
test('Round 6: bounded exports and pickers, clear shipping and return decisions',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const flows=require('../../src/operations/postgres-business-workflows'),returns=require('../../src/operations/postgres-returns');
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'round-six-fixture',shippingOptions:{verifyAccount:async()=>{throw Object.assign(new Error('secret provider response'),{status:401});}}});
 let firewallPosts=0;const server=await new Promise(r=>{const s=require('node:http').createServer((req,res)=>{if(req.url==='/_fixture/firewall'&&req.method==='POST'){firewallPosts++;res.writeHead(403,{'Content-Type':'text/html'});return res.end('<html><title>403 - Forbidden</title><body>web application firewall</body></html>');}return app(req,res);}).listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage(),origin='http://127.0.0.1:'+server.address().port,errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/login');await page.locator('[name=email]').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await t.test('shipping errors are friendly and retain provider without retaining the API key',async()=>{
  await page.goto(origin+'/settings/shipping');await page.locator('#existing-carrier-connection summary').click();await page.locator('[name=provider]').selectOption('shipstation');await page.locator('[name=apiKey]').fill('TEST_private-do-not-echo');
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify and connect',exact:true}).click()]);
  assert.equal(await page.locator('[name=provider]').inputValue(),'shipstation');assert.equal(await page.locator('[name=apiKey]').inputValue(),'');
  assert.match(await page.getByRole('alert').innerText(),/could not be verified/);assert.doesNotMatch(await page.locator('main').innerText(),/HTTP 401|secret provider|private-do-not-echo/);
 });
 await t.test('upstream firewall rejection shows StockChief help without changing or retrying the request',async()=>{
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
  await page.evaluate(()=>{const form=document.createElement('form');form.method='post';form.action='/_fixture/firewall';const input=document.createElement('input');input.name='name';input.value="Robert'); DROP TABLE items;--";form.append(input);document.body.append(form);form.submit();});
  await page.waitForURL('**/_fixture/firewall');assert.match(await page.locator('h1').innerText(),/couldn’t accept/);assert.equal(await page.getByRole('link',{name:'Report this problem in StockChief'}).getAttribute('href'),'/support');assert.equal(firewallPosts,1);await page.goto(origin+'/settings/shipping');
 });
 await t.test('maximum delivery days persist and remain visible after saving',async()=>{
  await page.locator('[name=maxDeliveryDays]').fill('4');await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save this rule',exact:true}).click()]);
  assert.match(await page.locator('main').innerText(),/Within 4 delivery days/);assert.equal(Number((await db.query('SELECT max_delivery_days FROM shipping_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].max_delivery_days),4);
 });
 await t.test('draft order has no misleading Short column and does not reserve stock',async()=>{
  const order=await flows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:'draft-round6',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1500}]});
  await page.goto(origin+'/orders/'+order.salesOrderId);assert.equal(await page.getByRole('columnheader',{name:'Short',exact:true}).count(),0);
  assert.equal(Number((await db.query('SELECT count(*) n FROM sales_order_allocations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 });
 await t.test('received return restocks in its receiving warehouse once, with original cost',async()=>{
  const order=await flows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'return-round6',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1500}]});
  await flows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'return-confirm'});await flows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'return-ship',lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:1}]});
  const r=await returns.requestCustomerReturn(db,ctx,{salesOrderId:order.salesOrderId,quarantineLocationId:f.location.id,resolution:'NO_REFUND',idempotencyKey:'return-request-r6',lines:[{salesOrderLineId:order.lineIds[0],quantity:1}]});
  await returns.authorizeCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:'return-authorize-r6'});let record=await returns.getCustomerReturn(db,ctx.workspaceId,r.customerReturnId);
  await returns.receiveCustomerReturn(db,ctx,record.id,{idempotencyKey:'return-receive-r6',lines:[{lineId:record.lines[0].id,quantity:1}]});
  await page.goto(origin+'/returns/'+record.id);assert.equal(await page.getByRole('button',{name:'Authorize this return',exact:true}).count(),0);assert.doesNotMatch(await page.locator('main').innerText(),/Authorize the goods expected back/);
  await page.locator('[name="restockLocation_'+record.lines[0].id+'"]').selectOption(f.location.id);
  const before=await f.balance(),value=await db.query('SELECT sum(total_cost_minor) n FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId]);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record inspection and disposition',exact:true}).click()]);
  assert.equal(await f.balance(),before);assert.equal(Number((await db.query('SELECT sum(total_cost_minor) n FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),Number(value.rows[0].n));
  record=await returns.getCustomerReturn(db,ctx.workspaceId,r.customerReturnId);assert.equal(record.status,'COMPLETED');assert.equal(Number(record.lines[0].quantity_restocked),1);
 });
 await t.test('72,000-product transfer picker stays bounded and searches the entire inventory',async()=>{
  const at=new Date().toISOString();await db.query(`INSERT INTO items(id,workspace_id,name,unit_label,tracking_mode,has_variants,allow_negative,is_active,created_at,updated_at) SELECT 'r6-item-'||n,$1,'Unfamiliar product '||n,'unit','quantity',0,0,1,$2,$2 FROM generate_series(1,72000)n`,[ctx.workspaceId,at]);
  await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_default,position,is_active,created_at) SELECT 'r6-sku-'||n,$1,'r6-item-'||n,'UNFAMILIAR-'||n,1,0,1,$2 FROM generate_series(1,72000)n`,[ctx.workspaceId,at]);
  await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Another warehouse',kind:'warehouse'});
  const response=await page.goto(origin+'/transfers/new');assert.equal(response.status(),200);assert.ok((await response.body()).length<150000);assert.ok(await page.locator('[name=skuId] option').count()<=50);
  await page.locator('#transfer-product-search').fill('UNFAMILIAR-71999');await page.waitForFunction(()=>document.querySelector('[name=skuId]').textContent.includes('UNFAMILIAR-71999'));assert.ok(await page.locator('[name=skuId] option').count()<=51);
 });
 await t.test('72,000-product export streams complete CSV files with bounded database fetches',async()=>{
  const {PassThrough}=require('node:stream'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
  const file=path.join(os.tmpdir(),'round6-export-'+Date.now()+'.zip'),out=new PassThrough();out.setHeader=()=>{};const target=fs.createWriteStream(file);out.pipe(target);let fetches=0,maxRows=0;
  const measured={transaction:(fn,options)=>db.transaction(client=>fn({query:async(sql,args)=>{const r=await client.query(sql,args);if(sql.startsWith('FETCH')){fetches++;maxRows=Math.max(maxRows,r.rows.length);}return r;}}),options)};
  const finish=new Promise((r,j)=>target.on('finish',r).on('error',j));await require('../../src/operations/postgres-export-stream').download(measured,ctx.workspaceId,out);await finish;
  try{const count=Number(cp.execFileSync('python',['-c','import zipfile,csv,io,sys; z=zipfile.ZipFile(sys.argv[1]); print(sum(1 for _ in csv.DictReader(io.TextIOWrapper(z.open("Inventory.csv"),encoding="utf-8-sig"))))',file],{encoding:'utf8',windowsHide:true}).trim());assert.equal(count,72001);assert.ok(fetches>140);assert.ok(maxRows<=500);}
  finally{fs.unlinkSync(file);}
 });
 await t.test('Settings exposes actual AI ceilings and enforces account isolation',async()=>{
  const budget=require('../../src/commercial/model-cost-budget'),before=await budget.status(db,ctx.workspaceId);assert.equal(before.accountCapMinor,2500);assert.equal(before.warning,false);
  await page.goto(origin+'/settings');assert.match(await page.locator('#ai-spending').innerText(),/AI spending protection/);assert.match(await page.getByRole('link',{name:'Export this inventory',exact:true}).innerText(),/this inventory/);
  assert.equal(await budget.status(db,'unrelated-workspace'),null);
 });
 await t.test('a cancelled export rolls back its snapshot and releases the database connection',async()=>{
  const {PassThrough}=require('node:stream'),out=new PassThrough();out.setHeader=()=>{};out.once('data',()=>out.destroy());let finished=false;
  const scoped={transaction:async(fn,options)=>{try{return await db.transaction(fn,options);}finally{finished=true;}}};
  const result=await require('../../src/operations/postgres-export-stream').download(scoped,ctx.workspaceId,out);assert.equal(result.cancelled,true);assert.equal(finished,true);assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok,1);
 });
 await t.test('registration creates a pending verified-email account while checkout remains closed',async()=>{
  const previous=process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='true';
  const context=await browser.newContext(),signup=await context.newPage();
  try{await signup.goto(origin+'/register');assert.equal(await signup.getByRole('button',{name:'Create account',exact:true}).isEnabled(),true);
   const email='signup-'+Date.now()+'@example.test';for(const [name,value]of Object.entries({businessName:'New independent business',name:'New owner',email,password:'Independent-account!2026',confirmPassword:'Independent-account!2026'}))await signup.locator('[name='+name+']').fill(value);
   await Promise.all([signup.waitForNavigation(),signup.getByRole('button',{name:'Create account',exact:true}).click()]);assert.match(signup.url(),/verify-email\/pending/);
   const row=(await db.query('SELECT id,plan FROM accounts WHERE email=$1',[email])).rows[0];assert.equal(row.plan,'commercial_pending');assert.equal(Number((await db.query('SELECT count(*) n FROM workspaces WHERE owner_account_id=$1',[row.id])).rows[0].n),0);assert.equal(require('../../src/config').commercial.checkoutEnabled,false);
  }finally{await context.close();if(previous===undefined)delete process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;else process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE=previous;}
 });
 await t.test('pricing availability and monthly billing have visible separation',async()=>{
  await page.goto(origin+'/pricing');const gap=await page.locator('.plan-price').first().evaluate(e=>parseFloat(getComputedStyle(e).columnGap));assert.ok(gap>=8);
 });
 assert.deepEqual(errors,[]);
});
