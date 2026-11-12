'use strict';const test=require('node:test'),assert=require('node:assert/strict'),comparison=require('../../src/commercial/agent-plan-comparison');

test('Customer order pages retain Pro teaching and lower-plan exclusion and never promise payment or physical fulfillment',()=>{const row=comparison.comparison().find(r=>r.id===83);assert.equal(row.status,'partial');for(const tier of ['starter','growth'])assert.equal(row.plans.find(p=>p.tier===tier).mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='pro').mode,'trained');assert.match(row.plans.find(p=>p.tier==='pro').currentScope,/same products, quantities/);assert.equal(row.plans.find(p=>p.tier==='enterprise').mode,'alone');assert.match(row.plans.find(p=>p.tier==='enterprise').currentScope,/without training/);assert.match(row.currentScope,/100 distinct whole-unit/);assert.match(row.currentScope,/unconfirmed native order draft/);assert.match(row.currentScope,/WhatsApp and SMS intake remain open/);});
test('Return disposition scopes preserve lower-plan exclusion, trained Pro decisions and separate physical repair release',()=>{const row=comparison.comparison().find(r=>r.id===113);assert.equal(row.status,'partial');for(const tier of ['starter','growth'])assert.equal(row.plans.find(p=>p.tier===tier).mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='pro').mode,'trained');assert.match(row.plans.find(p=>p.tier==='pro').currentScope,/physically completed/);assert.match(row.plans.find(p=>p.tier==='enterprise').currentScope,/without training/);assert.match(row.currentScope,/100 distinct whole-unit/);assert.match(row.currentScope,/stay unsellable/);assert.match(row.currentScope,/remain open/);});
test('Net margin keeps Starter to one read-only view and runs alone on paid plans with missing costs never counted as zero',()=>{const row=comparison.comparison().find(r=>r.id===85);assert.equal(row.status,'complete');assert.equal(row.plans.find(p=>p.tier==='starter').mode,'suggest');assert.match(row.plans.find(p=>p.tier==='starter').currentScope,/one read-only view/);for(const tier of ['growth','pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);assert.match(row.plans.find(p=>p.tier===tier).currentScope,/Needs you/);}assert.match(row.currentScope,/never as zero/);assert.match(row.currentScope,/currencies stay separate/);});
test('Foreign purchases keep Starter suggest-only, alert alone on paid plans and book receipts at the recorded rate',()=>{const row=comparison.comparison().find(r=>r.id===40);assert.equal(row.status,'complete');assert.equal(row.plans.find(p=>p.tier==='starter').mode,'suggest');assert.match(row.plans.find(p=>p.tier==='starter').currentScope,/one read-only/);for(const tier of ['growth','pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);assert.match(row.plans.find(p=>p.tier===tier).currentScope,/never changes a price or a cost/);}assert.match(row.currentScope,/European Central Bank/);assert.match(row.currentScope,/stops the receipt and asks/);});
test('Export packet scopes preserve exact plan levels, no-training drafts and separate owner review',()=>{const row=comparison.comparison().find(r=>r.id===70);assert.equal(row.status,'partial');assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='growth').mode,'draft');assert.match(row.plans.find(p=>p.tier==='growth').currentScope,/individual approval/);for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}assert.match(row.currentScope,/100 whole-unit/);assert.match(row.currentScope,/remain open/);});
test('limited plan descriptions state actual current work and keep higher-plan tracking out of Growth',()=>{
 const rows=comparison.comparison(),byId=id=>rows.find(row=>row.id===id);
 const amendments=byId(31);
 assert.match(amendments.currentScope,/revised quantities, measured weights, prices and delivery dates/);
 assert.match(amendments.currentScope,/connected purchase email thread/);
 assert.match(amendments.currentScope,/Earlier receipts and invoices keep their original/);
 for(const tier of ['starter','growth'])assert.equal(amendments.plans.find(plan=>plan.tier===tier).mode,'excluded');
 assert.equal(amendments.plans.find(plan=>plan.tier==='pro').mode,'trained');
 assert.match(amendments.plans.find(plan=>plan.tier==='pro').currentScope,/approved matching example/);
 assert.equal(amendments.plans.find(plan=>plan.tier==='enterprise').mode,'alone');
 assert.match(amendments.plans.find(plan=>plan.tier==='enterprise').currentScope,/without teaching/);
 const benefit=byId(97);assert.match(benefit.plans.find(p=>p.tier==='growth').currentScope,/one-time estimate/);assert.match(benefit.plans.find(p=>p.tier==='pro').currentScope,/Tracks checked rebate/);assert.equal(benefit.plans.find(p=>p.tier==='starter').currentScope,null);
 assert.match(byId(38).currentScope,/500 lines and 2,000 cartons/);const pro=comparison.presentation().plans.pro.groups.flatMap(g=>g.jobs).find(j=>j.id===97),growth=comparison.presentation().plans.growth.groups.flatMap(g=>g.jobs).find(j=>j.id===97);assert.match(pro.currentScope,/Tracks checked/);assert.match(growth.currentScope,/one-time estimate/);
 const promotion=byId(145);assert.equal(promotion.plans.find(p=>p.tier==='growth').currentScope,null);assert.match(promotion.plans.find(p=>p.tier==='pro').currentScope,/Automatic planning and draft preparation require Custom/);assert.match(promotion.plans.find(p=>p.tier==='enterprise').currentScope,/without training/);
 for(const row of rows)if(row.status==='pending')assert.equal(row.currentScope,null,'An unavailable duty cannot have an Available now description');
});

test('every operationally qualified duty explains its current scope while permission-only rows remain planned',()=>{
 const rows=comparison.comparison();
 for(const row of rows){
  if(row.status==='pending')continue;
  assert(row.currentScope&&row.currentScope.length>=35&&row.currentScope.length<=600,'Missing or unusable scope for duty '+row.id);
  for(const cell of row.plans){assert.equal(Boolean(cell.currentScope),cell.mode!=='excluded','Scope availability must match the plan cell for duty '+row.id+' '+cell.tier);}
 }
 const protectedStock=rows.find(r=>r.id===12);assert.equal(protectedStock.status,'complete');for(const tier of ['starter','growth'])assert.equal(protectedStock.plans.find(p=>p.tier===tier).currentScope,null);
 assert.equal(protectedStock.plans.find(p=>p.tier==='pro').mode,'trained');assert.match(protectedStock.plans.find(p=>p.tier==='pro').currentScope,/until you approve one or save a rule/);
 assert.equal(protectedStock.plans.find(p=>p.tier==='enterprise').mode,'alone');assert.match(protectedStock.plans.find(p=>p.tier==='enterprise').currentScope,/without training/);
 assert.match(protectedStock.currentScope,/big/);assert.match(protectedStock.currentScope,/repeating order/);assert.match(protectedStock.currentScope,/never takes stock already promised/);
 {const row=rows.find(r=>r.id===65);assert.equal(row.status,'complete');for(const tier of ['starter','growth'])assert.equal(row.plans.find(p=>p.tier===tier).mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='pro').mode,'trained');assert.match(row.plans.find(p=>p.tier==='pro').currentScope,/teach/);assert.equal(row.plans.find(p=>p.tier==='enterprise').mode,'alone');assert.match(row.plans.find(p=>p.tier==='enterprise').currentScope,/without training/);assert.match(row.currentScope,/never from one being picked/);}
 const approval=rows.find(r=>r.id===119);
 assert.equal(approval.status,'complete');
 assert.match(approval.currentScope,/exact stocking-unit limit/);
 assert.match(approval.currentScope,/Staff confirm picking, dispatch and receipt/);
 for(const tier of ['starter','growth'])assert.equal(approval.plans.find(p=>p.tier===tier).mode,'excluded');
 for(const tier of ['pro','enterprise']){
  const current=approval.plans.find(p=>p.tier===tier);
  assert.equal(current.mode,'alone');
  assert.match(current.currentScope,/without training/);
 }
 const balance=rows.find(r=>r.id===118);assert.equal(balance.status,'complete');
 assert.equal(balance.plans.find(p=>p.tier==='starter').mode,'suggest');
 assert.equal(balance.plans.find(p=>p.tier==='growth').mode,'trained');assert.match(balance.plans.find(p=>p.tier==='growth').currentScope,/complete a matching draft/);
 for(const tier of ['pro','enterprise']){assert.equal(balance.plans.find(p=>p.tier===tier).mode,'alone');assert.match(balance.plans.find(p=>p.tier===tier).currentScope,/without training/);}
 assert.deepEqual(rows.filter(r=>r.status==='complete').map(r=>r.id),require('../../src/commercial/agent-plan-progress.json').complete,'Only verified complete duties qualify');
 for(const id of [1,2,4,18,19,21,22,48,117,120,130,144,146,148,192])assert.equal(rows.find(r=>r.id===id).status,'complete');
 const reorderRefresh=rows.find(r=>r.id===21);
 assert.match(reorderRefresh.currentScope,/every stocked product and location/);
 assert.equal(reorderRefresh.plans.find(p=>p.tier==='starter').mode,'suggest');
 assert.match(reorderRefresh.plans.find(p=>p.tier==='starter').currentScope,/You change them yourself/);
 assert.equal(reorderRefresh.plans.find(p=>p.tier==='growth').mode,'trained');
 assert.match(reorderRefresh.plans.find(p=>p.tier==='growth').currentScope,/save a change limit, or approve a change/);
 for(const tier of ['pro','enterprise'])assert.match(reorderRefresh.plans.find(p=>p.tier===tier).currentScope,/without training inside your saved change limit/);
 const demandForecast=rows.find(r=>r.id===144);
 assert.match(demandForecast.currentScope,/yearly and weekday patterns/);
 assert.equal(demandForecast.plans.find(p=>p.tier==='starter').mode,'suggest');
 assert.match(demandForecast.plans.find(p=>p.tier==='starter').currentScope,/one product/);
 for(const tier of ['growth','pro','enterprise']){assert.equal(demandForecast.plans.find(p=>p.tier===tier).mode,'alone');assert.match(demandForecast.plans.find(p=>p.tier===tier).currentScope,/drive planning on their own/);}
 const launchForecast=rows.find(r=>r.id===146);
 assert.match(launchForecast.currentScope,/stops and asks you to choose one/);
 assert.equal(launchForecast.plans.find(p=>p.tier==='starter').mode,'excluded');
 assert.equal(launchForecast.plans.find(p=>p.tier==='growth').mode,'suggest');
 assert.match(launchForecast.plans.find(p=>p.tier==='growth').currentScope,/Planning does not use it/);
 for(const tier of ['pro','enterprise'])assert.match(launchForecast.plans.find(p=>p.tier===tier).currentScope,/drive planning on its own/);
 const demandTrend=rows.find(r=>r.id===148);
 assert.match(demandTrend.currentScope,/three standard deviations/);
 assert.match(demandTrend.currentScope,/one-off/);
 assert.equal(demandTrend.plans.find(p=>p.tier==='starter').mode,'suggest');
 assert.match(demandTrend.plans.find(p=>p.tier==='starter').currentScope,/Suggests one product/);
 for(const tier of ['growth','pro','enterprise']){assert.equal(demandTrend.plans.find(p=>p.tier===tier).mode,'alone');assert.match(demandTrend.plans.find(p=>p.tier===tier).currentScope,/lets planning follow the trend/);}
 const localReorder=rows.find(r=>r.id===120);
 assert.equal(localReorder.plans.find(p=>p.tier==='starter').mode,'excluded');
 assert.equal(localReorder.plans.find(p=>p.tier==='growth').mode,'trained');
 assert.match(localReorder.plans.find(p=>p.tier==='growth').currentScope,/individually approved and completed/);
 for(const tier of ['pro','enterprise']){
  const current=localReorder.plans.find(p=>p.tier===tier);
  assert.equal(current.mode,'alone');
  assert.match(current.currentScope,/without training/);
 }
 assert.match(localReorder.currentScope,/exact stocking increments/);
 const daily=rows.find(r=>r.id===4);
 assert.equal(daily.plans.find(p=>p.tier==='starter').mode,'suggest');
 assert.match(daily.plans.find(p=>p.tier==='starter').currentScope,/one read-only shelf suggestion/);
 assert.equal(daily.plans.find(p=>p.tier==='growth').mode,'draft');
 assert.match(daily.plans.find(p=>p.tier==='growth').currentScope,/owner confirms the current draft/);
 for(const tier of ['pro','enterprise']){
  const current=daily.plans.find(p=>p.tier===tier);
  assert.equal(current.mode,'alone');
  assert.match(current.currentScope,/without training/);
 }
});

test('Channel-buffer plan scopes distinguish individually reviewed quantities from routines without training',()=>{const row=comparison.comparison().find(r=>r.id===183);assert.equal(row.status,'partial');assert.match(row.currentScope,/Shopify and WooCommerce/);assert.match(row.currentScope,/remain open/);assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');assert.match(row.plans.find(p=>p.tier==='growth').currentScope,/individual approval/);for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}});

test('Annual stocktake scopes keep Growth drafts, run Pro and Custom from the owner rule and leave big differences to sign-off',()=>{const row=comparison.comparison().find(r=>r.id===16);assert.equal(row.status,'complete');assert.match(row.currentScope,/blind/);assert.match(row.currentScope,/recount/);assert.match(row.currentScope,/sign-off/);for(const tier of ['pro','enterprise'])assert.match(row.plans.find(p=>p.tier===tier).currentScope,/Big differences wait for your sign-off/);assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');assert.match(row.plans.find(p=>p.tier==='growth').currentScope,/individual approval/);for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);assert.match(row.plans.find(p=>p.tier===tier).currentScope,/10,000/);}});

test('Receipt routing preserves plan authority and separately confirmed dispatch',()=>{
 const row=comparison.comparison().find(r=>r.id===48);
 assert.equal(row.status,'complete');
 assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');
 const growth=row.plans.find(p=>p.tier==='growth');
 assert.equal(growth.mode,'trained');
 assert.match(growth.currentScope,/individually approved and completed/);
 for(const tier of ['pro','enterprise']){
  const plan=row.plans.find(p=>p.tier===tier);
  assert.equal(plan.mode,'alone');
  assert.match(plan.currentScope,/without training/);
 }
 assert.match(row.currentScope,/partial shipments/);
 assert.match(row.currentScope,/separately confirms physical picking and dispatch/);
});
test('Order splits follow the owner rules, with taught Pro authority and no-training Custom splitting',()=>{const row=comparison.comparison().find(r=>r.id===61);assert.equal(row.status,'complete');for(const tier of ['starter','growth'])assert.equal(row.plans.find(p=>p.tier===tier).mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='pro').mode,'trained');assert.match(row.plans.find(p=>p.tier==='pro').currentScope,/teach/);assert.equal(row.plans.find(p=>p.tier==='enterprise').mode,'alone');assert.match(row.plans.find(p=>p.tier==='enterprise').currentScope,/without training/);assert.match(row.currentScope,/accept partial shipments/);});

test('Purchased return-label instructions require Growth teaching and allow known-customer Pro and Custom requests without training',()=>{const row=comparison.comparison().find(r=>r.id===112);assert.equal(row.status,'partial');assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='growth').mode,'trained');assert.match(row.plans.find(p=>p.tier==='growth').currentScope,/provider-confirmed/);for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}assert.match(row.currentScope,/purchase postage separately/);});

test('Website stock answers preserve lower-plan exclusion and no-training Pro and Custom authority with explicit public scope',()=>{const row=comparison.comparison().find(r=>r.id===84);assert.equal(row.status,'partial');for(const tier of ['starter','growth'])assert.equal(row.plans.find(p=>p.tier===tier).mode,'excluded');for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}assert.match(row.currentScope,/1,000/);assert.match(row.currentScope,/Exact counts are optional/);assert.match(row.currentScope,/remain open/);});

test('Channel copy writes complete private AI batches while preserving the PDF tier modes',()=>{const row=comparison.comparison().find(r=>r.id===128);assert.equal(row.status,'complete');assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='growth').mode,'draft');assert.match(row.plans.find(p=>p.tier==='growth').currentScope,/approve each finished private batch/);for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}assert.match(row.currentScope,/AI writes/);assert.match(row.currentScope,/paged internally/);assert.match(row.currentScope,/language, tone/);assert.match(row.currentScope,/publication/);});

