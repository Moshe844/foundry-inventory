'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {addDays}=require('../../src/accounting/customer-money');

// Job 53: a customer's usual order repeated from one sentence.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:200});
  const {db,ctx,workflows}=f,sku=f.item.skuIds[0],ws=ctx.workspaceId;
  const tape=(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Packing tape',baseCode:'TAPE-'+randomUUID().slice(0,6),trackingMode:'quantity'})).skuIds[0];
  await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:tape,locationId:f.location.id,quantity:100,idempotencyKey:randomUUID()});
  const prices=require('../../src/pricing/postgres-service'),price=(id,amountMinor)=>prices.setPrice(db,ctx,{skuId:id,amountMinor,currency:'USD'});
  await price(sku,800);await price(tape,500);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),lastMonth=addDays(today.slice(0,7)+'-01',-1);
  const twoAgo=addDays(lastMonth.slice(0,7)+'-01',-10),threeAgo=addDays(twoAgo.slice(0,7)+'-01',-10);
  const source=async(date,lines)=>{
    const o=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',orderDate:date,deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:lines.map(([skuId,quantity])=>({skuId,quantity,unitPriceMinor:400}))});
    await workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});return o;
  };
  // The customer's history: last month three of the product; before that the product and tape.
  await source(threeAgo,[[sku,3],[tape,2]]);await source(twoAgo,[[sku,3],[tape,1]]);const last=await source(lastMonth,[[sku,3]]);
  const startedAt=new Date().toISOString();
  const codes=Object.fromEntries((await db.query('SELECT id,code FROM skus WHERE id=ANY($1)',[[sku,tape]])).rows.map(r=>[r.id,r.code]));
  const orders=async()=>(await db.query(`SELECT o.id,o.order_number,o.status,o.pricing_total_minor::int AS total,o.notes,
      (SELECT coalesce(sum(a.quantity),0)::float FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
        WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id) AS reserved
    FROM sales_orders o WHERE o.workspace_id=$1 AND o.created_at>$2 ORDER BY o.created_at,o.id`,[ws,startedAt])).rows;
  const age=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  return {...f,sku,tape,ws,price,source,last,codes,orders,age,lastMonth,
    modes:require('../../src/autopilot/job-modes'),autopilot:require('../../src/autopilot/postgres-service'),limits:require('../../src/sales/agent-customer-orders')};
}

