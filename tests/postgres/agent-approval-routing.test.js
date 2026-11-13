'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 176: each approval goes to the right person by role and amount.
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx}=f;
 const P=require('../../src/actions/permissions'),auth=require('../../src/domain/postgres-auth-service');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 async function member(name,grant,{limit=null,warehouses=null}={}){
  const account=await auth.createBusiness(db,{name,businessName:name+' elsewhere',email:randomUUID()+'@example.test',password:f.password});
  const id='member-'+randomUUID();
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,po_approval_limit_minor,po_approval_currency,warehouse_location_ids,created_at)
   VALUES($1,$2,$3,$4,'staff',$5,$6,$7,$8::jsonb,now()::text)`,[id,ctx.workspaceId,account.accountId,name,P.encodeGrant(grant),limit,limit==null?null:'USD',warehouses?JSON.stringify(warehouses):null]);
  return {workspaceId:ctx.workspaceId,actorId:id,accountId:account.accountId,name};
 }
 const desk=require('../../src/autopilot/approval-desk'),projection=require('../../src/projections/postgres-service');
 const routed=async actor=>(await projection.needs(db,ctx.workspaceId,actor.actorId)).filter(r=>r.approvalRequest).map(r=>r.approvalRequest.key).sort();
 const audits=async action=>Number((await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE $2',[ctx.workspaceId,action])).rows[0].n);
 return {...f,P,member,desk,routed,audits,assistant:require('../../src/assistant/postgres-service'),modes:require('../../src/autopilot/job-modes')};
}

test('approvals of every kind go to the person whose role, access and limit cover them, on Pro and Custom only',{timeout:900000},async t=>{
 const f=await fixture(t),{db,ctx,workflows,browser,subscribe,P,member,desk,routed,audits,assistant}=f,owner={...ctx,name:'Owner'};
 const buyer=await member('Buyer',[P.VIEW_PURCHASING,P.APPROVE_PO],{limit:5000});
 const senior=await member('Senior buyer',[P.VIEW_PURCHASING,P.APPROVE_PO]);
 const lead=await member('Stock lead',[P.VIEW,P.ADJUST,P.VIEW_TRANSFERS,P.APPROVE_TRANSFER]);
 const clerk=await member('Branch clerk',[P.VIEW,P.ADJUST,P.VIEW_TRANSFERS,P.APPROVE_TRANSFER],{warehouses:[f.location.id]});
 const returns=await member('Returns desk',[P.VIEW_PURCHASING,P.AUTHORIZE_SUPPLIER_RETURN]);
 // One waiting approval of each kind, all in the business's own records.
 const buy=cost=>workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:2,unitCost:cost}]});
 const small=await buy(10),large=await buy(50);
 const annex=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Annex',kind:'warehouse'});
 const move=await require('../../src/transfers/postgres-transfer-service').request(db,ctx,{fromLocationId:f.location.id,toLocationId:annex.id,reason:'Balance stock',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:1}]});
 const rtv=await require('../../src/operations/postgres-returns').requestSupplierReturn(db,ctx,{supplierId:'fixture-supplier',reason:'Damaged',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1}]});
 const prepare=async request=>{const r=await assistant.prepareAction(db,ctx,'Prepare this change',request);assert.equal(r.status,'PREPARED',JSON.stringify(r));return r.proposal.id;};
 const shelf=await prepare({action:'adjust',sku:'Parcel item',location:'Dispatch',countedQuantity:38,reason:'Shelf count'});
 const big=await prepare({action:'adjust',sku:'Parcel item',location:'Dispatch',countedQuantity:30,reason:'Shelf count'});
 const cost=await prepare({action:'set_purchase_cost',sku:'Parcel item',amount:'1.25',currency:'USD'});
 const keys={small:'purchase:'+small.purchaseOrderId,large:'purchase:'+large.purchaseOrderId,move:'transfer:'+move.id,rtv:'supplier_return:'+rtv.supplierReturnId,
  shelf:'proposal:'+shelf,big:'proposal:'+big,cost:'proposal:'+cost};
 const page=desk.path,review='/autopilot/reviews/purchase-review-routing';
 const olderPlan=await browser.get(page).expect(200);
 assert.match(olderPlan.text,/data-agent-plan-locked/);
 assert.ok(olderPlan.text.includes('This work is available on Pro and above.'));
 // Starter and Growth: excluded. Nothing is routed and the plan lock shows.
 for(const tier of ['starter','growth']){
  await subscribe(tier);
  for(const person of [buyer,senior,lead,returns])assert.deepEqual(await routed(person),[],tier+' routes nothing');
  assert.deepEqual(await routed(owner),Object.values(keys).sort(),tier+': every approval is the owner’s (job 174).');
  assert.match((await browser.get(page).expect(402)).text,/Pro/);await browser.get(review).expect(402);
  await assert.rejects(desk.saveRule(db,ctx,{kind:'purchase',userId:senior.actorId}),e=>e.code==='entitlement_required');
  await assert.rejects(desk.saveLimit(db,ctx,{kind:'adjustment',userId:lead.actorId,amount:'5',currency:'USD'}),e=>e.code==='entitlement_required');
 }
 await subscribe('pro');
 // Amount authority for stock changes: the stock lead approves write-offs up to $5.
 await assert.rejects(desk.saveLimit(db,lead,{kind:'adjustment',userId:lead.actorId,amount:'5',currency:'USD'}),/owner/);
 await desk.saveLimit(db,ctx,{kind:'adjustment',userId:lead.actorId,amount:'5',currency:'USD'});
 assert.equal(await audits('Approval limit changed'),1);
 const rows=Object.fromEntries((await desk.desk(db,ctx.workspaceId)).rows.map(r=>[r.key,r]));
 assert.deepEqual([rows[keys.small].amountMinor,rows[keys.large].amountMinor,rows[keys.shelf].amountMinor,rows[keys.big].amountMinor],[2000,10000,200,1000],'Amounts come from the records: PO totals and counted units at their recorded cost.');
 assert.deepEqual(await routed(buyer),[keys.small],'The buyer’s $50 limit covers the $20 order only.');
 assert.deepEqual(await routed(senior),[keys.large],'The $100 order goes to the buyer without a limit.');
 assert.deepEqual(await routed(lead),[keys.shelf,keys.move].sort(),'The $2 write-off and the transfer go to the stock lead.');
 assert.deepEqual(await routed(clerk),[],'Someone who sees only one warehouse gets no approvals.');
 assert.deepEqual(await routed(returns),[keys.rtv]);
 assert.deepEqual(await routed(owner),[keys.big,keys.cost].sort(),'Above every limit, or no one else allowed: the owner.');
 assert.match(rows[keys.big].reason,/No one else/);assert.match(rows[keys.small].reason,/Buyer can approve purchase orders up to \$50\.00/);
 // The approve path checks the same limit: over it is refused, within it posts.
 await assert.rejects(assistant.executeProposal(db,lead,big),/above your \$5\.00 approval limit/);
 assert.equal((await assistant.executeProposal(db,lead,shelf)).status,'EXECUTED');
 assert.deepEqual(await routed(lead),[keys.move],'A decided approval leaves Needs you.');
 // The owner's rule: purchase orders over $10 go to the senior buyer, not the owner or the buyer.
 await assert.rejects(desk.saveRule(db,ctx,{kind:'purchase',amount:'10',currency:'USD',userId:returns.actorId}),/cannot approve purchase orders/);
 await assert.rejects(desk.saveRule(db,ctx,{kind:'purchase',amount:'10',currency:'USD',userId:clerk.actorId}),/cannot approve|only sees/);
 await assert.rejects(desk.saveRule(db,buyer,{kind:'purchase',userId:senior.actorId}),/owner/);
 const rule=await desk.saveRule(db,ctx,{kind:'purchase',amount:'10',currency:'USD',userId:senior.actorId});
 assert.equal(rule.rule,'Purchase orders over $10.00 go to Senior buyer');
 assert.equal((await desk.saveRule(db,ctx,{kind:'purchase',amount:'10',currency:'USD',userId:senior.actorId})).unchanged,true,'Saving the same rule again changes nothing.');
 assert.deepEqual(await routed(buyer),[]);assert.deepEqual(await routed(senior),[keys.small,keys.large].sort());
 assert.match((await desk.desk(db,ctx.workspaceId)).rows.find(r=>r.key===keys.small).reason,/Your rule: Purchase orders over \$10\.00 go to Senior buyer/);
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_approval_routes WHERE workspace_id=$1 AND enabled",[ctx.workspaceId])).rows[0].n,1,'The rule is one saved rule against the plan allowance.');
 // Current permissions decide: without approval permission the senior buyer drops out.
 await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[senior.actorId,P.encodeGrant([P.VIEW_PURCHASING])]);
 assert.deepEqual(await routed(senior),[]);assert.deepEqual(await routed(buyer),[keys.small]);assert(( await routed(owner)).includes(keys.large));
 await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[senior.actorId,P.encodeGrant([P.VIEW_PURCHASING,P.APPROVE_PO])]);
 // The routine records where each approval went and audits it once.
 const first=await desk.run(db,ctx.workspaceId);assert(first.routed>=5);
 const logged=await audits('Approval sent to %');
 assert.deepEqual((await desk.run(db,ctx.workspaceId)).routed,0,'Running again changes nothing.');assert.equal(await audits('Approval sent to %'),logged);
 // Held: Ask me first, pause, Watch only and the first 14 days keep every approval with the owner.
 const everything=Object.values(keys).filter(k=>k!==keys.shelf).sort();
 await f.modes.save(db,ctx,176,{mode:'ask',revision:0});
 assert.deepEqual(await routed(owner),everything);assert.deepEqual(await routed(senior),[]);
 assert.deepEqual(await desk.run(db,ctx.workspaceId),{held:'This job is set to Ask me first. It needs individual approval.'});
 await f.modes.save(db,ctx,176,{mode:'inherit',revision:1});assert.deepEqual(await routed(senior),[keys.small,keys.large].sort());
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);assert.deepEqual(await routed(owner),everything);
 await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.deepEqual(await routed(owner),everything);assert.deepEqual(await routed(lead),[]);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // Custom routes the same way; removing the rule sends the small order back to the buyer.
 await subscribe('enterprise');
 await desk.saveRule(db,ctx,{remove:rule.id});assert.equal(await audits('Approval routing rule removed'),1);
 assert.deepEqual(await routed(buyer),[keys.small]);assert.deepEqual(await routed(senior),[keys.large]);
 // An approval the owner alone may give stays with the owner.
 assert.equal(desk.route({kind:'refund',permission:P.REFUND_CUSTOMER_RETURN,readPermission:P.VIEW_SALES,ownerOnly:true,amountMinor:100,currency:'USD'},
  {people:await desk.people(db,ctx.workspaceId),limits:[],rules:[],held:null}).reason,'Only the owner can approve this.');
 // The routing page and the review list render on Pro.
 await subscribe('pro');
 const screen=await browser.get(page).expect(200);
 assert.match(screen.text,/Who approves what/);assert.match(screen.text,/Senior buyer/);assert.match(screen.text,/Stock adjustments and write-offs up to/);
 await browser.post(page+'/rules').type('form').send({_csrf:f.csrf(screen.text),kind:'transfer',userId:lead.actorId}).expect(303);
 assert.match((await browser.get(page).expect(200)).text,/Transfers go to Stock lead/);
 assert.match((await browser.get(review).expect(200)).text,/Set who approves what/);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+page);assert(await tab.locator('[data-approval-desk]').isVisible());assert(await tab.locator('[data-approval-limits]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'approval-routing-'+width+'.png'),fullPage:true});
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
});