test('Supplier contract releases exclude lower plans, draft on Pro until taught and place real POs within limits on taught Pro and Custom',()=>{const row=comparison.comparison().find(r=>r.id===42);assert.equal(row.status,'complete');for(const tier of ['starter','growth'])assert.equal(row.plans.find(p=>p.tier===tier).mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='pro').mode,'trained');assert.match(row.plans.find(p=>p.tier==='pro').currentScope,/until you approve one and teach it/);assert.match(row.plans.find(p=>p.tier==='pro').currentScope,/undo before the email goes out/);assert.equal(row.plans.find(p=>p.tier==='enterprise').mode,'alone');assert.match(row.plans.find(p=>p.tier==='enterprise').currentScope,/without training/);assert.match(row.currentScope,/52 releases/);assert.match(row.currentScope,/real purchase order/);assert.match(row.currentScope,/never goes over/);});

test('Customer invoices are completed printable shipment paperwork with Growth teaching and Pro/Custom no-training authority',()=>{const row=comparison.comparison().find(r=>r.id===101);assert.equal(row.status,'complete');assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='growth').mode,'trained');assert.match(row.plans.find(p=>p.tier==='growth').currentScope,/individually approved and completed/);for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}assert.match(row.currentScope,/existing posted invoice/);assert.match(row.currentScope,/Partial dispatches, payments and return credits/);});