test('Ask repeats the usual order from one sentence under each plan, learns on Growth and stops on anything new',{timeout:900000},async t=>{
  const f=await setup(t);
  const {db,ctx,ws,sku,tape,codes,subscribe,modes,autopilot,limits,workflows}=f;
  const assistant=require('../../src/assistant/postgres-service');
  const say=(text,options={})=>assistant.ask(db,ctx,text,{usageKey:randomUUID(),...options});
  const row=async proposalId=>(await db.query("SELECT * FROM stockchief_runtime.agent_repeat_orders WHERE workspace_id=$1 AND id=(SELECT 'ask:'||idempotency_key FROM stockchief_runtime.assistant_action_proposals WHERE id=$2)",[ws,proposalId])).rows[0];
  const order=async id=>(await f.orders()).find(o=>o.id===id);

  // Starter is refused with the plan lock.
  await subscribe('starter');
  let r=await say('Same as last month for Receiver');
  assert.equal(r.status,'CLARIFY');assert.match(r.answer,/Growth/);assert.deepEqual(await f.orders(),[]);

  // Pro during the first 14 days prepares and only watches.
  await subscribe('pro');
  r=await say('Repeat Receiver’s usual order');
  assert.equal(r.status,'PREPARED',JSON.stringify(r));
  assert.match(r.answer,/usual order \(the products in at least 2 of their last 3 orders, at the quantity they order most often\)/);
  assert.match(r.answer,new RegExp('3 × '+codes[sku]+', 1 × '+codes[tape]));assert.match(r.answer,/Total \$29\.00/);
  assert.match(r.answer,/first 14 days/);assert.deepEqual(await f.orders(),[]);
  await f.age();

  // Growth prepares until taught: the person approves, then confirms the order.
  await subscribe('growth');
  r=await say('Repeat Receiver’s usual order');
  assert.equal(r.status,'PREPARED');assert.match(r.answer,/not taught StockChief this customer’s repeat order/);
  const approved=await assistant.executeProposal(db,ctx,r.proposal.id);
  let o=await order(approved.result.salesOrderId);
  assert.deepEqual([o.status,o.total],['DRAFT',2900]);assert.match(o.notes,/usual order/);
  assert.deepEqual([(await row(r.proposal.id)).status,(await row(r.proposal.id)).automatic],['DRAFTED',false]);
  await workflows.confirmSalesOrder(db,ctx,o.id,{idempotencyKey:randomUUID()});
  // That approved example teaches this customer's usual order: now it creates and confirms alone.
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  r=await say('Repeat Receiver’s usual order');
  assert.equal(r.status,'ANSWERED',JSON.stringify(r));assert.match(r.answer,/^Created and confirmed SO-\d+ for Receiver, repeating their usual order/);
  o=await order(/\/orders\/(.+)$/.exec(r.handoff.href)[1]);assert.deepEqual([o.status,o.total,o.reserved],['CONFIRMED',2900,4]);
  assert.equal((await row(r.proposal.id)).automatic,true);
  // A higher total than the example waits again.
  await f.price(sku,900);
  r=await say('Repeat Receiver’s usual order');assert.equal(r.status,'PREPARED');assert.match(r.answer,/not taught/);
  await f.price(sku,800);
  // Another reading is a different order: taught by a saved rule instead.
  r=await say('Same as last month for Receiver');
  assert.equal(r.status,'PREPARED');assert.match(r.answer,/order from last month, SO-\d+ at current prices\. 3 × /);assert.match(r.answer,/not taught/);
  await assistant.executeProposal(db,ctx,r.proposal.id);
  await require('../../src/autopilot/draft-authority').save(db,ctx,r.proposal.id,{mode:'save',maximum:'30',revision:0});
  r=await say('Receiver wants the same as last month');
  assert.equal(r.status,'ANSWERED',JSON.stringify(r));assert.match(r.answer,/Created and confirmed/);

  // Pro and Custom: alone within the owner's limits.
  await subscribe('pro');
  r=await say('Lo mismo que el mes pasado para Receiver');
  assert.equal(r.status,'PREPARED');assert.match(r.answer,/Save your limits/);
  await limits.configure(db,ctx,{revision:0,maximum:'100',maximumUnits:'10'});
  r=await say('Lo mismo que el mes pasado para Receiver');
  assert.equal(r.status,'ANSWERED',JSON.stringify(r));assert.match(r.answer,/Created and confirmed/);
  const alone=r;
  assert.equal((await assistant.executeProposal(db,ctx,alone.proposal.id)).replayed,true,'a replay creates nothing new');
  const count=(await f.orders()).length;
  await limits.configure(db,ctx,{revision:1,maximum:'20',maximumUnits:'10'});
  r=await say('Same as last month for Receiver');assert.equal(r.status,'PREPARED');assert.match(r.answer,/\$24\.00, over your limit of \$20\.00/);
  await limits.configure(db,ctx,{revision:2,maximum:'100',maximumUnits:'10'});
  await modes.save(db,ctx,53,{mode:'ask',revision:0});
  r=await say('Same as last month for Receiver');assert.equal(r.status,'PREPARED');assert.match(r.answer,/Ask me first/);
  await modes.save(db,ctx,53,{mode:'inherit',revision:1});
  await autopilot.pause(db,ctx,{role:'owner'},'Checking');
  r=await say('Same as last month for Receiver');assert.equal(r.status,'PREPARED');assert.match(r.answer,/paused/);
  await assert.rejects(assistant.executeRepeatRoutine(db,ctx,r.proposal.id),/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await db.query("UPDATE customers SET shipping_address='99 New Rd, Troy, NY 12180' WHERE id='fixture-customer'");
  r=await say('Same as last month for Receiver');assert.equal(r.status,'PREPARED');assert.match(r.answer,/has not used before/);
  await db.query("UPDATE customers SET shipping_address='10 Jobsite Rd, Albany, NY 12207' WHERE id='fixture-customer'");
  assert.equal((await f.orders()).length,count,'nothing was created while it waited');
  // A sentence with anything more is not a repeat request; the agent handles it.
  assert.equal(require('../../src/sales/repeat-order-sentence').read('How much did Receiver buy same as last month?'),null);
  assert.deepEqual(require('../../src/sales/repeat-order-sentence').leftover('Same as last month for Receiver but add tape',require('../../src/sales/repeat-order-sentence').read('Same as last month for Receiver but add tape'),['Receiver']),['but','add','tape']);
  // Another alphabet is read in English first, then repeats the same way.
  const {pricedUsage}=require('../helpers/postgres-model-fixture'),seen=[];
  const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',async complete(request){
    seen.push(request.schemaName);assert.equal(request.schemaName,'stockchief_question_in_english');
    return {data:{english:'Same as last month for Receiver'},usage:pricedUsage()};}};
  r=await say('אותו דבר כמו בחודש שעבר עבור Receiver',{provider});
  assert.deepEqual(seen,['stockchief_question_in_english']);assert.match(r.answer,/Created and confirmed/);
  await subscribe('enterprise');
  r=await say('Répète la commande habituelle de Receiver');assert.match(r.answer,/Created and confirmed .* repeating their usual order/);
  const custom=await order(/\/orders\/(.+)$/.exec(r.handoff.href)[1]);assert.equal(custom.status,'CONFIRMED');

  // Undo cancels an order StockChief confirmed and frees its stock.
  const undoRow=await row(r.proposal.id),page=await f.browser.get('/autopilot/customer-orders').expect(200);
  assert.match(page.text,/repeating|Repeat order/);
  await f.browser.post('/autopilot/customer-orders/repeat/'+encodeURIComponent(undoRow.id)+'/undo').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  assert.deepEqual([(await order(custom.id)).status,(await order(custom.id)).reserved],['CANCELLED',0]);
  assert.equal((await row(r.proposal.id)).status,'UNDONE');
  await f.browser.get('/autopilot/reviews/repeat-customer-orders').expect(303);

  // Two orders last month is a question, never a guess.
  await f.source(f.lastMonth,[[sku,1]]);
  r=await say('Same as last month for Receiver');assert.equal(r.status,'CLARIFY');assert.match(r.answer,/More than one customer order matches last month/);
  // After a downgrade, Growth keeps what it was taught (the saved rule for this order); Starter is refused.
  await subscribe('growth');
  r=await say('Repeat Receiver’s last order');assert.equal(r.status,'ANSWERED',JSON.stringify(r));assert.match(r.answer,/Created and confirmed .* repeating their last order, SO-/);
  await subscribe('starter');
  r=await say('Repeat Receiver’s usual order');assert.equal(r.status,'CLARIFY');

  const audited=(await db.query("SELECT action,count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Repeat customer order%' GROUP BY action",[ws])).rows;
  const n=action=>audited.find(a=>a.action===action)?.n||0;
  assert.equal(n('Repeat customer order created and confirmed by StockChief'),6);
  assert.equal(n('Repeat customer order drafted'),2);
});

