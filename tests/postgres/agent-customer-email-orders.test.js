'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

// Job 52: a customer email, or its PDF or spreadsheet, becomes a sales order.
test('customer emails, PDFs and spreadsheets become orders under each plan and stop on anything new',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:60});
  const {db,ctx,browser,subscribe,csrf,workflows}=f,sku=f.item.skuIds[0],ws=ctx.workspaceId;
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const connection=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES('order-desk',$1,'order-desk','Order desk','gmail','[]','{}','connected','[]',now()::text,now()::text) RETURNING *`,[ws])).rows[0];
  const mail=require('../../src/connections/postgres-mail'),runtime=require('../../src/operations/postgres-runtime-handlers').create();
  const orders=require('../../src/sales/agent-customer-orders'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const capture=async(bodyText,extra={})=>(await mail.capture(db,connection,{externalMessageId:randomUUID(),sender:'receiver@example.test',subject:'Purchase order',bodyText,...extra})).messageId;
  const run=(id,kind='mail.customer-order')=>runtime[kind]({workspaceId:ws,payload:{messageId:id}},db);
  const work=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_customer_email_orders WHERE workspace_id=$1 AND message_id=$2',[ws,id])).rows[0];
  const order=async id=>(await db.query(`SELECT o.id,o.order_number,o.status,o.reference,o.ship_to_address,o.pricing_total_minor::int AS total,
      (SELECT json_agg(json_build_object('sku',l.sku_id,'qty',l.quantity_ordered::float,'price',l.unit_price_minor) ORDER BY l.created_at,l.id)
        FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) AS lines,
      (SELECT coalesce(sum(a.quantity),0)::float FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) AS reserved
    FROM sales_orders o WHERE o.workspace_id=$1 AND o.source_email_message_id=$2`,[ws,id])).rows;
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId:sku,amountMinor:750,currency:'USD'});

  // Starter: the job is not included. Nothing is read or created.
  await subscribe('starter');
  const s1=await capture('PO #S-1\n'+code+' qty 1');
  assert.equal((await run(s1)).skipped,true);
  assert.deepEqual(await order(s1),[]);assert.equal(await work(s1),undefined);
  assert.match((await browser.get(orders.path).expect(200)).text,/data-agent-plan-locked/);
  await browser.get('/mail/'+s1+'/order').expect(402);

  // Pro during the first 14 days only watches and says what it would have done.
  await subscribe('pro');
  const w1=await capture('PO #W-1\n'+code+' qty 2');
  let r=await run(w1);
  assert.match(r.reason,/first 14 days/);assert.match(r.reason,/would have prepared Receiver’s order for \$15\.00/);
  assert.deepEqual(await order(w1),[]);assert.equal((await work(w1)).status,'WATCHED');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);

  // Growth prepares the draft; a person approves it through the ordinary order.
  await subscribe('growth');
  r=await run(w1);
  assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/for your approval/);
  let [o]=await order(w1);
  assert.deepEqual([o.status,o.reference,o.total,o.reserved],['DRAFT','W-1',1500,0]);
  assert.equal((await work(w1)).status,'DRAFTED');
  assert((await needs()).some(n=>n.sourceId==='customer-order:52:'+w1&&/^Approve /.test(n.title)),'the draft waits in Needs you');
  assert.equal((await run(w1)).replayed,true);assert.equal((await order(w1)).length,1);
  await workflows.confirmSalesOrder(db,ctx,o.id,{idempotencyKey:randomUUID()});
  assert(!(await needs()).some(n=>n.sourceId==='customer-order:52:'+w1),'an approved order leaves Needs you');

  // A different price stops; the person decides on the review form.
  const g2=await capture('PO #G-2\n'+code+' qty 2 @ $6.99');
  r=await run(g2);
  assert.match(r.reason,/customer wrote \$6\.99; your price is \$7\.50/);
  assert.deepEqual(await order(g2),[]);assert.equal((await work(g2)).status,'HELD');
  assert((await needs()).some(n=>n.sourceId==='customer-order:52:'+g2&&n.href==='/mail/'+g2+'/order'));
  const form=await browser.get('/mail/'+g2+'/order').expect(200);
  assert.match(form.text,/data-order-problems/);assert.match(form.text,/\$6\.99/);
  await browser.post('/mail/'+g2+'/order').type('form').send({_csrf:csrf(form.text),digest:/name="digest" value="([^"]+)"/.exec(form.text)[1]}).expect(303);
  [o]=await order(g2);assert.deepEqual([o.status,o.lines[0].price],['DRAFT',750]);
  assert.deepEqual([(await work(g2)).status,(await work(g2)).automatic],['DRAFTED',false]);

  // An unknown code stops until the owner saves it as the customer's own code.
  const g3=await capture('PO #G-3\nRCV-77 qty 1');
  assert.match((await run(g3)).reason,/does not know the product code “RCV-77”/);
  const page=await browser.get(orders.path).expect(200);
  await browser.post(orders.path+'/codes').type('form').send({_csrf:csrf(page.text),customerId:'fixture-customer',code:'RCV-77',sku:code}).expect(303);
  r=await run(g3);assert.equal(r.status,'DRAFT',JSON.stringify(r));
  [o]=await order(g3);assert.deepEqual(o.lines,[{sku,qty:1,price:750}]);
  // A barcode is read as its product too.
  await db.query("UPDATE skus SET barcode='0123456789012' WHERE id=$1",[sku]);
  const g4=await capture('PO #G-4\n3 x 0123456789012');
  r=await run(g4);assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.equal((await order(g4))[0].lines[0].qty,3);
  // A code that could mean two products is a question, never a guess.
  const clash=(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Clashing item',baseCode:'RCV-77',trackingMode:'quantity'})).skuIds[0];
  const g5=await capture('PO #G-5\nRCV-77 qty 1');
  assert.match((await run(g5)).reason,/matches .* and /);assert.deepEqual(await order(g5),[]);
  await db.query('UPDATE skus SET is_active=0 WHERE id=$1',[clash]);
  // A line StockChief cannot read keeps the whole order with a person.
  const g6=await capture('PO #G-6\n'+code+' qty 1\nAnd also send spare bolts');
  assert.match((await run(g6)).reason,/spare bolts/);assert.deepEqual(await order(g6),[]);

  // Spreadsheets and PDFs go through the attachment reader.
  const second=(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Second item',baseCode:'SECOND-'+randomUUID().slice(0,6),trackingMode:'quantity'})).skuIds[0];
  const code2=(await db.query('SELECT code FROM skus WHERE id=$1',[second])).rows[0].code;
  await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId:second,amountMinor:400,currency:'USD'});
  const XLSX=require('xlsx'),book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Purchase order','X-77'],[],['Item code','Description','Quantity','Unit price'],[code,'Parcel item',4,7.5],[code2,'Second item',1,'']]),'Order');
  const sheet=await capture('Please see attached purchase order.',{attachments:[{id:'sheet',filename:'order.xlsx',
    mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',contentBase64:XLSX.write(book,{type:'buffer',bookType:'xlsx'}).toString('base64')}]});
  r=await run(sheet,'mail.attachment-extract');
  assert.equal(r.order.status,'DRAFT',JSON.stringify(r.order));
  [o]=await order(sheet);assert.equal(o.reference,'X-77');assert.equal(o.total,3400);
  assert.deepEqual(o.lines.map(l=>[l.sku,l.qty]).sort(),[[second,1],[sku,4]].sort());
  const csv=await capture('Please see attached purchase order.',{attachments:[{id:'csv',filename:'order.csv',mimeType:'text/csv',
    contentBase64:Buffer.from('Purchase order,C-9\nSKU,Qty,Price\n'+code+',2,7.50\n').toString('base64')}]});
  r=await run(csv,'mail.attachment-extract');assert.equal(r.order.status,'DRAFT',JSON.stringify(r.order));assert.equal((await order(csv))[0].total,1500);
  // The same product written twice under two codes is a question.
  const twice=await capture('PO #G-7\n'+code+' qty 1\nRCV-77 qty 2');
  assert.match((await run(twice)).reason,/same product twice/);assert.deepEqual(await order(twice),[]);

  // Pro creates and confirms alone, within the owner's limits.
  await subscribe('pro');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const p1=await capture('PO #P-1\n'+code+' qty 2');
  r=await run(p1);assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/Save your limits/);
  const limitsPage=await browser.get(orders.path).expect(200);assert.match(limitsPage.text,/Your limits/);
  await browser.post(orders.path+'/limits').type('form').send({_csrf:csrf(limitsPage.text),revision:0,maximum:'60',maximumUnits:'8',enabled:'yes'}).expect(303);
  const p2=await capture('Purchase order #P-2\n'+code+' qty 2\nShip to: 10 Jobsite Rd, Albany, NY 12207\n\nThanks,\nRita');
  r=await run(p2);
  assert.equal(r.status,'CONFIRMED',JSON.stringify(r));
  [o]=await order(p2);assert.deepEqual([o.status,o.reserved,o.total],['CONFIRMED',2,1500]);
  assert.deepEqual([(await work(p2)).status,(await work(p2)).automatic],['CONFIRMED',true]);
  assert.equal((await run(p2)).replayed,true);assert.equal((await order(p2)).length,1);
  // Over the value or unit limit: prepared for approval, not confirmed.
  const p3=await capture('PO #P-3\n'+code+' qty 9');
  r=await run(p3);assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/\$67\.50, over your limit of \$60\.00/);
  await orders.configure(db,ctx,{revision:1,maximum:'1000',maximumUnits:'8'});
  const p3b=await capture('PO #P-3B\n'+code+' qty 9');
  assert.match((await run(p3b)).reason,/9 units, over your limit of 8 units/);
  // A new delivery address stops before any order exists.
  const p4=await capture('PO #P-4\n'+code+' qty 1\nShip to:\n99 New Rd\nTroy, NY 12180');
  assert.match((await run(p4)).reason,/New delivery address: 99 New Rd, Troy, NY 12180/);assert.deepEqual(await order(p4),[]);
  // A customer's first order is prepared for a person.
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('newco',$1,'Newco','buyer@newco.test','5 Mill St, Hudson, NY 12534','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  const p5=(await mail.capture(db,connection,{externalMessageId:randomUUID(),sender:'buyer@newco.test',subject:'Purchase order',bodyText:'PO #N-1\n'+code+' qty 1'})).messageId;
  r=await run(p5);assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/first order from this customer/);
  // The order checks run before confirming: over the credit limit it waits as a draft.
  await db.query(`INSERT INTO customer_payment_terms(id,workspace_id,customer_id,kind,net_days,credit_limit_minor,created_at,updated_at)
    VALUES('house-terms',$1,NULL,'ON_ACCOUNT',30,100,now()::text,now()::text)`,[ws]);
  const p6=await capture('PO #P-6\n'+code+' qty 1');
  r=await run(p6);assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/credit limit/);
  await db.query("DELETE FROM customer_payment_terms WHERE id='house-terms'");
  // The same customer purchase order number is never ordered twice.
  const p7=await capture('PO #P-2\n'+code+' qty 1');
  assert.match((await run(p7)).reason,/already uses this customer purchase order number/);assert.deepEqual(await order(p7),[]);
  // Ask me first prepares; Watch only and pause only watch.
  await modes.save(db,ctx,52,{mode:'ask',revision:0});
  const p8=await capture('PO #P-8\n'+code+' qty 1');
  r=await run(p8);assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/Ask me first/);
  await modes.save(db,ctx,52,{mode:'watch',revision:1});
  const p9=await capture('PO #P-9\n'+code+' qty 1');
  assert.match((await run(p9)).reason,/Watch only/);assert.deepEqual(await order(p9),[]);assert.equal((await work(p9)).status,'WATCHED');
  await modes.save(db,ctx,52,{mode:'inherit',revision:2});
  await autopilot.pause(db,ctx,{role:'owner'},'Checking orders');
  const p10=await capture('PO #P-10\n'+code+' qty 1');
  assert.match((await run(p10)).reason,/paused/);assert.deepEqual(await order(p10),[]);
  await autopilot.resume(db,ctx,{role:'owner'});
  r=await run(p10);assert.equal(r.status,'CONFIRMED',JSON.stringify(r));

  // Undo cancels the confirmed order through the ordinary path and frees its stock.
  const undoPage=await browser.get(orders.path).expect(200);
  assert.match(undoPage.text,new RegExp('/autopilot/customer-orders/email/'+p2+'/undo'));
  await browser.post(orders.path+'/email/'+p2+'/undo').type('form').send({_csrf:csrf(undoPage.text)}).expect(303);
  [o]=await order(p2);assert.deepEqual([o.status,o.reserved],['CANCELLED',0]);assert.equal((await work(p2)).status,'UNDONE');
  await browser.post(orders.path+'/email/'+p2+'/undo').type('form').send({_csrf:csrf(undoPage.text)}).expect(303);

  // Custom confirms alone too; a downgrade to Growth only prepares; Starter does nothing.
  await subscribe('enterprise');
  const c1=await capture('PO #C-1\n2 units of '+code);
  r=await run(c1);assert.equal(r.status,'CONFIRMED',JSON.stringify(r));
  await subscribe('growth');
  const d1=await capture('PO #D-1\n'+code+' qty 1');
  r=await run(d1);assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/for your approval/);
  await subscribe('starter');
  assert.equal((await run(await capture('PO #D-2\n'+code+' qty 1'))).skipped,true);

  // Every order StockChief made is audited.
  const audited=(await db.query("SELECT action,count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Customer%' GROUP BY action",[ws])).rows;
  const count=action=>audited.find(a=>a.action===action)?.n||0;
  assert.equal(count('Customer order from email created and confirmed by StockChief'),3);
  assert.equal(count('Customer order from email drafted'),1);
  assert(count('Customer order from email prepared by StockChief for approval')>=10);
  assert.equal(count('Customer order created by StockChief undone'),1);
  assert.equal(count('Customer order limits changed'),2);
  assert.equal(count('Customer product code added'),1);

  // The page at desktop and phone widths.
  await subscribe('pro');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port,shots=process.env.CUSTOMER_ORDER_SHOTS;
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const tab=await chrome.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500}),errors=[];
    tab.setDefaultTimeout(15000);tab.on('pageerror',e=>errors.push(e.message));
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const [where,expectText] of [[orders.path,/Customer orders from email[\s\S]*Waiting for you[\s\S]*Your limits[\s\S]*own product codes/],['/mail/'+g6,/spare bolts/]]){
      await tab.goto(origin+where);
      assert.match(await tab.locator('main').innerText(),expectText);
      assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scrolling on '+where+' at '+viewport.width);
      if(shots)await tab.screenshot({path:require('node:path').join(shots,'customer-orders-'+where.split('/').pop().slice(0,12)+'-'+viewport.width+'.png'),fullPage:true});
    }
    assert.deepEqual(errors,[]);
    await tab.close();
  }
});
