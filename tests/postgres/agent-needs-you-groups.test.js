'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 174: Needs you is one list of every decision, and similar approvals are
// approved or declined in one tap, each through its own service.
test('similar approvals are decided in one tap on every plan, each checked on its own, and a failure stays',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,workflows,browser,subscribe}=f;
 const P=require('../../src/actions/permissions'),auth=require('../../src/domain/postgres-auth-service');
 const projection=require('../../src/projections/postgres-service'),groups=require('../../src/autopilot/approval-groups'),assistant=require('../../src/assistant/postgres-service');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const account=await auth.createBusiness(db,{name:'Buyer',businessName:'Buyer elsewhere',email:randomUUID()+'@example.test',password:f.password});
 const buyer={workspaceId:ctx.workspaceId,actorId:'member-'+randomUUID()};
 await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,po_approval_limit_minor,po_approval_currency,created_at)
  VALUES($1,$2,$3,'Buyer','staff',$4,5000,'USD',now()::text)`,[buyer.actorId,ctx.workspaceId,account.accountId,P.encodeGrant([P.VIEW_PURCHASING,P.APPROVE_PO])]);
 await db.query(`INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('other-supplier',$1,'Other parts','active','USD',now()::text,now()::text)`,[ctx.workspaceId]);
 const annex=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Annex',kind:'warehouse'});
 const buy=(cost,supplierId='fixture-supplier')=>workflows.createPurchaseOrder(db,ctx,{supplierId,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:2,unitCost:cost}]});
 const orders=[await buy(10),await buy(10),await buy(15)],lone=await buy(10,'other-supplier');
 const transfers=require('../../src/transfers/postgres-transfer-service');
 const moves=[];for(let n=0;n<3;n++)moves.push(await transfers.request(db,ctx,{fromLocationId:f.location.id,toLocationId:annex.id,reason:'Balance stock',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:10}]}));
 const count=async n=>(await assistant.prepareAction(db,ctx,'Count correction',{action:'adjust',sku:'Parcel item',location:'Dispatch',countedQuantity:n,reason:'Shelf count'})).proposal.id;
 const counts=[await count(39),await count(38)];
 const cost=async amount=>(await assistant.prepareAction(db,ctx,'Cost change',{action:'set_purchase_cost',sku:'Parcel item',amount,currency:'USD'})).proposal.id;
 const costs=[await cost('1.25'),await cost('1.40')];
 const mine=async(actor=ctx)=>groups.fromItems(await projection.needs(db,ctx.workspaceId,actor.actorId));
 const byLabel=async(label,actor=ctx)=>(await mine(actor)).find(g=>g.label===label);
 const status=async(table,id)=>(await db.query(`SELECT status FROM ${table} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id])).rows[0].status;
 const post=async(group,decision,token=randomUUID(),as=browser)=>{const page=await as.get('/needs-you').expect(200);
  await as.post('/needs-you/groups').type('form').send({_csrf:f.csrf(page.text),group:group.key,decision,token,keys:group.items.map(i=>i.key)}).expect(303);return token;};
 // Every plan: the owner sees the same kinds together. One order from another supplier is not grouped.
 for(const tier of ['starter','growth']){
  await subscribe(tier);
  assert.deepEqual((await mine()).map(g=>[g.label,g.count]).sort(),[['Purchase cost changes',2],['Purchase orders from Fixture parts',3],['Stock count corrections at Dispatch that lower stock',2],['Transfers from Dispatch to Annex',3]],tier);
  assert.deepEqual(await mine(buyer),[],'Below Pro every approval stays with the owner.');
 }
 const items=await projection.needs(db,ctx.workspaceId,ctx.actorId);
 assert(items.some(i=>i.approvalRequest?.key==='purchase:'+lone.purchaseOrderId&&!i.approvalRequest.group?.key?.includes('fixture')),'The lone order is in the one list.');
 const page=await browser.get('/needs-you').expect(200);
 assert.match(page.text,/Approve similar ones together/);assert.match(page.text,/Approve all 3/);assert.match(page.text,/Decline all 2/);
 // Starter: approve all three orders. Each goes through the purchase approval service.
 await subscribe('starter');
 const purchases=await byLabel('Purchase orders from Fixture parts'),token=await post(purchases,'approve');
 for(const o of orders)assert.equal(await status('purchase_orders',o.purchaseOrderId),'APPROVED');
 assert.equal(await byLabel('Purchase orders from Fixture parts'),undefined,'Decided approvals leave Needs you.');
 // Replaying the same tap changes nothing.
 const events=async()=>(await db.query("SELECT count(*)::int n FROM purchase_order_events WHERE workspace_id=$1 AND event='approved'",[ctx.workspaceId])).rows[0].n,before=await events();
 const again=await groups.decide(db,ctx,{group:purchases.key,decision:'approve',token,keys:purchases.items.map(i=>i.key)});
 assert.equal(again.done.length,0);assert.equal(again.gone.length,3);assert.equal(await events(),before);
 // Growth: approve all transfers through the transfer service.
 await subscribe('growth');
 const moving=await byLabel('Transfers from Dispatch to Annex');
 assert.equal((await groups.decide(db,ctx,{group:moving.key,decision:'approve',token:randomUUID(),keys:moving.items.map(i=>i.key)})).done.length,3);
 assert.deepEqual(await Promise.all(moves.map(m=>status('inventory_transfers',m.id))),['APPROVED','APPROVED','APPROVED']);
 // Two cost changes for one product: the second no longer matches once the first is in. It stays, with its reason.
 const costing=await byLabel('Purchase cost changes');
 const result=await groups.decide(db,ctx,{group:costing.key,decision:'approve',token:randomUUID(),keys:costing.items.map(i=>i.key)});
 assert.equal(result.done.length,1);assert.equal(result.failed.length,1);assert.match(result.failed[0].reason,/changed after this preview was prepared/);
 assert.deepEqual(await Promise.all(costs.map(async id=>(await assistant.getProposal(db,ctx.workspaceId,id)).status)),['EXECUTED','PENDING']);
 assert((await projection.needs(db,ctx.workspaceId,ctx.actorId)).some(i=>i.approvalRequest?.key==='proposal:'+costs[1]),'The failed one still waits.');
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Approved a group in Needs you'",[ctx.workspaceId])).rows[0].n,3,'One audit entry per tap; the replay did nothing.');
 // Watch only for this job, Watch only for StockChief and the first 14 days: no groups, every item still listed.
 const modes=require('../../src/autopilot/job-modes');
 const countGroup=(await byLabel('Stock count corrections at Dispatch that lower stock')).key;
 await modes.save(db,ctx,174,{mode:'watch',revision:0});assert.deepEqual(await mine(),[]);
 assert((await projection.needs(db,ctx.workspaceId,ctx.actorId)).some(i=>i.approvalRequest?.key==='proposal:'+counts[0]));
 assert.deepEqual((await groups.decide(db,ctx,{group:countGroup,decision:'approve',token:randomUUID(),keys:['proposal:'+counts[0]]})).done,[],'Nothing is decided as a group.');
 await modes.save(db,ctx,174,{mode:'inherit',revision:1});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.deepEqual(await mine(),[]);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // Pause stops StockChief's own work, not a person's decision.
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);
 const declining=await byLabel('Stock count corrections at Dispatch that lower stock');assert.equal(declining.count,2);
 await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 // Someone else cannot decide the owner's group.
 assert.deepEqual((await groups.decide(db,buyer,{group:declining.key,decision:'decline',token:randomUUID(),keys:declining.items.map(i=>i.key)})).done,[]);
 await post(declining,'decline');
 for(const id of counts)assert.equal((await assistant.getProposal(db,ctx.workspaceId,id)).status,'CANCELLED');
 // Pro: the buyer's own group, inside the buyer's $50 limit. Two-person orders are never grouped.
 await subscribe('pro');
 const more=[await buy(10),await buy(10),await buy(30)];
 await require('../../src/purchasing/dual-approval').configure(db,ctx,{revision:0,currency:'USD',amount:'50'});
 const buyerGroup=await byLabel('Purchase orders from Fixture parts',buyer);
 assert.deepEqual(buyerGroup.items.map(i=>i.key).sort(),[more[0],more[1]].map(o=>'purchase:'+o.purchaseOrderId).sort(),'The $60 order is over the buyer’s limit and over the two-person amount.');
 assert.equal(await byLabel('Purchase orders from Fixture parts'),undefined);
 assert.equal((await groups.decide(db,buyer,{group:buyerGroup.key,decision:'approve',token:randomUUID(),keys:buyerGroup.items.map(i=>i.key)})).done.length,2);
 for(const o of more.slice(0,2))assert.equal(await status('purchase_orders',o.purchaseOrderId),'APPROVED');
 assert.equal(await status('purchase_orders',more[2].purchaseOrderId),'DRAFT');
 // Custom groups the same way; the page renders at desktop and phone width.
 await subscribe('enterprise');
 const extra=[await count(37),await count(36)];
 assert.equal((await byLabel('Stock count corrections at Dispatch that lower stock')).count,2);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/needs-you');assert(await tab.locator('[data-approval-groups]').isVisible());await tab.waitForTimeout(1500);
   assert.equal(await tab.locator('[data-approval-group]').count(),1);
   const decisionLinks=await tab.locator('article.ny-card .ny-action').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
   for(const id of extra)assert(decisionLinks.includes('/actions/'+id),'Every grouped approval is still listed on its own.');
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'needs-you-groups-'+width+'.png'),fullPage:true});
   if(phone)await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Approve all 2'}).first().click()]);
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 assert.equal((await assistant.getProposal(db,ctx.workspaceId,extra[1])).status,'EXECUTED','Tapping approve on the phone approved the group.');
});
