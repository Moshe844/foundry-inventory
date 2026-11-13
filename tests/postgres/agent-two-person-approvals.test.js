'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 205: two people approve anything over the amount the owner sets. Purchase
// orders are covered in agent-group-purchases; this covers stock write-offs,
// refunds and credits, and landed-cost postings.
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx}=f;
 const P=require('../../src/actions/permissions'),auth=require('../../src/domain/postgres-auth-service');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 async function member(name,grant){
  const account=await auth.createBusiness(db,{name,businessName:name+' elsewhere',email:randomUUID()+'@example.test',password:f.password});
  const id='member-'+randomUUID();
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,$4,'staff',$5,now()::text)`,[id,ctx.workspaceId,account.accountId,name,P.encodeGrant(grant)]);
  return {workspaceId:ctx.workspaceId,actorId:id,accountId:account.accountId,name};
 }
 const assistant=require('../../src/assistant/postgres-service'),two=require('../../src/autopilot/two-person-approval'),desk=require('../../src/autopilot/approval-desk');
 const prepare=async request=>{const r=await assistant.prepareAction(db,ctx,'Prepare this change',request);assert.equal(r.status,'PREPARED',JSON.stringify(r));return r.proposal.id;};
 const count=n=>prepare({action:'adjust',sku:'Parcel item',location:'Dispatch',countedQuantity:n,reason:'Shelf count'});
 const onHand=async()=>Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id])).rows[0].on_hand);
 const status=async id=>(await assistant.getProposal(db,ctx.workspaceId,id)).status;
 const routedTo=async id=>(await desk.desk(db,ctx.workspaceId)).rows.find(r=>r.key==='proposal:'+id);
 const audits=async action=>Number((await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);
 const threshold=async(amount,currency='USD')=>{const rule=await require('../../src/purchasing/dual-approval').setting(db,ctx.workspaceId);
  await require('../../src/purchasing/dual-approval').configure(db,ctx,{revision:rule.revision,currency,amount});};
 return {...f,P,member,assistant,two,desk,prepare,count,onHand,status,routedTo,audits,threshold,owner:{...ctx}};
}

test('write-offs over the owner’s amount need two different people who may approve them, bound to the exact amount',{timeout:900000},async t=>{
 const f=await fixture(t),{db,ctx,subscribe,browser,P,member,two,desk,count,onHand,status,routedTo,audits,threshold,owner}=f;
 const lead=await member('Stock lead',[P.VIEW,P.ADJUST]),second=await member('Second lead',[P.VIEW,P.ADJUST]),viewer=await member('Viewer',[P.VIEW]);
 // Starter and Growth: excluded. The amount cannot be set.
 for(const tier of ['starter','growth']){await subscribe(tier);await assert.rejects(threshold('5'),e=>e.code==='entitlement_required');
  assert.match((await browser.get('/autopilot/reviews/purchase-approval-threshold').expect(402)).text,/Pro/);}
 await subscribe('pro');await threshold('5');
 // Under the amount: one approval posts, as before.
 const small=await count(39);assert.equal((await two.approve(db,ctx,small)).status,'EXECUTED');assert.equal(await onHand(),39);
 // Over it ($9 at $1 a unit): the owner's approval is recorded and nothing moves.
 const big=await count(30);
 const review=await browser.get('/actions/'+big).expect(200);assert.match(review.text,/Two people approve this/);assert.match(review.text,/Approve as one of two people/);
 assert.deepEqual(await two.approve(db,owner,big),{required:true,status:'WAITING_FOR_SECOND_PERSON',people:['Owner']});
 assert.equal(await onHand(),39);assert.equal(await status(big),'PENDING');
 // No other path posts it on one approval, and the same person approving again counts once.
 await assert.rejects(f.assistant.executeProposal(db,ctx,big),/Two people must approve this/);
 assert.equal((await two.approve(db,owner,big)).status,'WAITING_FOR_SECOND_PERSON');
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_approval_signatures WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 // The second approval goes to someone who may approve it, never the first approver.
 let routed=await routedTo(big);assert.equal(routed.person.name,'Second lead');assert.match(routed.reason,/Needs a second approval: Owner approved it/);
 assert((await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,second.actorId)).some(n=>n.approvalRequest?.key==='proposal:'+big&&/Two people must approve it/.test(n.why)));
 // A limit below the amount, or no permission, means that person cannot be the second.
 await desk.saveLimit(db,ctx,{kind:'adjustment',userId:second.actorId,amount:'5',currency:'USD'});
 routed=await routedTo(big);assert.equal(routed.person.name,'Stock lead');
 await assert.rejects(two.approve(db,second,big),/above your \$5\.00 approval limit/);
 await assert.rejects(two.approve(db,viewer,big),/cannot approve|ADJUST|permission/i);
 // A changed amount needs fresh approvals: stock moved, so the count now writes off $8.
 const moved=await count(38);assert.equal((await two.approve(db,ctx,moved)).status,'EXECUTED');
 assert.equal((await two.view(db,owner,await f.assistant.getProposal(db,ctx.workspaceId,big))).people.length,0,'The earlier approval was for $9.');
 assert.equal((await two.approve(db,lead,big)).status,'WAITING_FOR_SECOND_PERSON');assert.equal(await onHand(),38);
 const posted=await two.approve(db,owner,big);assert.equal(posted.status,'EXECUTED');assert.equal(posted.twoPeople,true);assert.equal(await onHand(),30);
 assert.equal((await two.approve(db,owner,big)).replayed,true,'Approving again posts nothing twice.');
 assert.equal(await audits('Approved: waiting for a second person'),2);assert.equal(await audits('Approved as the second person'),1);
 // Another currency, or an amount it cannot work out, also needs two people.
 await threshold('1000','EUR');const foreign=await count(29);
 assert.equal((await two.approve(db,owner,foreign)).status,'WAITING_FOR_SECOND_PERSON');
 // Custom works the same; a downgrade below Pro refuses with the plan lock.
 await subscribe('enterprise');assert.equal((await two.approve(db,lead,foreign)).status,'EXECUTED');assert.equal(await onHand(),29);
 const held=await count(20);await subscribe('growth');
 await assert.rejects(two.approve(db,owner,held),e=>e.code==='entitlement_required');
 await assert.rejects(f.assistant.executeProposal(db,ctx,held),e=>e.code==='entitlement_required');
 assert.match((await browser.get('/actions/'+held).expect(200)).text,/needs Pro/);
 // Turning the rule off returns to one approval.
 await subscribe('pro');await threshold('');assert.equal((await two.approve(db,owner,held)).status,'EXECUTED');assert.equal(await onHand(),20);
 // The page shows who approved it, at desktop and phone width.
 await threshold('5');const shown=await count(10);await two.approve(db,owner,shown);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/actions/'+shown);assert.match(await tab.locator('[data-two-people]').innerText(),/Approved by Owner\. Waiting for a second person/);
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'two-person-approval-'+width+'.png'),fullPage:true});
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
});

test('refunds and credits over the amount need a second person; the owner posts what only the owner may',{timeout:900000},async t=>{
 const f=await fixture(t),{db,ctx,subscribe,P,member,assistant,two,status,routedTo,threshold,owner}=f;
 const refunds=await member('Refunds manager',[P.VIEW,P.VIEW_SALES,P.REFUND_CUSTOMER_RETURN]),lead=await member('Stock lead',[P.VIEW,P.ADJUST]);
 const at=new Date().toISOString();
 await db.query(`INSERT INTO accounting_tax_rates(id,workspace_id,name,jurisdiction,rate_millionths,applies_to,effective_from,active,created_by_user_id,created_at,updated_at)
  VALUES('two-tax',$1,'Sales tax','Fixture',82500,'SALES','2020-01-01',1,$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
 const sale=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,taxRateId:'two-tax',
  lines:[{skuId:f.item.skuIds[0],quantity:2,unitPriceMinor:1500}],idempotencyKey:randomUUID()});
 await f.workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
 const shipped=await f.workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:sale.lineIds[0],locationId:f.location.id,quantity:2}],shipment:{handover:'COLLECTED'}});
 const invoice=(await db.query('SELECT * FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,shipped.invoiceId])).rows[0];
 await subscribe('pro');await threshold('5');
 const prepared=await assistant.prepareAction(db,ctx,'Prepare this credit',{action:'customer_credit.prepare',recordReference:invoice.invoice_number,creditKind:'price_adjustment',creditLines:'1=10.00',reason:'Agreed lower price'});
 assert.equal(prepared.status,'PREPARED',JSON.stringify(prepared));const id=prepared.proposal.id,credit=(await assistant.getProposal(db,ctx.workspaceId,id)).payload.creditMinor;
 assert(credit>500,'The credit is over the $5 amount.');
 // The refunds manager approves first; only the owner may post a credit.
 assert.equal((await routedTo(id)).person.name,'Owner','The credit itself needs the owner.');
 assert.equal((await two.approve(db,refunds,id)).status,'WAITING_FOR_SECOND_PERSON');
 assert.equal((await routedTo(id)).person.name,'Owner');
 await assert.rejects(two.approve(db,lead,id),/cannot approve/);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_customer_credits WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0,'Nothing is booked yet.');
 const done=await two.approve(db,owner,id);assert.equal(done.status,'EXECUTED');assert.equal(done.result.status,'COMPLETED');
 // The owner first, then the second person: the owner posts it after both approved.
 const next=await assistant.prepareAction(db,ctx,'Prepare this credit',{action:'customer_credit.prepare',recordReference:invoice.invoice_number,creditKind:'price_adjustment',creditLines:'1=5.00',reason:'Agreed lower price'});
 assert.equal((await two.approve(db,owner,next.proposal.id)).status,'WAITING_FOR_SECOND_PERSON');
 assert.equal((await routedTo(next.proposal.id)).person.name,'Refunds manager');
 assert.equal((await two.approve(db,refunds,next.proposal.id)).status,'WAITING_FOR_OWNER');
 const back=await routedTo(next.proposal.id);assert.equal(back.person.name,'Owner');assert.match(back.reason,/approved it\. Approve it to post it/);
 assert.equal(await status(next.proposal.id),'PENDING');
 assert.equal((await two.approve(db,owner,next.proposal.id)).status,'EXECUTED');
 // Landed-cost postings: the same rule, whichever page or routine posts them.
 const landed={recordId:'landed-'+randomUUID(),fingerprint:'exact-evidence',training:{amountMinor:700,currency:'USD'}};
 assert.match(await two.landedCostWaiting(db,ctx,landed),/Two people must approve this/);
 await assert.rejects(db.transaction(c=>two.assertLandedCost(c,ctx,landed)),/Two people must approve this/);
 assert.equal(await two.landedCostWaiting(db,ctx,{...landed,training:{amountMinor:500,currency:'USD'}}),null,'At the amount, one person approves.');
});
