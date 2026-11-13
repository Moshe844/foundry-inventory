'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const staff=require('../../src/sales/agent-stock-ready-staff'),ready=require('../../src/sales/agent-stock-ready');

// Job 50 (Starter excluded, Growth draft, Pro and Custom alone): when an item a
// customer waited for is back in stock and reserved, the people who handle that
// customer are told (Needs you on Growth and up; email, text or push on Pro and
// Custom), and the customer is told once per order line.
async function setup(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:1}),{db,ctx}=f,ws=ctx.workspaceId,authz=require('../../src/actions/permissions'),auth=require('../../src/domain/postgres-auth-service');
 const member=async(name,grants=null)=>{const account=await auth.createBusiness(db,{name,businessName:name+' inventory',email:randomUUID()+'@example.test',password:f.password});
  const id='user-'+randomUUID();await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,$4,'staff',$5,now()::text)`,[id,ws,account.accountId,name,grants?authz.encodeGrant(grants):null]);
  return {workspaceId:ws,actorId:id,email:(await db.query('SELECT email FROM accounts WHERE id=$1',[account.accountId])).rows[0].email};};
 const seller=await member('Sam Seller',[authz.VIEW,authz.OPERATE,authz.VIEW_SALES,authz.MANAGE_SALES,authz.FULFILL_SALES]);
 const clerk=await member('Casey Clerk');
 const manager=await member('Mona Manager',[authz.VIEW,authz.OPERATE,authz.VIEW_SALES,authz.MANAGE_SALES]);
 const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
  VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
 const second=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Second part',baseCode:'SECOND-'+randomUUID().slice(0,6),trackingMode:'quantity'});
 const receive=(skuId,quantity=1)=>require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId,locationId:f.location.id,quantity,unitCost:'1.00',idempotencyKey:randomUUID()});
 const available=async skuId=>(await require('../../src/transfers/postgres-transfer-service').sourceAvailable(db,ws,skuId,f.location.id)).available;
 // A backordered order: one unit more than is free of each product.
 const waiting=async(who,{customer='fixture-customer',skus=[f.item.skuIds[0]]}={})=>{const lines=[];for(const skuId of skus)lines.push({skuId,quantity:await available(skuId)+1,unitPriceMinor:1200});
  const o=await f.workflows.createSalesOrder(db,who,{customerId:customer,deliveryMethod:'SHIP',shipToAddress:'10 Jobsite Rd, Albany, NY 12207',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines});
  await f.workflows.confirmSalesOrder(db,who,o.salesOrderId,{idempotencyKey:randomUUID()});
  assert.equal((await db.query('SELECT status FROM sales_orders WHERE id=$1',[o.salesOrderId])).rows[0].status,'BACKORDERED');return o;};
 const arrive=async(o,skus=[f.item.skuIds[0]])=>{for(const skuId of skus)await receive(skuId);await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});};
 const told=async who=>(await require('../../src/projections/postgres-service').needs(db,ws,who.actorId)).filter(n=>String(n.sourceId).startsWith('stock-ready-staff:'));
 const rows=async()=>(await db.query(`SELECT t.*,u.name FROM stockchief_runtime.agent_stock_ready_staff t JOIN users u ON u.id=t.user_id WHERE t.workspace_id=$1 ORDER BY t.created_at,u.name`,[ws])).rows;
 const alertEmails=async()=>(await db.query(`SELECT e.id,m.recipient,m.subject,m.body,m.status FROM stockchief_runtime.provider_effects e JOIN customer_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
  WHERE e.workspace_id=$1 AND e.kind='mail.outbound.send' AND e.payload->'standingAuthority'->>'kind'='agent_alert' AND e.payload->'standingAuthority'->>'job'='50' ORDER BY m.created_at,m.id`,[ws])).rows;
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}},mail=require('../../src/connections/postgres-outbound-mail');
 const notices=require('../../src/autopilot/operational-notices'),check=async()=>{const r=await staff.refresh(db,ws);await notices.refresh(db,ws);return r;};
 const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
 return {...f,ws,seller,clerk,manager,connector,second,receive,waiting,arrive,told,rows,alertEmails,sent,provider,mail,notices,check,audits,
  older:()=>db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]),
  deliverEffect:id=>mail.executeSendEffect(db,ws,id,{provider})};
}

test('the people who handle the customer hear about waited-for stock in Needs you, routed from the records',{timeout:900000},async t=>{
 const f=await setup(t),{db,ctx,ws}=f;
 // Starter: excluded, nothing recorded.
 await f.subscribe('starter');
 const first=await f.waiting(f.seller);await f.arrive(first);
 assert.deepEqual(await staff.refresh(db,ws),{skipped:'plan'});assert.deepEqual(await f.rows(),[]);
 // Growth, in the first 14 days: telling staff in the app changes nothing, so it happens; nothing is emailed.
 await f.subscribe('growth');
 let r=await f.check();assert.deepEqual(r,{lines:1,told:1,cleared:0});
 let told=await f.rows();assert.deepEqual(told.map(x=>[x.name,x.role]),[['Sam Seller','salesperson']]);
 assert.match(told[0].title,/is back in stock and reserved/);assert.equal(await f.audits('Told sales that waited-for stock is reserved'),1);
 let items=await f.told(f.seller);assert.equal(items.length,1);assert.match(items[0].title,/^Waited-for stock is back: /);assert.match(items[0].why,/You entered this order/);
 assert.deepEqual(await f.told(f.clerk),[]);assert.deepEqual(await f.told(f.manager),[]);
 assert(!(await f.told(ctx)).length,'The owner sees the order notice instead');
 assert((await f.notices.inbox(db,ws,ctx.actorId)).some(n=>n.sourceId==='agent-notice-50'));
 // Replays tell nobody twice.
 assert.deepEqual(await staff.refresh(db,ws),{lines:0,told:0,cleared:0});assert.equal(await f.audits('Told sales that waited-for stock is reserved'),1);
 // Growth sends nothing outside the app, and the page offers no sending settings.
 const page=await f.browser.get('/autopilot/reviews/stock-ready-updates').expect(200);assert.doesNotMatch(page.text,/How sales hear about it/);assert.match(page.text,/Sam Seller/);
 assert.equal((await f.alertEmails()).length,0);
 // Only the person told, or the owner, marks it seen.
 await assert.rejects(staff.seen(db,f.clerk,told[0].id),/Only the person it was sent to/);
 assert.deepEqual(await staff.seen(db,f.seller,told[0].id),{seen:1});assert.deepEqual(await staff.seen(db,f.seller,told[0].id),{replayed:true});
 assert.deepEqual(await f.told(f.seller),[]);assert.equal(await f.audits('Marked waited-for stock as seen'),1);

 // Entered by someone who cannot see sales orders: the people who handle this customer's orders.
 const byClerk=await f.waiting(f.clerk);await f.arrive(byClerk);await staff.refresh(db,ws);
 assert.deepEqual((await f.rows()).filter(x=>x.sales_order_id===byClerk.salesOrderId).map(x=>[x.name,x.role]),[['Sam Seller','customer']]);
 // A new customer nobody handles yet: whoever manages sales orders.
 const at=new Date().toISOString();
 await db.query("INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('walk-in',$1,'Walk-in buyer','walkin@example.test','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,$3,$3)",[ws,ctx.actorId,at]);
 const newCustomer=await f.waiting(f.clerk,{customer:'walk-in'});await f.arrive(newCustomer);await staff.refresh(db,ws);
 assert.deepEqual((await f.rows()).filter(x=>x.sales_order_id===newCustomer.salesOrderId).map(x=>x.name+':'+x.role).sort(),['Mona Manager:sales','Sam Seller:sales']);
 // The owner's own order is the owner's: nobody else is told.
 const own=await f.waiting(ctx);await f.arrive(own);await staff.refresh(db,ws);
 assert.equal((await f.rows()).filter(x=>x.sales_order_id===own.salesOrderId).length,0);
 // A line that ships or is cancelled is no longer news.
 await f.workflows.cancelSalesOrder(db,ctx,byClerk.salesOrderId,{idempotencyKey:randomUUID()});
 r=await staff.refresh(db,ws);assert.equal(r.cleared,1);assert(!(await f.told(f.seller)).some(n=>n.href.includes(byClerk.salesOrderId)));
 // Before migration 507's tables exist nothing breaks: the staff source answers nothing.
 assert.equal(typeof (await staff.inbox(db,ws,null)).length,'number');
});

test('Pro and Custom email the salesperson on their own; waits and the owner’s send follow the job’s mode',{timeout:900000},async t=>{
 const f=await setup(t),{db,ctx,ws}=f,alerts=require('../../src/autopilot/agent-alerts'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
 await f.subscribe('pro');
 let page=await f.browser.get('/autopilot/reviews/stock-ready-updates').expect(200);assert.match(page.text,/How sales hear about it/);
 await f.browser.post('/autopilot/alerts/50').type('form').send({_csrf:f.csrf(page.text),revision:0,mailbox:f.connector}).expect(303);
 // First 14 days: told in the app, the email waits.
 const one=await f.waiting(f.seller);await f.arrive(one);await f.check();
 assert.equal((await f.alertEmails()).length,0);assert.match((await alerts.panel(db,ctx,50)).stop,/first 14 days/);
 // After them, the salesperson gets one email from the chosen mailbox.
 await f.older();await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await f.check();let emails=await f.alertEmails();assert.equal(emails.length,1);assert.equal(emails[0].recipient,f.seller.email);assert.match(emails[0].subject,/^Waited-for stock is back: /);
 await f.check();assert.equal((await f.alertEmails()).length,1,'Each line goes out once');
 await f.deliverEffect(emails[0].id);assert.equal(f.sent.length,1);
 // Ask me first: the email waits; the owner sends the waiting ones.
 await modes.save(db,ctx,50,{mode:'ask',revision:0});
 const two=await f.waiting(f.seller);await f.arrive(two);await f.check();
 assert.equal((await f.alertEmails()).length,1);
 page=await f.browser.get('/autopilot/reviews/stock-ready-updates').expect(200);assert.match(page.text,/Send the waiting updates now/);
 await f.browser.post('/autopilot/alerts/50/send').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
 emails=await f.alertEmails();assert.equal(emails.length,2);
 // Seen before the mailbox sends: the email is not sent.
 const row=(await f.rows()).find(x=>x.sales_order_id===two.salesOrderId);await staff.seen(db,f.seller,row.id);
 await assert.rejects(f.deliverEffect(emails[1].id),/seen, shipped or changed/);assert.equal(f.sent.length,1);
 await modes.save(db,ctx,50,{mode:'inherit',revision:1});
 // Pause holds it.
 await autopilot.pause(db,ctx,{role:'owner'},'Synthetic pause');
 const three=await f.waiting(f.seller);await f.arrive(three);await f.check();assert.equal((await f.alertEmails()).length,2);
 await autopilot.resume(db,ctx,{role:'owner'});await f.check();assert.equal((await f.alertEmails()).length,3);
 // A downgrade to Growth stops a queued email at the mailbox.
 await f.subscribe('growth');await assert.rejects(f.deliverEffect((await f.alertEmails())[2].id),e=>e.code==='entitlement_required');
 // Custom sends on its own too.
 await f.subscribe('enterprise');const four=await f.waiting(f.seller);await f.arrive(four);await f.check();
 emails=await f.alertEmails();assert.equal(emails.length,4);await f.deliverEffect(emails[3].id);assert.equal(f.sent.length,2);
 assert(await f.audits('Alert email queued')>=4);
});

test('the customer hears once per waited-for line, never a date, and online shoppers are not held',{timeout:900000},async t=>{
 const f=await setup(t),{db,ctx,ws}=f,autopilot=require('../../src/autopilot/postgres-service');
 await f.subscribe('pro');await f.older();await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await ready.configure(db,ctx,{revision:0,connectorId:f.connector});
 // A shipped order makes the fixture customer known, so updates go out on their own.
 const parcel=await f.parcel();await f.shipping.markPacked(db,ctx,parcel.shipmentId);await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',trackingNumber:randomUUID(),carrier:'UPS'});
 // Two products both waiting; the second comes back first.
 const skus=[f.item.skuIds[0],f.second.skuIds[0]],order=await f.waiting(f.seller,{skus});
 await f.arrive(order,[skus[1]]);
 let p=await ready.facts(db,ctx,order.salesOrderId,f.connector);assert.deepEqual(p.lines.map(l=>l.sku),[(await db.query('SELECT code FROM skus WHERE id=$1',[skus[1]])).rows[0].code]);assert.equal(p.stillWaiting,true);
 let words=ready.compose(p);assert.match(words.body,/these items on your order/);assert.match(words.body,/still waiting for stock/);assert.match(words.body,/not a delivery date/);
 assert.doesNotMatch(words.body,/\b(tomorrow|by \w+day|will arrive|will ship on)\b/i);
 let r=await ready.run(db,ws);assert.equal(r.queued,1);
 assert.equal((await ready.run(db,ws)).queued,0,'One update per line');
 const again=await ready.facts(db,ctx,order.salesOrderId,f.connector);assert.equal(again.noticeKey,p.noticeKey,'Preparing it again finds the same update');
 // The rest arrives: a second update covers only the new line.
 await f.arrive(order,[skus[0]]);p=await ready.facts(db,ctx,order.salesOrderId,f.connector);
 assert.equal(p.lines.length,1);assert.equal(p.stillWaiting,false);assert.match(ready.compose(p).body,/Stock is now reserved for your order/);
 r=await ready.run(db,ws);assert.equal(r.queued,1);
 const notices=(await db.query('SELECT count(*)::int n FROM customer_communications WHERE workspace_id=$1 AND stock_ready_order_id=$2',[ws,order.salesOrderId])).rows[0].n;assert.equal(notices,2);
 const lines=(await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_stock_ready_lines WHERE workspace_id=$1 AND sales_order_id=$2 AND noticed_at IS NOT NULL',[ws,order.salesOrderId])).rows[0].n;assert.equal(lines,2);
 // A new business customer is held for a person; an online shopper from a connected channel is not.
 const at=new Date().toISOString();
 await db.query("INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('new-business',$1,'New business','buyer@example.test','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,$3,$3),('shopper',$1,'Online shopper','shopper@example.test','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,$3,$3)",[ws,ctx.actorId,at]);
 const business=await f.waiting(f.seller,{customer:'new-business'});await f.arrive(business);
 r=await ready.run(db,ws);assert.equal(r.held,1);assert.equal(r.queued,0);
 const shop=await f.waiting(f.seller,{customer:'shopper'});
 await db.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,created_at,updated_at) VALUES($1,$2,$3,'sales_order',$4,$5,$6,$6)`,[randomUUID(),ws,f.connector,'shop-'+randomUUID(),shop.salesOrderId,at]);
 await f.arrive(shop);r=await ready.run(db,ws);assert.equal(r.queued,1,'Online shoppers are not held as a first customer');
 const shopMail=(await db.query('SELECT recipient FROM customer_communications WHERE workspace_id=$1 AND stock_ready_order_id=$2',[ws,shop.salesOrderId])).rows;assert.deepEqual(shopMail.map(m=>m.recipient),['shopper@example.test']);
 // The owner's order notice clears once every ready line has its update.
 await f.notices.refresh(db,ws);const open=(await db.query("SELECT reference FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=50 AND NOT resolved",[ws])).rows.map(x=>x.reference);
 const numbers=async id=>(await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[id])).rows[0].order_number;
 assert(open.includes(await numbers(business.salesOrderId)),'The held order stays in the owner’s Needs you');assert(!open.includes(await numbers(order.salesOrderId)));assert(!open.includes(await numbers(shop.salesOrderId)));
});
