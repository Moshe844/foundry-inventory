'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 107: StockChief prepares refunds and credits; a person always approves.
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx}=f;
 await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const date=await require('../../src/lib/business-time').today(db,ctx.workspaceId),at=new Date().toISOString(),skuId=f.item.skuIds[0];
 await db.query(`INSERT INTO accounting_tax_rates(id,workspace_id,name,jurisdiction,rate_millionths,applies_to,effective_from,active,created_by_user_id,created_at,updated_at)
  VALUES('credit-tax',$1,'Sales tax','Fixture',82500,'SALES','2020-01-01',1,$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
 const assistant=require('../../src/assistant/postgres-service'),credits=require('../../src/accounting/agent-customer-credits');
 async function order({quantity=2,price=1313,discount=17,ship=quantity,confirm=true}={}){
  const sale=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,taxRateId:'credit-tax',discountMinor:discount,
   lines:[{skuId,quantity,unitPriceMinor:price}],idempotencyKey:randomUUID()});
  if(confirm)await f.workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
  let invoiceId=null;
  if(ship)invoiceId=(await f.workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:sale.lineIds[0],locationId:f.location.id,quantity:ship}],shipment:{handover:'COLLECTED'}})).invoiceId;
  return {...sale,invoiceId};
 }
 const invoice=async id=>(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
 const pay=(o,amountMinor,method='check')=>f.workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:o.invoiceId,salesOrderId:o.salesOrderId,amountMinor,paymentDate:date,method,idempotencyKey:randomUUID()});
 const control=async key=>Number((await db.query('SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::text n FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND a.system_key=$2',[ctx.workspaceId,key])).rows[0].n);
 const prepare=args=>assistant.prepareAction(db,ctx,'Prepare this customer credit',{action:'customer_credit.prepare',...args});
 const prepared=async args=>{const r=await prepare(args);assert.equal(r.status,'PREPARED',JSON.stringify(r));return assistant.getProposal(db,ctx.workspaceId,r.proposal.id);};
 const refunds=async creditId=>(await db.query('SELECT * FROM stockchief_runtime.agent_customer_credit_refunds WHERE workspace_id=$1 AND credit_id=$2 ORDER BY created_at,id',[ctx.workspaceId,creditId])).rows;
 const needs=()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 return {...f,date,skuId,assistant,credits,order,invoice,pay,control,prepare,prepared,refunds,needs,modes:require('../../src/autopilot/job-modes')};
}
// The exact arithmetic, worked independently of the module: scale the line's
// gross by the new price, keep the original discount share, and tax the net.
const r=(v,n,d)=>Math.round(v*n/d);
function expected(snapshot,unit,from,to){
 const G=snapshot.grossMinor,D=snapshot.discountMinor,T=snapshot.taxMinor-(snapshot.chargeTaxMinor||0),at=p=>{const g=r(G,p,unit),d=r(D,g,G),n=g-d;return {n,t:r(T,n,G-D)};};
 const a=at(from),b=at(to);return {revenue:a.n-b.n,tax:a.t-b.t};
}

test('price adjustments credit the exact goods, discount share and tax on Pro and Custom only, after a person approves',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,o=await f.order(),before=await f.invoice(o.invoiceId);
 const line=(await db.query('SELECT * FROM accounting_customer_invoice_lines WHERE workspace_id=$1 AND invoice_id=$2',[ctx.workspaceId,o.invoiceId])).rows[0];
 const snap=typeof line.pricing_snapshot==='string'?JSON.parse(line.pricing_snapshot):line.pricing_snapshot;assert(snap.taxMinor>0&&snap.discountMinor>0,'The sale carries a discount and tax.');
 await f.pay(o,300,'cash');
 // Starter and Growth: the job is not included.
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(f.prepare({recordReference:before.invoice_number,creditKind:'price_adjustment',creditLines:'1=10.00',reason:'Agreed lower price'}),e=>e.code==='entitlement_required');await f.browser.get('/autopilot/reviews/customer-credits').expect(402);}
 await f.subscribe('pro');
 const p=await f.prepared({recordReference:before.invoice_number,creditKind:'price_adjustment',creditLines:'1=10.00',reason:'Agreed lower price'});
 const want=expected(snap,1313,1313,1000);
 assert.deepEqual([p.payload.revenueMinor,p.payload.taxMinor,p.payload.creditMinor],[want.revenue,want.tax,want.revenue+want.tax]);
 assert.equal(p.payload.arMinor,p.payload.creditMinor,'The unpaid balance covers the whole credit, so nothing is paid back.');assert.equal(p.payload.refundMinor,0);
 assert.match(p.summary,/Shipping and other charges stay as invoiced/);assert.match(p.summary,/A person approves this/);
 // Nothing changes before approval; Watch only and the first 14 days stop approval.
 assert.equal(Number((await f.invoice(o.invoiceId)).balance_minor),Number(before.balance_minor)-300);
 await f.modes.save(db,ctx,107,{mode:'watch',revision:0});await assert.rejects(f.assistant.executeProposal(db,ctx,p.id),/Watch only/);await f.modes.save(db,ctx,107,{mode:'inherit',revision:1});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await assert.rejects(f.assistant.executeProposal(db,ctx,p.id),/first 14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const returns=await f.control('SALES_RETURNS'),tax=await f.control('SALES_TAX_PAYABLE'),ar=await f.control('ACCOUNTS_RECEIVABLE'),cash=await f.control('CASH');
 const done=await f.assistant.executeProposal(db,ctx,p.id);assert.equal(done.result.status,'COMPLETED');
 assert.equal(await f.control('SALES_RETURNS'),returns+want.revenue);assert.equal(await f.control('SALES_TAX_PAYABLE'),tax+want.tax);
 assert.equal(await f.control('ACCOUNTS_RECEIVABLE'),ar-p.payload.creditMinor);assert.equal(await f.control('CASH'),cash,'No money moved.');
 const after=await f.invoice(o.invoiceId);assert.equal(Number(after.total_minor),Number(before.total_minor)-p.payload.creditMinor);assert.equal(Number(after.balance_minor),Number(before.balance_minor)-300-p.payload.creditMinor);
 assert.equal(Number(after.total_minor),Number(after.subtotal_minor)-Number(after.discount_minor)+Number(after.tax_minor)+Number(after.charges_minor),'The invoice still adds up.');
 assert.equal((await f.assistant.executeProposal(db,ctx,p.id)).replayed,true,'Approving twice posts once.');
 // A second adjustment starts from the adjusted price, never the original one.
 await assert.rejects(f.prepare({recordReference:before.invoice_number,creditKind:'price_adjustment',creditLines:'1=11.00',reason:'Wrong'}),/lower than \$10\.00/);
 await assert.rejects(f.prepare({recordReference:before.invoice_number,creditKind:'price_adjustment',creditLines:'7=1.00',reason:'Wrong line'}),/not a line on this invoice/);
 // The rest is paid in full, so the next credit is money owed back: a person pays it.
 await f.pay(o,Number(after.balance_minor),'check');
 await f.subscribe('enterprise');
 const q=await f.prepared({recordReference:before.invoice_number,creditKind:'price_adjustment',creditLines:'1=9.00',reason:'Overcharged against the agreed price'});
 const second=expected(snap,1313,1000,900);assert.equal(q.payload.creditMinor,second.revenue+second.tax);assert.equal(q.payload.arMinor,0);assert.equal(q.payload.refundMinor,q.payload.creditMinor);
 const fromCash=Math.min(300,q.payload.creditMinor);
 assert.deepEqual(q.payload.parts.map(s=>[s.method,s.amountMinor,s.provider]),[['cash',fromCash,null],['check',q.payload.creditMinor-fromCash,null]].filter(x=>x[1]>0),'Oldest original payment first, each back the way it was paid.');
 const cashBefore=await f.control('CASH'),approved=await f.assistant.executeProposal(db,ctx,q.id);
 assert.equal(approved.result.status,'AWAITING_REFUND');assert.equal(await f.control('CASH'),cashBefore,'Approval books the credit but pays nothing.');
 assert.equal(await f.control('CUSTOMER_REFUNDS_PAYABLE'),-q.payload.refundMinor);
 const owed=await f.refunds(approved.result.creditId);assert(owed.every(x=>x.status==='TO_PAY'));
 const needs=await f.needs();for(const x of owed)assert(needs.some(n=>n.sourceId==='customer-credit-refund:'+x.id&&/Pay Receiver back/.test(n.title)));
 await assert.rejects(f.credits.markPaid(db,ctx,owed[0].id,{}),/how it was paid back/);
 for(const x of owed){await f.credits.markPaid(db,ctx,x.id,{reference:'Check '+x.id.slice(-4)});await f.credits.markPaid(db,ctx,x.id,{reference:'Check '+x.id.slice(-4)});}
 assert.equal(await f.control('CASH'),cashBefore-q.payload.refundMinor);assert.equal(await f.control('CUSTOMER_REFUNDS_PAYABLE'),0);
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.agent_customer_credits WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,approved.result.creditId])).rows[0].status,'COMPLETED');
 // Every approval and payment is audited.
 assert((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Customer %refund%' OR (workspace_id=$1 AND action LIKE 'Customer credit approved%')",[ctx.workspaceId])).rows[0].n>=3);
 // Goods returned on an invoice: the return is credited from the return, so the adjustment stops.
 const back=await f.order();const ret=require('../../src/operations/postgres-returns');const quarantine=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Credit test quarantine',kind:'warehouse'});
 await ret.requestCustomerReturn(db,ctx,{salesOrderId:back.salesOrderId,quarantineLocationId:quarantine.id,resolution:'REFUND',reason:'One back',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:back.lineIds[0],quantity:1}]});
 await assert.rejects(f.prepare({recordReference:(await f.invoice(back.invoiceId)).invoice_number,creditKind:'price_adjustment',creditLines:'1=10.00',reason:'Lower price'}),/were returned/);
});

test('a refund for an order cancelled after payment is prepared by StockChief, approved by a person and paid only by a person',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,o=await f.order({ship:0});
 const total=await require('../../src/sales/postgres-deposit-refunds').owed(db,ctx.workspaceId,(await db.query('SELECT * FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,o.salesOrderId])).rows[0]);
 assert(total>1000,'The order total is '+total);
 await f.workflows.recordCustomerDeposit(db,ctx,{customerId:'fixture-customer',salesOrderId:o.salesOrderId,amountMinor:1000,paymentDate:f.date,method:'bank_transfer',idempotencyKey:randomUUID()});
 await f.workflows.recordCustomerDeposit(db,ctx,{customerId:'fixture-customer',salesOrderId:o.salesOrderId,amountMinor:total-1000,paymentDate:f.date,method:'check',idempotencyKey:randomUUID()});
 // An open order is still waiting for its goods: nothing to refund yet.
 await assert.rejects(f.prepare({recordReference:o.salesOrderId,creditKind:'cancellation',reason:'Customer cancelled'}),/open order/);
 await f.workflows.cancelSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID(),reason:'Customer cancelled'});
 // Paused or Watch only: StockChief prepares nothing on its own.
 const auto=require('../../src/autopilot/postgres-service'),run=()=>f.credits.run(db,ctx.workspaceId);
 await auto.pause(db,ctx,{role:'owner'},'Hold refunds');assert.equal((await run()).prepared,0);await auto.resume(db,ctx,{role:'owner'});
 await f.modes.save(db,ctx,107,{mode:'watch',revision:0});assert.equal((await run()).prepared,0);await f.modes.save(db,ctx,107,{mode:'inherit',revision:1});
 // Growth is not included; Pro prepares it once for approval.
 await f.subscribe('growth');assert.equal((await run()).prepared,0);await f.subscribe('pro');
 assert.equal((await run()).prepared,1);assert.equal((await run()).prepared,0,'Prepared once.');
 const pending=(await db.query("SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND action_type='customer_credit.prepare' AND status='PENDING'",[ctx.workspaceId])).rows;
 assert.equal(pending.length,1);const p=pending[0];assert.equal(p.payload.kind,'cancellation');assert.equal(p.payload.refundMinor,total);
 assert.deepEqual(p.payload.parts.map(s=>[s.method,s.amountMinor]),[['bank_transfer',1000],['check',total-1000]]);assert.match(p.summary,/including any shipping paid in advance/);
 const cash=await f.control('CASH'),deposits=await f.control('CUSTOMER_DEPOSITS');
 const approved=await f.assistant.executeProposal(db,ctx,p.id);assert.equal(approved.result.status,'AWAITING_REFUND');
 assert.equal(await f.control('CASH'),cash,'Nothing is paid on approval.');
 // While the instruction waits, the money cannot be refunded a second time by hand.
 await assert.rejects(f.workflows.refundCustomerDeposit(db,ctx,{salesOrderId:o.salesOrderId,amountMinor:100,idempotencyKey:randomUUID()}),/more than this order has left/);
 assert.equal((await run()).prepared,0,'Approved money is not prepared again.');
 const parts=await f.refunds(approved.result.creditId);assert.deepEqual(parts.map(x=>x.status),['TO_PAY','TO_PAY']);
 for(const x of parts)await f.credits.markPaid(db,ctx,x.id,{reference:'Paid '+x.method});
 assert.equal(await f.control('CASH'),cash-total);assert.equal(await f.control('CUSTOMER_DEPOSITS'),deposits+total);
 assert.equal((await require('../../src/sales/postgres-deposit-refunds').forOrder(db,ctx.workspaceId,o.salesOrderId)).toRefundMinor,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM accounting_deposit_refunds WHERE workspace_id=$1 AND sales_order_id=$2 AND source_key LIKE 'agent-customer-credit:%'",[ctx.workspaceId,o.salesOrderId])).rows[0].n,2);
 // A shipped order with nothing paid beyond its invoices has nothing to give back.
 const shipped=await f.order();await assert.rejects(f.prepare({recordReference:shipped.salesOrderId,creditKind:'overpayment',reason:'Paid twice'}),/no paid money left/);
});

test('a Stripe-paid credit is refunded through Stripe only after approval and its exact confirmation; the page works on a phone',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,payments=require('../../src/payments/postgres-collection'),stripe=require('../../src/payments/providers/stripe'),at=new Date().toISOString();
 await f.subscribe('enterprise');
 await db.query(`INSERT INTO payment_connect_accounts(id,workspace_id,provider,provider_account_id,display_name,charges_enabled,livemode,checked_at,connected_by_user_id,created_at,updated_at)
  VALUES($1,$2,'stripe','acct_credit_refund','Test merchant',1,0,$3,$4,$3,$3)`,[randomUUID(),ctx.workspaceId,at,ctx.actorId]);
 const o=await f.order(),inv=await f.invoice(o.invoiceId);
 const request=await payments.queueRequest(db,ctx,o.salesOrderId,{provider:'stripe',purpose:'FULL'});
 await payments.executeRequestEffect(db,ctx.workspaceId,request.effectId,{accountContext:()=>({}),provider:{...stripe,createCustomer:async()=>({externalCustomerId:'cus_credit'}),createInvoice:async()=>({externalInvoiceId:'in_credit_refund',hostedUrl:'https://payments.example.test/in_credit_refund'})}});
 const paid=await payments.receiveVerifiedEvent(db,ctx.workspaceId,'stripe',{id:'evt_credit_refund',account:'acct_credit_refund',type:'invoice.paid',data:{object:{id:'in_credit_refund',amount_paid:Number(inv.total_minor),currency:'usd',status:'paid',payment_intent:'pi_credit_refund'}}});
 assert(paid.applied);
 const p=await f.prepared({recordReference:inv.invoice_number,creditKind:'price_adjustment',creditLines:'1=12.00',reason:'Agreed lower price'});
 assert.equal(p.payload.parts.length,1);assert.equal(p.payload.parts[0].provider,'stripe');const amount=p.payload.refundMinor;
 const cash=await f.control('CASH'),approved=await f.assistant.executeProposal(db,ctx,p.id);assert.equal(await f.control('CASH'),cash);
 const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='payment.refund.create' AND aggregate_id=$2",[ctx.workspaceId,approved.result.creditId])).rows[0];
 let posts=0,status='pending',reported=amount;
 const options={accountContext:()=>({stripeSecretKey:'sk_test_fixture',stripeAccountId:'acct_credit_refund',stripeFetch:async(url,input)=>{
  if(input.method==='POST'){posts++;assert.match(url,/\/refunds$/);assert.equal(input.body.get('payment_intent'),'pi_credit_refund');assert.equal(input.body.get('amount'),String(amount));assert.match(input.headers['Idempotency-Key'],/^agent-customer-credit-refund:/);}
  return new Response(JSON.stringify({id:'re_creditrefund',payment_intent:'pi_credit_refund',amount:reported,currency:'usd',status}),{status:200});}})};
 // Paused: nothing is dispatched.
 const auto=require('../../src/autopilot/postgres-service');await auto.pause(db,ctx,{role:'owner'},'Hold');
 await assert.rejects(payments.executeRefundEffect(db,ctx.workspaceId,effect.id,options),/Resume/);assert.equal(posts,0);await auto.resume(db,ctx,{role:'owner'});
 // An unconfirmed answer stays for review and books nothing; Stripe's exact confirmation books it once.
 await assert.rejects(payments.executeRefundEffect(db,ctx.workspaceId,effect.id,options),/not confirmed this exact refund/);assert.equal(posts,1);
 let part=(await f.refunds(approved.result.creditId))[0];assert.equal(part.status,'REVIEW');assert.equal(await f.control('CASH'),cash);
 assert((await f.needs()).some(n=>n.sourceId==='customer-credit-refund:'+part.id));
 status='succeeded';reported=amount-1;await assert.rejects(f.credits.verifyProviderPart(db,ctx,part.id,options),/not confirmed this exact refund/);assert.equal(await f.control('CASH'),cash);
 reported=amount;await f.credits.verifyProviderPart(db,ctx,part.id,options);await f.credits.verifyProviderPart(db,ctx,part.id,options).catch(()=>{});
 part=(await f.refunds(approved.result.creditId))[0];assert.equal(part.status,'SETTLED');assert.equal(part.external_refund_id,'re_creditrefund');assert.equal(posts,1,'Stripe is asked once.');
 assert.equal(await f.control('CASH'),cash-amount);assert.equal(await f.control('CUSTOMER_REFUNDS_PAYABLE'),0);
 // The page lists refunds to pay and records one as paid, at desktop and phone width.
 const o2=await f.order();await f.pay(o2,Number((await f.invoice(o2.invoiceId)).total_minor),'check');
 const q=await f.prepared({recordReference:(await f.invoice(o2.invoiceId)).invoice_number,creditKind:'price_adjustment',creditLines:'1=12.50',reason:'Agreed lower price'});await f.assistant.executeProposal(db,ctx,q.id);
 const page=await f.browser.get('/autopilot/reviews/customer-credits').expect(200);assert.match(page.text,/Refunds to pay or check/);assert.match(page.text,/Record as paid/);
 const form=await f.browser.post('/autopilot/customer-credits/prepare').type('form').send({_csrf:f.csrf(page.text),creditKind:'price_adjustment',recordReference:(await f.invoice(o2.invoiceId)).invoice_number,creditLines:'1=12.00',reason:'Second agreed price'}).expect(303);
 assert.match(form.headers.location,/^\/actions\//);await f.browser.get(form.headers.location).expect(200);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/autopilot/reviews/customer-credits');assert(await tab.locator('[data-credit-refunds]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'customer-credits-'+width+'.png'),fullPage:true});
   if(phone){await tab.locator('[data-credit-refund] input[name=reference]').first().fill('Check 2001');await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Record as paid'}).first().click()]);}
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_customer_credit_refunds WHERE workspace_id=$1 AND paid_reference='Check 2001' AND status='SETTLED'",[ctx.workspaceId])).rows[0].n,1);
});
