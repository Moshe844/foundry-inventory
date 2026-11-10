'use strict';const test=require('node:test'),assert=require('node:assert/strict'),comparison=require('../../src/commercial/agent-plan-comparison');
test('limited plan descriptions state actual current work and keep higher-plan tracking out of Growth',()=>{
 const rows=comparison.comparison(),byId=id=>rows.find(row=>row.id===id);assert.match(byId(31).currentScope,/delivery-date/);assert.match(byId(31).currentScope,/Quantity and price amendments remain planned/);
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
 for(const id of [12,65,107,112,113,114])assert.equal(rows.find(r=>r.id===id).status,'pending','Permission or configuration checks cannot qualify a completed workflow');
 for(const id of [118,119])assert.equal(rows.find(r=>r.id===id).status,'partial','Native physical-transfer qualification has a bounded supported scope');
 assert.equal(rows.filter(r=>r.status==='complete').length,4,'Scope descriptions must not upgrade workflow qualification');
});
