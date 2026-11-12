'use strict';const money=require('../domain/currency'),{ValidationError}=require('../domain/errors'),allocate=require('../pricing/calculator').allocate;
function split(amount,weights){money.integer(amount,'Cost',{signed:true});const out=allocate(Math.abs(amount),weights);return amount<0?out.map(n=>-n):out;}
// fact: the owner's checked cost import for the order. recorded: fees from the
// owner's channel fee terms and shipping from recorded carrier costs, used only
// when there is no import. A missing fee or carrier cost leaves net unknown.
function calculate(order,fact,recorded=null){
 const revenue=money.sum(order.lines.map(l=>l.revenue)),cogs=money.sum(order.lines.map(l=>l.cogs)),scrap=money.sum(order.lines.map(l=>l.scrap)),gross=money.sum([revenue,-cogs,-scrap]);let problem=order.problem,fees=null,shipping=null;
 if(!problem&&fact){if(fact.financial_hash!==order.financialHash||fact.currency!==order.currency)problem='Posted sale or return activity changed. Review the actual cost coverage again.';else{fees=money.integer(fact.fees_minor,'Net fees',{signed:true});shipping=money.integer(fact.shipping_minor,'Net shipping',{signed:true});}}
 else if(!problem&&recorded){fees=recorded.fees.minor;shipping=recorded.shipping.minor;const missing=[recorded.fees.problem,recorded.shipping.problem].filter(Boolean);if(missing.length)problem=missing.join(' ');}
 else if(!problem)problem='Confirm the actual net fees, shipping costs and their original source.';
 const weights=order.lines.map(l=>l.weight);if(!weights.some(n=>n>0))problem=problem||'No positive original sale revenue is available to allocate shared costs.';if(problem)return {revenue,cogs,scrap,gross,fees,shipping,net:null,problem,lines:order.lines.map(l=>({...l,net:null}))};
 fees=money.integer(fees,'Net fees',{signed:true});shipping=money.integer(shipping,'Net shipping',{signed:true});const feeParts=split(fees,weights),shippingParts=split(shipping,weights),lines=order.lines.map((l,i)=>({...l,fees:feeParts[i],shipping:shippingParts[i],net:money.sum([l.revenue,-l.cogs,-l.scrap,-feeParts[i],-shippingParts[i]])})),net=money.sum([gross,-fees,-shipping]);if(money.sum(lines.map(l=>l.net))!==net)throw new ValidationError('The allocated order contribution does not reconcile.');return {revenue,cogs,scrap,gross,fees,shipping,net,problem:null,lines};
}
module.exports={split,calculate};
