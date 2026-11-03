'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),economics=require('../../src/commercial/approved-economics'),offer=require('../../src/commercial/offers/approved-2026-11-02');
test('maximum combined usage reproduces the approved annual economics without hiding carry-month losses',()=>{
 for(const [id,cost]of [['starter',8409.916666666666],['growth',27599.916666666668],['pro',66249.91666666666]]){const row=economics.scenario(id,{annual:true});assert(Math.abs(row.costMinor-cost)<1e-7,id);assert(row.contributionMinor>0);}
 const carry=economics.scenario('pro',{annual:true,carry:true});assert(carry.contributionMinor<0);assert.equal(carry.carryFundingIsNewRevenue,false);assert.match(carry.qualification,/REQUIRES_PROVIDER_INVOICES/);assert.equal(economics.all().length,18);
});
test('new provider AI ceilings match approved reserve economics; configured spending caps remain authoritative',()=>{
 const budget=require('../../src/commercial/model-cost-budget');
 for(const [id,ceiling]of [['starter',49.5],['growth',165],['pro',412.5]])assert.equal(budget.periodLimit(id,offer.configuration(id)),ceiling);
 const key='STOCKCHIEF_AI_PERIOD_COST_CAP_USD_STARTER',prior=process.env[key];process.env[key]='12';try{assert.equal(budget.periodLimit('starter',offer.configuration('starter')),12);}finally{if(prior===undefined)delete process.env[key];else process.env[key]=prior;}
});
