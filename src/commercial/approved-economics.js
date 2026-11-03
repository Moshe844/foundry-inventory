'use strict';
const offer=require('./offers/approved-2026-11-02');
const operatingReserves=Object.freeze({starter:{infrastructure:1500,support:1000},growth:{infrastructure:3500,support:2500},pro:{infrastructure:7500,support:4000}});
// Approved reserve assumptions, not assertions that provider invoices or
// maximum shared-infrastructure workloads have been commercially qualified.
function scenario(planId,{annual=false,fraction=1,carry=false}={}){
 const plan=offer.plans[planId];if(!plan||![0.5,1].includes(fraction))throw new TypeError('Choose an approved plan and modeled usage fraction.');
 const limits=plan.limits,cost=offer.configuration(planId).providerCostReserves,operating=operatingReserves[planId];
 const revenueMinor=(annual?plan.annualMinor/12:plan.monthlyMinor),aiMinor=limits.ai_work_credits*cost.aiMinorPerCredit*fraction*(carry?2:1),failureMinor=aiMinor*cost.aiFailureFraction;
 const components={aiMinor,failureMinor,incomingMinor:limits.incoming_emails*cost.incomingMinorPerMessage*fraction,outgoingMinor:limits.emails_sent*cost.outgoingMinorPerRecipient*fraction,connectedMinor:limits.connected_operations*cost.connectedMinorPerOperation*fraction,infrastructureMinor:operating.infrastructure,supportMinor:operating.support,stripeMinor:(annual?plan.annualMinor:plan.monthlyMinor)*0.036/(annual?12:1)+35/(annual?12:1)};
 const costMinor=Object.values(components).reduce((a,b)=>a+b,0),contributionMinor=revenueMinor-costMinor;
 return {planId,annual,fraction,carry,revenueMinor,components,costMinor,contributionMinor,contributionPercent:contributionMinor/revenueMinor*100,qualification:'RESERVE_MODEL_REQUIRES_PROVIDER_INVOICES_AND_MAXIMUM_LOAD_EVIDENCE',carryFundingIsNewRevenue:false};
}
function all(){return Object.keys(offer.plans).flatMap(plan=>[false,true].flatMap(annual=>[scenario(plan,{annual,fraction:0.5}),scenario(plan,{annual}),scenario(plan,{annual,carry:true})]));}
module.exports={scenario,all};
