'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

const legacyTerms=async(db,f,tier)=>db.query(`UPDATE account_subscriptions SET plan_version_id=(SELECT id FROM commercial_plan_versions
  WHERE plan_id=$2 AND (configuration->>'offerId') IS DISTINCT FROM 'agent-v3' ORDER BY version_number LIMIT 1) WHERE account_id=$1`,[f.owner.accountId,tier]);

test('job 208: a run of identical approvals becomes a taught rule after one owner confirmation, inside the plan and the owner limits',{timeout:420000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,workflows,browser}=f;
 await subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const assistant=require('../../src/assistant/postgres-service'),learning=require('../../src/autopilot/approval-learning'),draft=require('../../src/autopilot/draft-authority');
 const sku=f.item.skuIds[0];
 const drafts=async(lines)=>{const id=(await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines})).purchaseOrderId;
  return (await db.query('SELECT po_number FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0].po_number;};
 // One combine of two drafts, approved (or declined) by the owner.
 const combine=async(units,{decline=false}={})=>{const numbers=[await drafts([{skuId:sku,quantityUnits:units,unitCost:2}]),await drafts([{skuId:sku,quantityUnits:1,unitCost:2}])].join(',');
  const p=await assistant.prepareAction(db,ctx,'Combine these supplier drafts '+randomUUID(),{action:'purchase_order.combine_drafts',sourceOrders:numbers});
  if(decline)await assistant.cancelProposal(db,ctx,p.proposal.id);else await assistant.executeProposal(db,ctx,p.proposal.id);return p.proposal.id;};
 const split=async()=>{const number=await drafts([{skuId:sku,quantityUnits:2,unitCost:2}]);
  const p=await assistant.prepareAction(db,ctx,'Split this supplier draft '+randomUUID(),{action:'purchase_order.split_draft',sourceOrders:number,splitStrategy:'budget',budgetAmount:'2'});
  await assistant.executeProposal(db,ctx,p.proposal.id);return p.proposal.id;};

 // Three approvals, then a "no", then four approvals: the run restarts after the no.
 for(const units of [1,2,3])await combine(units);
 await combine(1,{decline:true});
 const ids=[];for(const units of [1,2,4,1])ids.push(await combine(units));
 assert.equal((await learning.offers(db,ctx)).length,0,'Four approvals after a decline are not yet a run of five');
 ids.push(await combine(2));
 let offers=await learning.offers(db,ctx);
 assert.equal(offers.length,1);const offer=offers[0];
 assert.equal(offer.action,'purchase_order.combine_drafts');assert.equal(offer.run,5,'Only approvals after the last decline count');
 assert.equal(offer.latestId,ids.at(-1));assert.equal(offer.maximumMinor,1000,'The largest approved amount in the run: 4 units plus 1 at $2');assert.equal(offer.capped,null);
 // Job 210 runs alongside: the past approvals in this scope against the offered amount.
 assert.match(offer.test.sections[0].summary,/8 of 8 completed approvals/);
 assert.equal(offer.test.sections[0].rows.filter(r=>/you said no/.test(r['Would have'])).length,1);
 // Before the rule, Growth still drafts this routine for approval.
 const latest=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE id=$1',[offer.latestId])).rows[0].payload;
 assert.equal(await draft.trained(db,ctx.workspaceId,'purchase_order.combine_drafts',latest),false);

 // Each plan follows its own mode.
 await subscribe('starter');await assert.rejects(learning.offers(db,ctx),e=>e.code==='entitlement_required');
 await browser.get(learning.path).expect(402);
 await legacyTerms(db,f,'growth');assert.match((await browser.get(learning.path).expect(200)).text,/data-agent-plan-locked/);
 await subscribe('pro');
 assert.equal((await learning.offers(db,ctx)).length,0,'Pro combines drafts alone, so there is nothing to learn');
 const splits=[];for(let i=0;i<5;i++)splits.push(await split());
 offers=await learning.offers(db,ctx);assert.deepEqual(offers.map(o=>o.action),['purchase_order.split_draft'],'Pro learns split drafts, which it is trained for');
 await subscribe('enterprise');assert.equal((await learning.offers(db,ctx)).length,0,'Custom does both alone without training');
 // "Keep asking" holds until a new run of approvals.
 await subscribe('pro');
 await learning.dismiss(db,ctx,{latestId:splits.at(-1)});assert.equal((await learning.offers(db,ctx)).length,0);
 assert.equal((await db.query("SELECT decision FROM stockchief_runtime.agent_learning_decisions WHERE workspace_id=$1 AND job_id=208",[ctx.workspaceId])).rows[0].decision,'declined');
 for(let i=0;i<5;i++)await split();
 assert.equal((await learning.offers(db,ctx)).length,1,'Five new approvals after keep-asking make a new offer');

 // Owner choices and shadow mode come first.
 await subscribe('growth');
 const modes=require('../../src/autopilot/job-modes');
 await modes.save(db,ctx,24,{mode:'ask',revision:0});
 assert.equal((await learning.offers(db,ctx)).length,0,'Ask me first for the job means keep asking');
 await modes.save(db,ctx,24,{mode:'inherit',revision:1});
 await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
 assert.equal((await learning.offers(db,ctx)).length,0,'Nothing is learned while StockChief only watches');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // The owner's own limits cap the amount and a different currency stops the offer.
 const limit=learning.ownerLimit;const state={plan:'growth',terms:{offerId:'agent-v3'}};
 assert.equal((await limit(db,ctx.workspaceId,state,'purchase_order.reorder_drafts','USD')).minor,50000);
 assert.match((await limit(db,ctx.workspaceId,state,'purchase_order.reorder_drafts','EUR')).stop,/EUR/);
 // Anything on the "always needs a person" list is never learned: supplier prices over the review threshold.
 for(let i=0;i<5;i++)await db.query(`INSERT INTO stockchief_runtime.assistant_action_proposals(id,workspace_id,actor_user_id,action_type,payload,summary,source_message,status,idempotency_key,result,created_at,executed_at)
   VALUES($1,$2,$3,'catalog.supplier_price_list',$4,'Supplier prices','Supplier prices','EXECUTED',$1,'{}',now(),now())`,
  [randomUUID(),ctx.workspaceId,ctx.actorId,JSON.stringify({overReviewThreshold:true,training:draft.scope('fixture-supplier','USD',500,[135],'Fixture parts · supplier prices')})]);
 await subscribe('pro');assert.ok(!(await learning.offers(db,ctx)).some(o=>o.action==='catalog.supplier_price_list'));
 await subscribe('growth');

 // Needs you shows the offer to the owner.
 const notices=require('../../src/autopilot/operational-notices');
 await notices.refresh(db,ctx.workspaceId);assert((await notices.inbox(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='agent-notice-208'));

 // The page shows the run and its test, and one confirmation saves the taught rule.
 const page=await browser.get(learning.path).expect(200);
 assert.match(page.text,/data-learning-offer/);assert.match(page.text,/What it would have done/);assert.match(page.text,/data-rule-test/);
 const csrf=f.csrf(page.text);
 await browser.post(learning.path+'/confirm').type('form').send({_csrf:csrf,latestId:offer.latestId,maximum:'1001'});
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0,'A raised amount is refused');
 await browser.post(learning.path+'/confirm').type('form').send({_csrf:csrf,latestId:offer.latestId,maximum:String(offer.maximumMinor)}).expect(303);
 const rule=(await db.query("SELECT maximum_minor::int,authorized_by FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type='purchase_order.combine_drafts'",[ctx.workspaceId])).rows;
 assert.deepEqual(rule,[{maximum_minor:1000,authorized_by:ctx.actorId}]);
 const autonomy=require('../../src/autopilot/postgres-service');
 assert.equal(await draft.trained(db,ctx.workspaceId,'purchase_order.combine_drafts',latest),false,'Until routine work is switched on, it still asks');
 await autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 assert.equal(await draft.trained(db,ctx.workspaceId,'purchase_order.combine_drafts',latest),true,'Growth now does this routine alone');
 await autonomy.pause(db,ctx,{role:'owner'},'Stocktake');
 assert.equal(await draft.trained(db,ctx.workspaceId,'purchase_order.combine_drafts',latest),false,'Pause stops it');
 await autonomy.resume(db,ctx,{role:'owner'});
 assert.equal(await draft.trained(db,ctx.workspaceId,'purchase_order.combine_drafts',{...latest,training:{...latest.training,amountMinor:1001}}),false,'Above the learned amount it still asks');
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Stopped asking about a routine you always approved'",[ctx.workspaceId])).rows[0].n,1);
 assert.equal((await learning.confirm(db,ctx,{latestId:offer.latestId,maximum:String(offer.maximumMinor)})).replayed,true);
 assert.equal((await learning.offers(db,ctx)).length,0,'An existing rule is never raised');
 await notices.refresh(db,ctx.workspaceId);assert(!(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).some(r=>r.sourceId==='agent-notice-208'));
 assert.match((await browser.get(learning.path).expect(200)).text,/Up to \$10\.00/);
 assert.equal(await f.balance(),20,'Learning changes no stock');

 // Pick releases keep their own approvals: releases a person approved at Dispatch, one discarded.
 const release=require('../../src/warehouse/agent-pick-release');
 const recorded=async(status,minutes)=>db.query(`INSERT INTO stockchief_runtime.agent_pick_releases(id,workspace_id,location_id,status,authorization_kind,plan,fingerprint,request_key,prepared_by,released_by,released_at,created_at)
   VALUES($1,$2,$3,$4,$5,$6,$1,$1,$7,$8,$9,now()-make_interval(mins=>$10))`,[randomUUID(),ctx.workspaceId,f.location.id,status,status==='RELEASED'?'INDIVIDUAL':null,
  JSON.stringify({location:'Dispatch',orders:[{id:'a'},{id:'b'},{id:'c'}]}),ctx.actorId,status==='RELEASED'?ctx.actorId:null,status==='RELEASED'?new Date(Date.now()-minutes*60000).toISOString():null,minutes]);
 for(const [status,minutes] of [['RELEASED',100],['RELEASED',90],['DISCARDED',80],['RELEASED',70],['RELEASED',60],['RELEASED',50],['RELEASED',40]])await recorded(status,minutes);
 assert(!(await learning.offers(db,ctx)).some(o=>o.source==='release'),'Four releases after a discarded one are not a run');
 await recorded('RELEASED',30);
 const released=(await learning.offers(db,ctx)).find(o=>o.source==='release');
 assert.equal(released.run,5);assert.equal(released.maximum,'3 orders at a time');assert.match(released.test.sections[0].summary,/released orders at Dispatch 5 times in a row/);
 await subscribe('pro');assert(!(await learning.offers(db,ctx)).some(o=>o.source==='release'),'Pro releases alone without training');await subscribe('growth');
 assert.equal(await release.trained(db,ctx.workspaceId,{locationId:f.location.id}),false);
 await learning.confirm(db,ctx,{latestId:released.latestId,maximum:'0'});
 assert.deepEqual((await db.query('SELECT batch_orders,automatic,enabled FROM stockchief_runtime.agent_pick_release_rules WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,f.location.id])).rows,[{batch_orders:3,automatic:true,enabled:true}]);
 assert.equal(await release.trained(db,ctx.workspaceId,{locationId:f.location.id}),true,'Growth now releases at Dispatch alone');
 assert.equal((await learning.confirm(db,ctx,{latestId:released.latestId,maximum:'0'})).replayed,true);
 assert.match((await browser.get(learning.path).expect(200)).text,/Release ready orders at Dispatch/);
});

test('job 209: the same fix made again and again becomes a suggested rule, tested first and counted against the rule allowance once accepted',{timeout:480000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,workflows,browser}=f;
 await subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const engine=require('../../src/domain/postgres-inventory-engine'),rules=require('../../src/autopilot/correction-rules'),autonomy=require('../../src/autopilot/postgres-service');
 const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
 const draftPo=async units=>workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:units,unitCost:1}]});
 const declineReorder=async()=>{const plan=await autonomy.plan(db,ctx.workspaceId,{onlySkuIds:[sku]});
  const item=plan.created.find(w=>w.recommendedAction.type==='purchase'&&w.recommendedAction.destinationLocationId===f.location.id);
  assert(item,'The planner suggests a reorder at Dispatch: '+JSON.stringify(plan.considered));await autonomy.cancel(db,ctx,{role:'owner'},item.id);};
 await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,purchase_unit,units_per_purchase_unit,last_unit_cost,is_preferred,is_active,created_at,updated_at)
   VALUES($1,$2,'fixture-supplier',$3,'unit',1,1,1,1,now()::text,now()::text) ON CONFLICT(workspace_id,supplier_id,sku_id) DO NOTHING`,[randomUUID(),ctx.workspaceId,sku]);
 await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at)
   VALUES($1,$2,$3,$4,30,40,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,sku,f.location.id]);
 // Declined the reorder suggestion three times at 20, 19 and 18 in stock, correcting the count at Dispatch after each.
 const counts=require('../../src/accounting/postgres-physical-count');
 for(const quantity of [19,18,17]){await declineReorder();await counts.apply(db,ctx,{skuId:sku,locationId:f.location.id,countedQuantity:quantity,reasonCode:'count',idempotencyKey:randomUUID()});}
 // A past order that a supplier minimum would have changed, then the quantity raised on three drafts.
 const past=await draftPo(2);await workflows.approvePurchaseOrder(db,ctx,past.purchaseOrderId,{idempotencyKey:randomUUID()});
 for(let i=0;i<3;i++){const po=await draftPo(2);await workflows.reviseDraftPurchaseOrderLine(db,ctx,po.purchaseOrderId,{lineId:po.lineIds[0],quantityUnits:6,idempotencyKey:randomUUID()});}
 let found=await rules.suggestions(db,ctx);const by=p=>found.find(s=>s.pattern===p);
 assert.deepEqual(found.map(s=>s.pattern).sort(),['declined-reorder','order-quantity','stock-count']);
 assert.equal(by('declined-reorder').rule,'Reorder '+code+' at Dispatch only when it falls to 17.');
 assert.match(by('declined-reorder').test.sections[0].summary,/Under the current reorder point of 30 it would have asked 0 times/);
 assert.match(by('stock-count').rule,/^Count Dispatch with a recurring blind count/);
 assert.match(by('stock-count').test.sections[0].summary,/found the 3 corrections recorded there/);
 // Not now: it stays away until the same fix is made again.
 await rules.dismiss(db,ctx,{pattern:'declined-reorder',scope:by('declined-reorder').scope});
 assert.equal((await db.query("SELECT decision FROM stockchief_runtime.agent_learning_decisions WHERE workspace_id=$1 AND job_id=209 AND kind='declined-reorder'",[ctx.workspaceId])).rows[0].decision,'declined');
 found=await rules.suggestions(db,ctx,{test:false});assert(!found.some(s=>s.pattern==='declined-reorder'));
 await declineReorder();
 found=await rules.suggestions(db,ctx,{test:false});assert.equal(by('declined-reorder').times,4,'Declining again brings it back');
 // Moved stock from Dispatch to Shop three times, each time when Shop had one or none.
 const shop=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shop',kind:'warehouse'});
 const move=()=>engine.transfer(db,ctx,{skuId:sku,sourceLocationId:f.location.id,destinationLocationId:shop.id,quantity:3,idempotencyKey:randomUUID()});
 const sell=quantity=>engine.issue(db,ctx,{skuId:sku,locationId:shop.id,quantity,idempotencyKey:randomUUID()});
 await move();await sell(2);await move();await sell(3);await move();

 found=await rules.suggestions(db,ctx);
 assert.deepEqual(found.map(s=>s.pattern).sort(),['declined-reorder','order-quantity','repeat-move','stock-count']);
 assert.equal(by('order-quantity').rule,'Order at least 6 of '+code+' from Fixture parts.');
 assert.match(by('order-quantity').test.sections[0].summary,/^1 of 2 past order lines would have changed, adding 4 units/);
 assert.ok(by('repeat-move').rule.startsWith('Keep '+code+' stocked at Shop: reorder when it falls to 1, up to 3.'));
 assert.match(by('repeat-move').test.sections[0].summary,/would have asked for stock 2 times\. Stock never ran out\./);
 assert.equal(by('declined-reorder').rule,'Reorder '+code+' at Dispatch only when it falls to 16.','The newest decline at 17 lowers it');

 // Each plan follows its own mode.
 await subscribe('starter');await assert.rejects(rules.suggestions(db,ctx),e=>e.code==='entitlement_required');await browser.get(rules.path).expect(402);
 await legacyTerms(db,f,'growth');assert.match((await browser.get(rules.path).expect(200)).text,/data-agent-plan-locked/);
 for(const tier of ['pro','enterprise','growth']){await subscribe(tier);assert.equal((await rules.suggestions(db,ctx,{test:false})).length,4,tier);}

 // Needs you points to the suggestions.
 const notices=require('../../src/autopilot/operational-notices');await notices.refresh(db,ctx.workspaceId);
 const notice=(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).find(r=>r.sourceId==='agent-notice-209');
 assert.equal(notice.href,rules.path);assert.match(notice.happened,/^4 fixes/);

 // The page shows each rule with its test; accepting saves a standing rule.
 const page=await browser.get(rules.path).expect(200);
 assert.match(page.text,/data-correction-rule="order-quantity"/);assert.match(page.text,/What it would have done/);assert.match(page.text,/data-rule-test-summary/);
 const csrf=f.csrf(page.text);
 const used=async()=>(await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_instruction_rule_targets WHERE workspace_id=$1 AND active',[ctx.workspaceId])).rows[0].n;
 await browser.post(rules.path+'/accept').type('form').send({_csrf:csrf,pattern:'order-quantity',scope:by('order-quantity').scope}).expect(303);
 assert.equal((await db.query("SELECT minimum_order_quantity::int n FROM supplier_items WHERE workspace_id=$1 AND supplier_id='fixture-supplier' AND sku_id=$2",[ctx.workspaceId,sku])).rows[0].n,6);
 assert.equal(await used(),1,'The accepted suggestion is one of the plan’s rules');
 const audit=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Accepted a rule suggested by repeated corrections'",[ctx.workspaceId])).rows;
 assert.equal(audit.length,1);assert.match(audit[0].after_state.test.sections[0].summary,/^1 of 2 past order lines/);
 assert.equal((await rules.accept(db,ctx,{pattern:'order-quantity',scope:by('order-quantity').scope})).replayed,true);
 assert.equal((await rules.suggestions(db,ctx,{test:false})).length,3);
 // Over the allowance, accepting is refused and nothing changes.
 await db.query("INSERT INTO stockchief_runtime.agent_draft_rules(workspace_id,action_type,scope_key,scope_label,currency,maximum_minor,authorized_by) SELECT $1,'sales_order.repeat','allowance-'||i,'Existing routine','USD',100,$2 FROM generate_series(1,49)i",[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(rules.accept(db,ctx,{pattern:'repeat-move',scope:by('repeat-move').scope}),/50 active rules/);
 assert.equal((await db.query('SELECT count(*)::int n FROM reorder_policies WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,shop.id])).rows[0].n,0);
 await db.query("DELETE FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND scope_key LIKE 'allowance-%'",[ctx.workspaceId]);
 // Facts that no longer match stop the accept; shadow mode only watches.
 await assert.rejects(rules.accept(db,ctx,{pattern:'repeat-move',scope:'another:route:here'}),/changed since you saw it/);
 await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
 await assert.rejects(rules.accept(db,ctx,{pattern:'repeat-move',scope:by('repeat-move').scope}),/watching/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const moved=await rules.accept(db,ctx,{pattern:'repeat-move',scope:by('repeat-move').scope});
 assert.deepEqual((await db.query('SELECT reorder_point::int,target_stock::int FROM reorder_policies WHERE workspace_id=$1 AND location_id=$2',[ctx.workspaceId,shop.id])).rows,[{reorder_point:1,target_stock:3}]);
 assert.equal((await require('../../src/manager/postgres-operating-instructions').get(db,ctx.workspaceId,moved.ruleId)).status,'APPROVED');
 assert.equal(await used(),2);
 // The count rule is set where the counter and day are chosen.
 await assert.rejects(rules.accept(db,ctx,{pattern:'stock-count',scope:by('stock-count').scope}),/who counts/);
 assert.match((await browser.get(by('stock-count').link).expect(200)).text,new RegExp('value="'+f.location.id+'" selected'));
 assert.equal(await f.balance(),12,'Suggestions and rules post no stock');
});

test('job 210: a new rule is replayed on past records before it is switched on, on the plans that include it',{timeout:420000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,browser}=f;
 await subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const engine=require('../../src/domain/postgres-inventory-engine'),rehearsal=require('../../src/autopilot/rule-rehearsal'),reviews=require('../../src/autopilot/job-reviews');
 const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
 const shop=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shop',kind:'warehouse'});
 await engine.transfer(db,ctx,{skuId:sku,sourceLocationId:f.location.id,destinationLocationId:shop.id,quantity:5,idempotencyKey:randomUUID()});
 for(const quantity of [2,2,1])await engine.issue(db,ctx,{skuId:sku,locationId:shop.id,quantity,idempotencyKey:randomUUID()});
 const instructions=require('../../src/manager/postgres-operating-instructions');
 const proposal=await instructions.prepareReorderForm(db,ctx,{sku:code,location:'Shop',reorderPoint:'2',targetStock:'6'});
 const records=async()=>(await db.query(`SELECT (SELECT count(*) FROM movements WHERE workspace_id=$1)::int m,(SELECT count(*) FROM purchase_orders WHERE workspace_id=$1)::int p,
   (SELECT count(*) FROM reorder_policies WHERE workspace_id=$1)::int r`,[ctx.workspaceId])).rows[0];
 const before=await records();

 // Growth: the rule's page replays it before the switch.
 let page=await browser.get('/operating-instructions/'+proposal.id).expect(200);
 assert.match(page.text,/What it would have done/);
 assert.match(page.text,/stock reached 2 or less 1 time, so it would have asked for stock 1 time\. Stock ran out 1 time\./);
 assert.match(page.text,/Asked for 5 more to reach 6/);
 const review=await reviews.run(db,ctx,'rule-tests');
 assert.equal(review.rows.length,1);assert.equal(review.rows[0].link,'/operating-instructions/'+proposal.id);assert.match(review.rows[0]['What it would have done'],/1 time/);
 // Starter and older terms keep job 207's rules without the test; the review is locked.
 await subscribe('starter');
 assert.doesNotMatch((await browser.get('/operating-instructions/'+proposal.id).expect(200)).text,/data-rule-test/);
 await assert.rejects(reviews.run(db,ctx,'rule-tests'),e=>e.code==='entitlement_required');
 await legacyTerms(db,f,'pro');assert.doesNotMatch((await browser.get('/operating-instructions/'+proposal.id).expect(200)).text,/data-rule-test/);
 for(const tier of ['pro','enterprise'])
  {await subscribe(tier);assert.match((await browser.get('/operating-instructions/'+proposal.id).expect(200)).text,/data-rule-test-summary/,tier);}
 await subscribe('growth');

 // Every rule kind with a quantity to replay, from the same records.
 const shopChange=c=>({skuId:sku,displayName:'Parcel item',locationId:shop.id,locationName:'Shop',operation:'set',...c});
 assert.match((await rehearsal.change(db,ctx.workspaceId,shopChange({domain:'stock_alert',notificationThreshold:1,notificationComparator:'at_or_below',notificationMetric:'on_hand'}))).summary,/would have warned you 1 time/);
 const guard=await rehearsal.change(db,ctx.workspaceId,shopChange({domain:'stock_protection',guardMode:'block',guardComparator:'below',guardThreshold:2,guardReleaseCondition:'manual'}));
 assert.match(guard.summary,/^2 outgoing movements/);assert.equal(guard.rows[0]['Would have'],'Stopped taking out 2');
 assert.match((await rehearsal.change(db,ctx.workspaceId,{domain:'transfer_authority',operation:'set',maximumQuantity:4,locationId:shop.id})).summary,/^0 of 1 past transfer /);
 assert.match((await rehearsal.change(db,ctx.workspaceId,{domain:'transfer_authority',operation:'set',maximumQuantity:5,skuId:sku})).summary,/^1 of 1 past transfer /);
 assert.match((await rehearsal.change(db,ctx.workspaceId,{domain:'purchase_authority',operation:'set',supplierId:'fixture-supplier',supplierName:'Fixture parts',maximumValue:30,weeklyValue:100})).summary,/^1 of 1 past purchase order /);
 assert.match((await rehearsal.change(db,ctx.workspaceId,{domain:'purchase_authority',operation:'set',supplierId:'fixture-supplier',supplierName:'Fixture parts',maximumValue:10,weeklyValue:100})).summary,/^0 of 1 past purchase order /);
 assert.match((await rehearsal.change(db,ctx.workspaceId,{domain:'supplier_terms',operation:'set',skuId:sku,supplierId:'fixture-supplier',supplierName:'Fixture parts',displayName:'Parcel item',minimumOrderQuantity:25})).summary,/^1 of 1 past order line would have changed, adding 5 units/);
 assert.equal((await rehearsal.change(db,ctx.workspaceId,{domain:'operating_preference',operation:'set',daysOfStock:20})).tested,false);
 assert.deepEqual(await records(),before,'A past-data test changes nothing');

 // Switching the rule on keeps the test the owner saw.
 page=await browser.get('/operating-instructions/'+proposal.id).expect(200);
 await browser.post('/operating-instructions/'+proposal.id+'/approve').type('form').send({_csrf:f.csrf(page.text),integrityHash:proposal.integrityHash}).expect(303);
 const kept=(await db.query("SELECT reference,after_state FROM security_event_history WHERE workspace_id=$1 AND action='Rule tested on past data before it was switched on'",[ctx.workspaceId])).rows;
 assert.equal(kept.length,1);assert.equal(kept[0].reference,proposal.id);assert.equal(kept[0].after_state.sections[0].tested,true);
 assert.equal((await instructions.get(db,ctx.workspaceId,proposal.id)).status,'APPROVED');
 assert.equal((await reviews.run(db,ctx,'rule-tests')).rows.length,0,'Nothing is waiting to be switched on');
});