test('a customer’s “same as last month” email repeats their order under each plan and never twice',{timeout:900000},async t=>{
  const f=await setup(t);
  const {db,ctx,ws,sku,subscribe,autopilot,limits,workflows}=f;
  const connection=(await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
    VALUES('order-desk',$1,'order-desk','Order desk','gmail','[]','{}','connected','[]',now()::text,now()::text) RETURNING *`,[ws])).rows[0];
  const mail=require('../../src/connections/postgres-mail'),runtime=require('../../src/operations/postgres-runtime-handlers').create();
  const capture=async(bodyText,sender='receiver@example.test')=>(await mail.capture(db,connection,{externalMessageId:randomUUID(),sender,subject:'Order',bodyText})).messageId;
  const queued=async id=>(await db.query("SELECT kind FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND payload->>'messageId'=$2 ORDER BY kind",[ws,id])).rows.map(r=>r.kind);
  const run=id=>runtime['mail.customer-repeat-order.v1']({workspaceId:ws,payload:{messageId:id}},db);
  const lines=id=>runtime['mail.customer-order']({workspaceId:ws,payload:{messageId:id}},db);
  const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_repeat_orders WHERE workspace_id=$1 AND message_id=$2',[ws,id])).rows[0];
  const later=()=>db.query("UPDATE stockchief_runtime.agent_repeat_orders SET created_at=created_at-interval '8 days' WHERE workspace_id=$1",[ws]);
  const lastMonthly='Hi,\n\nSame as last month please.\n\nThanks,\nRita';

  await subscribe('starter');
  const s1=await capture(lastMonthly);
  assert(!(await queued(s1)).includes('mail.customer-repeat-order.v1'));assert.equal((await run(s1)).skipped,true);

  await subscribe('pro');
  const w1=await capture(lastMonthly);
  assert((await queued(w1)).includes('mail.customer-repeat-order.v1'));
  let r=await run(w1);
  assert.match(r.reason,/first 14 days/);assert.match(r.reason,/would have prepared Receiver’s order from last month, SO-\d+ for \$24\.00/);
  assert.equal((await row(w1)).status,'WATCHED');assert.equal((await lines(w1)).skipped,true,'the line-by-line reader leaves a repeat request alone');
  await f.age();

  // Growth prepares the draft; it waits in Needs you; the person confirms it.
  await subscribe('growth');
  const g1=await capture(lastMonthly);
  r=await run(g1);
  assert.equal(r.status,'DRAFT',JSON.stringify(r));assert.match(r.reason,/not taught/);assert.match(r.reading,/order from last month/);
  assert((await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).some(n=>n.sourceId==='customer-order:53:email:'+g1));
  assert.equal((await run(g1)).replayed,true);
  await f.browser.get('/mail/'+g1+'/order').expect(303);
  await workflows.confirmSalesOrder(db,ctx,r.salesOrderId,{idempotencyKey:randomUUID()});
  // Taught by that example, the next month's email is created and confirmed alone.
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await later();
  const g2=await capture(lastMonthly);
  r=await run(g2);assert.equal(r.status,'CONFIRMED',JSON.stringify(r));
  assert.deepEqual([(await row(g2)).status,(await row(g2)).automatic],['CONFIRMED',true]);
  // The same request again this week is a question; the person decides on the review form.
  const g3=await capture('Same as last month');
  assert.match((await run(g3)).reason,/already repeated this order as SO-\d+ this week/);
  const form=await f.browser.get('/mail/'+g3+'/order').expect(200);assert.match(form.text,/data-repeat-reading/);
  await f.browser.post('/mail/'+g3+'/order').type('form').send({_csrf:f.csrf(form.text),digest:/name="digest" value="([^"]+)"/.exec(form.text)[1]}).expect(303);
  assert.deepEqual([(await row(g3)).status,(await row(g3)).automatic],['DRAFTED',false]);
  // Anything beyond the repeat stops; a customer with no orders stops.
  const extra=await capture('Please send our usual order, and extra tape.');
  assert.match((await run(extra)).reason,/more than a repeat/);
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('newco',$1,'Newco','buyer@newco.test','5 Mill St, Hudson, NY 12534','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  assert.match((await run(await capture(lastMonthly,'buyer@newco.test'))).reason,/No confirmed customer order/);

  // Pro: alone within limits, in the customer's language.
  await subscribe('pro');await limits.configure(db,ctx,{revision:0,maximum:'100',maximumUnits:'10'});
  await later();
  const p1=await capture('Hallo,\nBitte unsere übliche Bestellung.\nDanke');
  r=await run(p1);assert.equal(r.status,'CONFIRMED',JSON.stringify(r));assert.match(r.reading,/usual order/);
  await limits.configure(db,ctx,{revision:1,maximum:'20',maximumUnits:'10'});await later();
  r=await run(await capture(lastMonthly));assert.equal(r.status,'DRAFT');assert.match(r.reason,/over your limit/);
  await autopilot.pause(db,ctx,{role:'owner'},'Checking');
  assert.match((await run(await capture('La même chose que le mois dernier, merci.'))).reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await limits.configure(db,ctx,{revision:2,maximum:'100',maximumUnits:'10'});await later();
  await subscribe('enterprise');
  r=await run(await capture('La même chose que le mois dernier, merci.'));assert.equal(r.status,'CONFIRMED',JSON.stringify(r));
  await subscribe('starter');
  assert.equal((await run(await capture(lastMonthly))).skipped,true);

  // The page at desktop and phone widths shows what each repeat was read as.
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
    await tab.goto(origin+'/autopilot/customer-orders');
    assert.match(await tab.locator('main').innerText(),/Repeat order[\s\S]*usual order/);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scrolling at '+viewport.width);
    if(shots)await tab.screenshot({path:require('node:path').join(shots,'repeat-orders-'+viewport.width+'.png'),fullPage:true});
    assert.deepEqual(errors,[]);await tab.close();
  }
});