test('Contract facts retain every plan ceiling and only Pro/Custom may enable reading newly filed originals',()=>{const row=comparison.comparison().find(r=>r.id===143);assert.equal(row.status,'complete');for(const tier of ['starter','growth']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'suggest');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/Automatic.*require/);}for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}assert.match(row.currentScope,/literal original quotes/);assert.match(row.currentScope,/100 AI credits/);assert.match(row.currentScope,/separate approval/);});
test('Complete source reading keeps Starter excluded, Growth batch approval and no-training Pro/Custom and preserves exact supplier precision across plan tiers',()=>{const row=comparison.comparison().find(r=>r.id===136);assert.equal(row.status,'complete');assert.equal(row.plans.find(p=>p.tier==='starter').mode,'excluded');assert.equal(row.plans.find(p=>p.tier==='growth').mode,'draft');assert.match(row.plans.find(p=>p.tier==='growth').currentScope,/approve each complete finished fact batch/);for(const tier of ['pro','enterprise']){assert.equal(row.plans.find(p=>p.tier===tier).mode,'alone');assert.match(row.plans.find(p=>p.tier===tier).currentScope,/without training/);}assert.match(row.currentScope,/original language and units/);assert.match(row.currentScope,/exact page quotations/);const supplier=comparison.comparison().find(r=>r.id===129);assert.equal(supplier.status,'complete');assert.match(supplier.currentScope,/exact fractional grams and millimetres/);assert.equal(supplier.plans.find(p=>p.tier==='starter').mode,'excluded');assert.match(supplier.plans.find(p=>p.tier==='growth').currentScope,/approve each exact supplier batch/);for(const tier of ['pro','enterprise'])assert.match(supplier.plans.find(p=>p.tier===tier).currentScope,/without training/);});
