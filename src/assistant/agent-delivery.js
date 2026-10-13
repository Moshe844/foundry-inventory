'use strict';
const {createHash}=require('node:crypto'),contract=require('./agent-conversation');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Agent-authored work, not commands, routes, workflow templates or authority.
// This is persisted only by final host verification in the goal transaction.
function create(report){
 const parsed=contract.parse(report);if(parsed?.status!=='completed')return null;
 const workProducts=(parsed.workProducts||[]).map(p=>({...p,id:hash(p)}));
 const nextActions=(parsed.nextActions||[]).filter(a=>contract.publicText(a.label,'')===a.label&&contract.publicText(a.instruction,'')===a.instruction)
  .map(a=>({...a,id:hash(a)}));
 if(!workProducts.length&&!nextActions.length)return null;
 return {version:1,id:hash({workProducts,nextActions}),workProducts,nextActions};
}
function visible(goal){
 const d=goal.checkpoint?.delivery;if(goal.status!=='COMPLETED'||d?.version!==1)return null;
 const products=contract.WorkProducts.safeParse(d.workProducts),actions=contract.NextActions.safeParse(d.nextActions);
 if(!products.success||!actions.success)return null;
 const canonical=create({status:'completed',answer:'Saved work',claims:[],workProducts:products.data,nextActions:actions.data});
 return canonical?.id===d.id?canonical:null;
}
module.exports={create,visible};
