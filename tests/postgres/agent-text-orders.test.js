'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

// Job 83: customers order by text message (SMS) or WhatsApp. Pro drafts until
// taught; Custom takes the order alone within the owner's limits. Anything
// unknown or unclear stops and asks.
test('orders by text and WhatsApp follow each plan, stop on anything new and answer the customer once',{timeout:900000},async t=>{
  Object.assign(process.env,{TWILIO_ACCOUNT_SID:'ACfixture',TWILIO_AUTH_TOKEN:'fixture-token',TWILIO_FROM_NUMBER:'+15005550006',FOUNDRY_PUBLIC_URL:'https://stockchief.test'});
  t.after(()=>{for(const k of ['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER','FOUNDRY_PUBLIC_URL'])delete process.env[k];});
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:60});
  const {db,ctx,browser,subscribe,csrf,workflows}=f,sku=f.item.skuIds[0],ws=ctx.workspaceId;
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const textOrders=require('../../src/sales/agent-text-orders'),orders=require('../../src/sales/agent-customer-orders');
  const providers=require('../../src/notifications/alert-providers'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const sent=[];let failNext=null;
  const fake=async message=>{if(failNext){const e=failNext;failNext=null;throw e;}sent.push(message);return {reference:'SMfake'+sent.length};};
  const runtime=require('../../src/operations/postgres-runtime-handlers').create(undefined,{textSender:fake});
  const run=id=>runtime[textOrders.kind]({workspaceId:ws,payload:{id}},db);
  await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId:sku,amountMinor:750,currency:'USD'});
  const line=async channel=>(await db.query('SELECT * FROM stockchief_runtime.agent_text_order_lines WHERE workspace_id=$1 AND channel=$2',[ws,channel])).rows[0];
  const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_customer_text_orders WHERE workspace_id=$1 AND id=$2',[ws,id])).rows[0];
  const order=async id=>{const r=await row(id);if(!r?.sales_order_id)return null;
    return (await db.query(`SELECT o.id,o.order_number,o.status,o.notes,o.pricing_total_minor::int AS total,
      (SELECT json_agg(json_build_object('sku',l.sku_id,'qty',l.quantity_ordered::float,'price',l.unit_price_minor)) FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) AS lines,
      (SELECT coalesce(sum(a.quantity),0)::float FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) AS reserved FROM sales_orders o WHERE o.workspace_id=$1 AND o.id=$2`,[ws,r.sales_order_id])).rows[0];};
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  // The provider posts a signed message to the line's private link.
  async function deliver(channel,from,body,{reference='SM'+randomUUID().replace(/-/g,''),signature=null,to=null,media='0'}={}){
    const l=await line(channel),prefix=channel==='WHATSAPP'?'whatsapp:':'';
    const params={MessageSid:reference,From:prefix+from,To:prefix+(to||l.number),Body:body,NumMedia:media,AccountSid:'ACfixture'};
    const url='https://stockchief.test'+textOrders.publicPath+'/'+l.endpoint;
    const response=await browser.post(textOrders.publicPath+'/'+l.endpoint).set('x-twilio-signature',signature||providers.twilioSignature(url,params,'fixture-token')).type('form').send(params);
    const saved=(await db.query('SELECT id FROM stockchief_runtime.agent_customer_text_orders WHERE workspace_id=$1 AND provider_reference=$2',[ws,reference])).rows[0];
    return {response,id:saved?.id,reference};
  }
  const text=async(body,options={})=>{const d=await deliver(options.channel||'SMS',options.from||'+15185550100',body,options);assert.equal(d.response.status,200,d.response.text);return d.id;};
  const page=async(path=textOrders.path)=>(await browser.get(path).expect(200)).text;

  // Starter and Growth: the job is not included.
  await subscribe('growth');
  await browser.get(textOrders.path).expect(402);
  await assert.rejects(textOrders.saveLine(db,ctx,{channel:'SMS',number:'+15185559999',revision:0}),e=>e.code==='entitlement_required');

  // Pro: the owner gives the SMS channel the business's number.
  await subscribe('pro');
  let html=await page();
  assert.match(html,/Orders by text and WhatsApp/);assert.match(html,/Your numbers/);
  await browser.post(textOrders.path+'/lines').type('form').send({_csrf:csrf(html),channel:'SMS',number:'+1 (518) 555-9999',revision:0,enabled:'yes'}).expect(303);
  const sms=await line('SMS');assert.equal(sms.number,'+15185559999');
  html=await page();assert.match(html,new RegExp('https://stockchief.test'+textOrders.publicPath+'/'+sms.endpoint));
  // A second business cannot claim the same number.
  const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other business',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
  await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,'pro',(SELECT id FROM commercial_plan_versions WHERE plan_id='pro' AND status='ACTIVE'),'ACTIVE')`,[randomUUID(),other.accountId]);
  await assert.rejects(textOrders.saveLine(db,{workspaceId:other.workspaceId,actorId:other.userId},{channel:'SMS',number:'+15185559999',revision:0}),/already uses this number/);

  // The link refuses unsigned, misdirected and unknown messages.
  assert.equal((await deliver('SMS','+15185550100','1 x '+code,{signature:'bad'})).response.status,403);
  assert.equal((await deliver('SMS','+15185550100','1 x '+code,{to:'+15185558888'})).response.status,403);
  await browser.post(textOrders.publicPath+'/'+'x'.repeat(32)).type('form').send({Body:'hi'}).expect(404);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_customer_text_orders WHERE workspace_id=$1',[ws])).rows[0].n,0);

  // The first 14 days only watch and say what StockChief would have done.
  const w1=await text('Hi, please send 10 x '+code+'. Thanks, Rita',{reference:'SMwatch0000001'});
  assert.equal((await deliver('SMS','+15185550100','again',{reference:'SMwatch0000001'})).id,w1,'a repeated delivery keeps one message');
  let r=await run(w1);
  assert.equal(r.watched,true);assert.match(r.reason,/first 14 days/);assert.match(r.reason,/would have prepared Receiver’s order for \$75\.00/);
  assert.equal((await row(w1)).status,'WATCHED');assert.equal(await order(w1),null);assert.equal(sent.length,0,'a watched message gets no answer');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);

  // Pro untaught: a draft for approval, in Needs you, and one answer.
  await textOrders.retry(db,ctx,w1);
  let o=await order(w1);
  assert.deepEqual([o.status,o.total,o.reserved],['DRAFT',7500,0]);assert.match(o.notes,/Ordered by Text message from \+15185550100/);
  assert.match((await row(w1)).reason,/not taught StockChief this customer’s text orders/);
  assert((await needs()).some(n=>n.sourceId==='customer-order:83:'+w1&&/^Approve /.test(n.title)),'the draft waits in Needs you');
  const p1=await text('5 '+code);
  r=await run(p1);assert.equal(r.status,'DRAFT',JSON.stringify(r));
  assert.equal(sent.length,1);assert.deepEqual([sent[0].channel,sent[0].from,sent[0].to],['SMS','+15185559999','+15185550100']);
  assert.match(sent[0].body,/received your order/);
  assert.equal((await run(p1)).replayed,true);assert.equal(sent.length,1,'the customer is answered once');
  // A person confirms one: that completed example teaches this customer.
  await workflows.confirmSalesOrder(db,ctx,o.id,{idempotencyKey:randomUUID()});
  assert(!(await needs()).some(n=>n.sourceId==='customer-order:83:'+w1),'a confirmed order leaves Needs you');
  assert.equal(await textOrders.taught(db,ws,'fixture-customer'),true);

  // Taught, but routine work is off and no limits are saved: still a draft.
  const p2=await text('2 x '+code);
  r=await run(p2);assert.equal(r.status,'DRAFT');assert.match(r.reason,/ask you first|Save your limits/);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const p3=await text('2 x '+code);
  r=await run(p3);assert.match(r.reason,/Save your limits/);
  await orders.configure(db,ctx,{revision:0,maximum:'1000',maximumUnits:'20'});

  // Taught Pro creates and confirms within the limits, through the normal confirmation.
  const p4=await text('Can you send us 4 Parcel items?');
  r=await run(p4);assert.equal(r.status,'CONFIRMED',JSON.stringify(r));assert.equal(r.automatic,true);
  o=await order(p4);assert.deepEqual([o.status,o.reserved,o.total],['CONFIRMED',4,3000]);
  assert.match(sent.at(-1).body,new RegExp('Order '+o.order_number+' is confirmed: \\$30\\.00'));
  assert.equal((await run(p4)).replayed,true);
  assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Customer order from text created and confirmed by StockChief'",[ws])).rows[0].n,1);
  // Over a limit: prepared for approval.
  const p5=await text(code+' x 30');
  r=await run(p5);assert.equal(r.status,'DRAFT');assert.match(r.reason,/30 units, over your limit of 20 units/);

  // Anything new or unclear stops before any order exists.
  const held=async(body,pattern,options)=>{const id=await text(body,options);const result=await run(id);assert.equal(result.held,true,JSON.stringify(result));
    assert.match(result.reason,pattern);assert.equal(await order(id),null);assert.equal((await row(id)).status,'HELD');return id;};
  const price=await held('2 x '+code+' @ $6.99',/customer wrote \$6\.99; your price is \$7\.50/);
  await held('3 x NOPE-1',/does not know the product “NOPE-1”/);
  await held('2 boxes of '+code,/cannot tell how many units/);
  await held('1 x '+code+'\nShip to: 99 New Rd, Troy, NY 12180',/New delivery address: 99 New Rd, Troy, NY 12180/);
  await held('12 x 345',/more than one way/);
  await held('1 x '+code,/sent a picture or file/,{media:'1'});
  const before=sent.length;
  await held('1 x '+code,/does not know the number \+14155550123/,{from:'+14155550123'});
  assert.equal(sent.length,before,'an unknown number gets no answer');
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('twin',$1,'Twin','twin@example.test','+1 518 555 0100','1 Twin Rd, Albany, NY 12207','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  await held('1 x '+code,/on more than one customer: Receiver and Twin/);
  await db.query("UPDATE customers SET phone=NULL WHERE id='twin'");
  // The person reviews the original and prepares the draft at the business's price.
  html=await page(textOrders.path+'/'+price);
  assert.match(html,/data-text-order-problems/);assert.match(html,/\$6\.99/);
  await browser.post(textOrders.path+'/'+price+'/prepare').type('form').send({_csrf:csrf(html),digest:/name="digest" value="([^"]+)"/.exec(html)[1]}).expect(303);
  o=await order(price);assert.deepEqual([o.status,o.lines[0].price],['DRAFT',750]);
  // A dismissed message stays without an order.
  const junk=await held('see you tomorrow',/could not read/);
  html=await page(textOrders.path+'/'+junk);
  await browser.post(textOrders.path+'/'+junk+'/dismiss').type('form').send({_csrf:csrf(html)}).expect(303);
  assert.equal((await row(junk)).status,'STOPPED');assert(!(await needs()).some(n=>n.sourceId==='customer-order:83:'+junk));

  // A new customer's first order goes to a person even when taught by a rule.
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('newco',$1,'Newco','buyer@newco.test','(212) 555-0142','5 Mill St, Hudson, NY 12534','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  html=await page();
  await browser.post(textOrders.path+'/rules').type('form').send({_csrf:csrf(html),customerId:'newco',enabled:'yes'}).expect(303);
  const n1=await text('1 x '+code,{from:'+12125550142'});
  r=await run(n1);assert.equal(r.status,'DRAFT');assert.match(r.reason,/first order from this customer/);

  // Ask me first, Watch only and pause hold the routine work.
  await modes.save(db,ctx,83,{mode:'ask',revision:0});
  r=await run(await text('1 x '+code));assert.equal(r.status,'DRAFT');assert.match(r.reason,/Ask me first/);
  await modes.save(db,ctx,83,{mode:'inherit',revision:1});
  await autopilot.pause(db,ctx,{role:'owner',permissions:null},'Stocktake');
  r=await run(await text('1 x '+code));assert.equal(r.watched,true);assert.match(r.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner',permissions:null});

  // Undo cancels an order StockChief confirmed on its own.
  html=await page();assert.match(html,/data-text-orders-recent/);
  await browser.post(textOrders.path+'/'+p4+'/undo').type('form').send({_csrf:csrf(html)}).expect(303);
  assert.equal((await order(p4)).status,'CANCELLED');assert.equal((await row(p4)).status,'UNDONE');
  assert.equal((await orders.undo(db,ctx,'text',p4)).replayed,true);

  // WhatsApp runs behind the same provider interface, from the WhatsApp number.
  html=await page();
  await browser.post(textOrders.path+'/lines').type('form').send({_csrf:csrf(html),channel:'WHATSAPP',number:'+15185557777',revision:0,enabled:'yes'}).expect(303);
  const wa=await text('3 x '+code,{channel:'WHATSAPP'});
  assert.equal((await row(wa)).channel,'WHATSAPP');
  r=await run(wa);assert.equal(r.status,'CONFIRMED',JSON.stringify(r));
  assert.deepEqual([sent.at(-1).channel,sent.at(-1).from,sent.at(-1).to],['WHATSAPP','+15185557777','+15185550100']);
  // The live sender never runs in tests; an uncertain answer is never sent again.
  await assert.rejects(providers.sendMessage({to:'whatsapp:+15185550100',from:'whatsapp:+15185557777',body:'x'}),/off in tests/);
  failNext=Object.assign(new Error('timeout'),{providerOutcomeUncertain:true});
  const u1=await text('1 x '+code,{channel:'WHATSAPP'});
  await run(u1);assert.equal((await row(u1)).reply_status,'UNCERTAIN');
  const count=sent.length;await run(u1);assert.equal(sent.length,count);

  // Custom takes orders alone without training, within the same limits.
  await subscribe('enterprise');
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('regular',$1,'Regular','regular@example.test','+44 20 7946 0958','2 Quay St, Hudson, NY 12534','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  const prior=await workflows.createSalesOrder(db,ctx,{customerId:'regular',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,shipToAddress:'2 Quay St, Hudson, NY 12534',idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:750}]});
  await workflows.confirmSalesOrder(db,ctx,prior.salesOrderId,{idempotencyKey:randomUUID()});
  const c1=await text('2 x '+code,{from:'+442079460958'});
  r=await run(c1);assert.equal(r.status,'CONFIRMED',JSON.stringify(r));
  // "Always ask me" for a customer holds even on Custom.
  html=await page();
  await browser.post(textOrders.path+'/rules').type('form').send({_csrf:csrf(html),customerId:'regular',enabled:'no'}).expect(303);
  r=await run(await text('1 x '+code,{from:'+442079460958'}));assert.equal(r.status,'DRAFT');assert.match(r.reason,/wait for you on every text order/);

  // The page, its review and Needs you stay readable; Ask reads it through job 83's review.
  html=await page();
  for(const marker of ['data-text-orders-waiting','data-text-order-numbers','data-text-order-customers'])assert.match(html,new RegExp(marker));
  assert.match(html,/Taken on its own: you confirmed one of their text orders/);assert.match(html,/Always asks you first/);
  const review=await require('../../src/autopilot/job-reviews').definitions.find(d=>d.key==='customer-order-pages').readPage(db,ctx,{});
  assert(review.rows.some(x=>x.Reference==='WhatsApp'));
  assert((await needs()).some(n=>n.href===textOrders.path+'/'+price||n.sourceId==='customer-order:83:'+price));

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();listener.closeAllConnections();await new Promise(done=>listener.close(done));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+listener.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const path of [textOrders.path,textOrders.path+'/'+price]){
      await tab.goto(base+path);
      assert(await tab.getByRole('heading',{name:'Orders by text and WhatsApp'}).first().isVisible());
      assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' '+path+' must not scroll sideways');
    }
    await tab.screenshot({path:require('node:path').join(folder,'text-orders-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
