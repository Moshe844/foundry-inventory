'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const assistant=require('../../src/assistant/postgres-service');
test('saved freight and exact current plan authority combine only qualifying native draft purchases',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,workflows,browser,subscribe}=f;
  const service=require('../../src/purchasing/agent-freight-combine');
  const modes=require('../../src/autopilot/job-modes');
  const jobs=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const {addDays}=require('../../src/accounting/customer-money');
  const supplier='fixture-supplier',location=f.location.id,sku=f.item.skuIds[0];
  const path='/autopilot/reviews/combine-draft-orders';
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query("UPDATE suppliers SET ordinary_freight_minor=500,free_freight_threshold_minor=1000,freight_terms_currency='USD' WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId,supplier]);
  const create=(day,cost=6)=>workflows.createPurchaseOrder(db,ctx,{supplierId:supplier,destinationLocationId:location,
    expectedDate:addDays(today,day),currency:'USD',idempotencyKey:randomUUID(),
    lines:[{skuId:sku,quantityUnits:1,unitCost:cost}]});
  const charge=(order,kind,amount)=>db.query(`INSERT INTO purchase_order_charges(id,workspace_id,purchase_order_id,label,kind,amount_minor,source,created_at)
    VALUES($1,$2,$3,$4,$5,$6,'Checked supplier quote',now()::text)`,
    [randomUUID(),ctx.workspaceId,order.purchaseOrderId,kind,kind,amount]);
  const orders=async ids=>(await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id',
    [ctx.workspaceId,ids])).rows.map(r=>r.status);
  const charges=async id=>(await db.query('SELECT kind,amount_minor FROM purchase_order_charges WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY kind',
    [ctx.workspaceId,id])).rows.map(r=>[r.kind,Number(r.amount_minor)]);
  const args=(maximum,trainingProposal='',revision=0)=>({supplierId:supplier,locationId:location,maximum,trainingProposal,confirmed:'yes',revision});
  const process=async()=>{
    const job=await jobs.processOne(db,handlers,{owner:'freight-test',kinds:[service.kind]});
    assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
    return job.result;
  };
  const queue=()=>service.enqueue(db,ctx.workspaceId,randomUUID());
  await subscribe('starter');
  await assert.rejects(service.configure(db,ctx,args('12')),e=>e.code==='entitlement_required');
  assert.deepEqual(await queue(),{skipped:true});
  await subscribe('growth');
  const a=await create(2),b=await create(2);
  await charge(a,'freight',500);await charge(b,'freight',500);await charge(a,'insurance',200);
  const sourceOrders=[a.poNumber,b.poNumber].join(',');
  await assert.rejects(service.configure(db,ctx,args('12')),/approved freight-saving example/);
  const plan=await assistant.prepareAction(db,ctx,'Review these purchases with freight terms',
    {action:'purchase_order.combine_drafts',sourceOrders});
  assert.match(plan.proposal.summary,/freight falls from \$10\.00 to \$0\.00/);
  const approved=await assistant.executeProposal(db,ctx,plan.proposal.id);
  assert.equal(approved.result.freight.savedMinor,1000);
  assert.deepEqual(await charges(approved.result.drafts[0]),[['insurance',200]]);
  assert.deepEqual(await orders([a.purchaseOrderId,b.purchaseOrderId]),['CANCELLED','CANCELLED']);
  await assert.rejects(service.configure(db,ctx,args('13',plan.proposal.id)),/within the saved limit/);
  const page=await browser.get(path).expect(200);
  assert.match(page.text,/Completed freight-saving example/);
  await browser.post(path+'/rule').type('form').send({_csrf:f.csrf(page.text),...args('12',plan.proposal.id)}).expect(303);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const grown=[await create(3),await create(3)];
  await queue();assert.equal((await process()).combined,1);
  assert.deepEqual(await orders(grown.map(o=>o.purchaseOrderId)),['CANCELLED','CANCELLED']);
  await queue();assert.equal((await process()).combined,0);

  await subscribe('pro');await service.configure(db,ctx,args('12','',1));
  const taxed=[await create(4),await create(4)];await charge(taxed[0],'tax',75);
  const pro=[await create(5),await create(5)];
  await queue();assert.equal((await process()).combined,1);
  assert.deepEqual(await orders(pro.map(o=>o.purchaseOrderId)),['CANCELLED','CANCELLED']);
  assert.deepEqual(await orders(taxed.map(o=>o.purchaseOrderId)),['DRAFT','DRAFT']);
  assert.deepEqual(await charges(taxed[0].purchaseOrderId),[['tax',75]]);

  await subscribe('enterprise');await service.configure(db,ctx,args('12','',2));
  const custom=[await create(6,4),await create(6,4)];
  await modes.save(db,ctx,24,{mode:'watch',revision:0});
  await queue();assert.equal((await process()).held,true);
  await modes.save(db,ctx,24,{mode:'routine',revision:1});
  await queue();await subscribe('starter');assert.equal((await process()).held,true);
  await subscribe('growth');await queue();assert.equal((await process()).combined,0);
  await subscribe('enterprise');await queue();assert.equal((await process()).combined,1);
  assert.deepEqual(await orders(custom.map(o=>o.purchaseOrderId)),['CANCELLED','CANCELLED']);
  const {rows:[replacement]}=await db.query(`SELECT id,status FROM purchase_orders WHERE workspace_id=$1
    AND source_detail::jsonb->'sourcePurchaseOrderIds' @> $2::jsonb`,[ctx.workspaceId,JSON.stringify(custom.map(o=>o.purchaseOrderId))]);
  assert.equal(replacement.status,'DRAFT');
  assert.deepEqual(await charges(replacement.id),[['freight',500]]);
});
test('vacation coverage sends open purchases and transfers only to a currently qualified deputy',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,workflows,browser,subscribe}=f;
  const auth=require('../../src/domain/postgres-auth-service'),p=require('../../src/actions/permissions'),vacation=require('../../src/autopilot/vacation-deputy');
  const colleague=await auth.createBusiness(db,{name:'Holiday buyer',businessName:'Independent business',email:randomUUID()+'@example.test',password:f.password});
  const actor={workspaceId:ctx.workspaceId,actorId:randomUUID()},grant=[p.VIEW_PURCHASING,p.APPROVE_PO,p.VIEW_TRANSFERS,p.APPROVE_TRANSFER];
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,po_approval_limit_minor,po_approval_currency,created_at)
    VALUES($1,$2,$3,'Holiday buyer','staff',$4,2000,'USD',now()::text)`,[actor.actorId,ctx.workspaceId,colleague.accountId,p.encodeGrant(grant)]);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),add=require('../../src/accounting/customer-money').addDays;
  const input={deputyId:actor.actorId,start:today,end:add(today,3),revision:0},path='/autopilot/reviews/vacation-deputy';
  await subscribe('starter');await browser.get(path).expect(402);await assert.rejects(vacation.save(db,ctx,input),/Growth/);
  await subscribe('growth');const page=await browser.get(path).expect(200);assert.match(page.text,/Holiday buyer/);
  await assert.rejects(vacation.save(db,actor,input),/owner/);
  await assert.rejects(vacation.save(db,ctx,{...input,deputyId:colleague.userId}),/current team member/);
  await browser.post('/autopilot/vacation-deputy').type('form').send({_csrf:f.csrf(page.text),...input}).expect(303);
  await assert.rejects(vacation.save(db,ctx,input),/changed/);
  const buy=cost=>workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:1,unitCost:cost}]});
  const small=(await buy(20)).purchaseOrderId,large=(await buy(21)).purchaseOrderId;
  const dst=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Vacation transfer site',kind:'warehouse'});
  const transfers=require('../../src/transfers/postgres-transfer-service');
  const move=await transfers.request(db,ctx,{fromLocationId:f.location.id,toLocationId:dst.id,reason:'Balance stock',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:1}]});
  const received=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,actor.actorId)).filter(r=>r.sourceId?.startsWith('vacation-')).map(r=>r.sourceId.slice(9)).sort();
  for(const tier of ['growth','pro','enterprise']){await subscribe(tier);assert.deepEqual(await received(),[small,move.id].sort());}
  await subscribe('starter');assert.deepEqual(await received(),[]);
  await subscribe('growth');await vacation.save(db,ctx,{...input,start:add(today,1),revision:1});assert.deepEqual(await received(),[]);
  await vacation.save(db,ctx,{...input,revision:2});await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[actor.actorId,p.encodeGrant([p.VIEW_PURCHASING,p.APPROVE_PO])]);
  assert.deepEqual(await received(),[small]);
  await assert.rejects(workflows.approvePurchaseOrder(db,actor,large,{idempotencyKey:randomUUID()}),/above your/);
  assert.equal((await workflows.approvePurchaseOrder(db,actor,small,{idempotencyKey:randomUUID()})).status,'APPROVED');assert.deepEqual(await received(),[]);
  await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[actor.actorId,p.encodeGrant(grant)]);assert.deepEqual(await received(),[move.id]);
  await vacation.save(db,ctx,{remove:'1',revision:3});assert.deepEqual(await received(),[]);
});
test('purchase threshold binds two authorized people to the exact amount, items and terms',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,workflows,browser,subscribe}=f;
  const dual=require('../../src/purchasing/dual-approval'),auth=require('../../src/domain/postgres-auth-service');
  const authz=require('../../src/actions/permissions');
  const manager=await auth.createBusiness(db,{name:'Manager',businessName:'Separate inventory',email:randomUUID()+'@example.test',password:f.password});
  const staff={workspaceId:ctx.workspaceId,actorId:'staff-'+randomUUID()};
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at)
    VALUES($1,$2,$3,'Buyer','staff',$4,now()::text)`,[staff.actorId,ctx.workspaceId,manager.accountId,authz.encodeGrant([authz.VIEW_PURCHASING,authz.APPROVE_PO])]);
  const seniorAccount=await auth.createBusiness(db,{name:'Senior buyer',businessName:'Other inventory',email:randomUUID()+'@example.test',password:f.password});
  const senior='senior-'+randomUUID();
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,po_approval_limit_minor,po_approval_currency,created_at)
    VALUES($1,$2,$3,'Senior buyer','staff',$4,25000,'USD',now()::text)`,[senior,ctx.workspaceId,seniorAccount.accountId,authz.encodeGrant([authz.VIEW_PURCHASING,authz.APPROVE_PO])]);
  await db.query("UPDATE users SET po_approval_limit_minor=2000,po_approval_currency='USD' WHERE id=$1",[staff.actorId]);
  const settings='/autopilot/reviews/purchase-approval-threshold',save='/autopilot/purchase-approval-threshold';
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    const page=await browser.get(settings).expect(402);assert.match(page.text,/Pro/);
    await assert.rejects(dual.configure(db,ctx,{revision:0,currency:'USD',amount:'10'}),e=>e.code==='entitlement_required');
  }
  await subscribe('pro');
  const page=await browser.get(settings).expect(200);
  await browser.post(save).type('form').send({_csrf:f.csrf(page.text),revision:0,currency:'USD',amount:'10'}).expect(303);
  await assert.rejects(dual.configure(db,staff,{revision:1,currency:'USD',amount:'11'}),/owner/);
  await assert.rejects(dual.configure(db,ctx,{revision:0,currency:'USD',amount:'11'}),/changed/);
  const create=currency=>workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,currency,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:2,unitCost:5}]});
  const direct=(id,actor=ctx)=>workflows.approvePurchaseOrder(db,actor,id,{idempotencyKey:randomUUID()});
  const exactly=await create('USD');assert.equal((await direct(exactly.purchaseOrderId)).status,'APPROVED');
  const order=await create('USD'),id=order.purchaseOrderId,url='/purchasing/orders/'+id;
  await db.query(`INSERT INTO purchase_order_charges(id,workspace_id,purchase_order_id,label,kind,amount_minor,created_at)
    VALUES($1,$2,$3,'Freight','freight',1,now()::text)`,[randomUUID(),ctx.workspaceId,id]);
  const digest=async()=>(await dual.view(db,ctx,id)).digest;
  const ui=await browser.get(url).expect(200),original=await digest();assert.match(ui.text,/Two-person approval/);assert.match(ui.text,/\$10\.01/);
  await assert.rejects(direct(id),/Two authorized people/);
  const ownerSign=()=>browser.post(url+'/sign').type('form').send({_csrf:f.csrf(ui.text),digest:original}).expect(303);
  await ownerSign();await ownerSign();assert.equal((await dual.view(db,ctx,id)).people.length,1);
  const routing=require('../../src/purchasing/approval-routing'),inbox=require('../../src/projections/postgres-service');
  const hasPurchase=async actor=>(await inbox.needs(db,ctx.workspaceId,actor)).some(entry=>entry.sourceId==='po-signature-'+id);
  assert.equal(await hasPurchase(staff.actorId),true);assert.equal(await hasPurchase(senior),false);assert.equal(await hasPurchase(ctx.actorId),false);
  await db.query("UPDATE stockchief_runtime.purchase_approval_signatures SET signed_at=now()-interval '25 hours' WHERE purchase_order_id=$1",[id]);
  assert.equal(await hasPurchase(staff.actorId),false);assert.equal(await hasPurchase(senior),true);
  const escalation=await browser.get('/autopilot/reviews/purchase-review-escalation').expect(200);
  assert.match(escalation.text,/Senior buyer/);assert.match(escalation.text,/response window passed/);
  await assert.rejects(workflows.placePurchaseOrder(db,ctx,id,{idempotencyKey:randomUUID()}),/Approve the purchase order/);
  await assert.rejects(dual.sign(db,{workspaceId:manager.workspaceId,actorId:manager.userId},id,original),e=>['not_found','entitlement_required'].includes(e.code));
  await db.query('UPDATE purchase_order_lines SET unit_cost=6,line_total=12 WHERE id=$1',[order.lineIds[0]]);
  await assert.rejects(dual.sign(db,staff,id,original),/changed/);
  const current=await digest();assert.notEqual(current,original);
  await subscribe('growth');await assert.rejects(dual.sign(db,ctx,id,current),/Pro/);
  assert.deepEqual(await routing.assignments(db,ctx.workspaceId),[]);await browser.get('/autopilot/reviews/purchase-review-routing').expect(402);
  await assert.rejects(direct(id),/Pro/);assert.equal((await dual.view(db,ctx,id)).locked,true);
  await subscribe('enterprise');
  await db.query("UPDATE users SET po_approval_limit_minor=1200,po_approval_currency='USD' WHERE id=$1",[staff.actorId]);
  await assert.rejects(dual.sign(db,staff,id,current),/above your/);
  await db.query('UPDATE users SET po_approval_limit_minor=1300 WHERE id=$1',[staff.actorId]);
  assert.equal((await dual.sign(db,staff,id,current)).status,'WAITING_FOR_SECOND_SIGNER');
  await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[staff.actorId,authz.encodeGrant([authz.VIEW_PURCHASING])]);
  assert.equal((await dual.sign(db,ctx,id,current)).status,'WAITING_FOR_SECOND_SIGNER');
  await assert.rejects(direct(id),/Two authorized people/);
  await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[staff.actorId,authz.encodeGrant([authz.VIEW_PURCHASING,authz.APPROVE_PO])]);
  assert.equal((await dual.sign(db,staff,id,current)).status,'APPROVED');
  assert.equal((await dual.sign(db,staff,id,current)).status,'APPROVED');
  assert.deepEqual(await routing.assignments(db,ctx.workspaceId),[]);
  assert.equal((await db.query("SELECT count(*)::int n FROM purchase_order_events WHERE purchase_order_id=$1 AND event='approved'",[id])).rows[0].n,1);
  await subscribe('starter');await assert.rejects(workflows.placePurchaseOrder(db,ctx,id,{idempotencyKey:randomUUID()}),/Pro/);
  await assert.rejects(dual.guardOrderMessage(db,ctx.workspaceId,id),/Pro/);
  await subscribe('pro');assert.equal((await workflows.placePurchaseOrder(db,ctx,id,{idempotencyKey:randomUUID()})).status,'ORDERED');
  const foreign=await create('EUR');await assert.rejects(direct(foreign.purchaseOrderId),/Two authorized people/);
});
test('regrouping draft POs preserves money and units, blocks stale drafts and enforces every tier',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10});
  const {db,ctx,subscribe,workflows,browser}=f,sku=f.item.skuIds[0];
  const second=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Second dock',kind:'warehouse'});
  await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
  const create=(locations,qty=3)=>workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:locations[0],
    expectedDate:'2027-02-10',currency:'USD',idempotencyKey:randomUUID(),lines:locations.map(destinationLocationId=>({skuId:sku,quantityUnits:qty,unitCost:2,destinationLocationId}))});
  const a=await create([f.location.id]),b=await create([second.id]),refs=a.poNumber+', '+b.poNumber;
  const combine=()=>assistant.prepareAction(db,ctx,'Combine these POs',{action:'purchase_order.combine_drafts',sourceOrders:refs});
  const split=(order,strategy,extra={})=>assistant.prepareAction(db,ctx,'Split the PO',{action:'purchase_order.split_draft',sourceOrders:order.poNumber,splitStrategy:strategy,...extra});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    if(tier==='starter')await assert.rejects(combine(),e=>e.code==='entitlement_required');else assert.match((await combine()).proposal.summary,/\$12.00/);
    if(tier==='starter'||tier==='growth')await assert.rejects(split(a,'budget',{budgetAmount:'4'}),e=>e.code==='entitlement_required');
    else assert.match((await split(a,'budget',{budgetAmount:'4'})).proposal.summary,/2 unsent/);
  }
  const page=await browser.get('/autopilot/reviews/combine-draft-orders').expect(200);
  const prepareWeb=await browser.post('/autopilot/reviews/combine-draft-orders/regroup').type('form').send({_csrf:f.csrf(page.text),sourceOrders:refs}).expect(303);
  const id=prepareWeb.headers.location.split('/').pop(),rival=await combine();
  await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,id),/Growth/);
  await subscribe('growth');
  const approved=await assistant.executeProposal(db,ctx,id),combinedId=approved.result.drafts[0];
  await assistant.executeProposal(db,ctx,id);
  await assert.rejects(assistant.executeProposal(db,ctx,rival.proposal.id),/unsent draft/);
  const row=async id=>(await db.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  assert.equal((await row(a.purchaseOrderId)).status,'CANCELLED');assert.equal((await row(b.purchaseOrderId)).status,'CANCELLED');
  const combined=await row(combinedId);
  await subscribe('pro');
  const parts=await split({poNumber:combined.po_number},'warehouse');
  await subscribe('growth');await assert.rejects(assistant.executeProposal(db,ctx,parts.proposal.id),/Pro/);
  await subscribe('pro');
  const warehouses=(await assistant.executeProposal(db,ctx,parts.proposal.id)).result.drafts;
  assert.equal(warehouses.length,2);
  assert.deepEqual(new Set(await Promise.all(warehouses.map(async id=>(await row(id)).destination_location_id))),new Set([f.location.id,second.id]));
  const dated=await create([f.location.id,second.id]);
  const byDate=await split(dated,'delivery-date',{lineDates:JSON.stringify([{line:1,date:'2027-03-01'},{line:2,date:'2027-03-04'}])});
  const dates=(await assistant.executeProposal(db,ctx,byDate.proposal.id)).result.drafts;
  assert.deepEqual((await Promise.all(dates.map(async id=>(await row(id)).expected_date))).sort(),['2027-03-01','2027-03-04']);
  const budgetOrder=await create([f.location.id],7);
  const budget=await split(budgetOrder,'budget',{budgetAmount:'6'});
  await subscribe('enterprise');
  const budgets=(await assistant.executeProposal(db,ctx,budget.proposal.id)).result.drafts;
  const summary=await db.query(`SELECT purchase_order_id,sum(quantity_units) units,sum(line_total) value FROM purchase_order_lines
    WHERE workspace_id=$1 AND purchase_order_id=ANY($2::text[]) GROUP BY purchase_order_id`,[ctx.workspaceId,budgets]);
  assert.deepEqual(summary.rows.map(r=>Number(r.value)).sort((a,b)=>a-b),[2,6,6]);
  assert.equal(summary.rows.reduce((n,r)=>n+Number(r.units),0),7);
  const stale=await create([f.location.id],7),check=await split(stale,'budget',{budgetAmount:'6'});
  await workflows.approvePurchaseOrder(db,ctx,stale.purchaseOrderId,{idempotencyKey:randomUUID()});
  await assert.rejects(assistant.executeProposal(db,ctx,check.proposal.id),/unsent draft/);
  assert.equal((await row(stale.purchaseOrderId)).status,'APPROVED');
  await subscribe('growth');
  const training=require('../../src/autopilot/draft-authority'),autonomy=require('../../src/autopilot/postgres-service');
  await autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const example=await browser.get('/actions/'+id).query({draftMaximum:'12.00'}).expect(200);
  assert.match(example.text,/1 of 1 completed matching draft operations/);
  const rulesUrl='/actions/'+id+'/draft-rule';
  await browser.post(rulesUrl).type('form').send({_csrf:f.csrf(example.text),revision:0,maximum:'12',mode:'save'}).expect(303);
  const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
  async function mission(qty){
    const source=[await create([f.location.id],qty),await create([second.id],qty)];
    const proposal=await assistant.prepareAction(db,ctx,'Combine the named supplier drafts',{action:'purchase_order.combine_drafts',sourceOrders:source.map(o=>o.poNumber).join(',')});
    await plans.save(db,ctx,'Combine drafts and review incoming orders',randomUUID(),[{contract:registry.get('purchase_order.combine_drafts'),args:{},dependsOn:[]},
      {contract:registry.get('read.agent_review'),args:{agentJob:'supplier-packs'},dependsOn:[0]}],[{result:proposal},{result:{status:'CLARIFY'}}]);
    return proposal.proposal.id;
  }
  const under=await mission(2),over=await mission(5);
  await assert.rejects(assistant.executeMission(db,ctx,over),e=>e.code==='entitlement_required');
  const trained=await assistant.executeMission(db,ctx,under);
  assert.equal(trained.result.drafts.length,1);
  const revoked=await mission(2);
  await training.save(db,ctx,id,{mode:'remove',revision:1});
  await assert.rejects(assistant.executeMission(db,ctx,revoked),e=>e.code==='entitlement_required');
  await subscribe('pro');
  await training.save(db,ctx,parts.proposal.id,{mode:'save',revision:0,maximum:'12.00'});
  const another=await create([f.location.id,second.id]),splitAgain=await split(another,'warehouse');
  await plans.save(db,ctx,'Split orders by receiving location and review supplier packs',randomUUID(),
    [{contract:registry.get('purchase_order.split_draft'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'supplier-packs'},dependsOn:[0]}],
    [{result:splitAgain},{result:{status:'CLARIFY'}}]);
  const automaticSplit=await assistant.executeMission(db,ctx,splitAgain.proposal.id);
  assert.equal(automaticSplit.result.drafts.length,2);
  const roi=await require('../../src/autopilot/time-saved').report(db,ctx);
  assert.equal(roi.rows.find(r=>r.key==='split-purchase').count,4);
  assert.equal(roi.rows.find(r=>r.key==='combine-purchases').count,2);
});
